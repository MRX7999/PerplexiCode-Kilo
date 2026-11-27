import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';
import { CompletionProvider } from '../agent/task';
import { AgentHost, CommandResult, resolveWorkspacePath } from '../agent/tools';
import { CompletionRequest, CompletionResult } from '../agent/transport';
import { getModelLabel } from '../api/modelCatalog';
import { LspManager, LspQueryRequest } from './lsp';
import { NodeAgentHost } from './nodeHost';
import { CoreSession, RunResult } from './runner';
import { defaultSettings, loadSettings } from './settings';
import type { CoreEvent } from './types';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class RemoteSecurityViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSecurityViolationError';
  }
}

const FORBIDDEN_SECRET_KEYS = new Set([
  'sessiontoken',
  'csrftoken',
  'fullcookies',
  'cookie',
  'cookies',
  'perplexitycookie',
  'pplxcookie',
]);

const FORBIDDEN_SECRET_VALUE_RE =
  /(__Secure-next-auth\.session-token\s*=|next-auth\.csrf-token\s*=|pplx\.visitor-id\s*=)/i;

/**
 * Enforces F26's security boundary: Perplexity session cookies, CSRF tokens, and account secrets
 * must NEVER cross the remote core transport in either direction.
 */
export function assertNoSessionSecretsOnWire(value: unknown, keyPath = 'root'): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (FORBIDDEN_SECRET_VALUE_RE.test(value)) {
      throw new RemoteSecurityViolationError(
        `Blocked attempt to transmit Perplexity session cookie/CSRF material in '${keyPath}'. Perplexity sessions must remain on the IDE machine.`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoSessionSecretsOnWire(value[i], `${keyPath}[${i}]`);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = k.replace(/[-_]/g, '').toLowerCase();
      if (FORBIDDEN_SECRET_KEYS.has(normalizedKey) && typeof v === 'string' && v.trim().length > 0) {
        throw new RemoteSecurityViolationError(
          `Blocked attempt to transmit credential field '${keyPath}.${k}' to/from remote core. Perplexity sessions must remain on the IDE machine.`
        );
      }
      assertNoSessionSecretsOnWire(v, `${keyPath}.${k}`);
    }
  }
}

/** Constant-time token comparison over fixed-length SHA-256 digests so token length is not leaked. */
export function verifyBearerTokenConstantTime(expected: string, candidate: string | undefined): boolean {
  if (!expected || !candidate) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(candidate, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function generateServeToken(): string {
  return randomBytes(32).toString('hex');
}

export function writeServeTokenFile(token: string, homeDir?: string): string {
  const dir = path.join(homeDir || process.env.HOME || os.homedir(), '.perplexicode');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'serve.token');
  fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows does not enforce POSIX chmod bits
  }
  return file;
}

// -----------------------------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket Frame Codec (pure Node, zero external dependencies)
// -----------------------------------------------------------------------------------------------

function encodeWsFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  if (mask) headerLen += 4;

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f); // FIN=1
  let offset = 2;
  const maskBit = mask ? 0x80 : 0x00;
  if (len < 126) {
    frame[1] = maskBit | len;
  } else if (len <= 0xffff) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }

  if (mask) {
    const maskKey = randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i & 3];
    }
  } else {
    payload.copy(frame, offset);
  }
  return frame;
}

class WsStreamAdapter {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;

  constructor(
    private readonly socket: Duplex,
    private readonly maskOutbound: boolean,
    private readonly onTextMessage: (text: string) => void,
    private readonly onClose: () => void
  ) {
    socket.on('data', (chunk: Buffer) => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('end', () => this._handleClose());
    socket.on('error', () => this._handleClose());
  }

  sendText(text: string): void {
    if (this.closed) return;
    const frame = encodeWsFrame(0x01, Buffer.from(text, 'utf8'), this.maskOutbound);
    try {
      this.socket.write(frame);
    } catch {
      this._handleClose();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeWsFrame(0x08, Buffer.alloc(0), this.maskOutbound));
      this.socket.end();
    } catch {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.onClose();
  }

  private _handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private _onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLen = second & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) {
          this.close();
          return;
        }
        payloadLen = Number(big);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) {
        return;
      }

      let payload = this.buffer.slice(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const maskKey = this.buffer.slice(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }
      this.buffer = this.buffer.slice(offset + maskLen + payloadLen);

      if (opcode === 0x08) {
        // Close
        this.close();
        return;
      }
      if (opcode === 0x09) {
        // Ping -> Pong
        if (!this.closed) {
          try {
            this.socket.write(encodeWsFrame(0x0a, payload, this.maskOutbound));
          } catch {
            // ignore
          }
        }
        continue;
      }
      if (opcode === 0x0a) {
        // Pong
        continue;
      }

      if (opcode === 0x00) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.fragmentOpcode === 0x01) {
            this.onTextMessage(full.toString('utf8'));
          }
          this.fragmentOpcode = 0;
        }
      } else if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          if (opcode === 0x01) {
            this.onTextMessage(payload.toString('utf8'));
          }
        } else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Bidirectional JSON-RPC 2.0 Channel (used by both Server and Client over WS or Unix Socket)
// -----------------------------------------------------------------------------------------------

interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

class BidirectionalRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (res: any) => void; reject: (err: Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly sendRaw: (jsonText: string) => void,
    private readonly closeTransport: () => void,
    private readonly onRequest: (method: string, params: any) => Promise<any>,
    private readonly onNotification?: (method: string, params: any) => void
  ) {}

  call<T = any>(method: string, params?: any): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`Remote core connection is closed (calling ${method}).`));
    }
    if (method !== 'auth') {
      assertNoSessionSecretsOnWire(params, `${method}.params`);
    }
    const id = this.nextId++;
    const msg: JsonRpcEnvelope = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendRaw(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: any): void {
    if (this.closed) return;
    assertNoSessionSecretsOnWire(params, `${method}.params`);
    const msg: JsonRpcEnvelope = { jsonrpc: '2.0', method, params };
    try {
      this.sendRaw(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  async handleIncomingText(rawText: string): Promise<void> {
    let msg: JsonRpcEnvelope;
    try {
      msg = JSON.parse(rawText) as JsonRpcEnvelope;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // Notification
    if (msg.id === undefined && typeof msg.method === 'string') {
      assertNoSessionSecretsOnWire(msg.params, `${msg.method}.params`);
      this.onNotification?.(msg.method, msg.params);
      return;
    }

    // Request
    if (msg.id !== undefined && typeof msg.method === 'string') {
      const reqId = msg.id;
      try {
        if (msg.method !== 'auth') {
          assertNoSessionSecretsOnWire(msg.params, `${msg.method}.params`);
        }
        const result = await this.onRequest(msg.method, msg.params);
        assertNoSessionSecretsOnWire(result, `${msg.method}.result`);
        if (!this.closed) {
          this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: reqId, result: result ?? null }));
        }
      } catch (err) {
        const errorMessage = (err as Error)?.message || String(err);
        const code = err instanceof RemoteSecurityViolationError ? -32001 : -32000;
        if (!this.closed) {
          this.sendRaw(
            JSON.stringify({
              jsonrpc: '2.0',
              id: reqId,
              error: { code, message: errorMessage },
            })
          );
        }
      }
      return;
    }

    // Response
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message || 'Remote core RPC error'));
      } else {
        try {
          assertNoSessionSecretsOnWire(msg.result, 'rpc.result');
          waiter.resolve(msg.result);
        } catch (secErr) {
          waiter.reject(secErr as Error);
        }
      }
    }
  }

  handleTransportClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error('Remote core connection closed.');
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  close(): void {
    this.handleTransportClosed();
    this.closeTransport();
  }
}

// -----------------------------------------------------------------------------------------------
// Remote Core Daemon (`pcode serve`)
// -----------------------------------------------------------------------------------------------

export interface RemoteCoreServerOptions {
  cwd: string;
  token: string;
  /** Unix domain socket path (mutually combinable or alternative to host/port). */
  socketPath?: string;
  /** TCP host for WebSocket listener (default `127.0.0.1`). */
  host?: string;
  /** TCP port for WebSocket listener (`0` picks an ephemeral port). */
  port?: number;
  version?: string;
  trustProject?: boolean;
  log?: (line: string) => void;
}

export interface RemoteCoreServerHandle {
  readonly cwd: string;
  readonly socketPath?: string;
  readonly wsUrl?: string;
  readonly port?: number;
  /** Inspects every raw JSON payload received by the daemon (for security / zero-cookie auditing in tests). */
  getWireAuditFrames(): string[];
  close(): Promise<void>;
}

/**
 * Starts the `pcode serve` daemon over Unix domain socket (`0600`) and/or RFC 6455 WebSocket
 * protected by a constant-time bearer token.
 *
 * Security design:
 * - No `AccountManager` or Perplexity cookies are loaded or accepted on the daemon.
 * - All LLM completions (`session/run`) reverse-proxy `llm/complete` back to the IDE client,
 *   keeping Perplexity sessions strictly on the IDE machine.
 */
export async function startRemoteCoreServer(options: RemoteCoreServerOptions): Promise<RemoteCoreServerHandle> {
  if (!options.token || options.token.trim().length < 8) {
    throw new Error('Remote core server requires a bearer token of at least 8 characters.');
  }
  if (!options.socketPath && options.port === undefined) {
    throw new Error('Specify socketPath and/or port for startRemoteCoreServer.');
  }

  const cwd = path.resolve(options.cwd);
  const hostImpl = new NodeAgentHost(cwd);
  const lsp = new LspManager(cwd, { trustProject: options.trustProject !== false });
  const activePeers = new Set<BidirectionalRpcPeer>();
  const runningCommands = new Map<string, AbortController>();
  const runningSessions = new Map<string, CoreSession>();
  const wireAudit: string[] = [];

  const recordAudit = (raw: string) => {
    // Redact the auth handshake token itself if recorded, while keeping everything else verbatim so tests can verify no Perplexity cookies ever crossed the wire.
    const sanitized = raw.replace(/"token"\s*:\s*"[^"]*"/g, '"token":"[BEARER_REDACTED]"');
    wireAudit.push(sanitized);
    if (wireAudit.length > 500) wireAudit.shift();
  };

  const attachSessionPeer = (
    sendLine: (jsonText: string) => void,
    closeUnderlying: () => void,
    preAuthenticated: boolean
  ) => {
    let authenticated = preAuthenticated;
    let peer!: BidirectionalRpcPeer;

    const handleMethod = async (method: string, params: any): Promise<any> => {
      if (method === 'auth') {
        const candidate = typeof params?.token === 'string' ? params.token : undefined;
        if (!verifyBearerTokenConstantTime(options.token, candidate)) {
          setTimeout(() => peer.close(), 10);
          throw new Error('Unauthorized: invalid bearer token.');
        }
        authenticated = true;
        return {
          authenticated: true,
          cwd,
          version: options.version || '4.0.0',
          pid: process.pid,
        };
      }

      if (!authenticated) {
        setTimeout(() => peer.close(), 10);
        throw new Error('Unauthorized: authenticate first.');
      }

      switch (method) {
        case 'daemon/info':
          return {
            cwd,
            version: options.version || '4.0.0',
            pid: process.pid,
            platform: process.platform,
          };

        case 'host/readFile': {
          const abs = resolveWorkspacePath(cwd, String(params?.path || ''));
          const content = await hostImpl.readFile(abs);
          return { content };
        }

        case 'host/writeFile': {
          const abs = resolveWorkspacePath(cwd, String(params?.path || ''));
          await hostImpl.writeFile(abs, String(params?.content ?? ''));
          return { ok: true };
        }

        case 'host/deleteFile': {
          const abs = resolveWorkspacePath(cwd, String(params?.path || ''));
          await hostImpl.deleteFile(abs);
          return { ok: true };
        }

        case 'host/runCommand': {
          const cmdId = String(params?.commandId || randomBytes(8).toString('hex'));
          const cmdCwd = params?.cwd ? resolveWorkspacePath(cwd, String(params.cwd)) : cwd;
          const timeoutMs = Number(params?.timeoutMs ?? 120_000);
          const ac = new AbortController();
          runningCommands.set(cmdId, ac);
          try {
            const res = await hostImpl.runCommand(String(params?.command || ''), cmdCwd, {
              signal: ac.signal,
              timeoutMs,
              onOutput: (chunk) => {
                peer.notify('command/output', { commandId: cmdId, chunk });
              },
            });
            return res;
          } finally {
            runningCommands.delete(cmdId);
          }
        }

        case 'host/abortCommand': {
          const cmdId = String(params?.commandId || '');
          runningCommands.get(cmdId)?.abort();
          return { aborted: true };
        }

        case 'lsp/query': {
          const text = await lsp.query({
            operation: params?.operation,
            path: params?.path,
            line: params?.line !== undefined ? Number(params.line) : undefined,
            character: params?.character !== undefined ? Number(params.character) : undefined,
          });
          return { text };
        }

        case 'session/run': {
          const runId = String(params?.runId || randomBytes(8).toString('hex'));
          const prompt = String(params?.prompt || '');
          const mode = String(params?.mode || 'code');
          const modelId = String(params?.baseModelId || 'turbo');
          const thinking = Boolean(params?.thinking);
          const webSearch = Boolean(params?.webSearch);
          const computeMode = params?.computeMode;
          const worktree = params?.worktree;
          const permissionMode = params?.permissionMode;

          // Reverse-proxy CompletionProvider: delegates every LLM turn back to the IDE client
          // so Perplexity cookies never exist on the remote daemon!
          const remoteProxyProvider: CompletionProvider = {
            complete: async (req: CompletionRequest): Promise<CompletionResult> => {
              const res = await peer.call<CompletionResult>('llm/complete', {
                runId,
                fullPrompt: req.fullPrompt,
                followUpPrompt: req.followUpPrompt,
                thread: req.thread,
                baseModelId: req.baseModelId,
                thinking: req.thinking,
                webSearch: req.webSearch,
                computeMode: req.computeMode,
                stopOnFallback: req.stopOnFallback,
              });
              return res;
            },
          };

          const settings = loadSettings(cwd, { trustProjectHooks: options.trustProject !== false });
          const baseDefaults = defaultSettings();
          const session = new CoreSession({
            cwd,
            provider: remoteProxyProvider,
            agentSettings: {
              autoApprove: {
                enabled: true,
                read: true,
                readOutsideWorkspace: false,
                write: Boolean(params?.autoApproveWrite ?? true),
                execute: Boolean(params?.autoApproveExecute ?? true),
                modeSwitch: true,
                subtasks: true,
                todo: true,
                retry: true,
                mcp: false,
                web: false,
              },
              allowedCommands: Array.isArray(params?.allowedCommands) ? params.allowedCommands : ['*'],
              deniedCommands: ['rm -rf', 'sudo'],
              maxRequests: Number(params?.maxRequests ?? 40),
              maxReadLines: 500,
              commandTimeoutSec: 120,
              terminalOutputLines: 300,
              webSearch: 'auto',
              contextStrategy: 'auto',
              maxPromptChars: 60000,
              language: 'auto',
              customInstructions: '',
              modeInstructions: {},
              diffEnabled: true,
              includeFileListOnStart: true,
              repoMapEnabled: baseDefaults.repoMapEnabled,
              repoMapMaxChars: baseDefaults.repoMapMaxChars,
              autoCompactThreshold: baseDefaults.autoCompactThreshold,
              autoCompactKeepSteps: baseDefaults.autoCompactKeepSteps,
            },
            selection: { baseModelId: modelId, thinking, webSearch, computeMode },
            mode,
            permissionMode,
            settings,
            journal: params?.journal !== false,
            getModelLabel: (id, th) => getModelLabel(id, th),
            trustProjectHooks: options.trustProject !== false,
            worktree,
            onAsk: async (_task, message) => {
              if (params?.interactiveApprovals) {
                const reply = await peer.call<{ response: 'yes' | 'no' | 'message'; text?: string }>(
                  'session/ask',
                  { runId, kind: message.ask?.kind, text: message.text, tool: message.tool, command: message.command }
                );
                return reply;
              }
              return { response: 'yes' };
            },
            onMessage: (_task, msg) => {
              peer.notify('session/message', { runId, message: msg });
            },
            onEvent: (_task, ev: CoreEvent) => {
              peer.notify('session/event', { runId, event: ev });
            },
            log: (line) => options.log?.(line),
          });

          runningSessions.set(runId, session);
          try {
            const result: RunResult = await session.run(prompt);
            return result;
          } finally {
            runningSessions.delete(runId);
          }
        }

        case 'session/abort': {
          const runId = String(params?.runId || '');
          runningSessions.get(runId)?.abort();
          return { aborted: true };
        }

        default:
          throw new Error(`Unknown remote core RPC method '${method}'.`);
      }
    };

    peer = new BidirectionalRpcPeer(sendLine, closeUnderlying, handleMethod);
    activePeers.add(peer);
    return peer;
  };

  let unixServer: net.Server | undefined;
  let httpServer: http.Server | undefined;
  let boundPort: number | undefined;
  const bindHost = options.host || '127.0.0.1';

  if (options.socketPath) {
    const sockPath = path.resolve(options.socketPath);
    fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(sockPath)) {
      const stat = fs.lstatSync(sockPath);
      if (stat.isSocket()) {
        fs.unlinkSync(sockPath);
      } else {
        throw new Error(`Refusing to overwrite non-socket file at ${sockPath}`);
      }
    }

    unixServer = net.createServer((socket) => {
      let buf = '';
      const peer = attachSessionPeer(
        (jsonText) => {
          socket.write(`${jsonText}\n`, 'utf8');
        },
        () => {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        },
        false
      );
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            recordAudit(line);
            void peer.handleIncomingText(line);
          }
          nl = buf.indexOf('\n');
        }
      });
      const cleanup = () => {
        activePeers.delete(peer);
        peer.handleTransportClosed();
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    });

    await new Promise<void>((resolve, reject) => {
      unixServer!.once('error', reject);
      unixServer!.listen(sockPath, () => {
        try {
          fs.chmodSync(sockPath, 0o600);
        } catch {
          // ignore on platforms without unix socket chmod
        }
        resolve();
      });
    });
  }

  if (options.port !== undefined) {
    httpServer = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        const authHeader = String(req.headers.authorization || '');
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (!verifyBearerTokenConstantTime(options.token, bearer)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cwd, version: options.version || '4.0.0' }));
        return;
      }
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required (WebSocket)');
    });

    httpServer.on('upgrade', (req, socket, head) => {
      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : String(req.headers['x-pcode-token'] || '').trim();

      if (!verifyBearerTokenConstantTime(options.token, bearer)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nUnauthorized');
        socket.destroy();
        return;
      }

      const wsKey = String(req.headers['sec-websocket-key'] || '').trim();
      const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
      if (!wsKey || upgradeHeader !== 'websocket') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = createHash('sha1')
        .update(wsKey + WS_MAGIC_GUID, 'ascii')
        .digest('base64');

      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '\r\n',
        ].join('\r\n')
      );

      let peer!: BidirectionalRpcPeer;
      const ws = new WsStreamAdapter(
        socket,
        false,
        (text) => {
          recordAudit(text);
          void peer.handleIncomingText(text);
        },
        () => {
          activePeers.delete(peer);
          peer.handleTransportClosed();
        }
      );

      peer = attachSessionPeer(
        (jsonText) => ws.sendText(jsonText),
        () => ws.close(),
        true // Authenticated on HTTP Upgrade via Bearer token
      );

      if (head && head.length > 0) {
        socket.unshift(head);
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer!.once('error', reject);
      httpServer!.listen(options.port, bindHost, () => {
        const addr = httpServer!.address();
        if (addr && typeof addr === 'object') {
          boundPort = addr.port;
        }
        resolve();
      });
    });
  }

  return {
    cwd,
    socketPath: options.socketPath ? path.resolve(options.socketPath) : undefined,
    wsUrl: boundPort !== undefined ? `ws://${bindHost}:${boundPort}` : undefined,
    port: boundPort,
    getWireAuditFrames: () => [...wireAudit],
    close: async () => {
      for (const [, ac] of runningCommands) ac.abort();
      runningCommands.clear();
      for (const [, sess] of runningSessions) sess.abort();
      runningSessions.clear();
      for (const p of [...activePeers]) p.close();
      activePeers.clear();
      await lsp.closeAll();
      if (unixServer) {
        await new Promise<void>((resolve) => unixServer!.close(() => resolve()));
        if (options.socketPath && fs.existsSync(options.socketPath)) {
          try {
            fs.unlinkSync(options.socketPath);
          } catch {
            // ignore
          }
        }
      }
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      }
    },
  };
}

// -----------------------------------------------------------------------------------------------
// IDE / Client connector (`RemoteCoreClient` + `RemoteAgentHost`)
// -----------------------------------------------------------------------------------------------

export interface RemoteCoreClientOptions {
  /** Target endpoint: `unix:///path/to/pcode.sock`, `/path/to/pcode.sock`, `ws://host:port`, or `wss://host:port`. */
  endpoint: string;
  /** Bearer token stored in IDE SecretStorage or CLI runtime memory. */
  token: string;
  /**
   * Local completion provider running on the IDE machine so Perplexity sessions stay strictly local
   * and are never transmitted to the remote `pcode serve` daemon.
   */
  localCompletionProvider?: CompletionProvider;
  onSessionEvent?: (runId: string, event: CoreEvent) => void;
  onSessionMessage?: (runId: string, message: unknown) => void;
  onAsk?: (
    runId: string,
    payload: { kind?: string; text?: string; tool?: unknown; command?: unknown }
  ) => Promise<{ response: 'yes' | 'no' | 'message'; text?: string }>;
}

export class RemoteCoreClient {
  private peer?: BidirectionalRpcPeer;
  private remoteCwd = '';
  private remoteVersion = '';
  private readonly outputListeners = new Map<string, (chunk: string) => void>();

  constructor(private readonly options: RemoteCoreClientOptions) {}

  get cwd(): string {
    return this.remoteCwd;
  }

  get version(): string {
    return this.remoteVersion;
  }

  get connected(): boolean {
    return Boolean(this.peer);
  }

  async connect(): Promise<{ cwd: string; version: string; pid: number }> {
    const endpoint = this.options.endpoint.trim();
    if (!endpoint) {
      throw new Error('Remote endpoint is empty.');
    }

    const handleServerRequest = async (method: string, params: any): Promise<any> => {
      if (method === 'llm/complete') {
        if (!this.options.localCompletionProvider) {
          throw new Error('IDE client has no localCompletionProvider configured for remote llm/complete.');
        }
        const ac = new AbortController();
        const result = await this.options.localCompletionProvider.complete({
          fullPrompt: String(params?.fullPrompt || ''),
          followUpPrompt: typeof params?.followUpPrompt === 'string' ? params.followUpPrompt : undefined,
          thread: params?.thread,
          baseModelId: String(params?.baseModelId || 'turbo'),
          thinking: Boolean(params?.thinking),
          webSearch: Boolean(params?.webSearch),
          computeMode: params?.computeMode,
          stopOnFallback: Boolean(params?.stopOnFallback),
          signal: ac.signal,
        });
        // Strip everything except non-secret completion fields before sending over the wire
        return {
          text: result.text,
          meta: result.meta,
          accountAlias: result.accountAlias,
          modelLabel: result.modelLabel,
          citations: result.citations,
          thread: result.thread,
          usedFollowUp: result.usedFollowUp,
          promptChars: result.promptChars,
          route: result.route,
        } satisfies CompletionResult;
      }

      if (method === 'session/ask') {
        if (this.options.onAsk) {
          return this.options.onAsk(String(params?.runId || ''), params);
        }
        return { response: 'yes' };
      }

      throw new Error(`Unsupported reverse RPC '${method}'.`);
    };

    const handleServerNotification = (method: string, params: any) => {
      if (method === 'command/output' && typeof params?.commandId === 'string') {
        this.outputListeners.get(params.commandId)?.(String(params.chunk ?? ''));
      } else if (method === 'session/event') {
        this.options.onSessionEvent?.(String(params?.runId || ''), params?.event as CoreEvent);
      } else if (method === 'session/message') {
        this.options.onSessionMessage?.(String(params?.runId || ''), params?.message);
      }
    };

    if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
      const parsed = new URL(endpoint);
      const isTls = parsed.protocol === 'wss:';
      const reqMod = isTls ? https : http;
      const wsKey = randomBytes(16).toString('base64');

      const socket = await new Promise<Duplex>((resolve, reject) => {
        const req = reqMod.request({
          protocol: isTls ? 'https:' : 'http:',
          hostname: parsed.hostname,
          port: parsed.port || (isTls ? 443 : 80),
          path: `${parsed.pathname || '/'}${parsed.search || ''}`,
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': wsKey,
            Authorization: `Bearer ${this.options.token}`,
          },
        });
        req.once('error', reject);
        req.once('response', (res) => {
          res.resume();
          reject(new Error(`Remote core WebSocket handshake failed with HTTP ${res.statusCode || 0}.`));
        });
        req.once('upgrade', (res, sock, head) => {
          const expectedAccept = createHash('sha1')
            .update(wsKey + WS_MAGIC_GUID, 'ascii')
            .digest('base64');
          if (res.headers['sec-websocket-accept'] !== expectedAccept) {
            sock.destroy();
            reject(new Error('Invalid Sec-WebSocket-Accept from remote core daemon.'));
            return;
          }
          if (head && head.length > 0) {
            sock.unshift(head);
          }
          resolve(sock);
        });
        req.end();
      });

      let peer!: BidirectionalRpcPeer;
      const ws = new WsStreamAdapter(
        socket,
        true,
        (text) => {
          void peer.handleIncomingText(text);
        },
        () => {
          peer.handleTransportClosed();
          if (this.peer === peer) this.peer = undefined;
        }
      );

      peer = new BidirectionalRpcPeer(
        (jsonText) => ws.sendText(jsonText),
        () => ws.close(),
        handleServerRequest,
        handleServerNotification
      );
      this.peer = peer;
      const info = await peer.call<{ cwd: string; version: string; pid: number }>('daemon/info');
      this.remoteCwd = info.cwd;
      this.remoteVersion = info.version;
      return info;
    }

    // Unix domain socket (`unix:///path/to/pcode.sock` or `/path/to/pcode.sock`)
    const socketPath = endpoint.startsWith('unix://') ? endpoint.slice('unix://'.length) : endpoint;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ path: socketPath });
      s.once('error', reject);
      s.once('connect', () => resolve(s));
    });

    let buf = '';
    const peer = new BidirectionalRpcPeer(
      (jsonText) => {
        socket.write(`${jsonText}\n`, 'utf8');
      },
      () => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      },
      handleServerRequest,
      handleServerNotification
    );

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          void peer.handleIncomingText(line);
        }
        nl = buf.indexOf('\n');
      }
    });
    const onClosed = () => {
      peer.handleTransportClosed();
      if (this.peer === peer) this.peer = undefined;
    };
    socket.on('close', onClosed);
    socket.on('error', onClosed);

    this.peer = peer;
    const authInfo = await peer.call<{ cwd: string; version: string; pid: number }>('auth', {
      token: this.options.token,
    });
    this.remoteCwd = authInfo.cwd;
    this.remoteVersion = authInfo.version;
    return authInfo;
  }

  private _requirePeer(): BidirectionalRpcPeer {
    if (!this.peer) {
      throw new Error('RemoteCoreClient is not connected.');
    }
    return this.peer;
  }

  async readFile(filePath: string): Promise<string> {
    const res = await this._requirePeer().call<{ content: string }>('host/readFile', { path: filePath });
    return res.content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this._requirePeer().call('host/writeFile', { path: filePath, content });
  }

  async deleteFile(filePath: string): Promise<void> {
    await this._requirePeer().call('host/deleteFile', { path: filePath });
  }

  async runCommand(
    command: string,
    cwd: string,
    options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void }
  ): Promise<CommandResult> {
    const peer = this._requirePeer();
    const commandId = randomBytes(8).toString('hex');
    if (options.onOutput) {
      this.outputListeners.set(commandId, options.onOutput);
    }
    const onAbort = () => {
      void peer.call('host/abortCommand', { commandId }).catch(() => undefined);
    };
    if (options.signal.aborted) {
      return { exitCode: null, output: '', timedOut: false, aborted: true };
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await peer.call<CommandResult>('host/runCommand', {
        commandId,
        command,
        cwd,
        timeoutMs: options.timeoutMs,
      });
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      this.outputListeners.delete(commandId);
    }
  }

  async lspQuery(request: LspQueryRequest): Promise<string> {
    const res = await this._requirePeer().call<{ text: string }>('lsp/query', request);
    return res.text;
  }

  async runRemoteSession(params: {
    prompt: string;
    mode?: string;
    baseModelId?: string;
    thinking?: boolean;
    webSearch?: boolean;
    computeMode?: string;
    worktree?: string | boolean;
    permissionMode?: string;
    autoApproveWrite?: boolean;
    autoApproveExecute?: boolean;
    allowedCommands?: string[];
    maxRequests?: number;
    interactiveApprovals?: boolean;
    journal?: boolean;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const peer = this._requirePeer();
    const runId = randomBytes(8).toString('hex');
    const onAbort = () => {
      void peer.call('session/abort', { runId }).catch(() => undefined);
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const { signal: _sig, ...wireParams } = params;
      return await peer.call<RunResult>('session/run', { runId, ...wireParams });
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
    }
  }

  createAgentHost(): RemoteAgentHost {
    return new RemoteAgentHost(this);
  }

  close(): void {
    this.peer?.close();
    this.peer = undefined;
  }
}

/**
 * `AgentHost` backed by a connected `RemoteCoreClient` (`pcode serve`).
 * Allows IDE `AgentTask` runs to execute all workspace reads, writes, commands, and LSP queries on
 * the remote daemon while Perplexity sessions remain locally in VS Code's `SecretStorage`.
 */
export class RemoteAgentHost implements AgentHost {
  constructor(private readonly client: RemoteCoreClient) {}

  get cwd(): string {
    return this.client.cwd;
  }

  readFile(absPath: string): Promise<string> {
    return this.client.readFile(absPath);
  }

  writeFile(absPath: string, content: string): Promise<void> {
    return this.client.writeFile(absPath, content);
  }

  deleteFile(absPath: string): Promise<void> {
    return this.client.deleteFile(absPath);
  }

  async getDiagnostics(absPath: string): Promise<string> {
    const res = await this.client.lspQuery({ operation: 'diagnostics', path: absPath });
    if (/^No errors or warnings|^No LSP servers configured/i.test(res)) {
      return '';
    }
    return res;
  }

  getWorkspaceProblems(): Promise<string> {
    return this.client.lspQuery({ operation: 'diagnostics' });
  }

  runCommand(
    command: string,
    cwd: string,
    options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void }
  ): Promise<CommandResult> {
    return this.client.runCommand(command, cwd, options);
  }

  lspQuery(request: LspQueryRequest): Promise<string> {
    return this.client.lspQuery(request);
  }
}
