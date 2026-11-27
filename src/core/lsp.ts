import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { LspOperation, LspQueryRequest, resolveWorkspacePath, toPosixRelative } from '../agent/tools';

export type { LspOperation, LspQueryRequest };

export interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** File extensions handled by this server, e.g. [".ts", ".tsx"]. */
  extensions: string[];
  /** Optional explicit extension -> languageId map. */
  extensionToLanguage: Record<string, string>;
  /** Default LSP languageId when extension is not mapped explicitly. */
  languageId?: string;
  initializationOptions?: Record<string, unknown>;
}

const DEFAULT_EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.java': 'java',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.lua': 'lua',
  '.sh': 'shellscript',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

const LANG_DEFAULT_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi'],
  go: ['.go'],
  rust: ['.rs'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
  java: ['.java'],
  swift: ['.swift'],
};

function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function parseServerEntry(name: string, raw: unknown): LspServerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.disabled === true) {
    return undefined;
  }
  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (!command) {
    return undefined;
  }
  const args = Array.isArray(obj.args) ? obj.args.map((a) => String(a)) : [];
  const env: Record<string, string> | undefined =
    obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)
      ? Object.fromEntries(Object.entries(obj.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;

  const extensionToLanguage: Record<string, string> = {};
  if (obj.extensionToLanguage && typeof obj.extensionToLanguage === 'object' && !Array.isArray(obj.extensionToLanguage)) {
    for (const [ext, lang] of Object.entries(obj.extensionToLanguage as Record<string, unknown>)) {
      const norm = normalizeExt(ext);
      if (norm && typeof lang === 'string' && lang.trim()) {
        extensionToLanguage[norm] = lang.trim();
      }
    }
  }

  const explicitExts = Array.isArray(obj.extensions)
    ? obj.extensions.map((e) => normalizeExt(String(e))).filter(Boolean)
    : Array.isArray(obj.fileExtensions)
      ? obj.fileExtensions.map((e) => normalizeExt(String(e))).filter(Boolean)
      : [];

  const languageId = typeof obj.languageId === 'string' && obj.languageId.trim()
    ? obj.languageId.trim()
    : name.toLowerCase();

  const extensions = Array.from(
    new Set([
      ...explicitExts,
      ...Object.keys(extensionToLanguage),
      ...(LANG_DEFAULT_EXTENSIONS[languageId] || []),
      ...(LANG_DEFAULT_EXTENSIONS[name.toLowerCase()] || []),
    ])
  );

  const initializationOptions =
    obj.initializationOptions && typeof obj.initializationOptions === 'object' && !Array.isArray(obj.initializationOptions)
      ? (obj.initializationOptions as Record<string, unknown>)
      : undefined;

  return {
    name,
    command,
    args,
    env,
    extensions,
    extensionToLanguage,
    languageId,
    initializationOptions,
  };
}

/**
 * Loads LSP server configurations from user and workspace `.lsp.json` files:
 * - `~/.perplexicode/lsp.json`
 * - `~/.claude/.lsp.json`
 * - `<cwd>/.perplexicode/lsp.json`
 * - `<cwd>/.lsp.json` (highest priority)
 *
 * Supports both `{ "servers": { "<name>": { ... } } }` and flat `{ "<name>": { "command": ... } }`.
 */
export function loadLspConfigs(cwd: string, options: { homeDir?: string; trustProject?: boolean } = {}): LspServerConfig[] {
  const home = options.homeDir || process.env.HOME || os.homedir();
  const trustProject = options.trustProject !== false;
  const candidates: Array<{ file: string; projectScoped: boolean }> = [
    { file: path.join(home, '.perplexicode', 'lsp.json'), projectScoped: false },
    { file: path.join(home, '.claude', '.lsp.json'), projectScoped: false },
    { file: path.join(cwd, '.perplexicode', 'lsp.json'), projectScoped: true },
    { file: path.join(cwd, '.lsp.json'), projectScoped: true },
  ];

  const byName = new Map<string, LspServerConfig>();
  for (const candidate of candidates) {
    if (candidate.projectScoped && !trustProject) {
      continue;
    }
    if (!fs.existsSync(candidate.file)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate.file, 'utf8')) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      const mapObj =
        parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)
          ? (parsed.servers as Record<string, unknown>)
          : parsed.lspServers && typeof parsed.lspServers === 'object' && !Array.isArray(parsed.lspServers)
            ? (parsed.lspServers as Record<string, unknown>)
            : parsed;
      for (const [name, rawEntry] of Object.entries(mapObj)) {
        const entry = parseServerEntry(name, rawEntry);
        if (entry) {
          byName.set(name, entry);
        }
      }
    } catch {
      // Ignore malformed config file so unrelated tools stay usable
    }
  }
  return [...byName.values()];
}

export function projectDefinesLspServers(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, '.lsp.json')) || fs.existsSync(path.join(cwd, '.perplexicode', 'lsp.json'));
}

interface LspDiagnosticItem {
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: string | number;
  source?: string;
  message?: string;
}

interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface LspLocationLink {
  targetUri: string;
  targetSelectionRange?: LspLocation['range'];
  targetRange: LspLocation['range'];
}

class StdioLspClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly openedVersions = new Map<string, { version: number; text: string }>();
  private readonly publishedDiagnostics = new Map<string, LspDiagnosticItem[]>();
  private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
  private initPromise?: Promise<void>;
  private closed = false;

  private supportsPullDiagnostics = false;

  constructor(
    readonly config: LspServerConfig,
    private readonly cwd: string,
    private readonly requestTimeoutMs = 15_000
  ) {}

  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this._startAndInitialize();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = undefined;
      throw err;
    }
  }

  private async _startAndInitialize(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.stdout.on('data', (chunk: Buffer) => this._onStdout(chunk));
    child.on('error', (err) => {
      this._rejectAll(new Error(`LSP server '${this.config.name}' failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (!this.closed) {
        this._rejectAll(
          new Error(
            `LSP server '${this.config.name}' exited unexpectedly (code ${code ?? 'null'})${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`
          )
        );
      }
    });

    const rootUri = pathToFileURL(this.cwd).toString();
    const initRes = await this.request('initialize', {
      processId: process.pid,
      rootPath: this.cwd,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.cwd) || 'workspace' }],
      initializationOptions: this.config.initializationOptions || {},
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: { relatedInformation: true },
          diagnostic: { dynamicRegistration: false },
        },
      },
    });
    this.supportsPullDiagnostics = Boolean(initRes?.capabilities?.diagnosticProvider);
    this.notify('initialized', {});
  }

  async syncDocument(absPath: string): Promise<string> {
    await this.ensureInitialized();
    const uri = pathToFileURL(absPath).toString();
    const text = await fs.promises.readFile(absPath, 'utf8');
    const ext = normalizeExt(path.extname(absPath));
    const languageId =
      this.config.extensionToLanguage[ext] ||
      DEFAULT_EXT_TO_LANG[ext] ||
      this.config.languageId ||
      'plaintext';

    const prev = this.openedVersions.get(uri);
    if (!prev) {
      this.openedVersions.set(uri, { version: 1, text });
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else if (prev.text !== text) {
      const nextVer = prev.version + 1;
      this.openedVersions.set(uri, { version: nextVer, text });
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: nextVer },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  async getDiagnosticsForUri(uri: string, settleMs = 250): Promise<LspDiagnosticItem[]> {
    await this.ensureInitialized();
    // Try LSP 3.17 pull diagnostics first only when advertised in server capabilities
    if (this.supportsPullDiagnostics) {
      try {
        const pull = await this.request('textDocument/diagnostic', {
          textDocument: { uri },
        });
        if (pull && Array.isArray(pull.items)) {
          return pull.items as LspDiagnosticItem[];
        }
      } catch {
        // Server uses push publishDiagnostics instead of LSP 3.17 pull
      }
    }
    if (!this.publishedDiagnostics.has(uri) && settleMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settleMs);
        const list = this.diagnosticWaiters.get(uri) || [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.diagnosticWaiters.set(uri, list);
      });
    }
    return this.publishedDiagnostics.get(uri) || [];
  }

  getAllPublishedDiagnostics(): Map<string, LspDiagnosticItem[]> {
    return new Map(this.publishedDiagnostics);
  }

  request(method: string, params: unknown): Promise<any> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`LSP server '${this.config.name}' is not running.`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${this.requestTimeoutMs}ms on '${this.config.name}'.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(frame, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child || this.closed) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    try {
      this.child.stdin.write(frame, 'utf8');
    } catch {
      // ignore broken pipe
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this._rejectAll(new Error(`LSP server '${this.config.name}' closed.`));
    if (!child) return;
    try {
      const shutdownPayload = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: null });
      const exitPayload = JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null });
      child.stdin.write(
        `Content-Length: ${Buffer.byteLength(shutdownPayload, 'utf8')}\r\n\r\n${shutdownPayload}` +
          `Content-Length: ${Buffer.byteLength(exitPayload, 'utf8')}\r\n\r\n${exitPayload}`,
        'utf8'
      );
      child.stdin.end();
    } catch {
      // ignore
    }
    if (child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          resolve();
        }, 250);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private _onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headerText = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(match[1]);
      const totalFrameLen = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalFrameLen) {
        return;
      }
      const bodyStr = this.buffer.slice(headerEnd + 4, totalFrameLen).toString('utf8');
      this.buffer = this.buffer.slice(totalFrameLen);
      let msg: any;
      try {
        msg = JSON.parse(bodyStr);
      } catch {
        continue;
      }
      this._handleMessage(msg);
    }
  }

  private _handleMessage(msg: any): void {
    // Server-initiated request (e.g., workspace/configuration, window/workDoneProgress/create)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') {
        const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
        result = items.map(() => ({}));
      }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      try {
        this.child?.stdin.write(`Content-Length: ${Buffer.byteLength(reply, 'utf8')}\r\n\r\n${reply}`, 'utf8');
      } catch {
        // ignore
      }
      return;
    }

    // Notification
    if (msg.id === undefined && typeof msg.method === 'string') {
      if (msg.method === 'textDocument/publishDiagnostics' && typeof msg.params?.uri === 'string') {
        const uri = msg.params.uri as string;
        const items = Array.isArray(msg.params.diagnostics) ? (msg.params.diagnostics as LspDiagnosticItem[]) : [];
        this.publishedDiagnostics.set(uri, items);
        const waiters = this.diagnosticWaiters.get(uri);
        if (waiters) {
          this.diagnosticWaiters.delete(uri);
          for (const w of waiters) w();
        }
      }
      return;
    }

    // Response to our request
    if (msg.id !== undefined) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(msg.id));
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private _rejectAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
}

function readLinePreview(absPath: string, zeroBasedLine: number): string {
  try {
    const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
    return (lines[zeroBasedLine] || '').trim().slice(0, 180);
  } catch {
    return '';
  }
}

function normalizeLocations(raw: unknown): LspLocation[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: LspLocation[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    if (typeof (item as LspLocation).uri === 'string' && (item as LspLocation).range) {
      out.push(item as LspLocation);
    } else if (typeof (item as LspLocationLink).targetUri === 'string') {
      const link = item as LspLocationLink;
      out.push({
        uri: link.targetUri,
        range: link.targetSelectionRange || link.targetRange,
      });
    }
  }
  return out;
}

export function formatHoverContents(contents: unknown): string {
  if (!contents) return '';
  if (typeof contents === 'string') return contents.trim();
  if (Array.isArray(contents)) {
    return contents.map((item) => formatHoverContents(item)).filter(Boolean).join('\n\n');
  }
  if (typeof contents === 'object') {
    const obj = contents as { language?: string; value?: string; kind?: string };
    if (typeof obj.language === 'string' && typeof obj.value === 'string') {
      return `\`\`\`${obj.language}\n${obj.value.trim()}\n\`\`\``;
    }
    if (typeof obj.value === 'string') {
      return obj.value.trim();
    }
  }
  return '';
}

function severityLabel(sev: number | undefined): string {
  switch (sev) {
    case 1:
      return 'Error';
    case 2:
      return 'Warning';
    case 3:
      return 'Info';
    case 4:
      return 'Hint';
    default:
      return 'Error';
  }
}

/**
 * Manages configured stdio LSP servers for a CLI / daemon workspace.
 */
export class LspManager {
  private readonly clients = new Map<string, StdioLspClient>();
  private configsCache?: LspServerConfig[];

  constructor(
    private readonly cwd: string,
    private readonly options: { homeDir?: string; trustProject?: boolean; requestTimeoutMs?: number } = {}
  ) {}

  getConfigs(): LspServerConfig[] {
    if (!this.configsCache) {
      this.configsCache = loadLspConfigs(this.cwd, this.options);
    }
    return this.configsCache;
  }

  reloadConfigs(): LspServerConfig[] {
    this.configsCache = loadLspConfigs(this.cwd, this.options);
    return this.configsCache;
  }

  private _pickServerForFile(absPath: string): LspServerConfig | undefined {
    const ext = normalizeExt(path.extname(absPath));
    const configs = this.getConfigs();
    if (!ext) return configs[0];
    return configs.find((cfg) => cfg.extensions.includes(ext));
  }

  private _getClient(config: LspServerConfig): StdioLspClient {
    let client = this.clients.get(config.name);
    if (!client) {
      client = new StdioLspClient(config, this.cwd, this.options.requestTimeoutMs);
      this.clients.set(config.name, client);
    }
    return client;
  }

  async query(req: LspQueryRequest): Promise<string> {
    const configs = this.getConfigs();
    if (configs.length === 0) {
      return 'No LSP servers configured. Create `.lsp.json` (or `~/.perplexicode/lsp.json`) with `{ "servers": { "<lang>": { "command": "...", "args": ["..."], "extensions": [".ts"] } } }`.';
    }

    if (req.operation === 'diagnostics' && !req.path) {
      const lines: string[] = [];
      for (const client of this.clients.values()) {
        for (const [uri, items] of client.getAllPublishedDiagnostics()) {
          const relevant = items.filter((d) => (d.severity ?? 1) <= 2);
          if (relevant.length === 0) continue;
          let fsPath = uri;
          try {
            fsPath = toPosixRelative(this.cwd, fileURLToPath(uri));
          } catch {
            // keep uri
          }
          lines.push(fsPath);
          for (const d of relevant.slice(0, 30)) {
            const lineNum = (d.range?.start?.line ?? 0) + 1;
            const colNum = (d.range?.start?.character ?? 0) + 1;
            const codePart = d.code !== undefined ? ` (${d.code})` : '';
            lines.push(`- [${severityLabel(d.severity)}] ${lineNum}:${colNum}${codePart}: ${d.message || ''}`);
          }
        }
      }
      return lines.length > 0 ? lines.join('\n') : 'No errors or warnings detected.';
    }

    if (!req.path) {
      return `Missing required 'path' parameter for LSP '${req.operation}'.`;
    }

    const absPath = resolveWorkspacePath(this.cwd, req.path);
    if (!fs.existsSync(absPath)) {
      return `File not found: ${toPosixRelative(this.cwd, absPath)}`;
    }

    const serverCfg = this._pickServerForFile(absPath);
    if (!serverCfg) {
      return `No LSP server configured in .lsp.json for '${path.extname(absPath) || path.basename(absPath)}' (configured: ${configs.map((c) => `${c.name}[${c.extensions.join(',')}]`).join(', ')}).`;
    }

    const client = this._getClient(serverCfg);
    const uri = await client.syncDocument(absPath);

    if (req.operation === 'diagnostics') {
      const items = await client.getDiagnosticsForUri(uri);
      const relevant = items.filter((d) => (d.severity ?? 1) <= 2);
      if (relevant.length === 0) {
        return `No errors or warnings in ${toPosixRelative(this.cwd, absPath)}.`;
      }
      const header = `Diagnostics for ${toPosixRelative(this.cwd, absPath)}:`;
      const formatted = relevant.slice(0, 50).map((d) => {
        const lineNum = (d.range?.start?.line ?? 0) + 1;
        const colNum = (d.range?.start?.character ?? 0) + 1;
        const src = d.source ? `[${d.source}] ` : '';
        const codePart = d.code !== undefined ? ` (${d.code})` : '';
        return `- [${severityLabel(d.severity)}] ${lineNum}:${colNum} ${src}${d.message || ''}${codePart}`;
      });
      return [header, ...formatted].join('\n');
    }

    const lineZero = Math.max(0, (req.line ?? 1) - 1);
    const charZero = Math.max(0, (req.character ?? 1) - 1);
    const positionParams = {
      textDocument: { uri },
      position: { line: lineZero, character: charZero },
    };

    if (req.operation === 'hover') {
      const res = await client.request('textDocument/hover', positionParams);
      const text = formatHoverContents(res?.contents);
      if (!text) {
        return `No hover information at ${toPosixRelative(this.cwd, absPath)}:${lineZero + 1}:${charZero + 1}.`;
      }
      return `Hover at ${toPosixRelative(this.cwd, absPath)}:${lineZero + 1}:${charZero + 1}:\n${text}`;
    }

    if (req.operation === 'definition') {
      const res = await client.request('textDocument/definition', positionParams);
      const locs = normalizeLocations(res);
      if (locs.length === 0) {
        return `No definition found for ${toPosixRelative(this.cwd, absPath)}:${lineZero + 1}:${charZero + 1}.`;
      }
      const lines = locs.slice(0, 20).map((loc) => {
        let targetAbs = loc.uri;
        let rel = loc.uri;
        try {
          targetAbs = fileURLToPath(loc.uri);
          rel = toPosixRelative(this.cwd, targetAbs);
        } catch {
          // non-file URI
        }
        const ln = (loc.range?.start?.line ?? 0) + 1;
        const col = (loc.range?.start?.character ?? 0) + 1;
        const preview = targetAbs.startsWith('/') || /^[a-zA-Z]:\\/.test(targetAbs)
          ? readLinePreview(targetAbs, loc.range?.start?.line ?? 0)
          : '';
        return `- ${rel}:${ln}:${col}${preview ? ` — \`${preview}\`` : ''}`;
      });
      return [`Definition(s) for ${toPosixRelative(this.cwd, absPath)}:${lineZero + 1}:${charZero + 1}:`, ...lines].join('\n');
    }

    if (req.operation === 'references') {
      const res = await client.request('textDocument/references', {
        ...positionParams,
        context: { includeDeclaration: true },
      });
      const locs = normalizeLocations(res);
      if (locs.length === 0) {
        return `No references found for ${toPosixRelative(this.cwd, absPath)}:${lineZero + 1}:${charZero + 1}.`;
      }
      const lines = locs.slice(0, 60).map((loc) => {
        let targetAbs = loc.uri;
        let rel = loc.uri;
        try {
          targetAbs = fileURLToPath(loc.uri);
          rel = toPosixRelative(this.cwd, targetAbs);
        } catch {
          // non-file URI
        }
        const ln = (loc.range?.start?.line ?? 0) + 1;
        const col = (loc.range?.start?.character ?? 0) + 1;
        const preview = targetAbs.startsWith('/') || /^[a-zA-Z]:\\/.test(targetAbs)
          ? readLinePreview(targetAbs, loc.range?.start?.line ?? 0)
          : '';
        return `- ${rel}:${ln}:${col}${preview ? ` — \`${preview}\`` : ''}`;
      });
      const suffix = locs.length > 60 ? `\n…and ${locs.length - 60} more reference(s).` : '';
      return [`References (${locs.length}) for ${toPosixRelative(this.cwd, absPath)}:${lineZero + 1}:${charZero + 1}:`, ...lines].join('\n') + suffix;
    }

    return `Unsupported LSP operation '${String(req.operation)}'. Expected definition, references, hover, or diagnostics.`;
  }

  async closeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(all.map((c) => c.close()));
  }
}
