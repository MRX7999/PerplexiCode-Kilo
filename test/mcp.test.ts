import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AskResponse, CompletionProvider, McpToolProvider } from '../src/agent/task';
import { parseMcpArgumentsParam } from '../src/agent/task';
import type { CompletionRequest, CompletionResult } from '../src/agent/transport';
import type { AgentSettings, UiMessage } from '../src/agent/types';
import { coerceMcpArgument, parseAssistantMessage } from '../src/agent/toolParser';
import { globFilesTool, htmlToReadableText, searchAndReplaceContent, webFetchTool } from '../src/agent/tools';
import { NodeAgentHost } from '../src/core/nodeHost';
import {
  expandMcpEnv,
  loadMcpServers,
  McpRegistry,
  parseMcpQualifiedToolName,
  projectDefinesStdioMcpServers,
  removeMcpServerConfig,
  resolveSpawnTarget,
  sanitizeMcpSegment,
  saveMcpServerConfig,
  toMcpQualifiedToolName,
} from '../src/core/mcp';
import { evaluatePermission, PermissionConfig } from '../src/core/permissions';
import { CoreSession } from '../src/core/runner';
import { loadSettings } from '../src/core/settings';
import { CoreEvent } from '../src/core/types';
import { headlessAnswer, parseArgs } from '../src/cli/index';

type TestCase = { name: string; run: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run });

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `pcode-mcp-${prefix}-`));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function workspace(files: Record<string, string> = {}): { root: string; home: string } {
  const root = tmp('ws');
  const home = tmp('home');
  for (const [name, content] of Object.entries(files)) write(path.join(root, name), content);
  return { root, home };
}

const SERVER_SCRIPT = path.resolve(process.cwd(), 'test', 'mcp-test-server.js');

/** Inline `--mcp-config` JSON for the stdio test server (scope "cli", so project trust does not apply). */
function stdioConfig(name: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}): string {
  return JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [SERVER_SCRIPT], env, ...extra } } });
}

const agentSettings = (overrides: Partial<AgentSettings> = {}): AgentSettings => ({
  autoApprove: { enabled: true, read: true, readOutsideWorkspace: false, write: false, execute: false, modeSwitch: true, subtasks: true, todo: true, retry: true, mcp: false, web: false },
  allowedCommands: [],
  deniedCommands: [],
  maxRequests: 30,
  maxReadLines: 500,
  commandTimeoutSec: 60,
  terminalOutputLines: 200,
  webSearch: 'never',
  contextStrategy: 'auto',
  maxPromptChars: 60000,
  language: 'en',
  customInstructions: '',
  modeInstructions: {},
  diffEnabled: true,
  includeFileListOnStart: false,
  ...overrides,
});

class ScriptedProvider implements CompletionProvider {
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly replies: Array<string | ((request: CompletionRequest) => string)>) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('ScriptedProvider ran out of replies');
    const text = typeof next === 'function' ? next(request) : next;
    request.onText?.(text, text);
    return { text, meta: {} as CompletionResult['meta'], accountAlias: 'test', modelLabel: 'scripted', citations: [], usedFollowUp: false, promptChars: request.fullPrompt.length };
  }
}

const lastUser = (request: CompletionRequest) => request.fullPrompt.slice(-8000);

function session(opts: {
  root: string;
  home: string;
  provider: CompletionProvider;
  mcp?: McpToolProvider;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  allow?: string[];
  deny?: string[];
  answers?: (message: UiMessage) => AskResponse;
  settings?: Partial<AgentSettings>;
}) {
  const events: CoreEvent[] = [];
  const asks: UiMessage[] = [];
  const settings = loadSettings(opts.root, { home: opts.home, trustProjectHooks: true });
  const core = new CoreSession({
    cwd: opts.root,
    home: opts.home,
    provider: opts.provider,
    agentSettings: agentSettings(opts.settings),
    selection: { baseModelId: 'turbo', thinking: false, webSearch: false },
    mode: 'code',
    permissionMode: opts.permissionMode,
    settings,
    extraAllow: opts.allow,
    extraDeny: opts.deny,
    journal: false,
    trustProjectHooks: true,
    mcp: opts.mcp,
    onAsk: async (_task, message) => {
      asks.push(message);
      return opts.answers ? opts.answers(message) : headlessAnswer(message, 10);
    },
    onEvent: (_task, event) => events.push(event),
  });
  return { core, events, asks };
}

// ---------------------------------------------------------------------------------------------
// Names, env expansion
// ---------------------------------------------------------------------------------------------

test('mcp names: sanitising, Claude Code qualified names and parsing', () => {
  assert.strictEqual(sanitizeMcpSegment(' My Server.v2 '), 'My_Server_v2');
  assert.strictEqual(toMcpQualifiedToolName('github', 'get_issue'), 'mcp__github__get_issue');
  assert.strictEqual(toMcpQualifiedToolName('weird name', 'weird name.v2'), 'mcp__weird_name__weird_name_v2');
  assert.deepStrictEqual(parseMcpQualifiedToolName('mcp__github__get_issue'), { server: 'github', tool: 'get_issue' });
  assert.deepStrictEqual(parseMcpQualifiedToolName('mcp__srv__*'), { server: 'srv', tool: '*' });
  assert.strictEqual(parseMcpQualifiedToolName('mcp__github'), undefined, 'a bare server name is not a tool name');
  assert.strictEqual(parseMcpQualifiedToolName('read_file'), undefined);
});

test('mcp env: ${VAR}, ${VAR:-default} and unset placeholders', () => {
  const env = { TOKEN: 'abc', EMPTY: '' };
  assert.strictEqual(expandMcpEnv('Bearer ${TOKEN}', env), 'Bearer abc');
  assert.strictEqual(expandMcpEnv('${MISSING:-fallback}/x', env), 'fallback/x');
  assert.strictEqual(expandMcpEnv('${EMPTY:-dflt}', env), 'dflt', 'empty counts as unset like in Claude Code');
  assert.strictEqual(expandMcpEnv('${MISSING}', env), '');
  assert.strictEqual(expandMcpEnv('no placeholders $HOME', env), 'no placeholders $HOME', 'only ${...} syntax is expanded');
});

test('mcp spawn: Windows .cmd shims (npx, npm) are resolved through PATH/PATHEXT and quoted for cmd.exe', () => {
  const bin = tmp('winbin');
  fs.writeFileSync(path.join(bin, 'npx.CMD'), '@echo off');
  fs.writeFileSync(path.join(bin, 'uvx.EXE'), '');
  const env = { PATH: `C:\\nowhere;${bin}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  const npx = resolveSpawnTarget('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/my dir'], env, 'win32');
  assert.strictEqual(npx.shell, true);
  assert.strictEqual(npx.command, path.join(bin, 'npx.CMD'), 'resolved shim path (quoted only when it contains spaces)');
  assert.strictEqual(resolveSpawnTarget('npx', [], { ...env, PATH: '' }, 'win32').shell, false, 'nothing found on PATH → plain spawn');
  assert.deepStrictEqual(npx.args, ['-y', '@modelcontextprotocol/server-filesystem', '"/tmp/my dir"']);

  const exe = resolveSpawnTarget('uvx', ['mcp-server-git'], env, 'win32');
  assert.strictEqual(exe.shell, false, 'executables do not need cmd.exe');
  assert.strictEqual(exe.command, path.join(bin, 'uvx.EXE'));

  const missing = resolveSpawnTarget('custom-server', ['a b'], env, 'win32');
  assert.deepStrictEqual(missing, { command: 'custom-server', args: ['a b'], shell: false }, 'unknown commands are left to spawn()');
  assert.deepStrictEqual(resolveSpawnTarget('C:\\tools\\run.cmd', ['x'], env, 'win32'), { command: 'C:\\tools\\run.cmd', args: ['x'], shell: true });
  assert.deepStrictEqual(resolveSpawnTarget('npx', ['-y', 'pkg'], env, 'linux'), { command: 'npx', args: ['-y', 'pkg'], shell: false }, 'no-op outside Windows');
});

// ---------------------------------------------------------------------------------------------
// Config layering
// ---------------------------------------------------------------------------------------------

test('mcp config: user/project/local/cli layers, overrides, type inference, disabled and invalid entries', () => {
  const { root, home } = workspace();
  const otherProject = tmp('other');
  write(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { alpha: { command: 'alpha-bin', args: ['--token', '${TOKEN}'] }, dropped: { description: 'no command or url' } },
    projects: {
      [root]: { mcpServers: { beta: { command: 'beta-bin' } } },
      [otherProject]: { mcpServers: { notMine: { command: 'x' } } },
    },
  }));
  write(path.join(home, '.perplexicode', 'mcp.json'), JSON.stringify({ mcpServers: { gamma: { url: 'https://${HOST:-api.example.com}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } } } }));
  // Bare map (no mcpServers wrapper) in a dedicated project .mcp.json, plus a $schema key that must be ignored.
  write(path.join(root, '.mcp.json'), JSON.stringify({ $schema: 'https://example.com/schema.json', delta: { command: 'npx', args: ['-y', 'delta-server'], env: { KEY: '${TOKEN}' }, timeout: 15 } }));
  write(path.join(root, '.perplexicode', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, mcpServers: { epsilon: { type: 'sse', url: 'http://localhost:9999/sse' }, zeta: { type: 'streamable-http', url: 'http://localhost:9998/mcp' }, off: { command: 'off-bin', disabled: true }, off2: { command: 'off-bin', enabled: false } } }));
  // Regression: a settings file without mcpServers must not be read as a bare server map (verify.command is not a server).
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({ verify: { command: 'npm test', maxAttempts: 2 }, hooks: {}, env: { X: '1' } }));
  write(path.join(home, '.perplexicode', 'settings.json'), JSON.stringify({ verify: { command: 'rm -rf /' } }));
  // Local layer overrides the user-level alpha.
  write(path.join(root, '.mcp.local.json'), JSON.stringify({ mcpServers: { alpha: { command: 'alpha-local', cwd: 'tools' } } }));
  const extraFile = path.join(root, 'extra-mcp.json');
  write(extraFile, JSON.stringify({ mcpServers: { eta: { command: 'eta-bin' } } }));
  const inline = JSON.stringify({ mcpServers: { theta: { url: 'http://127.0.0.1:1/mcp' } } });

  const servers = loadMcpServers(root, { home, extraConfigs: [extraFile, inline, '{not json', '   '], env: { TOKEN: 'secret' } });
  const byName = Object.fromEntries(servers.map((server) => [server.name, server]));

  assert.deepStrictEqual(Object.keys(byName).sort(), ['alpha', 'beta', 'delta', 'epsilon', 'eta', 'gamma', 'off', 'off2', 'theta', 'zeta']);
  assert.strictEqual(byName.alpha.command, 'alpha-local', 'local layer wins over user layer');
  assert.strictEqual(byName.alpha.scope, 'local');
  assert.strictEqual(byName.alpha.cwd, 'tools');
  assert.strictEqual(byName.beta.scope, 'local', '~/.claude.json projects[cwd] entries are local scope');
  assert.strictEqual(byName.gamma.type, 'http', 'url without type is streamable HTTP');
  assert.strictEqual(byName.gamma.url, 'https://api.example.com/mcp');
  assert.deepStrictEqual(byName.gamma.headers, { Authorization: 'Bearer secret' });
  assert.strictEqual(byName.delta.scope, 'project');
  assert.deepStrictEqual(byName.delta.args, ['-y', 'delta-server']);
  assert.deepStrictEqual(byName.delta.env, { KEY: 'secret' });
  assert.strictEqual(byName.delta.timeoutSec, 15);
  assert.strictEqual(byName.epsilon.type, 'sse');
  assert.strictEqual(byName.zeta.type, 'http');
  assert.strictEqual(byName.off.disabled, true);
  assert.strictEqual(byName.off2.disabled, true);
  assert.strictEqual(byName.eta.scope, 'cli');
  assert.strictEqual(byName.eta.sourceFile, extraFile);
  assert.strictEqual(byName.theta.sourceFile, '--mcp-config');
  assert.ok(!('dropped' in byName), 'entries without command/url are ignored');
  assert.ok(!('notMine' in byName), 'other projects in ~/.claude.json are ignored');

  // --strict-mcp-config: only the explicit configs.
  const strict = loadMcpServers(root, { home, extraConfigs: [extraFile, inline], strict: true });
  assert.deepStrictEqual(strict.map((server) => server.name).sort(), ['eta', 'theta']);

  assert.strictEqual(projectDefinesStdioMcpServers(root, { home }), true);
  assert.strictEqual(projectDefinesStdioMcpServers(otherProject, { home }), true, '~/.claude.json projects[dir] stdio servers count for that project');
  assert.strictEqual(projectDefinesStdioMcpServers(tmp('third'), { home }), false, 'only user-level servers → nothing to trust');
  fs.rmSync(path.join(root, '.mcp.json'));
  fs.rmSync(path.join(root, '.mcp.local.json'));
  assert.strictEqual(projectDefinesStdioMcpServers(root, { home }), true, 'beta (from ~/.claude.json projects) is still a local stdio server');
});

test('mcp config: save/remove per scope keeps other settings, validates names, bare maps only in mcp.json files', () => {
  const { root, home } = workspace();
  write(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'keep-bin' } }, note: 'preserved' }));
  write(path.join(root, '.perplexicode', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));

  const projectFile = saveMcpServerConfig(root, 'github', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }, 'project', home);
  assert.strictEqual(projectFile, path.join(root, '.mcp.json'));
  const project = readJson(projectFile);
  assert.strictEqual(project.note, 'preserved');
  assert.ok(project.mcpServers.keep, 'existing servers survive');
  assert.deepStrictEqual(project.mcpServers.github, { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });

  const userFile = saveMcpServerConfig(root, 'remote', { url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer x' }, timeoutSec: 20 }, 'user', home);
  assert.strictEqual(userFile, path.join(home, '.perplexicode', 'mcp.json'));
  const user = readJson(userFile);
  assert.strictEqual(user.mcpServers.remote.type, 'http', 'url-only specs default to streamable HTTP');
  assert.strictEqual(user.mcpServers.remote.timeout, 20);

  const localFile = saveMcpServerConfig(root, 'local-only', { command: 'local-bin' }, 'local', home);
  assert.strictEqual(localFile, path.join(root, '.perplexicode', 'settings.local.json'));
  const local = readJson(localFile);
  assert.deepStrictEqual(local.permissions, { allow: ['Bash(npm test:*)'] }, 'settings.local.json keeps its permissions');
  assert.strictEqual(local.mcpServers['local-only'].command, 'local-bin');

  assert.throws(() => saveMcpServerConfig(root, 'bad name!', { command: 'x' }, 'project', home), /letters, digits/);
  assert.throws(() => saveMcpServerConfig(root, '', { command: 'x' }, 'project', home));

  // The loader sees all three with the right scopes.
  const loaded = loadMcpServers(root, { home });
  const scopes = Object.fromEntries(loaded.map((server) => [server.name, server.scope]));
  assert.deepStrictEqual(scopes, { keep: 'project', github: 'project', remote: 'user', 'local-only': 'local' });

  // Remove with an explicit scope touches only that scope.
  assert.deepStrictEqual(removeMcpServerConfig(root, 'github', 'user', home), { removed: false, files: [] });
  const removedProject = removeMcpServerConfig(root, 'github', 'project', home);
  assert.deepStrictEqual(removedProject, { removed: true, files: [projectFile] });
  assert.ok(!readJson(projectFile).mcpServers.github);
  assert.ok(readJson(projectFile).mcpServers.keep);

  // Remove without a scope searches project, local and user files.
  const removedUser = removeMcpServerConfig(root, 'remote', undefined, home);
  assert.deepStrictEqual(removedUser, { removed: true, files: [userFile] });
  const removedLocal = removeMcpServerConfig(root, 'local-only', undefined, home);
  assert.deepStrictEqual(removedLocal, { removed: true, files: [localFile] });
  assert.deepStrictEqual(readJson(localFile).permissions, { allow: ['Bash(npm test:*)'] });
  assert.deepStrictEqual(removeMcpServerConfig(root, 'nope', undefined, home), { removed: false, files: [] });

  // Bare maps: accepted in .mcp.json, but a bare top-level key in settings.local.json is NOT a server entry.
  write(path.join(root, '.mcp.json'), JSON.stringify({ bare: { command: 'bare-bin' }, other: { command: 'other-bin' } }));
  write(path.join(root, '.perplexicode', 'settings.local.json'), JSON.stringify({ bare: { command: 'looks like a server but is a setting' }, permissions: {} }));
  const bare = removeMcpServerConfig(root, 'bare', undefined, home);
  assert.deepStrictEqual(bare.files, [path.join(root, '.mcp.json')]);
  assert.deepStrictEqual(readJson(path.join(root, '.mcp.json')), { other: { command: 'other-bin' } });
  assert.ok(readJson(path.join(root, '.perplexicode', 'settings.local.json')).bare, 'settings files are never treated as bare server maps');
});

// ---------------------------------------------------------------------------------------------
// stdio transport against the real test server
// ---------------------------------------------------------------------------------------------

test('mcp stdio: connect, list tools/resources/prompts, call tools, read resources, system prompt section', async () => {
  const { root, home } = workspace();
  const spawnLog = path.join(root, 'spawns.log');
  const registry = new McpRegistry({ cwd: root, home, extraConfigs: [stdioConfig('test', {}, { MCP_SPAWN_LOG: spawnLog, MCP_NOISY: '1' })] });
  try {
    assert.strictEqual(registry.hasServers(), true);
    assert.strictEqual(registry.getStates()[0].status, 'disconnected');
    const states = await registry.connectAll();
    assert.strictEqual(states.length, 1);
    const [state] = states;
    assert.strictEqual(state.status, 'connected', state.error);
    assert.deepStrictEqual(state.serverInfo, { name: 'pcode-test-mcp', version: '1.2.3' });
    const names = state.tools.map((tool) => tool.name);
    assert.ok(names.includes('echo') && names.includes('weird name.v2'), names.join(','));
    const weird = state.tools.find((tool) => tool.name === 'weird name.v2')!;
    assert.strictEqual(weird.qualifiedName, 'mcp__test__weird_name_v2');
    assert.strictEqual(state.resources.length, 2);
    assert.strictEqual(state.prompts[0].name, 'review');
    assert.strictEqual(state.prompts[0].arguments?.[0].required, true);

    const echo = await registry.callTool('test', 'echo', { text: 'hi' });
    assert.deepStrictEqual({ content: echo.content, isError: echo.isError }, { content: 'echo: hi', isError: false });
    const sum = await registry.callTool('test', 'add', { a: 2, b: 3 });
    assert.strictEqual(sum.content, '5');
    const failed = await registry.callTool('test', 'fail', { reason: 'test' });
    assert.strictEqual(failed.isError, true);
    assert.strictEqual(failed.content, 'boom: test');
    await assert.rejects(registry.callTool('test', 'does_not_exist', {}), /Unknown tool: does_not_exist/);
    const viaSanitised = await registry.callTool('test', 'weird_name_v2', {});
    assert.strictEqual(viaSanitised.content, 'weird ok', 'sanitised tool names resolve to the real tool name');
    const mixed = await registry.callTool('test', 'image', {});
    assert.strictEqual(mixed.content, '[MCP Image: image/png]\ncaption\nembedded');

    assert.strictEqual(await registry.readResource('test', 'test://greeting'), 'hello from resource');
    assert.match(await registry.readResource('test', 'test://blob'), /Binary resource test:\/\/blob \(application\/octet-stream\), 8 base64 chars/);
    await assert.rejects(registry.readResource('test', 'test://missing'), /Resource not found/);
    const resources = await registry.listResources();
    assert.deepStrictEqual(resources.map((resource) => resource.uri), ['test://greeting', 'test://blob']);
    assert.strictEqual(await registry.getPrompt('test', 'review', { file: 'a.ts' }), 'Please review a.ts');

    const found = registry.findTool('mcp__test__echo');
    assert.strictEqual(found?.tool.name, 'echo');
    assert.strictEqual(registry.findTool('mcp__other__echo'), undefined);
    assert.strictEqual(registry.findTool('test', 'weird_name_v2')?.tool.name, 'weird name.v2');

    const section = registry.formatSystemPromptSection();
    assert.match(section, /## MCP Server: test \(stdio\)/);
    assert.match(section, /- echo \[mcp__test__echo\] \(params: text\*\): Echo text back/);
    assert.match(section, /- add \[mcp__test__add\] \(params: a\*, b\*\)/);
    assert.match(section, /Resources:\n- test:\/\/greeting \(Greeting\): A friendly greeting/);

    await registry.closeAll();
    assert.strictEqual(registry.getStates()[0].status, 'disconnected');
    assert.strictEqual(registry.formatSystemPromptSection(), '', 'disconnected servers are not advertised');
    // Calls after closeAll reconnect transparently.
    const again = await registry.callTool('test', 'echo', { text: 'again' });
    assert.strictEqual(again.content, 'echo: again');
    assert.strictEqual(fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length, 2, 'one process per connection');
  } finally {
    await registry.closeAll();
  }
});

test('mcp stdio: env expansion, cwd, roots/list + ping from the server, list_changed refresh, Content-Length framing', async () => {
  const { root, home } = workspace({ 'tools/.keep': '' });
  const registry = new McpRegistry({
    cwd: root,
    home,
    env: { ...process.env, SECRET_FROM_ENV: 'shh' },
    extraConfigs: [stdioConfig('test', { cwd: 'tools' }, { MCP_ASK_ROOTS: '1', TEST_TOKEN: '${SECRET_FROM_ENV}' })],
  });
  try {
    await registry.connectAll();
    assert.strictEqual(registry.getStates()[0].status, 'connected', registry.getStates()[0].error);
    assert.strictEqual((await registry.callTool('test', 'env', {})).content, 'shh', 'server env is expanded from the registry env');
    assert.strictEqual(fs.realpathSync((await registry.callTool('test', 'cwd', {})).content), fs.realpathSync(path.join(root, 'tools')));
    // The client answered roots/list (and ping) instead of ignoring server → client requests.
    const roots = JSON.parse((await registry.callTool('test', 'roots', {})).content) as Array<{ uri: string; name: string }>;
    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0].uri.startsWith('file://'), roots[0].uri);
    assert.ok(roots[0].uri.endsWith(path.basename(root)), roots[0].uri);

    assert.ok(!registry.getAllTools().some((tool) => tool.name === 'dynamic'));
    await registry.callTool('test', 'add_tool', {});
    for (let i = 0; i < 50 && !registry.getAllTools().some((tool) => tool.name === 'dynamic'); i += 1) await sleep(20);
    assert.ok(registry.getAllTools().some((tool) => tool.name === 'dynamic'), 'tools/list_changed re-reads the tool list');
  } finally {
    await registry.closeAll();
  }

  const framed = new McpRegistry({ cwd: root, home, extraConfigs: [stdioConfig('framed', {}, { MCP_FRAMING: 'content-length' })] });
  try {
    const [state] = await framed.connectAll();
    assert.strictEqual(state.status, 'connected', state.error);
    assert.strictEqual((await framed.callTool('framed', 'echo', { text: 'lsp' })).content, 'echo: lsp');
  } finally {
    await framed.closeAll();
  }
});

test('mcp stdio: failures are isolated per server (missing binary, crash with stderr, init timeout, slow tool) and connects are deduplicated', async () => {
  const { root, home } = workspace();
  const spawnLog = path.join(root, 'spawns.log');
  const logs: string[] = [];
  const config = JSON.stringify({
    mcpServers: {
      missing: { command: path.join(root, 'definitely-not-installed-bin') },
      crash: { command: process.execPath, args: [SERVER_SCRIPT], env: { MCP_EXIT_IMMEDIATELY: '1' } },
      hang: { command: process.execPath, args: [SERVER_SCRIPT], env: { MCP_HANG_INIT: '1' }, timeout: 1 },
      ok: { command: process.execPath, args: [SERVER_SCRIPT], env: { MCP_SPAWN_LOG: spawnLog }, timeout: 1 },
      off: { command: 'never-started', disabled: true },
    },
  });
  const registry = new McpRegistry({ cwd: root, home, extraConfigs: [config], log: (line) => logs.push(line) });
  try {
    // Parallel connects to the same server must share one process.
    const [a, b, c] = await Promise.all([registry.connectServer('ok'), registry.connectServer('ok'), registry.ensureConnected().then(() => registry.getStates().find((s) => s.config.name === 'ok')!)]);
    assert.strictEqual(a.status, 'connected', a.error);
    assert.strictEqual(b.status, 'connected');
    assert.strictEqual(c.status, 'connected');
    const states = Object.fromEntries(registry.getStates().map((state) => [state.config.name, state]));
    assert.strictEqual(states.missing.status, 'error');
    assert.match(states.missing.error || '', /failed to start|ENOENT/);
    assert.strictEqual(states.crash.status, 'error');
    assert.match(states.crash.error || '', /exited \(3\).*TEST_API_KEY is not set/);
    assert.strictEqual(states.hang.status, 'error');
    assert.match(states.hang.error || '', /timed out after 1s/);
    assert.strictEqual(states.off.status, 'disabled');
    assert.strictEqual(fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length, 1, 'concurrent connects spawned one process');
    assert.ok(logs.some((line) => line.includes('[mcp] crash:')), logs.join('|'));

    // A broken server does not block the healthy one, and failed servers are not retried on ensureConnected.
    assert.strictEqual((await registry.callTool('ok', 'echo', { text: 'x' })).content, 'echo: x');
    await registry.ensureConnected();
    assert.strictEqual(fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length, 1);
    assert.strictEqual(registry.formatSystemPromptSection().includes('MCP Server: ok'), true);
    assert.strictEqual(registry.formatSystemPromptSection().includes('crash'), false);

    // Per-request timeout (timeout: 1 second) for a slow tool.
    await assert.rejects(registry.callTool('ok', 'slow', {}), /timed out after 1s/);
    // Unknown server / disabled server errors are explicit.
    await assert.rejects(registry.callTool('nope', 'echo', {}), /Unknown MCP server 'nope'/);
    await assert.rejects(registry.callTool('off', 'echo', {}), /not connected/);
    await assert.rejects(registry.connectServer('ghost'), /Unknown MCP server 'ghost'/);
  } finally {
    await registry.closeAll();
  }
});

test('mcp trust: project/local stdio servers wait for trust, user/cli/http servers do not; reloadConfigs follows file changes', async () => {
  const { root, home } = workspace();
  write(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { project: { command: process.execPath, args: [SERVER_SCRIPT] } } }));
  write(path.join(home, '.perplexicode', 'mcp.json'), JSON.stringify({ mcpServers: { user: { command: process.execPath, args: [SERVER_SCRIPT] } } }));
  const httpServer = await startHttpMcp();
  write(path.join(root, '.perplexicode', 'settings.local.json'), JSON.stringify({ mcpServers: { remote: { url: httpServer.url } } }));
  const registry = new McpRegistry({ cwd: root, home, trustProject: false });
  try {
    const states = Object.fromEntries((await registry.connectAll()).map((state) => [state.config.name, state]));
    assert.strictEqual(states.project.status, 'untrusted');
    assert.match(states.project.error || '', /trusted/);
    assert.strictEqual(states.user.status, 'connected', states.user.error);
    assert.strictEqual(states.remote.status, 'connected', `${states.remote.error}`);
    await assert.rejects(registry.callTool('project', 'echo', { text: 'x' }), /not connected/);

    registry.setTrustProject(true);
    await registry.connectAll();
    assert.strictEqual(registry.getStates().find((state) => state.config.name === 'project')!.status, 'connected');
    assert.strictEqual((await registry.callTool('project', 'echo', { text: 'now' })).content, 'echo: now');

    // Removing the project file drops the server (and closes its process); adding a new one shows up as disconnected.
    fs.rmSync(path.join(root, '.mcp.json'));
    write(path.join(root, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: { fresh: { command: process.execPath, args: [SERVER_SCRIPT] } } }));
    const reloaded = registry.reloadConfigs().map((config) => config.name).sort();
    assert.deepStrictEqual(reloaded, ['fresh', 'remote', 'user']);
    const after = Object.fromEntries(registry.getStates().map((state) => [state.config.name, state.status]));
    assert.deepStrictEqual(after, { user: 'connected', remote: 'connected', fresh: 'disconnected' });
  } finally {
    await registry.closeAll();
    httpServer.close();
  }
});

// ---------------------------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------------------------

function startHttpMcp(options: { auth?: string; sse?: boolean; fail?: boolean } = {}): Promise<{ url: string; close: () => void; requests: Array<{ method: string; headers: http.IncomingHttpHeaders; body: any }> }> {
  const requests: Array<{ method: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: body?.method, headers: req.headers, body });
      if (options.auth && req.headers.authorization !== options.auth) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (options.fail) {
        res.writeHead(500).end('internal failure');
        return;
      }
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      switch (body.method) {
        case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'http-test', version: '0.1' } }; break;
        case 'tools/list': result = { tools: [{ name: 'http_echo', description: 'Echo over HTTP', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }; break;
        case 'tools/call': result = body.params.name === 'http_echo' ? { content: [{ type: 'text', text: `http: ${body.params.arguments?.text ?? ''}` }] } : { isError: true, content: [{ type: 'text', text: 'unknown' }] }; break;
        case 'resources/list': result = { resources: [] }; break;
        case 'prompts/list': result = { prompts: [] }; break;
        default:
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `no ${body.method}` } }));
          return;
      }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      const headers: Record<string, string> = body.method === 'initialize' ? { 'mcp-session-id': 'sess-42' } : {};
      if (options.sse) {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${reply}\n\n`);
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(reply);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => server.close(), requests });
  }));
}

test('mcp http: JSON and SSE replies, custom headers, session id, HTTP 401/500 and JSON-RPC errors', async () => {
  const { root, home } = workspace();
  const json = await startHttpMcp({ auth: 'Bearer t0ken' });
  const sse = await startHttpMcp({ sse: true });
  const failing = await startHttpMcp({ fail: true });
  const config = JSON.stringify({
    mcpServers: {
      json: { type: 'http', url: json.url, headers: { Authorization: 'Bearer ${API_TOKEN}' } },
      noauth: { type: 'http', url: json.url },
      sse: { type: 'sse', url: sse.url },
      broken: { url: failing.url },
      unreachable: { url: 'http://127.0.0.1:9/mcp' },
    },
  });
  const registry = new McpRegistry({ cwd: root, home, extraConfigs: [config], env: { ...process.env, API_TOKEN: 't0ken' } });
  try {
    const states = Object.fromEntries((await registry.connectAll()).map((state) => [state.config.name, state]));
    assert.strictEqual(states.json.status, 'connected', states.json.error);
    assert.strictEqual(states.json.serverInfo?.name, 'http-test');
    assert.strictEqual(states.json.tools[0].qualifiedName, 'mcp__json__http_echo');
    assert.strictEqual(states.noauth.status, 'error');
    assert.match(states.noauth.error || '', /HTTP 401/);
    assert.strictEqual(states.sse.status, 'connected', states.sse.error);
    assert.strictEqual(states.broken.status, 'error');
    assert.match(states.broken.error || '', /HTTP 500/);
    assert.strictEqual(states.unreachable.status, 'error');

    assert.strictEqual((await registry.callTool('json', 'http_echo', { text: 'hello' })).content, 'http: hello');
    assert.strictEqual((await registry.callTool('sse', 'http_echo', { text: 'stream' })).content, 'http: stream');
    await assert.rejects(registry.readResource('json', 'x://y'), /no resources\/read/);

    const authed = json.requests.filter((request) => request.headers.authorization === 'Bearer t0ken');
    assert.ok(authed.length >= 4, 'every request carries the configured header');
    const afterInit = json.requests.filter((request) => request.method !== 'initialize' && request.headers.authorization === 'Bearer t0ken');
    assert.ok(afterInit.every((request) => request.headers['mcp-session-id'] === 'sess-42'), 'Mcp-Session-Id from initialize is echoed on later requests');
    assert.ok(json.requests.some((request) => request.method === 'notifications/initialized'), 'initialized notification is sent');
  } finally {
    await registry.closeAll();
    json.close();
    sse.close();
    failing.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Parser, permissions, argument parsing
// ---------------------------------------------------------------------------------------------

test('toolParser: use_mcp_tool / access_mcp_resource / list_mcp_resources / web_fetch / glob_files and direct <mcp__server__tool> tags', () => {
  const use = parseAssistantMessage('<use_mcp_tool>\n<server_name>github</server_name>\n<tool_name>get_issue</tool_name>\n<arguments>{"owner": "a", "repo": "b", "number": 7}</arguments>\n</use_mcp_tool>');
  assert.strictEqual(use.tool?.name, 'use_mcp_tool');
  assert.strictEqual(use.tool?.params.server_name, 'github');
  assert.deepStrictEqual(JSON.parse(use.tool!.params.arguments), { owner: 'a', repo: 'b', number: 7 });

  const direct = parseAssistantMessage('Calling the tool.\n<mcp__github__get_issue>\n<owner>a</owner>\n<repo>b</repo>\n<number>7</number>\n<draft>true</draft>\n<labels>["x","y"]</labels>\n</mcp__github__get_issue>');
  assert.strictEqual(direct.tool?.name, 'use_mcp_tool');
  assert.strictEqual(direct.tool?.params.server_name, 'github');
  assert.strictEqual(direct.tool?.params.tool_name, 'get_issue');
  assert.deepStrictEqual(JSON.parse(direct.tool!.params.arguments), { owner: 'a', repo: 'b', number: 7, draft: true, labels: ['x', 'y'] });
  assert.strictEqual(direct.text, 'Calling the tool.');

  const directJson = parseAssistantMessage('<mcp__srv__tool>\n<arguments>{"q": "<b>bold</b>"}</arguments>\n</mcp__srv__tool>');
  assert.deepStrictEqual(JSON.parse(directJson.tool!.params.arguments), { q: '<b>bold</b>' });
  const directBare = parseAssistantMessage('<mcp__srv__tool>{"n": 1}</mcp__srv__tool>');
  assert.deepStrictEqual(JSON.parse(directBare.tool!.params.arguments), { n: 1 });
  const directEmpty = parseAssistantMessage('<mcp__srv__tool></mcp__srv__tool>');
  assert.strictEqual(directEmpty.tool?.params.arguments, '{}');
  assert.strictEqual(parseAssistantMessage('<mcp__srv__tool><q>partial', true).tool?.partial, true);

  const resource = parseAssistantMessage('<access_mcp_resource><server_name>files</server_name><uri>file:///tmp/a.txt</uri></access_mcp_resource>');
  assert.strictEqual(resource.tool?.name, 'access_mcp_resource');
  assert.strictEqual(resource.tool?.params.uri, 'file:///tmp/a.txt');
  const list = parseAssistantMessage('<list_mcp_resources></list_mcp_resources>');
  assert.strictEqual(list.tool?.name, 'list_mcp_resources');
  const fetch = parseAssistantMessage('<web_fetch><url>https://example.com/docs?x=1&y=2</url></web_fetch>');
  assert.strictEqual(fetch.tool?.params.url, 'https://example.com/docs?x=1&y=2');
  const glob = parseAssistantMessage('<glob_files><path>src</path><pattern>**/*.test.ts</pattern></glob_files>\n<read_file><path>a.ts</path></read_file>');
  assert.strictEqual(glob.tool?.name, 'glob_files');
  assert.strictEqual(glob.readBatch?.length, 1, 'glob_files is read-only and batches with other reads');
  const sr = parseAssistantMessage('<search_and_replace><path>a.ts</path><search>foo</search><replace>bar</replace><use_regex>false</use_regex></search_and_replace>');
  assert.strictEqual(sr.tool?.name, 'search_and_replace');
  assert.strictEqual(sr.tool?.params.replace, 'bar');

  assert.strictEqual(coerceMcpArgument(' 42 '), 42);
  assert.strictEqual(coerceMcpArgument('4.5'), 4.5);
  assert.strictEqual(coerceMcpArgument('true'), true);
  assert.strictEqual(coerceMcpArgument('null'), null);
  assert.strictEqual(coerceMcpArgument('007'), 7);
  assert.strictEqual(coerceMcpArgument('12345678901234567890'), '12345678901234567890', 'huge numbers stay strings');
  assert.deepStrictEqual(coerceMcpArgument('{"a": [1]}'), { a: [1] });
  assert.strictEqual(coerceMcpArgument('{not json'), '{not json');
  assert.strictEqual(coerceMcpArgument('plain text'), 'plain text');
});

test('task: parseMcpArgumentsParam accepts strict and loose JSON objects only', () => {
  assert.deepStrictEqual(parseMcpArgumentsParam(undefined), {});
  assert.deepStrictEqual(parseMcpArgumentsParam('  '), {});
  assert.deepStrictEqual(parseMcpArgumentsParam('{"a": 1}'), { a: 1 });
  assert.deepStrictEqual(parseMcpArgumentsParam("{'a': 'it\\'s', b: [1, 2,], }"), { a: "it's", b: [1, 2] });
  assert.deepStrictEqual(parseMcpArgumentsParam('{query: "x: y", limit: 5}'), { query: 'x: y', limit: 5 });
  assert.strictEqual(parseMcpArgumentsParam('[1, 2]'), null, 'arrays are not argument objects');
  assert.strictEqual(parseMcpArgumentsParam('"text"'), null);
  assert.strictEqual(parseMcpArgumentsParam('{broken'), null);
});

test('permissions: mcp__server__tool, mcp__server, mcp, WebFetch(domain:) rules and plan mode', () => {
  const root = tmp('perm');
  const perm = (overrides: Partial<PermissionConfig> = {}): PermissionConfig => ({ allow: [], ask: [], deny: [], mode: 'default', protectSecrets: true, ...overrides });
  const call = (server: string, tool: string) => ({ name: 'use_mcp_tool', params: { server_name: server, tool_name: tool, arguments: '{}' } });
  const read = (server: string, uri: string) => ({ name: 'access_mcp_resource', params: { server_name: server, uri } });
  const fetch = (url: string) => ({ name: 'web_fetch', params: { url } });
  // No verdict (`{}`) means the gate defers to the agent's auto-approve settings, i.e. the tool asks unless autoApprove.mcp/web is on.
  const decide = (config: PermissionConfig, tool: { name: string; params: Record<string, string> }) => evaluatePermission(config, tool, root).decision ?? 'defer';

  assert.strictEqual(decide(perm(), call('github', 'get_issue')), 'defer', 'MCP tools have no implicit allow');
  assert.strictEqual(decide(perm({ allow: ['mcp__github__get_issue'] }), call('github', 'get_issue')), 'allow');
  assert.strictEqual(decide(perm({ allow: ['mcp__github__get_issue'] }), call('github', 'create_issue')), 'defer');
  assert.strictEqual(decide(perm({ allow: ['mcp__github'] }), call('github', 'create_issue')), 'allow', 'server rule covers every tool');
  assert.strictEqual(decide(perm({ allow: ['mcp__github__*'] }), call('github', 'anything')), 'allow');
  assert.strictEqual(decide(perm({ allow: ['mcp__github'] }), read('github', 'repo://x')), 'allow', 'server rule also covers resources');
  assert.strictEqual(decide(perm({ allow: ['mcp__github__get_issue'] }), read('github', 'repo://x')), 'defer', 'a tool rule does not cover resources');
  assert.strictEqual(decide(perm({ allow: ['mcp__github'] }), call('gitlab', 'x')), 'defer');
  assert.strictEqual(decide(perm({ allow: ['mcp'] }), call('any', 'thing')), 'allow');
  assert.strictEqual(decide(perm({ allow: ['mcp'] }), { name: 'list_mcp_resources', params: {} }), 'allow');
  assert.strictEqual(decide(perm({ allow: ['mcp'], deny: ['mcp__github__delete_repo'] }), call('github', 'delete_repo')), 'deny', 'deny beats allow');
  assert.strictEqual(decide(perm({ allow: ['mcp__my_server__tool'] }), call('my server', 'tool')), 'allow', 'rule names use the sanitised server name');
  assert.strictEqual(decide(perm({ allow: ['mcp__my-server__tool'] }), call('my-server', 'tool')), 'allow');
  assert.strictEqual(decide(perm({ allow: ['mcp__my-server__tool'] }), call('my server', 'tool')), 'defer', 'hyphen and space are different servers');
  assert.strictEqual(decide(perm({ allow: ['mcp__test__weird_name_v2'] }), call('test', 'weird name.v2')), 'allow');
  // Claude Code function-style spelling.
  assert.strictEqual(decide(perm({ allow: ['mcp(github)'] }), call('github', 'x')), 'allow');
  assert.strictEqual(decide(perm({ allow: ['mcp(github__get_issue)'] }), call('github', 'get_issue')), 'allow');
  assert.strictEqual(decide(perm({ allow: ['mcp(github:get_issue)'] }), call('github', 'other')), 'defer');

  // Plan mode: MCP tools may have side effects, so they are denied unless explicitly allowed.
  assert.strictEqual(decide(perm({ mode: 'plan' }), call('github', 'get_issue')), 'deny');
  assert.strictEqual(decide(perm({ mode: 'plan', allow: ['mcp__github__get_issue'] }), call('github', 'get_issue')), 'allow');
  assert.strictEqual(decide(perm({ mode: 'bypassPermissions' }), call('github', 'get_issue')), 'allow');

  // WebFetch rules.
  assert.strictEqual(decide(perm(), fetch('https://docs.example.com/a')), 'defer');
  assert.strictEqual(decide(perm({ allow: ['WebFetch(domain:example.com)'] }), fetch('https://docs.example.com/a')), 'allow', 'subdomains match');
  assert.strictEqual(decide(perm({ allow: ['WebFetch(domain:example.com)'] }), fetch('https://example.com.evil.net/a')), 'defer');
  assert.strictEqual(decide(perm({ allow: ['WebFetch(domain:example.com)'] }), fetch('https://notexample.com/')), 'defer');
  assert.strictEqual(decide(perm({ allow: ['WebFetch'] }), fetch('https://anything.io/')), 'allow');
  assert.strictEqual(decide(perm({ allow: ['WebFetch'], deny: ['WebFetch(domain:internal.corp)'] }), fetch('https://wiki.internal.corp/x')), 'deny');
  assert.strictEqual(decide(perm({ mode: 'plan', allow: ['WebFetch'] }), fetch('https://a.b/')), 'allow', 'reading the web is fine in plan mode');
});

// ---------------------------------------------------------------------------------------------
// New built-in tools
// ---------------------------------------------------------------------------------------------

test('tools: glob_files, search_and_replace (literal $ handling, regex, ranges), html → text, web_fetch with redirects', async () => {
  const { root } = workspace({
    'src/a.ts': 'export const a = 1;',
    'src/deep/b.test.ts': 'test',
    'src/deep/c.ts': 'c',
    'node_modules/dep/index.ts': 'ignored',
    '.hidden/secret.ts': 'ignored',
    'README.md': '# hi',
  });
  const host = new NodeAgentHost(root);
  const all = (await globFilesTool(host, '.', '**/*.ts')).split('\n');
  assert.deepStrictEqual(all.sort(), ['src/a.ts', 'src/deep/b.test.ts', 'src/deep/c.ts'], 'node_modules and dot-dirs are skipped');
  assert.deepStrictEqual((await globFilesTool(host, 'src', '*.test.ts')).split('\n'), ['src/deep/b.test.ts'], 'basename patterns match at any depth');
  assert.strictEqual(await globFilesTool(host, '.', '*.py'), 'No matching files found.');
  assert.match(await globFilesTool(host, '.', '**/*', 2), /\[Showing 2 of 4 matching files\.\]/);
  await assert.rejects(globFilesTool(host, 'missing-dir', '*'), /Directory not found/);

  const literal = searchAndReplaceContent('price = cost\ncost = 2', { search: 'cost', replace: '$total$&' });
  assert.deepStrictEqual(literal, { content: 'price = $total$&\n$total$& = 2', replacements: 2 }, 'literal mode never interprets $& / $1');
  const regex = searchAndReplaceContent('a1 b2 c3', { search: '([a-z])(\\d)', replace: '$2$1', useRegex: true });
  assert.deepStrictEqual(regex, { content: '1a 2b 3c', replacements: 3 });
  const ranged = searchAndReplaceContent('x\nx\nx\nx', { search: 'x', replace: 'y', startLine: 2, endLine: 3 });
  assert.deepStrictEqual(ranged, { content: 'x\ny\ny\nx', replacements: 2 });
  const ci = searchAndReplaceContent('Foo foo FOO', { search: 'foo', replace: 'bar', ignoreCase: true });
  assert.strictEqual(ci.content, 'bar bar bar');
  const crlf = searchAndReplaceContent('a\r\nb\r\n', { search: 'b', replace: 'c' });
  assert.strictEqual(crlf.content, 'a\r\nc\r\n', 'CRLF files keep their line endings');
  const multi = searchAndReplaceContent('one two three', { operations: [{ search: 'one', replace: '1' }, { search: 'three', replace: '3' }] });
  assert.deepStrictEqual(multi, { content: '1 two 3', replacements: 2 });
  assert.throws(() => searchAndReplaceContent('abc', { search: 'zzz', replace: 'y' }), /No matches found/);
  assert.throws(() => searchAndReplaceContent('abc', { search: '', replace: 'y' }), /requires a non-empty/);
  assert.throws(() => searchAndReplaceContent('abc', { search: '(', replace: 'y', useRegex: true }), /Invalid regular expression/);

  const html = '<html><head><title>T</title><style>.x{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Hello&nbsp;<b>world</b> &amp; friends</p><ul><li>one</li><li>two</li></ul><a href="https://x.y/z">link</a><pre>code\nblock</pre></body></html>';
  const text = htmlToReadableText(html);
  assert.ok(!text.includes('alert(1)') && !text.includes('.x{}'), text);
  assert.match(text, /# Title/);
  assert.match(text, /Hello world & friends/);
  assert.match(text, /- one\n- two/);
  assert.match(text, /link \(https:\/\/x\.y\/z\)/);
  assert.match(text, /```\ncode\nblock\n```/);

  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/page' }).end();
    } else if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body><h1>Fetched</h1><p>ok</p></body></html>');
    } else if (req.url === '/data.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1,"b":[1,2]}');
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(5000));
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const fetched = await webFetchTool(`${base}/start`);
    assert.match(fetched, /# Fetched\s+ok/, 'redirects are followed and HTML is converted');
    assert.strictEqual(await webFetchTool(`${base}/data.json`), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    await assert.rejects(webFetchTool(`${base}/missing`), /HTTP 404/);
    await assert.rejects(webFetchTool(`${base}/loop`), /Too many redirects/);
    await assert.rejects(webFetchTool('ftp://example.com/x'), /requires an http/);
    const truncated = await webFetchTool(`${base}/big`, { maxChars: 100 });
    assert.ok(truncated.startsWith('x'.repeat(100)));
    assert.match(truncated, /\[Content truncated at 100 chars/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(webFetchTool(`${base}/page`, { signal: controller.signal }), /Aborted|aborted/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Agent loop end-to-end (real registry + stdio server, scripted model)
// ---------------------------------------------------------------------------------------------

test('session: MCP tools end-to-end — system prompt section, use_mcp_tool, direct tag, resources, errors, permissions', async () => {
  const { root, home } = workspace({ 'a.txt': 'x' });
  const registry = new McpRegistry({ cwd: root, home, extraConfigs: [stdioConfig('test')] });
  const provider = new ScriptedProvider([
    (request) => {
      assert.match(request.fullPrompt, /# Connected MCP Servers/, 'the system prompt advertises connected servers');
      assert.match(request.fullPrompt, /mcp__test__echo/);
      assert.match(request.fullPrompt, /## use_mcp_tool/);
      return '<use_mcp_tool>\n<server_name>test</server_name>\n<tool_name>echo</tool_name>\n<arguments>{"text": "hello"}</arguments>\n</use_mcp_tool>';
    },
    (request) => {
      assert.match(lastUser(request), /echo: hello/);
      return '<mcp__test__add>\n<a>2</a>\n<b>40</b>\n</mcp__test__add>';
    },
    (request) => {
      assert.match(lastUser(request), /\b42\b/, 'typed arguments reach the server as numbers');
      return '<mcp__test__fail><reason>bad input</reason></mcp__test__fail>';
    },
    (request) => {
      assert.match(lastUser(request), /\[ERROR\] The MCP tool reported an error:\s*boom: bad input/);
      return '<use_mcp_tool><server_name>test</server_name><tool_name>echo</tool_name><arguments>not json at all</arguments></use_mcp_tool>';
    },
    (request) => {
      assert.match(lastUser(request), /must be a JSON object/);
      return '<list_mcp_resources></list_mcp_resources>';
    },
    (request) => {
      assert.match(lastUser(request), /test:\/\/greeting \[test\] Greeting \(text\/plain\): A friendly greeting/);
      return '<access_mcp_resource><server_name>test</server_name><uri>test://greeting</uri></access_mcp_resource>';
    },
    (request) => {
      assert.match(lastUser(request), /hello from resource/);
      return '<use_mcp_tool><server_name>ghost</server_name><tool_name>echo</tool_name><arguments>{}</arguments></use_mcp_tool>';
    },
    (request) => {
      assert.match(lastUser(request), /Unknown MCP server 'ghost'/);
      return '<use_mcp_tool><server_name>test</server_name><tool_name>weird name.v2</tool_name><arguments>{}</arguments></use_mcp_tool>';
    },
    (request) => {
      assert.match(lastUser(request), /\[DENIED\]|denied|not permitted/i, 'the deny rule for the sanitised tool name blocks the real tool');
      return '<attempt_completion><result>MCP round trip done.</result></attempt_completion>';
    },
  ]);
  const { core, events, asks } = session({ root, home, provider, mcp: registry, allow: ['mcp__test__echo', 'mcp__test__add', 'mcp__test__fail', 'mcp'], deny: ['mcp__test__weird_name_v2'] });
  try {
    const result = await core.run('use the mcp server');
    assert.strictEqual(result.result, 'MCP round trip done.');
    assert.ok(!asks.some((ask) => ask.ask?.kind === 'tool'), `allowed MCP tools must not prompt: ${asks.map((a) => a.ask?.kind).join(',')}`);
    assert.ok(events.some((event) => event.type === 'denied' && event.tool === 'use_mcp_tool'), 'denied event for the blocked tool');
    const toolMessages = core.currentTask!.uiMessages.filter((message) => message.tool?.server === 'test');
    assert.ok(toolMessages.length >= 4, `tool cards carry the MCP server name (${toolMessages.length})`);
    assert.ok(toolMessages.some((message) => message.status === 'error' && /boom/.test(message.tool?.content || '')), 'isError results render as failed cards');
  } finally {
    await registry.closeAll();
  }
});

test('session: without servers the MCP tools are hidden and calls fail with guidance; asks fall back to the approval prompt', async () => {
  const { root, home } = workspace();
  const stub: McpToolProvider = {
    hasServers: () => false,
    ensureConnected: async () => undefined,
    formatSystemPromptSection: () => '',
    callTool: async () => { throw new Error('never'); },
    readResource: async () => { throw new Error('never'); },
    listResources: async () => [],
  };
  const provider = new ScriptedProvider([
    (request) => {
      assert.ok(!/## use_mcp_tool/.test(request.fullPrompt), 'MCP tools are not advertised without servers');
      return '<use_mcp_tool><server_name>x</server_name><tool_name>y</tool_name><arguments>{}</arguments></use_mcp_tool>';
    },
    (request) => {
      assert.match(lastUser(request), /No MCP servers are configured/);
      return '<attempt_completion><result>no mcp</result></attempt_completion>';
    },
  ]);
  const { core } = session({ root, home, provider, mcp: stub });
  assert.strictEqual((await core.run('try mcp')).result, 'no mcp');

  // With a configured server but no allow rule, the tool asks; headless answers "no" and the model adapts.
  const asking: McpToolProvider = {
    hasServers: () => true,
    ensureConnected: async () => undefined,
    formatSystemPromptSection: () => '# Connected MCP Servers (Model Context Protocol)\n## MCP Server: stub (stdio)\nTools:\n- ping [mcp__stub__ping]',
    callTool: async () => ({ content: 'pong', isError: false }),
    readResource: async () => 'resource',
    listResources: async () => [],
  };
  const provider2 = new ScriptedProvider([
    '<use_mcp_tool><server_name>stub</server_name><tool_name>ping</tool_name><arguments>{}</arguments></use_mcp_tool>',
    (request) => {
      assert.match(lastUser(request), /not permitted|denied/i);
      return '<attempt_completion><result>asked and refused</result></attempt_completion>';
    },
  ]);
  const second = session({ root, home, provider: provider2, mcp: asking });
  assert.strictEqual((await second.core.run('ping')).result, 'asked and refused');
  assert.ok(second.asks.some((ask) => ask.ask?.kind === 'tool' && ask.tool?.name === 'use_mcp_tool' && ask.tool?.server === 'stub'), 'unapproved MCP tools prompt');

  // autoApprove.mcp approves without a rule; plan mode still blocks.
  const provider3 = new ScriptedProvider([
    '<use_mcp_tool><server_name>stub</server_name><tool_name>ping</tool_name><arguments>{}</arguments></use_mcp_tool>',
    (request) => {
      assert.match(lastUser(request), /pong/);
      return '<attempt_completion><result>auto approved</result></attempt_completion>';
    },
  ]);
  const third = session({ root, home, provider: provider3, mcp: asking, settings: { autoApprove: { ...agentSettings().autoApprove, mcp: true } } });
  assert.strictEqual((await third.core.run('ping')).result, 'auto approved');
  assert.ok(!third.asks.some((ask) => ask.ask?.kind === 'tool'));

  const provider4 = new ScriptedProvider([
    '<use_mcp_tool><server_name>stub</server_name><tool_name>ping</tool_name><arguments>{}</arguments></use_mcp_tool>',
    (request) => {
      assert.match(lastUser(request), /DENIED|plan/i);
      return '<attempt_completion><result>plan blocked</result></attempt_completion>';
    },
  ]);
  const fourth = session({ root, home, provider: provider4, mcp: asking, permissionMode: 'plan', settings: { autoApprove: { ...agentSettings().autoApprove, mcp: true } } });
  assert.strictEqual((await fourth.core.run('ping')).result, 'plan blocked');
  assert.ok(fourth.events.some((event) => event.type === 'denied' && event.tool === 'use_mcp_tool'));
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function runCli(args: string[], env: Record<string, string>, cwd: string, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = path.resolve(process.cwd(), 'out', 'cli.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('cli: argument parsing for --compute, --mcp-config, --strict-mcp-config, -- passthrough, scope/transport/env/header flags', () => {
  const opts = parseArgs(['-p', 'do it', '--compute', 'Computer', '--mcp-config', 'a.json', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--no-mcp']);
  assert.strictEqual(opts.computeMode, 'computer');
  assert.deepStrictEqual(opts.mcpConfigs, ['a.json', '{"mcpServers":{}}']);
  assert.strictEqual(opts.strictMcpConfig, true);
  assert.strictEqual(opts.noMcp, true);
  assert.strictEqual(parseArgs(['--compute=ultra']).computeMode, 'ultra');
  assert.strictEqual(parseArgs(['--compute-mode', 'deep-research']).computeMode, 'research');
  assert.throws(() => parseArgs(['--compute', 'bogus']), /--compute must be one of search, computer/);
  assert.throws(() => parseArgs(['--transport', 'carrier-pigeon']), /--transport must be/);
  assert.throws(() => parseArgs(['--scope', 'galaxy']), /--scope must be/);

  const add = parseArgs(['mcp', 'add', 'srv', '-s', 'user', '-t', 'stdio', '-e', 'A=1', '-e', 'B=x=y', '--', 'npx', '-y', 'some-server', '--port', '1']);
  assert.strictEqual(add.command, 'mcp');
  assert.deepStrictEqual(add.args, ['add', 'srv', 'npx', '-y', 'some-server', '--port', '1'], 'everything after -- is positional even when it looks like flags');
  assert.strictEqual(add.mcpScope, 'user');
  assert.strictEqual(add.mcpTransport, 'stdio');
  assert.deepStrictEqual(add.mcpEnv, ['A=1', 'B=x=y']);
  const remote = parseArgs(['mcp', 'add', 'remote', '-t', 'http', '-H', 'Authorization: Bearer x', 'https://example.com/mcp']);
  assert.deepStrictEqual(remote.args, ['add', 'remote', 'https://example.com/mcp']);
  assert.deepStrictEqual(remote.mcpHeaders, ['Authorization: Bearer x']);
});

test('cli e2e: pcode mcp add/list/get/remove, --compute validation, models shows compute modes, doctor shows MCP', async () => {
  if (!fs.existsSync(path.resolve(process.cwd(), 'out', 'cli.js'))) throw new Error('out/cli.js missing: run npm run build first');
  const { root, home } = workspace({ 'a.txt': 'x' });
  const env = { HOME: home, USERPROFILE: home, PERPLEXICODE_HOME: path.join(home, '.perplexicode') };

  const empty = await runCli(['mcp', 'list'], env, root);
  assert.strictEqual(empty.code, 0, empty.stderr);
  assert.match(empty.stderr, /No MCP servers configured/);
  assert.strictEqual(empty.stdout, '', 'stdout stays machine readable (rows only)');

  const added = await runCli(['mcp', 'add', 'test', '-e', 'TEST_TOKEN=from-cli', '--', process.execPath, SERVER_SCRIPT], env, root);
  assert.strictEqual(added.code, 0, added.stderr + added.stdout);
  assert.match(added.stderr, /test \(stdio, project\)/);
  assert.match(added.stderr, /Project stdio servers start only in trusted folders/);
  const projectConfig = readJson(path.join(root, '.mcp.json'));
  assert.deepStrictEqual(projectConfig.mcpServers.test, { type: 'stdio', command: process.execPath, args: [SERVER_SCRIPT], env: { TEST_TOKEN: 'from-cli' } });

  const userAdded = await runCli(['mcp', 'add', 'remote', '-s', 'user', '-H', 'Authorization: Bearer abc', 'https://example.invalid/mcp'], env, root);
  assert.strictEqual(userAdded.code, 0, userAdded.stderr + userAdded.stdout);
  const userConfig = readJson(path.join(home, '.perplexicode', 'mcp.json'));
  assert.deepStrictEqual(userConfig.mcpServers.remote, { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer abc' } });
  const badTransport = await runCli(['mcp', 'add', 'x', '-t', 'http', '--', 'node', 'server.js'], env, root);
  assert.strictEqual(badTransport.code, 64);
  assert.match(badTransport.stdout + badTransport.stderr, /needs an http\(s\) URL/);
  const badName = await runCli(['mcp', 'add', 'bad name', '--', 'node'], env, root);
  assert.strictEqual(badName.code, 1);

  const list = await runCli(['mcp', 'list'], env, root);
  assert.strictEqual(list.code, 0, list.stderr);
  const rows = list.stdout.trim().split('\n').map((line) => line.split('\t'));
  const testRow = rows.find((row) => row[0] === 'test')!;
  assert.deepStrictEqual(testRow.slice(1, 4), ['stdio', 'project', 'untrusted'], 'an untrusted folder reports project stdio servers as untrusted');
  const remoteRow = rows.find((row) => row[0] === 'remote')!;
  assert.deepStrictEqual(remoteRow.slice(1, 5), ['http', 'user', 'enabled', 'https://example.invalid/mcp']);

  // `get` connects; without trust the project server is skipped, with --trust-project it answers.
  const untrusted = await runCli(['mcp', 'get', 'test'], env, root);
  assert.match(untrusted.stdout + untrusted.stderr, /skipped until project is trusted/);
  const trusted = await runCli(['mcp', 'get', 'test', '--trust-project'], env, root);
  assert.strictEqual(trusted.code, 0, trusted.stderr + trusted.stdout);
  const trustedOut = trusted.stdout + trusted.stderr;
  assert.match(trustedOut, /\d+ tools, 2 resources, 1 prompts/);
  assert.match(trustedOut, /mcp__test__echo: Echo text back/);
  assert.match(trustedOut, /pcode-test-mcp/);
  const unknown = await runCli(['mcp', 'get', 'ghost'], env, root);
  assert.strictEqual(unknown.code, 1);
  assert.match(unknown.stdout + unknown.stderr, /Unknown MCP server 'ghost'/);
  // Inline --mcp-config with --strict-mcp-config ignores the project file entirely.
  const strict = await runCli(['mcp', 'list', '--strict-mcp-config', '--mcp-config', stdioConfig('only')], env, root);
  assert.deepStrictEqual(strict.stdout.trim().split('\n').map((line) => line.split('\t')[0]), ['only']);

  const removed = await runCli(['mcp', 'remove', 'test'], env, root);
  assert.strictEqual(removed.code, 0, removed.stderr);
  assert.ok(!readJson(path.join(root, '.mcp.json')).mcpServers.test);
  const removedAgain = await runCli(['mcp', 'remove', 'test'], env, root);
  assert.strictEqual(removedAgain.code, 1);
  const removedUser = await runCli(['mcp', 'rm', 'remote', '-s', 'user'], env, root);
  assert.strictEqual(removedUser.code, 0, removedUser.stderr);
  assert.ok(!readJson(path.join(home, '.perplexicode', 'mcp.json')).mcpServers.remote);
  const badSub = await runCli(['mcp', 'frobnicate'], env, root);
  assert.strictEqual(badSub.code, 64);

  const bogus = await runCli(['-p', 'hi', '--compute', 'bogus'], env, root);
  assert.notStrictEqual(bogus.code, 0);
  assert.match(bogus.stderr + bogus.stdout, /--compute must be one of/);

  const models = await runCli(['models'], env, root);
  assert.strictEqual(models.code, 0, models.stderr);
  const modelsOut = models.stdout + models.stderr;
  assert.match(modelsOut, /Compute modes/i);
  assert.match(modelsOut, /computer/);
  assert.match(modelsOut, /ultra/);
  const selectableModels = modelsOut.split(/Compute modes/i)[0];
  assert.ok(!/pplx_asi/.test(selectableModels), 'hidden ASI model ids are not listed as selectable models');
  assert.match(modelsOut.split(/Compute modes/i)[1] || '', /standard\s+Compute · Standard\s+max · pplx_asi_opus/, 'compute modes list their orchestrator model');

  const help = await runCli(['--help'], env, root);
  assert.match(help.stdout + help.stderr, /--compute/);
  assert.match(help.stdout + help.stderr, /mcp add/);

  write(path.join(root, '.mcp.json'), stdioConfig('doc'));
  const doctor = await runCli(['doctor'], env, root);
  assert.strictEqual(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout + doctor.stderr, /MCP/);
  assert.match(doctor.stdout + doctor.stderr, /doc/);
});

test('cli e2e: headless run with --mcp-config calls an MCP tool when allowed by --allowedTools', async () => {
  const { root, home } = workspace({ 'a.txt': 'x' });
  const server = await mockOpenAI([
    '<use_mcp_tool>\n<server_name>test</server_name>\n<tool_name>echo</tool_name>\n<arguments>{"text": "from headless"}</arguments>\n</use_mcp_tool>',
    '<attempt_completion><result>MCP said: echo: from headless</result></attempt_completion>',
  ]);
  try {
    const env = { HOME: home, USERPROFILE: home, PERPLEXICODE_HOME: path.join(home, '.perplexicode'), PCODE_OPENAI_BASE_URL: server.url, PCODE_OPENAI_MODEL: 'mock' };
    const run = await runCli(['-p', 'echo via mcp', '--provider', 'openai', '--output-format', 'json', '--mcp-config', stdioConfig('test'), '--allowedTools', 'mcp__test__echo'], env, root);
    assert.strictEqual(run.code, 0, `exit ${run.code}\n${run.stderr}\n${run.stdout}`);
    const payload = JSON.parse(run.stdout.trim().split('\n').pop()!);
    assert.strictEqual(payload.subtype, 'success');
    assert.match(payload.result, /echo: from headless/);
    const second = server.requests[1] as { messages: Array<{ content: string }> };
    assert.match(second.messages[second.messages.length - 1].content, /echo: from headless/);
    const first = server.requests[0] as { messages: Array<{ content: string }> };
    assert.match(first.messages[0].content, /mcp__test__echo/, 'the headless system prompt lists the MCP tools');

    // --no-mcp hides the servers even when configured.
    const noMcpServer = await mockOpenAI([
      '<use_mcp_tool><server_name>test</server_name><tool_name>echo</tool_name><arguments>{}</arguments></use_mcp_tool>',
      '<attempt_completion><result>no servers</result></attempt_completion>',
    ]);
    try {
      const off = await runCli(['-p', 'echo', '--provider', 'openai', '--output-format', 'json', '--mcp-config', stdioConfig('test'), '--no-mcp'], { ...env, PCODE_OPENAI_BASE_URL: noMcpServer.url }, root);
      assert.strictEqual(off.code, 0, off.stderr);
      const reply = noMcpServer.requests[1] as { messages: Array<{ content: string }> };
      assert.match(reply.messages[reply.messages.length - 1].content, /No MCP servers are configured/);
    } finally {
      noMcpServer.close();
    }
  } finally {
    server.close();
  }
});

function mockOpenAI(replies: string[]): Promise<{ url: string; requests: unknown[]; close: () => void }> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ ...parsed, authorization: req.headers.authorization });
      const text = replies.shift() ?? '<attempt_completion><result>out of replies</result></attempt_completion>';
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }], model: 'mock' }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${address.port}/v1`, requests, close: () => server.close() });
  }));
}

async function main(): Promise<void> {
  let failed = 0;
  let ran = 0;
  const filter = process.env.MCP_TEST_FILTER;
  for (const entry of tests) {
    if (filter && !entry.name.includes(filter)) continue;
    const started = Date.now();
    ran++;
    try {
      await Promise.race([
        entry.run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 40s')), 40_000)),
      ]);
      console.log(`  ✓ ${entry.name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${entry.name}\n    ${(error as Error).stack?.split('\n').slice(0, 8).join('\n    ')}`);
    }
  }
  console.log(`\nmcp: ${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
