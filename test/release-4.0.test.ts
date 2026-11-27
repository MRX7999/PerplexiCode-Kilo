import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  buildQuickEditPrompt,
  extractStreamingQuickEditCode,
  QuickEditStreamAssembler,
  runInlineQuickEdit,
} from '../src/agent/inlineQuickEdit';
import { buildRepoMap, REPO_MAP_NO_WORKSPACE_TEXT } from '../src/agent/repoMap';
import { AgentTask, CompletionProvider } from '../src/agent/task';
import { isBroadScanRoot } from '../src/agent/tools';
import { isNetworkErrorMessage, PerplexityTransport, TransportError } from '../src/agent/transport';
import { parseAssistantMessage } from '../src/agent/toolParser';
import { CapabilityFetcher } from '../src/api/capabilityFetcher';
import type { AgentSettings } from '../src/agent/types';
import {
  getModelCatalog,
  setRuntimeModelCatalog,
  setVerifiedRemoteModelsConfig,
} from '../src/api/modelCatalog';
import {
  loadCachedVerifiedModelCatalog,
  parseSha256Digest,
  updateModelCatalogFromRepository,
  verifyAndParseRemoteCatalog,
} from '../src/api/remoteCatalogUpdater';
import { RotationEngine } from '../src/api/rotationEngine';
import type { AccountSession, StreamCallbacks } from '../src/api/types';
import { LongCommandTimer, parseArgs } from '../src/cli/index';
import { loadLspConfigs, LspManager } from '../src/core/lsp';
import { NodeAgentHost } from '../src/core/nodeHost';
import { evaluatePermission } from '../src/core/permissions';
import {
  assertNoSessionSecretsOnWire,
  RemoteCoreClient,
  RemoteSecurityViolationError,
  startRemoteCoreServer,
  verifyBearerTokenConstantTime,
} from '../src/core/remoteCore';
import { CoreSession } from '../src/core/runner';
import { defaultSettings } from '../src/core/settings';

function baseAgentSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    autoApprove: {
      enabled: true,
      read: true,
      readOutsideWorkspace: false,
      write: true,
      execute: true,
      modeSwitch: true,
      subtasks: true,
      todo: true,
      retry: true,
      mcp: true,
      web: true,
    },
    allowedCommands: ['*'],
    deniedCommands: [],
    maxRequests: 15,
    maxReadLines: 500,
    commandTimeoutSec: 30,
    terminalOutputLines: 200,
    webSearch: 'never',
    contextStrategy: 'full',
    maxPromptChars: 60000,
    language: 'ru',
    customInstructions: '',
    modeInstructions: {},
    diffEnabled: true,
    includeFileListOnStart: false,
    ...overrides,
  };
}

function makeMockCompletion(text: string) {
  return {
    text,
    meta: { model: 'turbo' },
    accountAlias: 'MockAccount',
    modelLabel: 'Turbo',
    citations: [],
    usedFollowUp: false,
    promptChars: text.length,
  };
}

// ---------------------------------------------------------------------------
// F26 — `pcode serve`: Unix socket + WebSocket daemon, bearer auth, local sessions
// ---------------------------------------------------------------------------

test('F26: Unix socket remote core (`0600`) executes host tools and keeps Perplexity sessions strictly local', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-unix-ws-'));
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-sock-'));
  const socketPath = path.join(sockDir, 'serve.sock');
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'initial-remote-content\n', 'utf8');

  const testAuthKey = 'unit-test-opaque-serve-key-9876543210';
  const server = await startRemoteCoreServer({
    cwd: workspace,
    token: testAuthKey,
    socketPath,
    trustProject: true,
  });

  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(socketPath).mode & 0o777;
      assert.equal(mode, 0o600, 'Unix domain socket must be restricted to 0600');
    }

    // Wrong bearer token must be rejected
    const badClient = new RemoteCoreClient({
      endpoint: `unix://${socketPath}`,
      token: 'wrong-key-value-0000000000',
    });
    await assert.rejects(() => badClient.connect(), /Unauthorized/i);

    let localLlmCalls = 0;
    const localIdeProvider: CompletionProvider = {
      complete: async (req) => {
        localLlmCalls += 1;
        if (localLlmCalls === 1) {
          assert.match(req.fullPrompt, /Update hello\.txt/);
          return makeMockCompletion(
            '<write_to_file><path>hello.txt</path><content>updated-from-ide-client\n</content></write_to_file>'
          );
        }
        return makeMockCompletion('<attempt_completion><result>Remote edit done</result></attempt_completion>');
      },
    };

    const client = new RemoteCoreClient({
      endpoint: `unix://${socketPath}`,
      token: testAuthKey,
      localCompletionProvider: localIdeProvider,
    });
    const handshake = await client.connect();
    assert.equal(fs.realpathSync(handshake.cwd), fs.realpathSync(workspace));

    // Direct RemoteAgentHost operations
    const remoteHost = client.createAgentHost();
    const initial = await remoteHost.readFile(path.join(workspace, 'hello.txt'));
    assert.equal(initial, 'initial-remote-content\n');

    const cmdRes = await remoteHost.runCommand('echo remote-shell-ok', workspace, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    assert.equal(cmdRes.exitCode, 0);
    assert.match(cmdRes.output, /remote-shell-ok/);

    // Full remote session run where LLM turns execute locally on the IDE client
    const sessionRes = await client.runRemoteSession({
      prompt: 'Update hello.txt on the remote workspace',
      mode: 'code',
      baseModelId: 'turbo',
    });
    assert.equal(sessionRes.status, 'completed');
    assert.equal(localLlmCalls, 2);
    assert.equal(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8'), 'updated-from-ide-client\n');

    // Audit wire frames: no session credentials or cookie keys ever crossed the wire
    const wireFrames = server.getWireAuditFrames().join('\n');
    assert.doesNotMatch(wireFrames, /sessionToken|csrfToken|fullCookies|next-auth/i);

    client.close();
  } finally {
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sockDir, { recursive: true, force: true });
  }
});

test('F26: WebSocket remote core enforces constant-time bearer auth and blocks Perplexity session secrets on wire', async () => {
  assert.equal(verifyBearerTokenConstantTime('alpha-secret-1234', 'alpha-secret-1234'), true);
  assert.equal(verifyBearerTokenConstantTime('alpha-secret-1234', 'alpha-secret-1235'), false);
  assert.equal(verifyBearerTokenConstantTime('alpha-secret-1234', undefined), false);

  assert.throws(
    () => assertNoSessionSecretsOnWire({ nested: { sessionToken: 'synthetic-disallowed-field' } }),
    RemoteSecurityViolationError
  );
  assert.throws(
    () => assertNoSessionSecretsOnWire({ nested: { csrfToken: 'synthetic-disallowed-csrf' } }),
    RemoteSecurityViolationError
  );

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-ws-'));
  fs.writeFileSync(path.join(workspace, 'ws.txt'), 'ws-ok\n', 'utf8');
  const testAuthKey = 'ws-opaque-test-key-abcdef123456';

  const server = await startRemoteCoreServer({
    cwd: workspace,
    token: testAuthKey,
    host: '127.0.0.1',
    port: 0,
  });

  try {
    assert.ok(server.wsUrl?.startsWith('ws://127.0.0.1:'));

    const unauth = new RemoteCoreClient({
      endpoint: server.wsUrl!,
      token: 'invalid-ws-key-00000000',
    });
    await assert.rejects(() => unauth.connect(), /401|Unauthorized/i);

    const client = new RemoteCoreClient({
      endpoint: server.wsUrl!,
      token: testAuthKey,
    });
    await client.connect();
    const host = client.createAgentHost();
    assert.equal(await host.readFile(path.join(workspace, 'ws.txt')), 'ws-ok\n');
    client.close();
  } finally {
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('F26: `pcode serve` CLI rejects `--token` on argv with exit 64 and starts cleanly via env var', async () => {
  const cliPath = path.join(process.cwd(), 'out', 'cli.js');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-cli-home-'));
  const sockPath = path.join(tmpHome, 'cli-serve.sock');

  try {
    const bad = spawnSync(process.execPath, [cliPath, 'serve', '--token', 'forbidden-argv-value'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpHome },
    });
    assert.equal(bad.status, 64, 'Passing --token on CLI argv must fail with exit code 64');
    assert.match(`${bad.stdout}\n${bad.stderr}`, /--token.*forbidden|PCODE_SERVE_TOKEN/i);

    const child = spawn(process.execPath, [cliPath, 'serve', '--socket', sockPath], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PCODE_SERVE_TOKEN: 'env-provided-opaque-key-1234567890',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const readyJson = await new Promise<{ endpoint: string; transport: string; token_source: string }>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Timed out waiting for pcode serve ready line. Output: ${buf}`));
      }, 10_000);
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (const line of buf.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.includes('"serve_ready"')) {
            clearTimeout(timer);
            resolve(JSON.parse(trimmed));
            return;
          }
        }
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(readyJson.transport, 'unix');
    assert.equal(readyJson.token_source, 'env:PCODE_SERVE_TOKEN');
    assert.ok(readyJson.endpoint.includes(sockPath));

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F27 — `lsp` tool in CLI (`.lsp.json` stdio JSON-RPC) + parser & permissions
// ---------------------------------------------------------------------------

function writeMockLspServerScript(dir: string): string {
  const scriptPath = path.join(dir, 'mock-lsp-server.cjs');
  const code = `
const path = require('node:path');
let buffer = Buffer.alloc(0);

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!m) break;
    const len = Number(m[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const raw = buffer.slice(bodyStart, bodyStart + len).toString('utf8');
    buffer = buffer.slice(bodyStart + len);
    const msg = JSON.parse(raw);
    handle(msg);
  }
});

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true } } });
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    const uri = msg.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: [
          {
            range: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } },
            severity: 1,
            source: 'mock-ts',
            code: 'TS2322',
            message: 'Type string is not assignable to number.',
          }
        ]
      }
    });
    return;
  }
  if (msg.method === 'textDocument/definition') {
    const uri = msg.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [{ uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } }]
    });
    return;
  }
  if (msg.method === 'textDocument/references') {
    const uri = msg.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } },
        { uri, range: { start: { line: 2, character: 9 }, end: { line: 2, character: 14 } } }
      ]
    });
    return;
  }
  if (msg.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { contents: { kind: 'markdown', value: 'function greet(name: string): string' } }
    });
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
}
`;
  fs.writeFileSync(scriptPath, code, 'utf8');
  return scriptPath;
}

test('F27: `.lsp.json` stdio LSP client resolves definition, references, hover, and diagnostics in CLI & AgentTask', async () => {
  // Verify XML tool parser & permission matcher
  const parsed = parseAssistantMessage(
    '<lsp><operation>definition</operation><path>src/sample.ts</path><line>3</line><character>10</character></lsp>'
  );
  assert.ok(parsed.tool);
  assert.equal(parsed.tool.name, 'lsp');
  assert.equal(parsed.tool.params.operation, 'definition');
  assert.equal(parsed.tool.params.line, '3');

  const permDeny = evaluatePermission(
    {
      allow: [],
      ask: [],
      deny: ['Lsp(secret/**)'],
      mode: 'default',
      protectSecrets: true,
    },
    { name: 'lsp', params: { path: 'secret/internal.ts' }, raw: '' },
    '/tmp/ws'
  );
  assert.equal(permDeny.decision, 'deny');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-lsp-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-lsphome-'));
  const serverScript = writeMockLspServerScript(workspace);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'src', 'sample.ts'),
    ['export function greet(name: string): string {', '  const bad: number = "oops";', '  return greet(name);', '}'].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(workspace, '.lsp.json'),
    JSON.stringify({
      servers: {
        'mock-ts': {
          command: process.execPath,
          args: [serverScript],
          extensions: ['.ts'],
          languageIds: { '.ts': 'typescript' },
        },
      },
    }),
    'utf8'
  );

  // Untrusted workspace must ignore project `.lsp.json`
  const untrustedServers = loadLspConfigs(workspace, { homeDir, trustProject: false });
  assert.equal(untrustedServers.length, 0, 'Project .lsp.json must not load when trustProject is false');

  const manager = new LspManager(workspace, { homeDir, trustProject: true });
  try {
    const defOut = await manager.query({ operation: 'definition', path: 'src/sample.ts', line: 3, character: 10 });
    assert.match(defOut, /Definition\(s\)[\s\S]*src\/sample\.ts:1:17/);

    const refOut = await manager.query({ operation: 'references', path: 'src/sample.ts', line: 1, character: 17 });
    assert.match(refOut, /References \(2\)/);
    assert.match(refOut, /src\/sample\.ts:3:10/);

    const hoverOut = await manager.query({ operation: 'hover', path: 'src/sample.ts', line: 1, character: 17 });
    assert.match(hoverOut, /function greet\(name: string\): string/);

    const diagOut = await manager.query({ operation: 'diagnostics', path: 'src/sample.ts' });
    assert.match(diagOut, /\[Error\].*Type string is not assignable to number.*\(TS2322\)/);
  } finally {
    await manager.closeAll();
  }

  // Also test full CoreSession + AgentTask `<lsp>` tool invocation via NodeAgentHost
  const host = new NodeAgentHost(workspace, undefined, homeDir, true);
  let turn = 0;
  let observedToolOutput = '';
  const provider: CompletionProvider = {
    complete: async (req) => {
      turn += 1;
      if (turn === 1) {
        return makeMockCompletion(
          '<lsp><operation>hover</operation><path>src/sample.ts</path><line>1</line><character>17</character></lsp>'
        );
      }
      observedToolOutput = req.fullPrompt;
      return makeMockCompletion('<attempt_completion><result>Hover verified</result></attempt_completion>');
    },
  };

  const session = new CoreSession({
    cwd: workspace,
    home: homeDir,
    host,
    provider,
    agentSettings: baseAgentSettings(),
    selection: { baseModelId: 'turbo', thinking: false },
    getModelLabel: () => 'Turbo',
    mode: 'ask',
    trustProjectHooks: true,
    onAsk: async () => ({ response: 'yes' }),
  });

  try {
    const res = await session.run('Check hover signature of greet');
    assert.equal(res.status, 'completed');
    assert.match(observedToolOutput, /function greet\(name: string\): string/);
  } finally {
    await session.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F28 — REPL UX: `!` local command context injection, `/rewind` files + session, timer
// ---------------------------------------------------------------------------

test('F28: `!<command>` injects local command output into context and `/rewind` rolls back both files and session', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-repl-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-replhome-'));
  fs.writeFileSync(path.join(workspace, 'app.ts'), 'export const v = 0;\n', 'utf8');

  let seenPromptOnTurn3 = '';
  let callIndex = 0;
  const provider: CompletionProvider = {
    complete: async (req) => {
      callIndex += 1;
      if (callIndex === 1) {
        return makeMockCompletion(
          '<write_to_file><path>app.ts</path><content>export const v = 1;\n</content></write_to_file>'
        );
      }
      if (callIndex === 2) {
        return makeMockCompletion('<attempt_completion><result>Step 1 complete</result></attempt_completion>');
      }
      if (callIndex === 3) {
        seenPromptOnTurn3 = req.fullPrompt;
        return makeMockCompletion(
          '<write_to_file><path>app.ts</path><content>export const v = 2;\n</content></write_to_file>'
        );
      }
      if (callIndex === 4) {
        return makeMockCompletion(
          '<write_to_file><path>extra.ts</path><content>export const extra = true;\n</content></write_to_file>'
        );
      }
      return makeMockCompletion('<attempt_completion><result>Step 2 complete</result></attempt_completion>');
    },
  };

  const session = new CoreSession({
    cwd: workspace,
    home: homeDir,
    provider,
    agentSettings: baseAgentSettings(),
    selection: { baseModelId: 'turbo', thinking: false },
    getModelLabel: () => 'Turbo',
    mode: 'code',
    trustProjectHooks: true,
    onAsk: async () => ({ response: 'yes' }),
  });

  try {
    // Step 1: creates Checkpoint #1 (before app.ts changed from v = 0 -> v = 1)
    const r1 = await session.run('Set v = 1');
    assert.equal(r1.status, 'completed');
    assert.equal(fs.readFileSync(path.join(workspace, 'app.ts'), 'utf8'), 'export const v = 1;\n');

    // `!` local command runs immediately and injects stdout + exit code into conversation context
    const bang = await session.runLocalBangCommand('echo local-bang-marker-42');
    assert.equal(bang.exitCode, 0);
    assert.match(bang.output, /local-bang-marker-42/);

    const msgCountBeforeStep2 = session.root!.apiMessages.length;

    // Step 2: sees `!` command output in prompt and creates Checkpoint #2 (app.ts 1 -> 2) & Checkpoint #3 (extra.ts created)
    const r2 = await session.run('Now set v = 2 and add extra.ts');
    assert.equal(r2.status, 'completed');
    assert.match(seenPromptOnTurn3, /local-bang-marker-42/, 'Model must receive !<cmd> output in session context');
    assert.equal(fs.readFileSync(path.join(workspace, 'app.ts'), 'utf8'), 'export const v = 2;\n');
    assert.equal(fs.existsSync(path.join(workspace, 'extra.ts')), true);
    assert.ok(session.root!.apiMessages.length > msgCountBeforeStep2);

    const checkpointsBefore = session.listCheckpoints();
    assert.equal(checkpointsBefore.length, 3);
    const step2Checkpoint = checkpointsBefore[1]; // seq 2 (before app.ts 1 -> 2 and before extra.ts created)

    // `/rewind 2`: rolls back BOTH workspace files AND session messages/checkpoints to before Step 2!
    const rewindRes = await session.rewind(step2Checkpoint.seq);
    assert.equal(rewindRes.seq, step2Checkpoint.seq);
    assert.equal(rewindRes.restoredFiles, 2);
    assert.equal(
      fs.readFileSync(path.join(workspace, 'app.ts'), 'utf8'),
      'export const v = 1;\n',
      '/rewind must restore app.ts to its pre-Step-2 state'
    );
    assert.equal(
      fs.existsSync(path.join(workspace, 'extra.ts')),
      false,
      '/rewind must delete files created at or after the target checkpoint'
    );
    assert.ok(
      rewindRes.apiMessagesAfter < rewindRes.apiMessagesBefore,
      '/rewind must truncate session conversation history back to the checkpoint'
    );
    assert.equal(session.listCheckpoints().length, 1);
  } finally {
    await session.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('F28: `LongCommandTimer` emits live elapsed updates only when command exceeds threshold', async () => {
  const fastWrites: string[] = [];
  const fastTimer = new LongCommandTimer({
    thresholdMs: 200,
    tickMs: 50,
    onTick: (line) => fastWrites.push(line),
  });
  fastTimer.start('echo quick');
  await new Promise((r) => setTimeout(r, 30));
  const fastRes = fastTimer.stop();
  assert.equal(fastRes.showedTimer, false);
  assert.equal(fastWrites.length, 0, 'Short commands must not emit long-command timer noise');

  const slowWrites: string[] = [];
  const slowTimer = new LongCommandTimer({
    thresholdMs: 50,
    tickMs: 50,
    onTick: (line) => slowWrites.push(line),
  });
  slowTimer.start('npm test');
  await new Promise((r) => setTimeout(r, 130));
  const slowRes = slowTimer.stop();
  assert.ok(slowRes.durationMs >= 80);
  assert.equal(slowRes.showedTimer, true);
  assert.ok(slowWrites.some((line) => line.includes('⏱ running')), 'Long commands must emit live timer ticks');
});

// ---------------------------------------------------------------------------
// F29 — Nightly Canary Workflow (`scripts/canary-check.mjs` + `.github/workflows/canary.yml`)
// ---------------------------------------------------------------------------

test('F29: Canary check skips cleanly without secret, passes on valid SSE, and opens redacted issue on schema drift', async () => {
  const canaryScript = path.join(process.cwd(), 'scripts', 'canary-check.mjs');
  const workflowYaml = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'canary.yml'), 'utf8');
  assert.match(workflowYaml, /schedule:/);
  assert.match(workflowYaml, /workflow_dispatch:/);
  assert.match(workflowYaml, /PPLX_CANARY_COOKIE:\s*\$\{\{\s*secrets\.PPLX_CANARY_COOKIE\s*\}\}/);

  // 1. Missing secret -> clean skip with exit code 0
  const envNoSecret = { ...process.env };
  delete envNoSecret.PPLX_CANARY_COOKIE;
  const skipped = spawnSync(process.execPath, [canaryScript], {
    encoding: 'utf8',
    env: envNoSecret,
  });
  assert.equal(skipped.status, 0, 'Canary must exit 0 (skip, not fail) when PPLX_CANARY_COOKIE is unset');
  assert.match(skipped.stdout, /skipping live canary check cleanly/);

  // 2. Valid SSE schema -> OK (exit 0)
  let sseMode: 'valid' | 'drifted' = 'valid';

  const mockServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/rest/sse/perplexity_ask')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (sseMode === 'valid') {
        const payload = JSON.stringify({
          backend_uuid: 'uuid-123',
          display_model: 'turbo',
          text_completed: true,
          blocks: [{ intended_usage: 'ask_text', markdown_block: { answer: 'OK' } }],
        });
        res.write(`event: message\ndata: ${payload}\n\n`);
        res.end(`event: end_of_stream\ndata: {}\n\n`);
      } else {
        // Drifted schema: missing backend_uuid and answer/blocks/chunks, with an unexpected key
        const driftedPayload = JSON.stringify({
          completely_new_envelope_v9: { nested_payload: 'unexpected' },
        });
        res.write(`event: message\ndata: ${driftedPayload}\n\n`);
        res.end();
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (mockServer.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const ghOutFile = path.join(os.tmpdir(), `pcode-40-ghout-${process.pid}.txt`);

  const runCanaryCli = (env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [canaryScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  try {
    const syntheticCanaryCred = '__Secure-next-auth.session-token=synthetic_canary_only_val';
    const passRun = await runCanaryCli({
      ...process.env,
      PPLX_CANARY_COOKIE: syntheticCanaryCred,
      PPLX_CANARY_URL: `${baseUrl}/rest/sse/perplexity_ask`,
    });
    assert.equal(passRun.status, 0, `Expected canary OK, got: ${passRun.stdout} ${passRun.stderr}`);
    assert.match(passRun.stdout, /\[canary\] OK/);

    // 3. Drifted SSE schema -> writes GITHUB_OUTPUT drift=true + redacted issue markdown file and exits 2
    sseMode = 'drifted';
    fs.writeFileSync(ghOutFile, '', 'utf8');
    const failRun = await runCanaryCli({
      ...process.env,
      PPLX_CANARY_COOKIE: syntheticCanaryCred,
      PPLX_CANARY_URL: `${baseUrl}/rest/sse/perplexity_ask`,
      GITHUB_OUTPUT: ghOutFile,
    });
    assert.equal(failRun.status, 2, 'Canary must fail with exit 2 on SSE format drift');
    const ghOutputContent = fs.readFileSync(ghOutFile, 'utf8');
    assert.match(ghOutputContent, /drift=true/);
    const issueFileMatch = /^issue_file=(.+)$/m.exec(ghOutputContent);
    assert.ok(issueFileMatch, 'GITHUB_OUTPUT must expose issue_file path for canary.yml issue creation');
    const issueBody = fs.readFileSync(issueFileMatch[1].trim(), 'utf8');
    assert.match(issueBody, /completely_new_envelope_v9/);
    assert.doesNotMatch(issueBody, /synthetic_canary_only_val/, 'Issue body must redact secret cookie values');
    fs.rmSync(issueFileMatch[1].trim(), { force: true });
  } finally {
    fs.rmSync(ghOutFile, { force: true });
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// F30 — Out-of-band Model Catalog Update with SHA-256 verification & fallback
// ---------------------------------------------------------------------------

test('F30: Remote model catalog verifies SHA-256 hash and falls back to built-in snapshot on mismatch or error', async () => {
  const bundledBytes = fs.readFileSync(path.join(process.cwd(), 'src', 'api', 'bundledModelsConfig.json'));
  const bundledShaFile = fs.readFileSync(path.join(process.cwd(), 'src', 'api', 'bundledModelsConfig.json.sha256'), 'utf8');
  const verifiedBundled = verifyAndParseRemoteCatalog(bundledBytes, bundledShaFile);
  assert.ok(verifiedBundled.models.length > 10, 'Bundled models JSON must match bundledModelsConfig.json.sha256');
  assert.equal(
    parseSha256Digest('8a9b35c4f34c254d3eae20998a14aa417af4b13e4268d91ee78303d2ed34c380  bundledModelsConfig.json\n'),
    '8a9b35c4f34c254d3eae20998a14aa417af4b13e4268d91ee78303d2ed34c380'
  );

  const updatedCatalogObj = JSON.parse(bundledBytes.toString('utf8'));
  updatedCatalogObj.snapshot_date = '2026-12-15';
  updatedCatalogObj.models['nextgen-40-test'] = {
    label: 'NextGen 4.0 Test Model',
    description: 'Added out-of-band without extension release',
    mode: 'search',
    provider: 'OPENAI',
  };
  updatedCatalogObj.config.push({
    label: 'NextGen 4.0 Test Model',
    description: 'Added out-of-band without extension release',
    subheader: 'Added out-of-band without extension release',
    mode: 'search',
    model_Family: 'openai',
    non_reasoning_model: 'nextgen-40-test',
    reasoning_model: null,
    enabled: true,
    subscription_tier: 'pro',
  });
  const updatedJson = JSON.stringify(updatedCatalogObj, null, 2);
  const validHash = createHash('sha256').update(updatedJson, 'utf8').digest('hex');

  let serveTamperedHash = false;
  const catalogServer = http.createServer((req, res) => {
    if (req.url === '/bundledModelsConfig.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(updatedJson);
      return;
    }
    if (req.url === '/bundledModelsConfig.json.sha256') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const digest = serveTamperedHash
        ? createHash('sha256').update('tampered-other-content').digest('hex')
        : validHash;
      res.end(`${digest}  src/api/bundledModelsConfig.json\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => catalogServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (catalogServer.address() as { port: number }).port;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-40-catcache-'));

  const resetCatalogState = () => {
    setVerifiedRemoteModelsConfig(undefined);
    setRuntimeModelCatalog([]);
  };

  try {
    resetCatalogState();

    // 1. Tampered SHA-256 -> rejected, built-in snapshot stays active as fallback!
    serveTamperedHash = true;
    const badRes = await updateModelCatalogFromRepository({
      catalogUrl: `http://127.0.0.1:${port}/bundledModelsConfig.json`,
      sha256Url: `http://127.0.0.1:${port}/bundledModelsConfig.json.sha256`,
      cacheDir,
    });
    assert.equal(badRes.updated, false);
    assert.equal(badRes.usedFallback, true);
    assert.match(badRes.error || '', /SHA-256 mismatch/);
    assert.equal(
      getModelCatalog().some((m) => m.id === 'nextgen-40-test'),
      false,
      'Tampered catalog must not pollute runtime catalog'
    );

    // 2. Network error -> clean fallback to built-in snapshot
    const netFailRes = await updateModelCatalogFromRepository({
      catalogUrl: 'http://127.0.0.1:1/unreachable.json',
      sha256Url: 'http://127.0.0.1:1/unreachable.json.sha256',
      cacheDir,
      timeoutMs: 1000,
    });
    assert.equal(netFailRes.updated, false);
    assert.equal(netFailRes.usedFallback, true);
    assert.ok(netFailRes.models.length > 10);

    // 3. Valid SHA-256 -> updates catalog in place and caches verified snapshot
    serveTamperedHash = false;
    const okRes = await updateModelCatalogFromRepository({
      catalogUrl: `http://127.0.0.1:${port}/bundledModelsConfig.json`,
      sha256Url: `http://127.0.0.1:${port}/bundledModelsConfig.json.sha256`,
      cacheDir,
    });
    assert.equal(okRes.updated, true);
    assert.equal(okRes.usedFallback, false);
    assert.equal(okRes.snapshotDate, '2026-12-15');
    assert.equal(
      getModelCatalog().some((m) => m.id === 'nextgen-40-test'),
      true,
      'Verified remote catalog must immediately expose new model without a release'
    );

    // 4. Reload from verified cache after reset
    resetCatalogState();
    assert.equal(getModelCatalog().some((m) => m.id === 'nextgen-40-test'), false);
    const cachedRes = loadCachedVerifiedModelCatalog(cacheDir);
    assert.equal(cachedRes.updated, true);
    assert.ok(cachedRes.models.some((m) => m.id === 'nextgen-40-test'));
  } finally {
    resetCatalogState();
    await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F31 — Inline Selection Quick-Edit (`Cmd/Ctrl+I`) streaming diff & Migration 4.0
// ---------------------------------------------------------------------------

test('F31: `QuickEditStreamAssembler` & `runInlineQuickEdit` stream live diffs and `README.md` documents Migration to 4.0', async () => {
  const fullDoc = [
    'import * as fs from "node:fs";',
    '',
    'export function readConfig(file: string): string {',
    '  return fs.readFileSync(file, "utf8");',
    '}',
    '',
  ].join('\n');

  const selStart = fullDoc.indexOf('export function readConfig');
  const selEnd = fullDoc.indexOf('}\n') + 1;

  const prompt = buildQuickEditPrompt({
    filePath: 'src/config.ts',
    languageId: 'typescript',
    instruction: 'Make readConfig async using fs.promises.readFile',
    selectedText: fullDoc.slice(selStart, selEnd),
    prefixContext: fullDoc.slice(0, selStart),
    suffixContext: fullDoc.slice(selEnd),
  });
  assert.match(prompt, /Make readConfig async/);
  assert.match(prompt, /<<<SELECTED_CODE/);

  assert.equal(
    extractStreamingQuickEditCode('```typescript\nexport async function readConfig() {}\n```'),
    'export async function readConfig() {}'
  );

  const assembler = new QuickEditStreamAssembler(fullDoc, selStart, selEnd);
  const partial = assembler.update('```typescript\nexport async function readConfig(file: string): Promise<string> {');
  assert.doesNotMatch(partial.replacementCode, /```/, 'Code fences must be stripped even mid-stream');

  const snapshots: number[] = [];
  const streamingProvider: CompletionProvider = {
    complete: async (req) => {
      const chunks = [
        '```typescript\n',
        'export async function readConfig(file: string): Promise<string> {\n',
        '  return fs.promises.readFile(file, "utf8");\n',
        '}\n```',
      ];
      let acc = '';
      for (const ch of chunks) {
        acc += ch;
        req.onText?.(acc, ch);
      }
      return makeMockCompletion(acc);
    },
  };

  const finalSnap = await runInlineQuickEdit({
    provider: streamingProvider,
    baseModelId: 'turbo',
    filePath: 'src/config.ts',
    languageId: 'typescript',
    fullDocumentText: fullDoc,
    selectionStartOffset: selStart,
    selectionEndOffset: selEnd,
    instruction: 'Convert to async',
    signal: new AbortController().signal,
    onStreamSnapshot: (snap) => {
      snapshots.push(snap.replacementCode.length);
    },
  });

  assert.ok(snapshots.length >= 4, 'Streaming diff callback must fire incrementally as chunks arrive');
  assert.match(finalSnap.replacementCode, /export async function readConfig/);
  assert.match(finalSnap.previewFullDocument, /import \* as fs from "node:fs";[\s\S]*fs\.promises\.readFile/);
  assert.ok(finalSnap.added >= 2 && finalSnap.removed >= 2);

  // Verify CLI args parsing for 4.0 commands (`serve`, `models update`)
  const parsedServe = parseArgs(['serve', '--ws', '--host', '127.0.0.1', '--port', '4190']);
  assert.equal(parsedServe.command, 'serve');
  assert.equal(parsedServe.servePort, 4190);

  // Verify package.json 4.0.0, Cmd/Ctrl+I keybinding, preserved settings, and README Migration section
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.match(pkg.version, /^4\.0\.\d+$/);
  const quickEditCmd = pkg.contributes.commands.find((c: any) => c.command === 'perplexicodeKilo.quickEditSelection');
  assert.ok(quickEditCmd, 'perplexicodeKilo.quickEditSelection command must be registered');
  const quickEditKey = pkg.contributes.keybindings.find((k: any) => k.command === 'perplexicodeKilo.quickEditSelection');
  assert.equal(quickEditKey?.key, 'ctrl+i');
  assert.equal(quickEditKey?.mac, 'cmd+i');

  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /## Migrating to 4\.0/, 'README.md must include the "Migrating to 4.0" section');
  assert.match(readme, /pcode serve/);
  assert.match(readme, /stopOnFallback/);
  assert.match(readme, /worktree/);
});

// ---------------------------------------------------------------------------
// 4.0.2 — no-folder tasks must not walk the home directory; network errors must not disable accounts
// ---------------------------------------------------------------------------

function withFakeHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-402-home-')));
  fs.mkdirSync(path.join(home, 'Documents', 'secret-project'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Documents', 'secret-project', 'privateModule.ts'), 'export const privateValue = 1;\n');
  fs.writeFileSync(path.join(home, 'home-notes.txt'), 'notes\n');
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return run(home).finally(() => {
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
  });
}

test('4.0.2: isBroadScanRoot flags the home directory and filesystem roots only', () => {
  const home = path.join(os.tmpdir(), 'pcode-402-fake-home');
  assert.equal(isBroadScanRoot(home, home), true);
  assert.equal(isBroadScanRoot(`${home}${path.sep}`, home), true);
  assert.equal(isBroadScanRoot(path.parse(home).root, home), true);
  assert.equal(isBroadScanRoot(path.join(home, 'project'), home), false);
  assert.equal(isBroadScanRoot(os.tmpdir(), home), false);
});

test('4.0.2: buildRepoMap skips the home directory instead of walking it', async () => {
  await withFakeHome(async (home) => {
    const skipped = await buildRepoMap({ cwd: home });
    assert.equal(skipped.text, REPO_MAP_NO_WORKSPACE_TEXT);
    assert.equal(skipped.totalFilesScanned, 0);
    assert.doesNotMatch(skipped.text, /privateModule/);

    const project = await buildRepoMap({ cwd: path.join(home, 'Documents', 'secret-project') });
    assert.match(project.text, /privateModule\.ts/, 'a real folder is still mapped');
  });
});

test('4.0.2: buildRepoMap stops the directory walk at its directory budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-402-wide-'));
  for (let i = 0; i < 30; i += 1) {
    fs.mkdirSync(path.join(root, `dir${String(i).padStart(2, '0')}`));
    fs.writeFileSync(path.join(root, `dir${String(i).padStart(2, '0')}`, `mod${i}.ts`), `export const v${i} = ${i};\n`);
  }
  const limited = await buildRepoMap({ cwd: root, maxDirsScan: 5, maxChars: 20000 });
  assert.ok(limited.totalFilesScanned <= 4, `walk must stop after 5 directories, scanned ${limited.totalFilesScanned}`);
  const full = await buildRepoMap({ cwd: root, maxChars: 20000 });
  assert.equal(full.totalFilesScanned, 30);
});

test('4.0.2: a task with no folder open (cwd = home) reaches the model without a file list or repo map', async () => {
  await withFakeHome(async (home) => {
    const prompts: string[] = [];
    const provider: CompletionProvider = {
      complete: async (req) => {
        prompts.push(req.fullPrompt);
        return makeMockCompletion('<attempt_completion><result>ok</result></attempt_completion>') as any;
      },
    };
    const task = new AgentTask({
      host: new NodeAgentHost(home, {}, home),
      provider,
      mode: 'ask',
      getSettings: () => baseAgentSettings({ includeFileListOnStart: true, repoMapEnabled: true }),
      getSelection: () => ({ baseModelId: 'turbo', thinking: false, webSearch: false }),
      getModelLabel: () => 'Best',
      callbacks: {
        onMessage: () => {},
        onState: (owner) => {
          const askId = owner.status.state === 'waiting' ? owner.status.askId : undefined;
          if (askId) {
            queueMicrotask(() => owner.respond(askId, { response: 'yes' }));
          }
        },
      },
    });
    const started = Date.now();
    await task.start('тест');
    assert.equal(task.status.state, 'completed');
    assert.equal(prompts.length, 1, 'the request must be sent');
    assert.ok(Date.now() - started < 5000, 'start must not stall on a home-directory scan');
    assert.doesNotMatch(prompts[0], /privateModule|home-notes\.txt/, 'home files must not be listed or mapped');
    assert.doesNotMatch(prompts[0], /# Repository Map/);
  });
});

test('4.0.2: network timeouts are surfaced and never disable the only account', async () => {
  const account: AccountSession = {
    id: 'acc-net',
    alias: 'Account-net',
    sessionToken: 'tok-redacted-test',
    csrfToken: 'csrf-redacted-test',
    status: 'active',
    addedAt: new Date(0).toISOString(),
    queriestoday: 0,
    queriesTotalLifetime: 0,
    errorCount: 0,
    capabilities: {
      plan: 'max',
      availableModels: ['turbo', 'claude55sonnet'],
      unavailableModels: [],
      modes: ['search', 'research'],
      fetchedAt: new Date().toISOString(),
      source: 'cached',
    } as any,
  } as AccountSession;
  const timeoutMessage = 'Connection timed out: no response from www.perplexity.ai within 60 s. Check your network, VPN or proxy.';
  let calls = 0;
  const client = {
    streamQuery: (_q: string, _m: string, callbacks: StreamCallbacks) => {
      calls += 1;
      const controller = new AbortController();
      setTimeout(() => callbacks.onError(new Error(timeoutMessage)), 0);
      return controller;
    },
  } as any;
  const manager = { getAccounts: () => [account], saveMetas: async () => undefined, refreshSession: async () => false } as any;
  const transport = new PerplexityTransport(manager, new RotationEngine(), new CapabilityFetcher(), () => client);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      () =>
        transport.complete({
          fullPrompt: 'тест',
          baseModelId: 'claude55sonnet',
          thinking: false,
          webSearch: false,
          signal: new AbortController().signal,
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.match(error.message, /Connection timed out/);
        assert.doesNotMatch(error.message, /No active Perplexity account/);
        return true;
      }
    );
  }
  assert.equal(calls, 4);
  assert.equal(account.status, 'active');
  assert.equal(account.errorCount, 0);

  assert.equal(isNetworkErrorMessage('Connection failed: getaddrinfo ENOTFOUND www.perplexity.ai'), true);
  assert.equal(isNetworkErrorMessage('Connection failed: could not connect to www.perplexity.ai within 20 s'), true);
  assert.equal(isNetworkErrorMessage('HTTP 403: Forbidden'), false);
});

test('4.0.3: user-facing strings are English (Cyrillic only in allow-listed compatibility code)', () => {
  const root = path.join(__dirname, '..', '..');
  const files = [
    'webview-ui/agent/main.ts',
    'src/agent/controller.ts',
    'src/agent/task.ts',
    'src/agent/transport.ts',
    'src/agent/types.ts',
    'src/extension.ts',
    'src/cli/index.ts',
    'src/core/compaction.ts',
    'src/core/contextInspector.ts',
    'src/core/diagnostics.ts',
    'src/core/journal.ts',
    'src/core/mcpOAuth.ts',
    'src/core/permissions.ts',
    'src/core/types.ts',
    'src/core/worktree.ts',
  ];
  // Reading data written by earlier versions, the Russian "unfinished reply" detector and the [y/N] answer.
  const allowed = [/результат не подтверждён'\)\)/, /\(\?:Modified files\|Изменённые файлы\)|\(\?:Verified hypotheses\|Проверенные гипотезы\)|\(\?:Constraints\|Ограничения\)/, /item !== '\(нет |item !== '\(явных /, /\|сейчас\|теперь\|/, /answer !== 'д' && answer !== 'да'/];
  const offenders: string[] = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (/[А-Яа-яЁё]/.test(line) && !allowed.some((re) => re.test(line))) {
        offenders.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
