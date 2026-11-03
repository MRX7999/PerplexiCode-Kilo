import * as fs from 'fs';
import * as path from 'path';
import { perplexicodeHome } from './journal';

/**
 * File-backed replacements for vscode.Memento and vscode.SecretStorage, so the existing
 * AccountManager (account rotation, cookies, CSRF refresh) runs unchanged in the CLI.
 *
 *   ~/.perplexicode/state.json         account metadata (aliases, counters, cooldowns)
 *   ~/.perplexicode/credentials.json   session token, CSRF and full cookie string per account
 *
 * Both files are created with mode 0600 inside a 0700 directory. Secrets are never accepted as
 * command line arguments by the CLI (they would leak into shell history and `ps`).
 */

function readJsonFile(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonFile(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
}

export class FileMemento {
  private data: Record<string, unknown>;

  constructor(private readonly file: string) {
    this.data = readJsonFile(file);
  }

  keys(): readonly string[] {
    return Object.keys(this.data);
  }

  get<T>(key: string, defaultValue?: T): T {
    return (key in this.data ? this.data[key] : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data = readJsonFile(this.file);
    if (value === undefined) {
      delete this.data[key];
    } else {
      this.data[key] = value;
    }
    writeJsonFile(this.file, this.data);
  }

  setKeysForSync(): void {
    // Not applicable outside VS Code.
  }
}

export class FileSecretStorage {
  private readonly listeners: Array<(event: { key: string }) => void> = [];

  constructor(private readonly file: string) {}

  async get(key: string): Promise<string | undefined> {
    const value = readJsonFile(this.file)[key];
    return typeof value === 'string' ? value : undefined;
  }

  async store(key: string, value: string): Promise<void> {
    const data = readJsonFile(this.file);
    data[key] = value;
    writeJsonFile(this.file, data);
    this.listeners.forEach((listener) => listener({ key }));
  }

  async delete(key: string): Promise<void> {
    const data = readJsonFile(this.file);
    delete data[key];
    writeJsonFile(this.file, data);
    this.listeners.forEach((listener) => listener({ key }));
  }

  async keys(): Promise<string[]> {
    return Object.keys(readJsonFile(this.file));
  }

  onDidChange(listener: (event: { key: string }) => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
  }
}

export function cliStores(home = perplexicodeHome()): { state: FileMemento; secrets: FileSecretStorage; stateFile: string; secretsFile: string } {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stateFile = path.join(home, 'state.json');
  const secretsFile = path.join(home, 'credentials.json');
  return { state: new FileMemento(stateFile), secrets: new FileSecretStorage(secretsFile), stateFile, secretsFile };
}

/** Parses a pasted Cookie header / cookie string into the Perplexity session pieces. */
export function parseCookieInput(input: string): { sessionToken: string; csrfToken: string; fullCookies?: string } | undefined {
  const text = input.trim().replace(/^cookie:\s*/i, '');
  if (!text) return undefined;
  // Netscape cookies.txt export
  if (text.includes('\t')) {
    const pairs: string[] = [];
    let session: string | undefined;
    let csrf: string | undefined;
    for (const line of text.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 7 || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
      if (!parts[0].includes('perplexity.ai')) continue;
      const name = parts[5];
      const value = parts[6].trim();
      pairs.push(`${name}=${value}`);
      if (name === '__Secure-next-auth.session-token') session = value;
      if (name === 'next-auth.csrf-token' || name === '__Host-next-auth.csrf-token') csrf = value;
    }
    return session ? { sessionToken: session, csrfToken: csrf || 'auto', fullCookies: pairs.join('; ') } : undefined;
  }
  const session = text.match(/__Secure-next-auth\.session-token=([^;\s]+)/);
  if (session) {
    const csrf = text.match(/(?:__Host-)?next-auth\.csrf-token=([^;\s]+)/);
    return { sessionToken: session[1], csrfToken: csrf ? csrf[1] : 'auto', fullCookies: text };
  }
  if (/^eyJ[\w.-]+$/.test(text) || /^[\w-]+\.\.[\w.-]+$/.test(text)) {
    return { sessionToken: text, csrfToken: 'auto' };
  }
  return undefined;
}
