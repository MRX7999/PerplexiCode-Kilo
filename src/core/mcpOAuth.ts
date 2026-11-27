import * as cp from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { McpSecretStore } from './mcpCredentials';

export interface McpOAuthConfig {
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  clientId?: string;
  scopes?: string[];
}

export interface McpOAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  scope?: string;
  clientId: string;
  tokenUrl: string;
  authorizationUrl?: string;
  serverUrl: string;
  updatedAt: number;
}

export interface McpOAuthTokenStore {
  get(serverName: string, serverUrl: string): Promise<McpOAuthTokenSet | undefined>;
  save(serverName: string, serverUrl: string, tokens: McpOAuthTokenSet): Promise<void>;
  remove(serverName: string, serverUrl: string): Promise<boolean>;
}

export interface McpOAuthRuntimeProvider {
  getAccessToken(serverName: string, serverUrl: string): Promise<string | undefined>;
  onUnauthorized(serverName: string, serverUrl: string): Promise<string | undefined>;
}

const KEYCHAIN_SERVICE = 'perplexicode-mcp-oauth';

export function normalizeMcpOAuthServerUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl.trim());
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return serverUrl.trim().replace(/\/$/, '');
  }
}

export function mcpOAuthStorageKey(serverName: string, serverUrl: string): string {
  const normalized = normalizeMcpOAuthServerUrl(serverUrl);
  const digest = createHash('sha256')
    .update(JSON.stringify([serverName.trim(), normalized]))
    .digest('hex');
  return `perplexicode.mcp.oauth.v1.${digest}`;
}

function parseStoredTokens(raw: string | undefined): McpOAuthTokenSet | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<McpOAuthTokenSet>;
    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof parsed.accessToken !== 'string'
      || !parsed.accessToken.trim()
      || typeof parsed.clientId !== 'string'
      || typeof parsed.tokenUrl !== 'string'
      || typeof parsed.serverUrl !== 'string'
    ) {
      return undefined;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken ? parsed.refreshToken : undefined,
      tokenType: typeof parsed.tokenType === 'string' && parsed.tokenType ? parsed.tokenType : 'Bearer',
      expiresAt: typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : undefined,
      scope: typeof parsed.scope === 'string' && parsed.scope ? parsed.scope : undefined,
      clientId: parsed.clientId,
      tokenUrl: parsed.tokenUrl,
      authorizationUrl: typeof parsed.authorizationUrl === 'string' ? parsed.authorizationUrl : undefined,
      serverUrl: parsed.serverUrl,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return undefined;
  }
}

/**
 * IDE token store backed by VS Code `SecretStorage` (`McpSecretStore`).
 */
export class SecretStorageMcpOAuthStore implements McpOAuthTokenStore {
  constructor(private readonly secrets: McpSecretStore) {}

  async get(serverName: string, serverUrl: string): Promise<McpOAuthTokenSet | undefined> {
    const raw = await this.secrets.get(mcpOAuthStorageKey(serverName, serverUrl));
    return parseStoredTokens(raw);
  }

  async save(serverName: string, serverUrl: string, tokens: McpOAuthTokenSet): Promise<void> {
    await this.secrets.store(mcpOAuthStorageKey(serverName, serverUrl), JSON.stringify(tokens));
  }

  async remove(serverName: string, serverUrl: string): Promise<boolean> {
    const key = mcpOAuthStorageKey(serverName, serverUrl);
    const existing = await this.secrets.get(key);
    await this.secrets.delete(key);
    return Boolean(existing);
  }
}

export interface KeychainExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type KeychainCommandRunner = (
  command: string,
  args: string[],
  stdinText?: string
) => Promise<KeychainExecResult>;

function defaultKeychainRunner(command: string, args: string[], stdinText?: string): Promise<KeychainExecResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: KeychainExecResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ code: 127, stdout: '', stderr: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ code: 124, stdout, stderr: 'keychain command timed out' });
    }, 5000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ code: 127, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 1, stdout, stderr });
    });
    try {
      if (stdinText !== undefined) {
        child.stdin.write(stdinText, 'utf8');
      }
      child.stdin.end();
    } catch {
      // ignore broken pipe
    }
  });
}

/**
 * CLI token store backed by the OS keychain:
 * - macOS: `/usr/bin/security -i` (stdin batch mode so secrets never enter process argv)
 * - Linux: `secret-tool` (libsecret, secret passed via stdin)
 * - Windows: PowerShell DPAPI protected file (`ConvertFrom-SecureString` / `ConvertTo-SecureString` via stdin)
 * Falls back to a `0600` file `~/.perplexicode/mcp-oauth.json` when headless/no keychain daemon is available.
 */
export class SystemKeychainMcpOAuthStore implements McpOAuthTokenStore {
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: KeychainCommandRunner;
  private readonly allowFileFallback: boolean;

  constructor(options?: {
    home?: string;
    platform?: NodeJS.Platform;
    runner?: KeychainCommandRunner;
    allowFileFallback?: boolean;
  }) {
    this.home = options?.home || os.homedir();
    this.platform = options?.platform || process.platform;
    this.run = options?.runner || defaultKeychainRunner;
    this.allowFileFallback = options?.allowFileFallback ?? true;
  }

  private fallbackPath(): string {
    return path.join(this.home, '.perplexicode', 'mcp-oauth.json');
  }

  private readFallbackMap(): Record<string, string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fallbackPath(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  }

  private writeFallbackMap(entries: Record<string, string>): void {
    const file = this.fallbackPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ignore
    }
  }

  async get(serverName: string, serverUrl: string): Promise<McpOAuthTokenSet | undefined> {
    const account = mcpOAuthStorageKey(serverName, serverUrl);
    if (this.platform === 'darwin') {
      const res = await this.run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
      if (res.code === 0 && res.stdout.trim()) {
        const hex = res.stdout.trim();
        const decoded = /^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0
          ? Buffer.from(hex, 'hex').toString('utf8')
          : hex;
        const tokens = parseStoredTokens(decoded);
        if (tokens) return tokens;
      }
    } else if (this.platform === 'linux') {
      const res = await this.run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
      if (res.code === 0 && res.stdout.trim()) {
        const tokens = parseStoredTokens(res.stdout.trim());
        if (tokens) return tokens;
      }
    } else if (this.platform === 'win32') {
      const dpapiFile = path.join(this.home, '.perplexicode', 'keychain', `${account}.dpapi`);
      if (fs.existsSync(dpapiFile)) {
        const cipher = fs.readFileSync(dpapiFile, 'utf8').trim();
        const script = '$enc = [Console]::In.ReadToEnd().Trim(); $sec = ConvertTo-SecureString $enc; $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }';
        const res = await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], cipher);
        if (res.code === 0 && res.stdout.trim()) {
          const tokens = parseStoredTokens(res.stdout.trim());
          if (tokens) return tokens;
        }
      }
    }
    if (!this.allowFileFallback) return undefined;
    const map = this.readFallbackMap();
    return parseStoredTokens(map[account]);
  }

  async save(serverName: string, serverUrl: string, tokens: McpOAuthTokenSet): Promise<void> {
    const account = mcpOAuthStorageKey(serverName, serverUrl);
    const serialized = JSON.stringify(tokens);
    let storedInKeychain = false;

    if (this.platform === 'darwin') {
      // Encode JSON as hex and pass command via `security -i` stdin so no secret ever touches argv.
      const hex = Buffer.from(serialized, 'utf8').toString('hex');
      const cmdLine = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${hex}\n`;
      const res = await this.run('/usr/bin/security', ['-i'], cmdLine);
      storedInKeychain = res.code === 0;
    } else if (this.platform === 'linux') {
      const res = await this.run(
        'secret-tool',
        ['store', `--label=PerplexiCode MCP (${serverName})`, 'service', KEYCHAIN_SERVICE, 'account', account],
        serialized
      );
      storedInKeychain = res.code === 0;
    } else if (this.platform === 'win32') {
      const script = '$plain = [Console]::In.ReadToEnd(); $sec = ConvertTo-SecureString $plain -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $sec))';
      const res = await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], serialized);
      if (res.code === 0 && res.stdout.trim()) {
        const dpapiDir = path.join(this.home, '.perplexicode', 'keychain');
        fs.mkdirSync(dpapiDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dpapiDir, `${account}.dpapi`), res.stdout.trim(), { encoding: 'utf8', mode: 0o600 });
        storedInKeychain = true;
      }
    }

    if (storedInKeychain) {
      // Clean up any stale fallback entry if OS keychain succeeded.
      const map = this.readFallbackMap();
      if (account in map) {
        delete map[account];
        this.writeFallbackMap(map);
      }
      return;
    }

    if (!this.allowFileFallback) {
      throw new Error('The system keychain is unavailable and the file fallback is disabled.');
    }
    const map = this.readFallbackMap();
    map[account] = serialized;
    this.writeFallbackMap(map);
  }

  async remove(serverName: string, serverUrl: string): Promise<boolean> {
    const account = mcpOAuthStorageKey(serverName, serverUrl);
    let removed = false;

    if (this.platform === 'darwin') {
      const res = await this.run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
      if (res.code === 0) removed = true;
    } else if (this.platform === 'linux') {
      const res = await this.run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
      if (res.code === 0) removed = true;
    } else if (this.platform === 'win32') {
      const dpapiFile = path.join(this.home, '.perplexicode', 'keychain', `${account}.dpapi`);
      if (fs.existsSync(dpapiFile)) {
        fs.unlinkSync(dpapiFile);
        removed = true;
      }
    }

    if (this.allowFileFallback) {
      const map = this.readFallbackMap();
      if (account in map) {
        delete map[account];
        this.writeFallbackMap(map);
        removed = true;
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------------------------
// PKCE (RFC 7636 S256) + HTTP JSON helpers
// ---------------------------------------------------------------------------------------------

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  return { codeVerifier, codeChallenge };
}

interface HttpRawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequestRaw(
  targetUrl: string,
  options: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<HttpRawResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid OAuth URL: ${targetUrl}`));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const method = options.method || 'GET';
    const bodyBuf = options.body !== undefined ? Buffer.from(options.body, 'utf8') : undefined;
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      ...(options.headers || {}),
    };
    if (bodyBuf) {
      headers['Content-Length'] = bodyBuf.byteLength;
    }
    const req = client.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        timeout: options.timeoutMs ?? 15_000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body,
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`OAuth request timed out: ${parsed.origin}${parsed.pathname}`)));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export interface DiscoveredOAuthEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  scopesSupported?: string[];
}

/**
 * Discovers OAuth 2.0 endpoints per MCP specification (RFC 9728 Protected Resource Metadata
 * `/.well-known/oauth-protected-resource` + RFC 8414 `/.well-known/oauth-authorization-server`),
 * overlaid with any explicit `oauth` fields from `.mcp.json`.
 */
export async function discoverMcpOAuthEndpoints(
  serverUrl: string,
  explicit?: McpOAuthConfig
): Promise<DiscoveredOAuthEndpoints> {
  if (explicit?.authorizationUrl && explicit?.tokenUrl) {
    return {
      authorizationUrl: explicit.authorizationUrl,
      tokenUrl: explicit.tokenUrl,
      registrationUrl: explicit.registrationUrl,
      scopesSupported: explicit.scopes,
    };
  }

  const base = new URL(serverUrl);
  const origin = base.origin;
  let authIssuerOrigin = origin;

  // 1. Try Protected Resource Metadata (RFC 9728)
  const resourceMetadataCandidates = [
    `${origin}/.well-known/oauth-protected-resource${base.pathname === '/' ? '' : base.pathname}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ];
  for (const candidate of resourceMetadataCandidates) {
    const res = await httpRequestRaw(candidate, { timeoutMs: 8000 }).catch(() => undefined);
    if (res && res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const json = JSON.parse(res.body) as { authorization_servers?: unknown };
        if (Array.isArray(json.authorization_servers) && typeof json.authorization_servers[0] === 'string') {
          authIssuerOrigin = json.authorization_servers[0].replace(/\/$/, '');
          break;
        }
      } catch {
        // ignore invalid metadata
      }
    }
  }

  // 2. Try Authorization Server Metadata (RFC 8414 / OIDC)
  const issuerUrl = new URL(authIssuerOrigin);
  const metadataCandidates = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname === '/' ? '' : issuerUrl.pathname}`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}/.well-known/openid-configuration`,
  ];
  for (const candidate of metadataCandidates) {
    const res = await httpRequestRaw(candidate, { timeoutMs: 8000 }).catch(() => undefined);
    if (res && res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const meta = JSON.parse(res.body) as Record<string, unknown>;
        const authorizationUrl = explicit?.authorizationUrl
          || (typeof meta.authorization_endpoint === 'string' ? meta.authorization_endpoint : undefined);
        const tokenUrl = explicit?.tokenUrl
          || (typeof meta.token_endpoint === 'string' ? meta.token_endpoint : undefined);
        if (authorizationUrl && tokenUrl) {
          return {
            authorizationUrl,
            tokenUrl,
            registrationUrl: explicit?.registrationUrl
              || (typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : undefined),
            scopesSupported: Array.isArray(meta.scopes_supported)
              ? (meta.scopes_supported as unknown[]).filter((s): s is string => typeof s === 'string')
              : explicit?.scopes,
          };
        }
      } catch {
        // try next
      }
    }
  }

  // 3. Conventional MCP fallback paths on the authorization origin (`<origin>/authorize`, `<origin>/token`)
  return {
    authorizationUrl: explicit?.authorizationUrl || `${issuerUrl.origin}/authorize`,
    tokenUrl: explicit?.tokenUrl || `${issuerUrl.origin}/token`,
    registrationUrl: explicit?.registrationUrl,
    scopesSupported: explicit?.scopes,
  };
}

async function dynamicallyRegisterClient(
  registrationUrl: string,
  redirectUri: string,
  serverName: string
): Promise<string | undefined> {
  const payload = JSON.stringify({
    client_name: `PerplexiCode (${serverName})`,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  const res = await httpRequestRaw(registrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    timeoutMs: 10_000,
  }).catch(() => undefined);
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return undefined;
  try {
    const parsed = JSON.parse(res.body) as { client_id?: unknown };
    return typeof parsed.client_id === 'string' && parsed.client_id.trim() ? parsed.client_id.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface McpOAuthLoginOptions {
  serverName: string;
  serverUrl: string;
  store: McpOAuthTokenStore;
  oauthConfig?: McpOAuthConfig;
  clientId?: string;
  scopes?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  openAuthorizationUrl: (authorizationUrl: string) => Promise<void> | void;
}

/**
 * Performs standard OAuth 2.0 Authorization Code + PKCE (`S256`) login with an ephemeral
 * `http://127.0.0.1:<port>/callback` loopback listener and saves the resulting tokens in `store`.
 */
export async function performMcpOAuthLogin(options: McpOAuthLoginOptions): Promise<McpOAuthTokenSet> {
  const serverUrl = normalizeMcpOAuthServerUrl(options.serverUrl);
  const endpoints = await discoverMcpOAuthEndpoints(serverUrl, options.oauthConfig);
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const expectedState = randomBytes(24).toString('base64url');
  const timeoutMs = options.timeoutMs ?? 120_000;

  let resolveCallback!: (code: string) => void;
  let rejectCallback!: (err: Error) => void;
  const callbackPromise = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const loopbackServer = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const errParam = reqUrl.searchParams.get('error');
      const errDesc = reqUrl.searchParams.get('error_description');
      if (errParam) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h3>Authorization failed</h3><p>You may close this tab.</p></body></html>');
        rejectCallback(new Error(`OAuth authorization denied: ${errParam}${errDesc ? ` (${errDesc})` : ''}`));
        return;
      }
      const state = reqUrl.searchParams.get('state');
      const code = reqUrl.searchParams.get('code');
      if (!state || state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h3>Invalid OAuth state</h3><p>CSRF state mismatch.</p></body></html>');
        rejectCallback(new Error('OAuth callback rejected due to state mismatch.'));
        return;
      }
      if (!code || !code.trim()) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h3>Missing authorization code</h3></body></html>');
        rejectCallback(new Error('OAuth callback did not include an authorization code.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h3>PerplexiCode: signed in</h3><p>You can close this browser window.</p></body></html>');
      resolveCallback(code.trim());
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal callback error');
      rejectCallback(err as Error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    loopbackServer.once('error', reject);
    loopbackServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = loopbackServer.address();
  if (!address || typeof address === 'string') {
    loopbackServer.close();
    throw new Error('Failed to bind 127.0.0.1 loopback OAuth listener.');
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;

  let timer: NodeJS.Timeout | undefined;
  try {
    let clientId = options.clientId?.trim() || options.oauthConfig?.clientId?.trim();
    if (!clientId && endpoints.registrationUrl) {
      clientId = await dynamicallyRegisterClient(endpoints.registrationUrl, redirectUri, options.serverName);
    }
    if (!clientId) {
      clientId = 'perplexicode-cli';
    }

    const scopes = options.scopes?.length
      ? options.scopes
      : options.oauthConfig?.scopes?.length
        ? options.oauthConfig.scopes
        : undefined;

    const authUrl = new URL(endpoints.authorizationUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', expectedState);
    if (scopes && scopes.length > 0) {
      authUrl.searchParams.set('scope', scopes.join(' '));
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`OAuth login timed out after ${Math.round(timeoutMs / 1000)}s waiting for loopback callback.`));
      }, timeoutMs);
      if (options.signal) {
        if (options.signal.aborted) {
          reject(new Error('OAuth login cancelled.'));
          return;
        }
        options.signal.addEventListener('abort', () => reject(new Error('OAuth login cancelled.')), { once: true });
      }
    });

    await options.openAuthorizationUrl(authUrl.toString());
    const code = await Promise.race([callbackPromise, timeoutPromise]);

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    const tokenRes = await httpRequestRaw(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: 15_000,
    });

    if (tokenRes.statusCode < 200 || tokenRes.statusCode >= 300) {
      throw new Error(`OAuth token endpoint returned HTTP ${tokenRes.statusCode}.`);
    }

    let parsedToken: Record<string, unknown>;
    try {
      parsedToken = JSON.parse(tokenRes.body) as Record<string, unknown>;
    } catch {
      throw new Error('OAuth token endpoint returned invalid JSON.');
    }
    const accessToken = typeof parsedToken.access_token === 'string' ? parsedToken.access_token.trim() : '';
    if (!accessToken) {
      throw new Error('OAuth token response did not contain access_token.');
    }
    const expiresIn = typeof parsedToken.expires_in === 'number' && Number.isFinite(parsedToken.expires_in)
      ? parsedToken.expires_in
      : undefined;

    const tokenSet: McpOAuthTokenSet = {
      accessToken,
      refreshToken: typeof parsedToken.refresh_token === 'string' && parsedToken.refresh_token.trim()
        ? parsedToken.refresh_token.trim()
        : undefined,
      tokenType: typeof parsedToken.token_type === 'string' && parsedToken.token_type.trim()
        ? parsedToken.token_type.trim()
        : 'Bearer',
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      scope: typeof parsedToken.scope === 'string' ? parsedToken.scope : scopes?.join(' '),
      clientId,
      tokenUrl: endpoints.tokenUrl,
      authorizationUrl: endpoints.authorizationUrl,
      serverUrl,
      updatedAt: Date.now(),
    };

    await options.store.save(options.serverName, serverUrl, tokenSet);
    return tokenSet;
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve) => loopbackServer.close(() => resolve()));
  }
}

/**
 * Exchanges a stored `refresh_token` at `tokenUrl` and updates `store` in place.
 */
export async function refreshMcpOAuthToken(
  serverName: string,
  serverUrl: string,
  store: McpOAuthTokenStore
): Promise<McpOAuthTokenSet | undefined> {
  const normalizedUrl = normalizeMcpOAuthServerUrl(serverUrl);
  const current = await store.get(serverName, normalizedUrl);
  if (!current || !current.refreshToken || !current.tokenUrl) {
    return undefined;
  }

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: current.clientId,
  });

  const res = await httpRequestRaw(current.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    timeoutMs: 15_000,
  }).catch(() => undefined);

  if (!res || res.statusCode < 200 || res.statusCode >= 300) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
    if (!accessToken) return undefined;
    const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
      ? parsed.expires_in
      : undefined;
    const updated: McpOAuthTokenSet = {
      ...current,
      accessToken,
      refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim()
        ? parsed.refresh_token.trim()
        : current.refreshToken,
      tokenType: typeof parsed.token_type === 'string' && parsed.token_type.trim()
        ? parsed.token_type.trim()
        : current.tokenType || 'Bearer',
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      scope: typeof parsed.scope === 'string' ? parsed.scope : current.scope,
      updatedAt: Date.now(),
    };
    await store.save(serverName, normalizedUrl, updated);
    return updated;
  } catch {
    return undefined;
  }
}

/**
 * Runtime provider wired into `McpRegistry` / `HttpMcpConnection` so HTTP/SSE MCP servers
 * automatically attach stored OAuth bearer tokens and refresh once upon HTTP `401`.
 */
export function createMcpOAuthRuntimeProvider(store: McpOAuthTokenStore): McpOAuthRuntimeProvider {
  const inflightRefresh = new Map<string, Promise<string | undefined>>();

  return {
    async getAccessToken(serverName: string, serverUrl: string): Promise<string | undefined> {
      const normalized = normalizeMcpOAuthServerUrl(serverUrl);
      const existing = await store.get(serverName, normalized);
      if (!existing) return undefined;
      // Proactively refresh if expired (with 15s skew) and refreshToken is present.
      if (existing.expiresAt && existing.expiresAt <= Date.now() + 15_000 && existing.refreshToken) {
        const refreshed = await refreshMcpOAuthToken(serverName, normalized, store);
        if (refreshed) return refreshed.accessToken;
      }
      return existing.accessToken;
    },

    async onUnauthorized(serverName: string, serverUrl: string): Promise<string | undefined> {
      const normalized = normalizeMcpOAuthServerUrl(serverUrl);
      const key = mcpOAuthStorageKey(serverName, normalized);
      const pending = inflightRefresh.get(key);
      if (pending) return pending;
      const attempt = refreshMcpOAuthToken(serverName, normalized, store)
        .then((tokens) => tokens?.accessToken)
        .finally(() => inflightRefresh.delete(key));
      inflightRefresh.set(key, attempt);
      return attempt;
    },
  };
}
