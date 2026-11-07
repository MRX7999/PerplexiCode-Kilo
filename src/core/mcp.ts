import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

/**
 * Claude Code compatible Model Context Protocol (MCP) client, config loader, and server.
 *
 * Supported configuration layers (later overrides earlier by server name):
 *   1. ~/.claude.json (root `mcpServers` + `projects[cwd].mcpServers`)
 *   2. ~/.claude/.mcp.json, ~/.claude/mcp.json, ~/.perplexicode/mcp.json
 *   3. ~/.claude/settings.json, ~/.perplexicode/settings.json (`mcpServers`)
 *   4. <cwd>/.mcp.json, <cwd>/.claude/.mcp.json, <cwd>/.claude/mcp.json, <cwd>/.perplexicode/mcp.json
 *   5. <cwd>/.claude/settings.json, <cwd>/.perplexicode/settings.json (`mcpServers`)
 *   6. <cwd>/.claude/settings.local.json, <cwd>/.perplexicode/settings.local.json, <cwd>/.mcp.local.json
 *   7. --mcp-config <file-or-json>
 *
 * Supported transports:
 *   - stdio (JSON-RPC 2.0 over stdin/stdout; reads both newline-delimited JSON and Content-Length frames)
 *   - http / sse (Streamable HTTP JSON-RPC 2.0 POST with JSON or SSE response, plus legacy GET SSE endpoint handshake)
 */

export type McpTransportType = 'stdio' | 'http' | 'sse';
export type McpServerScope = 'user' | 'project' | 'local' | 'cli';

export interface McpServerConfig {
  name: string;
  type: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeoutSec?: number;
  disabled?: boolean;
  scope: McpServerScope;
  sourceFile: string;
}

export interface McpToolInfo {
  server: string;
  name: string;
  /** Canonical Claude Code name: mcp__<server>__<tool> */
  qualifiedName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceInfo {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  server: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpServerState {
  config: McpServerConfig;
  status: 'connected' | 'disconnected' | 'error' | 'disabled' | 'untrusted';
  error?: string;
  serverInfo?: { name?: string; version?: string };
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

export interface McpToolCallResult {
  content: string;
  isError: boolean;
  raw?: unknown;
}

export function sanitizeMcpSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export function toMcpQualifiedToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpSegment(server)}__${sanitizeMcpSegment(tool)}`;
}

export function parseMcpQualifiedToolName(value: string): { server: string; tool: string } | undefined {
  const match = value.trim().match(/^mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_.*-]+)$/);
  if (!match) {
    return undefined;
  }
  return { server: match[1], tool: match[2] };
}

/**
 * Expands Claude Code style `${VAR}` and `${VAR:-default}` placeholders in strings.
 */
export function expandMcpEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const current = env[name];
    if (current !== undefined && current !== '') {
      return current;
    }
    return fallback !== undefined ? fallback : '';
  });
}

function expandStringMap(input: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = expandMcpEnv(String(v), env);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseServerEntry(
  name: string,
  raw: unknown,
  scope: McpServerScope,
  sourceFile: string,
  env: NodeJS.ProcessEnv
): McpServerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const rawType = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : typeof obj.transport === 'string' ? obj.transport.trim().toLowerCase() : '';
  const url = typeof obj.url === 'string' && obj.url.trim() ? expandMcpEnv(obj.url.trim(), env) : undefined;
  const command = typeof obj.command === 'string' && obj.command.trim() ? expandMcpEnv(obj.command.trim(), env) : undefined;
  if (!url && !command) {
    return undefined;
  }
  const type: McpTransportType = rawType === 'sse'
    ? 'sse'
    : (rawType === 'http' || rawType === 'streamable-http' || rawType === 'streamable_http' || (!command && Boolean(url)))
      ? 'http'
      : 'stdio';
  const args = Array.isArray(obj.args)
    ? obj.args.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number').map((item) => expandMcpEnv(String(item), env))
    : undefined;
  const serverEnv = expandStringMap(obj.env as Record<string, unknown> | undefined, env);
  const headers = expandStringMap(obj.headers as Record<string, unknown> | undefined, env);
  const cwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? expandMcpEnv(obj.cwd.trim(), env) : undefined;
  const timeoutSec = typeof obj.timeout === 'number' && obj.timeout > 0
    ? obj.timeout
    : typeof obj.timeoutSec === 'number' && obj.timeoutSec > 0
      ? obj.timeoutSec
      : undefined;
  const disabled = obj.disabled === true || obj.enabled === false;

  return {
    name: name.trim(),
    type,
    command,
    args,
    env: serverEnv,
    cwd,
    url,
    headers,
    timeoutSec,
    disabled,
    scope,
    sourceFile,
  };
}

/** Dedicated MCP files (`.mcp.json`, `mcp.json`, `.mcp.local.json`, `--mcp-config`) may be a bare server map. */
function isDedicatedMcpFile(file: string): boolean {
  return file === '--mcp-config' || /(^|[\\/.])mcp(\.local)?\.json$/i.test(path.basename(file));
}

function extractServersMap(parsed: unknown, allowBareMap: boolean): Record<string, unknown> | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    return obj.mcpServers as Record<string, unknown>;
  }
  if (!allowBareMap) {
    // settings.json: blocks such as `verify: { command: "npm test" }` are not MCP servers.
    return undefined;
  }
  // Support top-level map in dedicated .mcp.json files when keys look like server objects
  const entries = Object.entries(obj).filter(([key, val]) =>
    key !== '$schema' && val && typeof val === 'object' && !Array.isArray(val)
    && ('command' in (val as Record<string, unknown>) || 'url' in (val as Record<string, unknown>))
  );
  if (entries.length > 0) {
    return Object.fromEntries(entries);
  }
  return undefined;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export interface LoadMcpConfigOptions {
  home?: string;
  extraConfigs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Extra credentials bound to this server and source file, never shared with other servers. */
  serverEnv?: (name: string, scope: McpServerScope, sourceFile: string, rawSpec: unknown) => NodeJS.ProcessEnv;
  /** Only use servers from `extraConfigs` (Claude Code `--strict-mcp-config`). */
  strict?: boolean;
}

export function loadMcpServers(cwd: string, options: LoadMcpConfigOptions = {}): McpServerConfig[] {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const resolvedCwd = path.resolve(cwd);
  const byName = new Map<string, McpServerConfig>();

  const addFromMap = (map: Record<string, unknown> | undefined, scope: McpServerScope, sourceFile: string) => {
    if (!map) return;
    for (const [name, raw] of Object.entries(map)) {
      if (!name.trim()) continue;
      const scopedEnv = options.serverEnv?.(name, scope, sourceFile, raw);
      const entry = parseServerEntry(name, raw, scope, sourceFile, scopedEnv ? { ...env, ...scopedEnv } : env);
      if (entry) {
        byName.set(entry.name, entry);
      }
    }
  };

  if (!options.strict) {
    // 1. ~/.claude.json (root mcpServers + projects[cwd].mcpServers)
    const claudeJsonPath = path.join(home, '.claude.json');
    const claudeJson = readJsonFile(claudeJsonPath) as Record<string, unknown> | undefined;
    if (claudeJson && typeof claudeJson === 'object') {
      if (claudeJson.mcpServers && typeof claudeJson.mcpServers === 'object' && !Array.isArray(claudeJson.mcpServers)) {
        addFromMap(claudeJson.mcpServers as Record<string, unknown>, 'user', claudeJsonPath);
      }
      const projects = claudeJson.projects as Record<string, unknown> | undefined;
      const projectEntry = projects?.[resolvedCwd] as Record<string, unknown> | undefined;
      if (projectEntry?.mcpServers && typeof projectEntry.mcpServers === 'object' && !Array.isArray(projectEntry.mcpServers)) {
        addFromMap(projectEntry.mcpServers as Record<string, unknown>, 'local', claudeJsonPath);
      }
    }

    // 2. User-level MCP files & settings
    const userFiles = [
      path.join(home, '.claude', '.mcp.json'),
      path.join(home, '.claude', 'mcp.json'),
      path.join(home, '.perplexicode', 'mcp.json'),
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.perplexicode', 'settings.json'),
    ];
    for (const file of userFiles) {
      addFromMap(extractServersMap(readJsonFile(file), isDedicatedMcpFile(file)), 'user', file);
    }

    // 3. Project-level MCP files & settings
    const projectFiles = [
      path.join(resolvedCwd, '.mcp.json'),
      path.join(resolvedCwd, '.claude', '.mcp.json'),
      path.join(resolvedCwd, '.claude', 'mcp.json'),
      path.join(resolvedCwd, '.perplexicode', 'mcp.json'),
      path.join(resolvedCwd, '.claude', 'settings.json'),
      path.join(resolvedCwd, '.perplexicode', 'settings.json'),
    ];
    for (const file of projectFiles) {
      addFromMap(extractServersMap(readJsonFile(file), isDedicatedMcpFile(file)), 'project', file);
    }

    // 4. Local-level MCP files & settings
    const localFiles = [
      path.join(resolvedCwd, '.mcp.local.json'),
      path.join(resolvedCwd, '.claude', 'settings.local.json'),
      path.join(resolvedCwd, '.perplexicode', 'settings.local.json'),
    ];
    for (const file of localFiles) {
      addFromMap(extractServersMap(readJsonFile(file), isDedicatedMcpFile(file)), 'local', file);
    }
  }

  // 5. Extra CLI --mcp-config files or inline JSON strings
  for (const item of options.extraConfigs || []) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        addFromMap(extractServersMap(JSON.parse(trimmed), true), 'cli', '--mcp-config');
      } catch {
        // Ignore malformed inline JSON
      }
    } else {
      const resolvedFile = path.resolve(resolvedCwd, trimmed);
      addFromMap(extractServersMap(readJsonFile(resolvedFile), true), 'cli', resolvedFile);
    }
  }

  return [...byName.values()];
}

export function projectDefinesStdioMcpServers(cwd: string, options: LoadMcpConfigOptions = {}): boolean {
  return loadMcpServers(cwd, options).some((server) =>
    !server.disabled && server.type === 'stdio' && (server.scope === 'project' || server.scope === 'local')
  );
}

export function saveMcpServerConfig(
  cwd: string,
  name: string,
  spec: {
    type?: McpTransportType;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    timeoutSec?: number;
    disabled?: boolean;
  },
  scope: 'project' | 'user' | 'local' = 'project',
  home = os.homedir()
): string {
  const cleanName = name.trim();
  if (!cleanName || !/^[a-zA-Z0-9_.-]+$/.test(cleanName)) {
    throw new Error('MCP server name may only contain letters, digits, dots, hyphens, and underscores.');
  }
  const targetFile = scope === 'user'
    ? path.join(home, '.perplexicode', 'mcp.json')
    : scope === 'local'
      ? path.join(path.resolve(cwd), '.perplexicode', 'settings.local.json')
      : path.join(path.resolve(cwd), '.mcp.json');

  let root: Record<string, unknown> = {};
  const existing = readJsonFile(targetFile);
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    root = { ...(existing as Record<string, unknown>) };
  }
  const servers: Record<string, unknown> = root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
    ? { ...(root.mcpServers as Record<string, unknown>) }
    : {};

  const entry: Record<string, unknown> = {};
  const type = spec.type || (spec.url && !spec.command ? 'http' : 'stdio');
  entry.type = type;
  if (spec.command) entry.command = spec.command;
  if (spec.args && spec.args.length > 0) entry.args = spec.args;
  if (spec.env && Object.keys(spec.env).length > 0) entry.env = spec.env;
  if (spec.cwd) entry.cwd = spec.cwd;
  if (spec.url) entry.url = spec.url;
  if (spec.headers && Object.keys(spec.headers).length > 0) entry.headers = spec.headers;
  if (spec.timeoutSec) entry.timeout = spec.timeoutSec;
  if (spec.disabled) entry.disabled = true;

  servers[cleanName] = entry;
  root.mcpServers = servers;

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return targetFile;
}

export function removeMcpServerConfig(
  cwd: string,
  name: string,
  scope?: 'project' | 'user' | 'local',
  home = os.homedir()
): { removed: boolean; files: string[] } {
  const resolvedCwd = path.resolve(cwd);
  const candidates = scope === 'user'
    ? [path.join(home, '.perplexicode', 'mcp.json'), path.join(home, '.claude', 'mcp.json'), path.join(home, '.claude', '.mcp.json')]
    : scope === 'local'
      ? [path.join(resolvedCwd, '.mcp.local.json'), path.join(resolvedCwd, '.perplexicode', 'settings.local.json'), path.join(resolvedCwd, '.claude', 'settings.local.json')]
      : scope === 'project'
        ? [path.join(resolvedCwd, '.mcp.json'), path.join(resolvedCwd, '.perplexicode', 'mcp.json'), path.join(resolvedCwd, '.claude', 'mcp.json')]
        : [
          path.join(resolvedCwd, '.mcp.json'),
          path.join(resolvedCwd, '.perplexicode', 'mcp.json'),
          path.join(resolvedCwd, '.claude', 'mcp.json'),
          path.join(resolvedCwd, '.mcp.local.json'),
          path.join(resolvedCwd, '.perplexicode', 'settings.local.json'),
          path.join(home, '.perplexicode', 'mcp.json'),
          path.join(home, '.claude', 'mcp.json'),
        ];

  const modifiedFiles: string[] = [];
  for (const file of candidates) {
    const parsed = readJsonFile(file);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
      const servers = { ...(obj.mcpServers as Record<string, unknown>) };
      if (name in servers) {
        delete servers[name];
        obj.mcpServers = servers;
        fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
        modifiedFiles.push(file);
      }
    } else if (/(^|[\\/])\.?mcp(\.local)?\.json$/.test(file) && name in obj && isServerLikeEntry(obj[name])) {
      // Bare server maps (no "mcpServers" wrapper) are only accepted in dedicated mcp.json files.
      delete obj[name];
      fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
      modifiedFiles.push(file);
    }
  }
  return { removed: modifiedFiles.length > 0, files: modifiedFiles };
}

function isServerLikeEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.command === 'string' || typeof entry.url === 'string';
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC 2.0 Transport Connections (stdio and HTTP/SSE)
// ---------------------------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpConnection {
  initialize(): Promise<{ serverInfo?: { name?: string; version?: string } }>;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

/**
 * Windows: `npx`, `npm`, `pnpm`, `yarn`, `bunx` and friends are `.cmd` shims that `spawn` can't start
 * directly (ENOENT). Resolve the shim through PATH/PATHEXT so configs copied from Claude Code docs work
 * without wrapping the command in `cmd /c`. Returns the command, args and whether a shell is required.
 */
export function resolveSpawnTarget(command: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') {
    return { command, args, shell: false };
  }
  let resolved = command;
  if (!/[\\/]/.test(command) && !path.extname(command)) {
    const dirs = (env.PATH || env.Path || '').split(';').filter(Boolean);
    const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    outer: for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, command + ext);
        if (fs.existsSync(candidate)) {
          resolved = candidate;
          break outer;
        }
      }
    }
  }
  const needsShell = /\.(cmd|bat)$/i.test(resolved);
  if (!needsShell) {
    return { command: resolved, args, shell: false };
  }
  // cmd.exe joins arguments with spaces and does no quoting of its own.
  const quote = (value: string) => (/[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  return { command: quote(resolved), args: args.map(quote), shell: true };
}

class StdioMcpConnection implements McpConnection {
  private child?: cp.ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private stdoutBuffer = Buffer.alloc(0);
  private stderrTail = '';
  private closed = false;

  constructor(private readonly config: McpServerConfig, private readonly defaultCwd: string) {}

  isAlive(): boolean {
    return Boolean(this.child && !this.closed && this.child.exitCode === null && !this.child.killed);
  }

  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string } }> {
    if (!this.config.command) {
      throw new Error(`MCP server '${this.config.name}' has no command.`);
    }
    const cwd = this.config.cwd ? path.resolve(this.defaultCwd, this.config.cwd) : this.defaultCwd;
    const env = { ...process.env, ...(this.config.env || {}) };
    const target = resolveSpawnTarget(this.config.command, this.config.args || [], env);
    const child = cp.spawn(target.command, target.args, {
      cwd: fs.existsSync(cwd) ? cwd : this.defaultCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: target.shell,
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      this._onStdout(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      this._failAll(new Error(`MCP server '${this.config.name}' failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      this.closed = true;
      const detail = this.stderrTail.trim() ? `: ${this.stderrTail.trim().split('\n').slice(-3).join(' | ')}` : '';
      this._failAll(new Error(`MCP server '${this.config.name}' exited (${code ?? 'killed'})${detail}`));
    });

    const timeoutMs = (this.config.timeoutSec || 30) * 1000;
    const initResult = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'perplexicode-kilo', version: '3.4.0' },
    }, timeoutMs) as Record<string, unknown> | undefined;

    await this.notify('notifications/initialized', {});
    const serverInfo = initResult?.serverInfo && typeof initResult.serverInfo === 'object'
      ? initResult.serverInfo as { name?: string; version?: string }
      : undefined;
    return { serverInfo };
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = (this.config.timeoutSec || 60) * 1000): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`MCP server '${this.config.name}' is not running.`));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' on '${this.config.name}' timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._writeMessage(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.child || this.closed) return;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    await new Promise<void>((resolve) => {
      this._writeMessage(payload, () => resolve());
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this._failAll(new Error(`MCP server '${this.config.name}' closed.`));
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 500);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private _writeMessage(message: JsonRpcRequest, cb: (err?: Error | null) => void): void {
    try {
      this.child!.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', cb);
    } catch (err) {
      cb(err as Error);
    }
  }

  private _onStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      // Support Content-Length framed messages if a server emits them
      const headerMatch = this.stdoutBuffer.toString('latin1', 0, Math.min(this.stdoutBuffer.length, 128)).match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
      if (headerMatch) {
        const headerByteLen = Buffer.byteLength(headerMatch[0], 'latin1');
        const bodyLen = Number(headerMatch[1]);
        if (this.stdoutBuffer.length < headerByteLen + bodyLen) {
          return;
        }
        const rawJson = this.stdoutBuffer.subarray(headerByteLen, headerByteLen + bodyLen).toString('utf8');
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerByteLen + bodyLen);
        this._handleJsonLine(rawJson);
        continue;
      }

      const newlineIdx = this.stdoutBuffer.indexOf(0x0a); // '\n'
      if (newlineIdx === -1) {
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newlineIdx).toString('utf8').trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      this._handleJsonLine(line);
    }
  }

  private _handleJsonLine(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const incoming = parsed as JsonRpcResponse & { method?: string; params?: Record<string, unknown> };
    if (typeof incoming.method === 'string') {
      // Server → client request or notification (ping, roots/list, sampling, logging, list_changed).
      if (incoming.id !== undefined && incoming.id !== null) {
        this._answerServerRequest(incoming.id, incoming.method);
      } else if (incoming.method === 'notifications/tools/list_changed' || incoming.method === 'notifications/resources/list_changed' || incoming.method === 'notifications/prompts/list_changed') {
        this.onListChanged?.();
      }
      return;
    }
    if (parsed.id !== undefined && parsed.id !== null) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message || `MCP error ${parsed.error.code ?? ''}`));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  /** Fired when the server announces that its tool/resource/prompt list changed. */
  onListChanged?: () => void;

  private _answerServerRequest(id: number | string, method: string): void {
    let response: Record<string, unknown>;
    if (method === 'ping') {
      response = { jsonrpc: '2.0', id, result: {} };
    } else if (method === 'roots/list') {
      const uri = `file://${this.defaultCwd.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`;
      response = { jsonrpc: '2.0', id, result: { roots: [{ uri, name: path.basename(this.defaultCwd) || this.defaultCwd }] } };
    } else {
      response = { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not supported by this client: ${method}` } };
    }
    try {
      this.child?.stdin.write(`${JSON.stringify(response)}\n`, 'utf8');
    } catch {
      // ignore: the server is going away
    }
  }

  private _failAll(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

class HttpMcpConnection implements McpConnection {
  private nextId = 1;
  private sessionId?: string;
  private postEndpoint: string;
  private closed = false;

  constructor(private readonly config: McpServerConfig) {
    this.postEndpoint = config.url || '';
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string } }> {
    if (!this.config.url) {
      throw new Error(`MCP server '${this.config.name}' has no url.`);
    }
    this.postEndpoint = this.config.url;
    const timeoutMs = (this.config.timeoutSec || 30) * 1000;
    const initResult = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'perplexicode-kilo', version: '3.4.0' },
    }, timeoutMs) as Record<string, unknown> | undefined;

    await this.notify('notifications/initialized', {}).catch(() => undefined);
    const serverInfo = initResult?.serverInfo && typeof initResult.serverInfo === 'object'
      ? initResult.serverInfo as { name?: string; version?: string }
      : undefined;
    return { serverInfo };
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = (this.config.timeoutSec || 60) * 1000): Promise<unknown> {
    if (this.closed) {
      throw new Error(`MCP server '${this.config.name}' is closed.`);
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    const response = await this._postJson(payload, timeoutMs);
    if (!response) {
      return {};
    }
    if (response.error) {
      throw new Error(response.error.message || `MCP HTTP error ${response.error.code ?? ''}`);
    }
    return response.result;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    await this._postJson(payload, 10_000).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private _postJson(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse | undefined> {
    return new Promise((resolve, reject) => {
      let targetUrl: URL;
      try {
        targetUrl = new URL(this.postEndpoint);
      } catch {
        reject(new Error(`Invalid MCP server URL: ${this.postEndpoint}`));
        return;
      }
      const body = JSON.stringify(payload);
      const client = targetUrl.protocol === 'https:' ? https : http;
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...(this.config.headers || {}),
      };
      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }

      const req = client.request(
        {
          method: 'POST',
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const sid = res.headers['mcp-session-id'];
          if (typeof sid === 'string' && sid.trim()) {
            this.sessionId = sid.trim();
          }
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            raw += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`MCP server '${this.config.name}' returned HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
              return;
            }
            const trimmed = raw.trim();
            if (!trimmed) {
              resolve(undefined);
              return;
            }
            // Handle SSE formatted response (data: {...})
            const contentType = String(res.headers['content-type'] || '').toLowerCase();
            if (contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
              const dataLines = trimmed
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.replace(/^data:\s?/, '').trim())
                .filter(Boolean);
              for (let i = dataLines.length - 1; i >= 0; i -= 1) {
                try {
                  const parsed = JSON.parse(dataLines[i]) as JsonRpcResponse;
                  if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
                    resolve(parsed);
                    return;
                  }
                } catch {
                  // try earlier line
                }
              }
              resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(trimmed) as JsonRpcResponse);
            } catch (err) {
              reject(new Error(`Invalid JSON from MCP server '${this.config.name}': ${(err as Error).message}`));
            }
          });
        }
      );
      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy(new Error(`MCP HTTP request '${payload.method}' timed out`));
      });
      req.write(body);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------------------------
// MCP Registry (manages servers, tools, resources, prompts for a workspace)
// ---------------------------------------------------------------------------------------------

export interface McpRegistryOptions {
  cwd: string;
  home?: string;
  trustProject?: boolean;
  extraConfigs?: string[];
  /** Only use servers from `extraConfigs` (Claude Code `--strict-mcp-config`). */
  strict?: boolean;
  env?: NodeJS.ProcessEnv;
  serverEnv?: LoadMcpConfigOptions['serverEnv'];
  log?: (line: string) => void;
}

export class McpRegistry {
  private readonly cwd: string;
  private readonly home: string;
  private trustProject: boolean;
  private readonly extraConfigs: string[];
  private readonly strict: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serverEnv?: LoadMcpConfigOptions['serverEnv'];
  private readonly log: (line: string) => void;
  private readonly connections = new Map<string, McpConnection>();
  private readonly states = new Map<string, McpServerState>();
  private readonly connecting = new Map<string, Promise<McpServerState>>();

  constructor(options: McpRegistryOptions) {
    this.cwd = path.resolve(options.cwd);
    this.home = options.home || os.homedir();
    this.trustProject = options.trustProject ?? true;
    this.extraConfigs = options.extraConfigs || [];
    this.strict = options.strict ?? false;
    this.env = options.env || process.env;
    this.serverEnv = options.serverEnv;
    this.log = options.log || (() => undefined);
    this.reloadConfigs();
  }

  setTrustProject(trusted: boolean): void {
    this.trustProject = trusted;
  }

  reloadConfigs(): McpServerConfig[] {
    const configs = loadMcpServers(this.cwd, {
      home: this.home,
      extraConfigs: this.extraConfigs,
      strict: this.strict,
      env: this.env,
      serverEnv: this.serverEnv,
    });
    const seen = new Set<string>();
    for (const config of configs) {
      seen.add(config.name);
      const prev = this.states.get(config.name);
      const isUntrustedStdio = !this.trustProject && config.type === 'stdio' && (config.scope === 'project' || config.scope === 'local');
      if (config.disabled) {
        this.states.set(config.name, {
          config,
          status: 'disabled',
          tools: [],
          resources: [],
          prompts: [],
        });
      } else if (isUntrustedStdio) {
        this.states.set(config.name, {
          config,
          status: 'untrusted',
          error: 'Project stdio MCP server skipped until project is trusted.',
          tools: [],
          resources: [],
          prompts: [],
        });
      } else if (prev && prev.status === 'connected' && this.connections.get(config.name)?.isAlive()) {
        this.states.set(config.name, { ...prev, config });
      } else {
        this.states.set(config.name, {
          config,
          status: prev?.status === 'error' ? 'error' : 'disconnected',
          error: prev?.error,
          tools: prev?.tools || [],
          resources: prev?.resources || [],
          prompts: prev?.prompts || [],
        });
      }
    }
    for (const name of [...this.states.keys()]) {
      if (!seen.has(name)) {
        this.states.delete(name);
        const conn = this.connections.get(name);
        if (conn) {
          this.connections.delete(name);
          void conn.close();
        }
      }
    }
    return configs;
  }

  getStates(): McpServerState[] {
    return [...this.states.values()];
  }

  getAllTools(): McpToolInfo[] {
    return this.getStates().flatMap((state) => state.tools);
  }

  getAllResources(): McpResourceInfo[] {
    return this.getStates().flatMap((state) => state.resources);
  }

  getAllPrompts(): McpPromptInfo[] {
    return this.getStates().flatMap((state) => state.prompts);
  }

  findTool(serverOrQualified: string, toolName?: string): { state: McpServerState; tool: McpToolInfo } | undefined {
    if (!toolName) {
      const parsed = parseMcpQualifiedToolName(serverOrQualified);
      if (!parsed) return undefined;
      for (const state of this.states.values()) {
        if (sanitizeMcpSegment(state.config.name) === parsed.server || state.config.name === parsed.server) {
          const tool = state.tools.find((t) => sanitizeMcpSegment(t.name) === parsed.tool || t.name === parsed.tool || t.qualifiedName === serverOrQualified);
          if (tool) return { state, tool };
        }
      }
      return undefined;
    }
    const state = this._findServerState(serverOrQualified);
    if (!state) return undefined;
    const tool = state.tools.find((t) => t.name === toolName || sanitizeMcpSegment(t.name) === sanitizeMcpSegment(toolName));
    return tool ? { state, tool } : undefined;
  }

  /** Any server configured for this workspace (connected or not). */
  hasServers(): boolean {
    return this.states.size > 0;
  }

  async connectAll(): Promise<McpServerState[]> {
    this.reloadConfigs();
    const names = [...this.states.keys()];
    await Promise.all(names.map((name) => this.connectServer(name).catch(() => undefined)));
    return this.getStates();
  }

  /**
   * Connects every server that has not been tried yet (status "disconnected"). Servers that failed
   * stay in "error" until `reconnect`/`connectAll`, so a broken server does not delay every request.
   */
  async ensureConnected(): Promise<void> {
    const pending = this.getStates().filter((state) => state.status === 'disconnected' && !state.config.disabled);
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending.map((state) => this.connectServer(state.config.name).catch(() => undefined)));
  }

  /** Resources of one server or of all connected servers (connects on demand). */
  async listResources(server?: string): Promise<McpResourceInfo[]> {
    if (server) {
      const state = await this._ensureServerConnected(server);
      if (state.status !== 'connected') {
        throw new Error(`MCP server '${state.config.name}' is not connected${state.error ? `: ${state.error}` : ''}.`);
      }
      return state.resources;
    }
    await this.ensureConnected();
    return this.getAllResources();
  }

  async connectServer(name: string): Promise<McpServerState> {
    const state = this._findServerState(name);
    if (!state) {
      throw new Error(`Unknown MCP server '${name}'.`);
    }
    const inFlight = this.connecting.get(state.config.name);
    if (inFlight) {
      return inFlight;
    }
    const attempt = this._connect(state).finally(() => this.connecting.delete(state.config.name));
    this.connecting.set(state.config.name, attempt);
    return attempt;
  }

  private async _connect(state: McpServerState): Promise<McpServerState> {
    if (state.config.disabled) {
      state.status = 'disabled';
      return state;
    }
    if (!this.trustProject && state.config.type === 'stdio' && (state.config.scope === 'project' || state.config.scope === 'local')) {
      state.status = 'untrusted';
      state.error = 'Project stdio MCP server skipped until project is trusted.';
      return state;
    }

    const existing = this.connections.get(state.config.name);
    if (existing && existing.isAlive() && state.status === 'connected') {
      return state;
    }
    if (existing) {
      this.connections.delete(state.config.name);
      await existing.close().catch(() => undefined);
    }

    const conn: McpConnection = state.config.type === 'stdio'
      ? new StdioMcpConnection(state.config, this.cwd)
      : new HttpMcpConnection(state.config);
    if (conn instanceof StdioMcpConnection) {
      conn.onListChanged = () => {
        void this.refreshServer(state.config.name).catch(() => undefined);
      };
    }

    try {
      const { serverInfo } = await conn.initialize();
      this.connections.set(state.config.name, conn);

      const toolsRes = await conn.request('tools/list', {}).catch(() => ({ tools: [] })) as { tools?: Array<Record<string, unknown>> } | undefined;
      const resourcesRes = await conn.request('resources/list', {}).catch(() => ({ resources: [] })) as { resources?: Array<Record<string, unknown>> } | undefined;
      const promptsRes = await conn.request('prompts/list', {}).catch(() => ({ prompts: [] })) as { prompts?: Array<Record<string, unknown>> } | undefined;

      const tools: McpToolInfo[] = (Array.isArray(toolsRes?.tools) ? toolsRes!.tools : [])
        .filter((t) => t && typeof t.name === 'string' && t.name.trim())
        .map((t) => ({
          server: state.config.name,
          name: String(t.name).trim(),
          qualifiedName: toMcpQualifiedToolName(state.config.name, String(t.name).trim()),
          description: typeof t.description === 'string' ? t.description.trim() : undefined,
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema as Record<string, unknown> : undefined,
        }));

      const resources: McpResourceInfo[] = (Array.isArray(resourcesRes?.resources) ? resourcesRes!.resources : [])
        .filter((r) => r && typeof r.uri === 'string' && r.uri.trim())
        .map((r) => ({
          server: state.config.name,
          uri: String(r.uri).trim(),
          name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : String(r.uri).trim(),
          description: typeof r.description === 'string' ? r.description.trim() : undefined,
          mimeType: typeof r.mimeType === 'string' ? r.mimeType.trim() : undefined,
        }));

      const prompts: McpPromptInfo[] = (Array.isArray(promptsRes?.prompts) ? promptsRes!.prompts : [])
        .filter((p) => p && typeof p.name === 'string' && p.name.trim())
        .map((p) => ({
          server: state.config.name,
          name: String(p.name).trim(),
          description: typeof p.description === 'string' ? p.description.trim() : undefined,
          arguments: Array.isArray(p.arguments)
            ? (p.arguments as Array<Record<string, unknown>>)
              .filter((a) => a && typeof a.name === 'string')
              .map((a) => ({
                name: String(a.name),
                description: typeof a.description === 'string' ? a.description : undefined,
                required: a.required === true,
              }))
            : undefined,
        }));

      const nextState: McpServerState = {
        config: state.config,
        status: 'connected',
        serverInfo,
        tools,
        resources,
        prompts,
      };
      this.states.set(state.config.name, nextState);
      return nextState;
    } catch (error) {
      await conn.close().catch(() => undefined);
      const message = (error as Error).message || String(error);
      this.log(`[mcp] ${state.config.name}: ${message}`);
      const nextState: McpServerState = {
        config: state.config,
        status: 'error',
        error: message,
        tools: [],
        resources: [],
        prompts: [],
      };
      this.states.set(state.config.name, nextState);
      return nextState;
    }
  }

  /** Re-reads tools/resources/prompts of a connected server (after a list_changed notification). */
  async refreshServer(name: string): Promise<McpServerState | undefined> {
    const state = this._findServerState(name);
    const conn = state ? this.connections.get(state.config.name) : undefined;
    if (!state || !conn || !conn.isAlive() || state.status !== 'connected') {
      return state;
    }
    const toolsRes = await conn.request('tools/list', {}).catch(() => undefined) as { tools?: Array<Record<string, unknown>> } | undefined;
    if (Array.isArray(toolsRes?.tools)) {
      state.tools = toolsRes!.tools
        .filter((t) => t && typeof t.name === 'string' && String(t.name).trim())
        .map((t) => ({
          server: state.config.name,
          name: String(t.name).trim(),
          qualifiedName: toMcpQualifiedToolName(state.config.name, String(t.name).trim()),
          description: typeof t.description === 'string' ? t.description.trim() : undefined,
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema as Record<string, unknown> : undefined,
        }));
    }
    const resourcesRes = await conn.request('resources/list', {}).catch(() => undefined) as { resources?: Array<Record<string, unknown>> } | undefined;
    if (Array.isArray(resourcesRes?.resources)) {
      state.resources = resourcesRes!.resources
        .filter((r) => r && typeof r.uri === 'string' && String(r.uri).trim())
        .map((r) => ({
          server: state.config.name,
          uri: String(r.uri).trim(),
          name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : String(r.uri).trim(),
          description: typeof r.description === 'string' ? r.description.trim() : undefined,
          mimeType: typeof r.mimeType === 'string' ? r.mimeType.trim() : undefined,
        }));
    }
    return state;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    const state = await this._ensureServerConnected(serverName);
    const conn = this.connections.get(state.config.name);
    if (!conn) {
      throw new Error(`MCP server '${state.config.name}' is not connected${state.error ? `: ${state.error}` : ''}.`);
    }
    const resolvedTool = state.tools.find((t) => t.name === toolName || sanitizeMcpSegment(t.name) === sanitizeMcpSegment(toolName));
    const actualToolName = resolvedTool ? resolvedTool.name : toolName;
    const raw = await conn.request('tools/call', {
      name: actualToolName,
      arguments: args,
    }) as Record<string, unknown> | undefined;

    const isError = raw?.isError === true;
    const content = formatMcpContent(raw?.content ?? raw);
    return { content, isError, raw };
  }

  async readResource(serverName: string, uri: string): Promise<string> {
    const state = await this._ensureServerConnected(serverName);
    const conn = this.connections.get(state.config.name);
    if (!conn) {
      throw new Error(`MCP server '${state.config.name}' is not connected${state.error ? `: ${state.error}` : ''}.`);
    }
    const raw = await conn.request('resources/read', { uri }) as { contents?: Array<Record<string, unknown>> } | undefined;
    const contents = Array.isArray(raw?.contents) ? raw!.contents : [];
    if (contents.length === 0) {
      return formatMcpContent(raw);
    }
    return contents.map((item) => {
      if (typeof item.text === 'string') return item.text;
      if (typeof item.blob === 'string') return `[Binary resource ${item.uri || uri} (${item.mimeType || 'application/octet-stream'}), ${item.blob.length} base64 chars]`;
      return JSON.stringify(item);
    }).join('\n\n');
  }

  async getPrompt(serverName: string, promptName: string, args: Record<string, string> = {}): Promise<string> {
    const state = await this._ensureServerConnected(serverName);
    const conn = this.connections.get(state.config.name);
    if (!conn) {
      throw new Error(`MCP server '${state.config.name}' is not connected${state.error ? `: ${state.error}` : ''}.`);
    }
    const raw = await conn.request('prompts/get', { name: promptName, arguments: args }) as {
      description?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
    } | undefined;
    const messages = Array.isArray(raw?.messages) ? raw!.messages : [];
    if (messages.length === 0) {
      return formatMcpContent(raw);
    }
    return messages.map((m) => formatMcpContent(m.content)).join('\n\n');
  }

  async closeAll(): Promise<void> {
    const conns = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(conns.map((c) => c.close().catch(() => undefined)));
    for (const [name, state] of this.states.entries()) {
      if (state.status === 'connected') {
        this.states.set(name, { ...state, status: 'disconnected' });
      }
    }
  }

  /**
   * Formats connected MCP servers, tools, and resources for the agent system prompt.
   */
  formatSystemPromptSection(): string {
    const connected = this.getStates().filter((s) => s.status === 'connected' && (s.tools.length > 0 || s.resources.length > 0));
    if (connected.length === 0) {
      return '';
    }
    const lines: string[] = [
      '# Connected MCP Servers (Model Context Protocol)',
      'You can call MCP tools with `<use_mcp_tool>` (or directly via `<mcp__server__tool>`) and read MCP resources with `<access_mcp_resource>`.',
    ];
    for (const state of connected) {
      lines.push(`\n## MCP Server: ${state.config.name} (${state.config.type})`);
      if (state.tools.length > 0) {
        lines.push('Tools:');
        for (const tool of state.tools) {
          const schemaProps = tool.inputSchema && typeof tool.inputSchema.properties === 'object' && tool.inputSchema.properties
            ? Object.keys(tool.inputSchema.properties as Record<string, unknown>)
            : [];
          const required = Array.isArray(tool.inputSchema?.required)
            ? (tool.inputSchema!.required as string[])
            : [];
          const paramsDesc = schemaProps.length > 0
            ? ` (params: ${schemaProps.map((p) => required.includes(p) ? `${p}*` : p).join(', ')})`
            : '';
          lines.push(`- ${tool.name} [${tool.qualifiedName}]${paramsDesc}${tool.description ? `: ${tool.description}` : ''}`);
        }
      }
      if (state.resources.length > 0) {
        lines.push('Resources:');
        for (const res of state.resources) {
          lines.push(`- ${res.uri} (${res.name})${res.description ? `: ${res.description}` : ''}`);
        }
      }
    }
    return lines.join('\n');
  }

  private _findServerState(nameOrSanitized: string): McpServerState | undefined {
    const direct = this.states.get(nameOrSanitized);
    if (direct) return direct;
    const sanitized = sanitizeMcpSegment(nameOrSanitized);
    for (const state of this.states.values()) {
      if (sanitizeMcpSegment(state.config.name) === sanitized) {
        return state;
      }
    }
    return undefined;
  }

  private async _ensureServerConnected(name: string): Promise<McpServerState> {
    const state = this._findServerState(name);
    if (!state) {
      throw new Error(`Unknown MCP server '${name}'. Configured servers: ${[...this.states.keys()].join(', ') || 'none'}`);
    }
    const conn = this.connections.get(state.config.name);
    if (state.status === 'connected' && conn?.isAlive()) {
      return state;
    }
    return this.connectServer(state.config.name);
  }
}

function formatMcpContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== 'object') return String(item);
      const obj = item as Record<string, unknown>;
      if (obj.type === 'text' && typeof obj.text === 'string') {
        return obj.text;
      }
      if (obj.type === 'resource' && obj.resource && typeof obj.resource === 'object') {
        const res = obj.resource as Record<string, unknown>;
        if (typeof res.text === 'string') return res.text;
      }
      if (obj.type === 'image') {
        return `[MCP Image: ${obj.mimeType || 'image/png'}]`;
      }
      return JSON.stringify(obj);
    }).join('\n');
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    return JSON.stringify(obj, null, 2);
  }
  return String(content ?? '');
}
