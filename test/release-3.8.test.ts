import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { AgentTask, CompletionProvider } from '../src/agent/task';
import type { AgentSettings, UiMessage } from '../src/agent/types';
import { NodeAgentHost } from '../src/core/nodeHost';
import {
  collectWorkspaceReviewDiff,
  inferModelFamily,
  parseCrossReviewVerdict,
  selectCrossReviewModel,
} from '../src/core/crossReview';
import {
  formatMcpPromptSlashCommand,
  McpRegistry,
  parseMcpPromptArgs,
  resolveMcpPromptSlashCommand,
} from '../src/core/mcp';
import {
  createMcpOAuthRuntimeProvider,
  performMcpOAuthLogin,
  SecretStorageMcpOAuthStore,
  SystemKeychainMcpOAuthStore,
} from '../src/core/mcpOAuth';
import { evaluatePermission } from '../src/core/permissions';
import { defaultSettings } from '../src/core/settings';
import { main as cliMain, parseArgs } from '../src/cli/index';

function initTempGitRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-git-'));
  const git = (args: string[]) => {
    const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
    return res.stdout.trim();
  };
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  git(['add', '-A']);
  git(['commit', '-m', 'Initial commit']);
  return fs.realpathSync(root);
}

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
      mcp: false,
      web: false,
    },
    allowedCommands: ['*'],
    deniedCommands: [],
    maxRequests: 20,
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
    stopOnFallback: false,
    repoMapEnabled: false,
    repoMapMaxChars: 4000,
    autoCompactThreshold: 0.8,
    autoCompactKeepSteps: 4,
    worktreeEnabled: false,
    maxParallelSubtasks: 3,
    crossModelReview: false,
    ...overrides,
  };
}

/**
 * Starts a local mock OAuth 2.0 + MCP HTTP server supporting:
 * - RFC 9728 `/.well-known/oauth-protected-resource`
 * - RFC 8414 `/.well-known/oauth-authorization-server`
 * - RFC 7591 `/oauth/register`
 * - PKCE S256 `/oauth/authorize` + `/oauth/token` (`authorization_code` & `refresh_token`)
 * - Bearer-protected `/mcp` JSON-RPC 2.0 endpoint
 */
async function startMockOAuthMcpServer() {
  let validAccessToken = 'tok_initial_1';
  const validRefreshToken = 'rtok_1';
  let refreshCount = 0;
  let mcpToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const pendingCodes = new Map<string, { codeChallenge: string; redirectUri: string; clientId: string }>();

  const server = http.createServer(async (req, res) => {
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const url = new URL(req.url || '/', baseUrl);

    if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth/register') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ client_id: 'dyn_client_38' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      const clientId = url.searchParams.get('client_id') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const state = url.searchParams.get('state') || '';
      const challenge = url.searchParams.get('code_challenge') || '';
      const method = url.searchParams.get('code_challenge_method') || '';
      if (method !== 'S256' || !challenge || !redirectUri.startsWith('http://127.0.0.1:')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid pkce or loopback redirect_uri');
        return;
      }
      const code = `code_${Math.random().toString(36).slice(2, 10)}`;
      pendingCodes.set(code, { codeChallenge: challenge, redirectUri, clientId });
      const cb = new URL(redirectUri);
      cb.searchParams.set('code', code);
      cb.searchParams.set('state', state);
      res.writeHead(302, { Location: cb.toString() });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const code = params.get('code') || '';
        const verifier = params.get('code_verifier') || '';
        const pending = pendingCodes.get(code);
        pendingCodes.delete(code);
        if (!pending) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const computedChallenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (computedChallenge !== pending.codeChallenge) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pkce_mismatch' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: validAccessToken,
          refresh_token: validRefreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp:tools mcp:prompts',
        }));
        return;
      }
      if (grantType === 'refresh_token') {
        if (params.get('refresh_token') !== validRefreshToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_refresh_token' }));
          return;
        }
        refreshCount++;
        validAccessToken = `tok_refreshed_${refreshCount}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: validAccessToken,
          refresh_token: validRefreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${validAccessToken}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="mcp"', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const rpc = JSON.parse(raw);
      const reply = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-38' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (rpc.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      switch (rpc.method) {
        case 'initialize':
          reply({
            protocolVersion: '2025-03-26',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'mock-oauth-mcp', version: '1.0.0' },
          });
          return;
        case 'tools/list':
          reply({
            tools: [
              {
                name: 'query',
                description: 'Execute SQL against mock DB',
                inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
              },
            ],
          });
          return;
        case 'resources/list':
          reply({ resources: [] });
          return;
        case 'prompts/list':
          reply({
            prompts: [
              {
                name: 'review_pr',
                description: 'Review pull request diff',
                arguments: [
                  { name: 'pr', description: 'PR number', required: true },
                  { name: 'focus', description: 'Optional area of focus', required: false },
                ],
              },
            ],
          });
          return;
        case 'prompts/get': {
          const pArgs = rpc.params?.arguments || {};
          reply({
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Review PR #${pArgs.pr || '?'} focusing on ${pArgs.focus || 'general safety'}`,
                },
              },
            ],
          });
          return;
        }
        case 'tools/call': {
          mcpToolCalls.push({ name: rpc.params?.name, arguments: rpc.params?.arguments || {} });
          reply({
            content: [{ type: 'text', text: `SQL OK: ${rpc.params?.arguments?.sql}` }],
          });
          return;
        }
        default:
          reply({});
          return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port as number;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    expireAccessToken: () => { validAccessToken = 'tok_expired_server_side'; },
    getRefreshCount: () => refreshCount,
    getToolCalls: () => mcpToolCalls,
    resetToolCalls: () => { mcpToolCalls = []; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('F21: OAuth 2.0 + PKCE loopback login, SecretStorage persistence, automatic 401 refresh, and logout', async () => {
  const mock = await startMockOAuthMcpServer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-oauth-'));
  try {
    const secretMap = new Map<string, string>();
    const secretStore = new SecretStorageMcpOAuthStore({
      get: async (k) => secretMap.get(k),
      store: async (k, v) => { secretMap.set(k, v); },
      delete: async (k) => { secretMap.delete(k); },
    });

    const tokens = await performMcpOAuthLogin({
      serverName: 'corp_db',
      serverUrl: mock.mcpUrl,
      store: secretStore,
      openAuthorizationUrl: async (authUrl) => {
        // Simulate browser visiting authorize endpoint -> 302 -> 127.0.0.1:<port>/callback
        const authRes = await fetch(authUrl, { redirect: 'manual' });
        assert.equal(authRes.status, 302);
        const callbackLocation = authRes.headers.get('location');
        assert.ok(callbackLocation && callbackLocation.startsWith('http://127.0.0.1:'));
        const cbRes = await fetch(callbackLocation);
        assert.equal(cbRes.status, 200);
      },
    });

    assert.equal(tokens.accessToken, 'tok_initial_1');
    assert.equal(tokens.clientId, 'dyn_client_38');
    assert.equal(secretMap.size, 1, 'token stored in IDE SecretStorage');

    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { corp_db: { type: 'http', url: mock.mcpUrl } } }),
      'utf8'
    );

    const logLines: string[] = [];
    const registry = new McpRegistry({
      cwd: tmpDir,
      trustProject: true,
      oauthProvider: createMcpOAuthRuntimeProvider(secretStore),
      log: (line) => logLines.push(line),
    });

    await registry.connectAll();
    const firstCall = await registry.callTool('corp_db', 'query', { sql: 'SELECT 1' });
    assert.match(firstCall.content, /SQL OK: SELECT 1/);

    // Expire token server-side so next call receives HTTP 401 and must auto-refresh + retry once
    mock.expireAccessToken();
    const secondCall = await registry.callTool('corp_db', 'query', { sql: 'SELECT 2' });
    assert.match(secondCall.content, /SQL OK: SELECT 2/);
    assert.equal(mock.getRefreshCount(), 1, '401 triggered transparent refresh_token grant');

    const refreshed = await secretStore.get('corp_db', mock.mcpUrl);
    assert.equal(refreshed?.accessToken, 'tok_refreshed_1');

    // Ensure tokens never leaked into MCP registry logs
    for (const line of logLines) {
      assert.ok(!line.includes('tok_initial_1') && !line.includes('tok_refreshed_1') && !line.includes('rtok_1'));
    }

    await registry.closeAll();

    // Logout wipes SecretStorage
    const removed = await secretStore.remove('corp_db', mock.mcpUrl);
    assert.equal(removed, true);
    assert.equal(await secretStore.get('corp_db', mock.mcpUrl), undefined);
  } finally {
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F21: CLI SystemKeychainMcpOAuthStore passes secrets via stdin only (never argv) and falls back to 0600 store', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-keychain-'));
  try {
    const capturedCalls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
    let keychainMemory = '';

    // 1. macOS `/usr/bin/security -i` stdin verification
    const macStore = new SystemKeychainMcpOAuthStore({
      platform: 'darwin',
      home: homeDir,
      runner: async (cmd, args, stdinText) => {
        capturedCalls.push({ cmd, args, stdin: stdinText });
        if (stdinText?.includes('add-generic-password')) {
          const m = /-w ([0-9a-f]+)/i.exec(stdinText);
          keychainMemory = m ? m[1] : '';
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'find-generic-password') {
          return keychainMemory
            ? { code: 0, stdout: `${keychainMemory}\n`, stderr: '' }
            : { code: 44, stdout: '', stderr: 'not found' };
        }
        if (args[0] === 'delete-generic-password') {
          keychainMemory = '';
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: '' };
      },
    });

    await macStore.save('gh_mcp', 'https://mcp.example.com/v1', {
      accessToken: 'super_secret_access_999',
      refreshToken: 'super_secret_refresh_999',
      clientId: 'cli',
      tokenUrl: 'https://mcp.example.com/token',
      serverUrl: 'https://mcp.example.com/v1',
      updatedAt: Date.now(),
    });

    for (const c of capturedCalls) {
      const joinedArgs = c.args.join(' ');
      assert.ok(!joinedArgs.includes('super_secret_access_999'), 'access token must NEVER appear in process argv');
      assert.ok(!joinedArgs.includes('super_secret_refresh_999'), 'refresh token must NEVER appear in process argv');
    }
    assert.deepEqual(capturedCalls[0].args, ['-i'], 'macOS security must run in interactive stdin mode (-i)');

    const loadedMac = await macStore.get('gh_mcp', 'https://mcp.example.com/v1');
    assert.equal(loadedMac?.accessToken, 'super_secret_access_999');
    assert.equal(await macStore.remove('gh_mcp', 'https://mcp.example.com/v1'), true);
    assert.equal(await macStore.get('gh_mcp', 'https://mcp.example.com/v1'), undefined);

    // 2. Headless Linux fallback (0600 file when secret-tool is unavailable)
    const fallbackStore = new SystemKeychainMcpOAuthStore({
      platform: 'linux',
      home: homeDir,
      runner: async () => ({ code: 127, stdout: '', stderr: 'secret-tool: not found' }),
    });
    await fallbackStore.save('gh_mcp', 'https://mcp.example.com/v1', {
      accessToken: 'fallback_secret_tok',
      clientId: 'cli',
      tokenUrl: 'https://mcp.example.com/token',
      serverUrl: 'https://mcp.example.com/v1',
      updatedAt: Date.now(),
    });
    const fallbackFile = path.join(homeDir, '.perplexicode', 'mcp-oauth.json');
    assert.ok(fs.existsSync(fallbackFile));
    if (process.platform !== 'win32') {
      const mode = fs.statSync(fallbackFile).mode & 0o777;
      assert.equal(mode, 0o600, 'fallback file must have 0600 permissions');
    }
    assert.equal((await fallbackStore.get('gh_mcp', 'https://mcp.example.com/v1'))?.accessToken, 'fallback_secret_tok');
    assert.equal(await fallbackStore.remove('gh_mcp', 'https://mcp.example.com/v1'), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('F22: MCP server:skill slash command formatting, argument parsing, and interactive REPL execution', async () => {
  assert.equal(formatMcpPromptSlashCommand('github', 'review_pr'), '/github:review_pr');
  assert.deepEqual(
    parseMcpPromptArgs('pr=42 focus="auth flow"', [
      { name: 'pr', required: true },
      { name: 'focus', required: false },
    ]),
    { pr: '42', focus: 'auth flow' }
  );
  assert.deepEqual(
    parseMcpPromptArgs('108', [{ name: 'pr', required: true }]),
    { pr: '108' },
    'positional single value maps to first required argument'
  );

  const resolved = resolveMcpPromptSlashCommand('/github:review_pr pr=77 focus=sql', [
    {
      server: 'github',
      name: 'review_pr',
      description: 'Review PR',
      arguments: [{ name: 'pr', required: true }, { name: 'focus' }],
    },
  ]);
  assert.ok(resolved);
  assert.equal(resolved.prompt.server, 'github');
  assert.deepEqual(resolved.args, { pr: '77', focus: 'sql' });

  // End-to-end REPL test with real out/cli.js + stdio MCP server + mock OpenAI server
  const mockMcp = await startMockOAuthMcpServer();
  const seenPrompts: string[] = [];
  const openAiServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const allContent = (body.messages || []).map((m: any) => String(m.content || '')).join('\n');
    seenPrompts.push(allContent);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            content: '<attempt_completion><result>PR review completed</result></attempt_completion>',
          },
        },
      ],
    }));
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, '127.0.0.1', () => resolve()));
  const openAiPort = (openAiServer.address() as any).port as number;

  const replWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-repl-'));
  const replHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-repl-home-'));
  try {
    // Pre-populate OAuth token in fallback store for the mock HTTP MCP server
    const cliStore = new SystemKeychainMcpOAuthStore({
      platform: 'linux',
      home: replHome,
      runner: async () => ({ code: 127, stdout: '', stderr: '' }),
    });
    await cliStore.save('github', mockMcp.mcpUrl, {
      accessToken: 'tok_initial_1',
      refreshToken: 'rtok_1',
      clientId: 'dyn_client_38',
      tokenUrl: `${mockMcp.baseUrl}/oauth/token`,
      serverUrl: mockMcp.mcpUrl,
      updatedAt: Date.now(),
    });
    fs.writeFileSync(
      path.join(replWorkspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { github: { type: 'http', url: mockMcp.mcpUrl } } }),
      'utf8'
    );

    const cliPath = path.join(process.cwd(), 'out', 'cli.js');
    const child = spawn(
      process.execPath,
      [cliPath, '--provider', 'openai', '--cwd', replWorkspace, '--trust-project', '--no-journal'],
      {
        env: {
          ...process.env,
          HOME: replHome,
          USERPROFILE: replHome,
          PCODE_FORCE_REPL: '1',
          PCODE_OPENAI_BASE_URL: `http://127.0.0.1:${openAiPort}/v1`,
          PCODE_OPENAI_API_KEY: 'test-key',
          PCODE_OPENAI_MODEL: 'gpt-4o-mini',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let combined = '';
    child.stdout.on('data', (d) => { combined += d.toString(); });
    child.stderr.on('data', (d) => { combined += d.toString(); });

    child.stdin.write('/skills\n/github:review_pr pr=42 focus="auth flow"\n/exit\n');
    child.stdin.end();

    const exitCode: number = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    assert.equal(exitCode, 0, `REPL exited cleanly, output:\n${combined}`);
    assert.match(combined, /\/github:review_pr/, 'REPL /skills lists /server:skill prompt');
    assert.ok(
      seenPrompts.some((p) => p.includes('Review PR #42 focusing on auth flow')),
      'REPL /github:review_pr expanded MCP prompt arguments and sent to session'
    );
  } finally {
    await mockMcp.close();
    await new Promise<void>((resolve) => openAiServer.close(() => resolve()));
    fs.rmSync(replWorkspace, { recursive: true, force: true });
    fs.rmSync(replHome, { recursive: true, force: true });
  }
});

test('F23: Argument-level MCP permission rules and deny overriding autoApprove.mcp and bypassPermissions', async () => {
  const rules = {
    allow: ['mcp__corp_db__query(sql:SELECT *)'],
    ask: ['mcp__corp_db__query(sql:*DELETE*)'],
    deny: [
      'mcp__corp_db__query(sql:*DROP*)',
      'mcp__k8s__apply({"metadata":{"namespace":"prod*"}})',
      'mcp__vault__read_resource(uri:secret://*)',
    ],
  };

  const baseConfig = {
    ...rules,
    protectSecrets: true,
    additionalDirectories: [] as string[],
  };

  // 1. SELECT matches allow
  const allowRes = evaluatePermission(
    { ...baseConfig, mode: 'default' },
    { name: 'use_mcp_tool', params: { server_name: 'corp_db', tool_name: 'query', arguments: '{"sql":"SELECT id FROM users"}' } },
    process.cwd()
  );
  assert.equal(allowRes.decision, 'allow');

  // 2. DELETE matches ask
  const askRes = evaluatePermission(
    { ...baseConfig, mode: 'default' },
    { name: 'use_mcp_tool', params: { server_name: 'corp_db', tool_name: 'query', arguments: '{"sql":"DELETE FROM sessions"}' } },
    process.cwd()
  );
  assert.equal(askRes.decision, 'ask');

  // 3. DROP matches deny EVEN in bypassPermissions mode
  const denyRes = evaluatePermission(
    { ...baseConfig, mode: 'bypassPermissions' },
    { name: 'use_mcp_tool', params: { server_name: 'corp_db', tool_name: 'query', arguments: '{"sql":"DROP TABLE users"}' } },
    process.cwd()
  );
  assert.equal(denyRes.decision, 'deny');

  // 4. Nested JSON object matcher
  const nestedDeny = evaluatePermission(
    { ...baseConfig, mode: 'bypassPermissions' },
    {
      name: 'use_mcp_tool',
      params: {
        server_name: 'k8s',
        tool_name: 'apply',
        arguments: JSON.stringify({ kind: 'Deployment', metadata: { namespace: 'production-eu', name: 'api' } }),
      },
    },
    process.cwd()
  );
  assert.equal(nestedDeny.decision, 'deny');

  // 5. Malformed JSON fails closed when a deny rule constrains arguments on that tool
  const malformedDeny = evaluatePermission(
    { ...baseConfig, mode: 'bypassPermissions' },
    { name: 'use_mcp_tool', params: { server_name: 'corp_db', tool_name: 'query', arguments: '{not valid json' } },
    process.cwd()
  );
  assert.equal(malformedDeny.decision, 'deny');

  // 6. Resource URI rule on access_mcp_resource
  const resourceDeny = evaluatePermission(
    { ...baseConfig, mode: 'bypassPermissions' },
    { name: 'access_mcp_resource', params: { server_name: 'vault', uri: 'secret://prod/root-key' } },
    process.cwd()
  );
  assert.equal(resourceDeny.decision, 'deny');

  // 7. End-to-end AgentTask (IDE path with autoApprove.mcp = true and NO CoreBridge)
  const mock = await startMockOAuthMcpServer();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-f23-'));
  try {
    fs.mkdirSync(path.join(ws, '.perplexicode'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.perplexicode', 'settings.json'),
      JSON.stringify({
        permissions: {
          deny: ['mcp__corp_db__query(sql:*DROP*)'],
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { corp_db: { type: 'http', url: mock.mcpUrl } } }),
      'utf8'
    );

    const secretMap = new Map<string, string>();
    const store = new SecretStorageMcpOAuthStore({
      get: async (k) => secretMap.get(k),
      store: async (k, v) => { secretMap.set(k, v); },
      delete: async (k) => { secretMap.delete(k); },
    });
    await store.save('corp_db', mock.mcpUrl, {
      accessToken: 'tok_initial_1',
      clientId: 'c1',
      tokenUrl: `${mock.baseUrl}/oauth/token`,
      serverUrl: mock.mcpUrl,
      updatedAt: Date.now(),
    });

    const registry = new McpRegistry({
      cwd: ws,
      trustProject: true,
      oauthProvider: createMcpOAuthRuntimeProvider(store),
    });

    let turn = 0;
    const promptsReceived: string[] = [];
    const provider: CompletionProvider = {
      complete: async (req) => {
        promptsReceived.push(req.fullPrompt);
        turn++;
        let text: string;
        if (turn === 1) {
          text = `<use_mcp_tool><server_name>corp_db</server_name><tool_name>query</tool_name><arguments>{"sql":"DROP TABLE accounts"}</arguments></use_mcp_tool>`;
        } else if (turn === 2) {
          text = `<use_mcp_tool><server_name>corp_db</server_name><tool_name>query</tool_name><arguments>{"sql":"SELECT count(*) FROM accounts"}</arguments></use_mcp_tool>`;
        } else {
          text = `<attempt_completion><result>Checked DB safely</result></attempt_completion>`;
        }
        return {
          text,
          accountAlias: 'test',
          modelLabel: 'Claude 4.6 Sonnet',
          citations: [],
          usedFollowUp: false,
          promptChars: req.fullPrompt.length,
        };
      },
    };

    const messages: UiMessage[] = [];
    const task = new AgentTask({
      mode: 'code',
      provider,
      host: new NodeAgentHost(ws),
      mcp: registry,
      getSettings: () =>
        baseAgentSettings({
          autoApprove: {
            ...baseAgentSettings().autoApprove,
            enabled: true,
            mcp: true, // Explicitly enabled! Deny rule MUST still block DROP TABLE!
          },
        }),
      getSelection: () => ({ baseModelId: 'claude46sonnet', thinking: false, webSearch: false }),
      getModelLabel: (id) => id,
      callbacks: {
        onMessage: (_t, msg) => { messages.push(msg); },
        onState: (owner) => {
          if (owner.status.state === 'waiting' && owner.status.askId) {
            owner.respond(owner.status.askId, { response: 'yes' });
          }
        },
      },
    });

    await task.start('Run DB queries');
    await registry.closeAll();

    // Verify DROP TABLE was NEVER sent to the MCP server despite autoApprove.mcp = true
    assert.deepEqual(
      mock.getToolCalls(),
      [{ name: 'query', arguments: { sql: 'SELECT count(*) FROM accounts' } }],
      'DROP TABLE must be blocked before reaching MCP server even when autoApprove.mcp is true'
    );
    assert.ok(
      promptsReceived.some((p) => p.includes('mcp__corp_db__query(sql:*DROP*)')),
      'Model receives explicit deny rule rejection'
    );
  } finally {
    await mock.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('F24: Cross-model review selects different model family, is off by default, and gates attempt_completion on diff + verify', async () => {
  // 1. Default off in settings & CLI args
  assert.equal(defaultSettings().crossModelReview, false);
  const parsedDefault = parseArgs(['-p', 'hello']);
  assert.equal(parsedDefault.crossModelReview, undefined);
  const parsedEnabled = parseArgs(['--cross-review', '--cross-review-model', 'gpt54', '-p', 'hello']);
  assert.equal(parsedEnabled.crossModelReview, true);
  assert.equal(parsedEnabled.crossModelReviewModel, 'gpt54');

  // 2. Family inference & cross-family selection
  assert.equal(inferModelFamily('claude46sonnet'), 'anthropic');
  assert.equal(inferModelFamily('gpt54'), 'openai');
  assert.equal(inferModelFamily('gemini31pro'), 'google');
  assert.equal(inferModelFamily('grok41'), 'xai');

  const pickedForClaude = selectCrossReviewModel('claude46sonnet');
  assert.ok(pickedForClaude, 'picks a reviewer model for Claude author');
  assert.notEqual(pickedForClaude.reviewerFamily, 'anthropic', 'reviewer must belong to a different family than Claude');

  const pickedForGpt = selectCrossReviewModel('gpt54');
  assert.ok(pickedForGpt);
  assert.notEqual(pickedForGpt.reviewerFamily, 'openai', 'reviewer must belong to a different family than GPT');

  // Verdict parser handles fenced JSON & plain JSON
  assert.equal(parseCrossReviewVerdict('```json\n{"verdict":"APPROVE","summary":"LGTM","issues":[]}\n```').approved, true);
  assert.equal(
    parseCrossReviewVerdict('{"verdict":"CHANGES_REQUESTED","summary":"Broken","issues":["bug 1"]}').approved,
    false
  );

  // 3. End-to-end AgentTask flow:
  //    - Author (`claude46sonnet`) edits `math.ts` with a bug, runs test, calls attempt_completion
  //    - Cross-family reviewer (`gpt*` / non-Anthropic) rejects first attempt_completion
  //    - Author fixes `math.ts`, re-runs test, calls attempt_completion again
  //    - Cross-family reviewer approves -> task completes!
  const repo = initTempGitRepo({
    'math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  });

  try {
    const requests: Array<{ baseModelId: string; fullPrompt: string }> = [];
    let authorStep = 0;
    let reviewStep = 0;

    const provider: CompletionProvider = {
      complete: async (req) => {
        requests.push({ baseModelId: req.baseModelId, fullPrompt: req.fullPrompt });
        const isReviewer = req.baseModelId !== 'claude46sonnet';
        if (isReviewer) {
          reviewStep++;
          assert.notEqual(
            inferModelFamily(req.baseModelId),
            'anthropic',
            `Reviewer model (${req.baseModelId}) must be from a different family than claude46sonnet`
          );
          assert.match(req.fullPrompt, /math\.ts/, 'Reviewer prompt must include git diff of math.ts');
          assert.match(req.fullPrompt, /=== Verification status ===/, 'Reviewer prompt must include verify status');
          if (reviewStep === 1) {
            return {
              text: JSON.stringify({
                verdict: 'CHANGES_REQUESTED',
                summary: 'multiply() uses subtraction instead of multiplication.',
                issues: ['math.ts:2 computes a - b instead of a * b'],
              }),
              accountAlias: 'test',
              modelLabel: 'Reviewer Model',
              citations: [],
              usedFollowUp: false,
              promptChars: req.fullPrompt.length,
            };
          }
          return {
            text: JSON.stringify({
              verdict: 'APPROVE',
              summary: 'multiply() is fixed and verified.',
              issues: [],
            }),
            accountAlias: 'test',
            modelLabel: 'Reviewer Model',
            citations: [],
            usedFollowUp: false,
            promptChars: req.fullPrompt.length,
          };
        }

        authorStep++;
        let text: string;
        if (authorStep === 1) {
          text = `<write_to_file><path>math.ts</path><content>export const add = (a: number, b: number) => a + b;\nexport const multiply = (a: number, b: number) => a - b;\n</content></write_to_file>`;
        } else if (authorStep === 2) {
          text = `<execute_command><command>node -e "process.exit(0)"</command></execute_command>`;
        } else if (authorStep === 3) {
          text = `<attempt_completion><result>Added multiply()</result></attempt_completion>`;
        } else if (authorStep === 4) {
          assert.match(
            req.fullPrompt,
            /\[NOT ACCEPTED — Cross-model review/,
            'Author receives cross-model review feedback blocking premature completion'
          );
          text = `<write_to_file><path>math.ts</path><content>export const add = (a: number, b: number) => a + b;\nexport const multiply = (a: number, b: number) => a * b;\n</content></write_to_file>`;
        } else if (authorStep === 5) {
          text = `<execute_command><command>node -e "process.exit(0)"</command></execute_command>`;
        } else {
          text = `<attempt_completion><result>Added and verified multiply()</result></attempt_completion>`;
        }
        return {
          text,
          accountAlias: 'test',
          modelLabel: 'Claude 4.6 Sonnet',
          citations: [],
          usedFollowUp: false,
          promptChars: req.fullPrompt.length,
        };
      },
    };

    const task = new AgentTask({
      mode: 'code',
      provider,
      host: new NodeAgentHost(repo),
      getSettings: () =>
        baseAgentSettings({
          crossModelReview: true,
          autoApprove: {
            ...baseAgentSettings().autoApprove,
            enabled: true,
            write: true,
            execute: true,
          },
          allowedCommands: ['*'],
        }),
      getSelection: () => ({ baseModelId: 'claude46sonnet', thinking: false, webSearch: false }),
      getModelLabel: (id) => id,
      callbacks: {
        onMessage: () => undefined,
        onState: (owner) => {
          if ((owner.status.state === 'waiting' || owner.status.state === 'completed') && owner.status.askId) {
            owner.respond(owner.status.askId, { response: 'yes' });
          }
        },
      },
    });

    await task.start('Add multiply() to math.ts');

    assert.equal(reviewStep, 2, 'Cross-model reviewer ran twice (1st rejected, 2nd approved)');
    assert.equal(authorStep, 6, 'Author fixed code after review rejection before completing');
    const finalContent = fs.readFileSync(path.join(repo, 'math.ts'), 'utf8');
    assert.match(finalContent, /a \* b/);

    const diffSummary = await collectWorkspaceReviewDiff(repo, ['math.ts']);
    assert.match(diffSummary, /math\.ts/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('F21 CLI E2E: `pcode mcp login <server>` and `pcode mcp logout <server>` complete without leaking tokens to output', async () => {
  const mock = await startMockOAuthMcpServer();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-cli-login-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-38-cli-home-'));
  try {
    fs.writeFileSync(
      path.join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { corp_db: { type: 'http', url: mock.mcpUrl } } }),
      'utf8'
    );
    const cliPath = path.join(process.cwd(), 'out', 'cli.js');
    const child = spawn(
      process.execPath,
      [cliPath, 'mcp', 'login', 'corp_db', '--cwd', ws],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home, PCODE_OAUTH_NO_OPEN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    let browserVisited = false;
    const visitUrlIfPresent = async (chunk: string) => {
      output += chunk;
      if (browserVisited) return;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+)/.exec(output);
      if (m) {
        browserVisited = true;
        const authRes = await fetch(m[1], { redirect: 'manual' });
        const loc = authRes.headers.get('location');
        if (loc) await fetch(loc);
      }
    };
    child.stdout.on('data', (d) => { void visitUrlIfPresent(d.toString()); });
    child.stderr.on('data', (d) => { void visitUrlIfPresent(d.toString()); });

    const loginCode: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
    assert.equal(loginCode, 0, `pcode mcp login exited cleanly:\n${output}`);
    assert.ok(!output.includes('tok_initial_1') && !output.includes('rtok_1'), 'OAuth tokens must never print to CLI output');

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const logoutCode = await cliMain(['mcp', 'logout', 'corp_db', '--cwd', ws]);
      assert.equal(logoutCode, 0);
    } finally {
      process.env.HOME = prevHome;
    }
  } finally {
    await mock.close();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
