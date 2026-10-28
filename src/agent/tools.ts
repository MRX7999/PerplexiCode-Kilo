import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Workspace tool implementations. Everything VS Code specific goes through AgentHost so the
 * task loop can be unit tested in plain Node.
 */

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface AgentHost {
  readonly cwd: string;
  readFile(absPath: string): Promise<string>;
  /** Writes through the editor so open documents, undo and formatters stay consistent. */
  writeFile(absPath: string, content: string): Promise<void>;
  deleteFile?(absPath: string): Promise<void>;
  /** Returns new error-level diagnostics for the file after an edit (empty string when none). */
  getDiagnostics?(absPath: string): Promise<string>;
  /** Returns all workspace problems formatted for the prompt. */
  getWorkspaceProblems?(): Promise<string>;
  runCommand(command: string, cwd: string, options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void }): Promise<CommandResult>;
  ripgrepPath?(): string | undefined;
  openTabs?(): string[];
  visibleFiles?(): string[];
  activeFile?(): string | undefined;
}

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.nuxt', '.turbo', '.cache',
  '__pycache__', '.venv', 'venv', '.idea', '.gradle', 'target', 'Pods', 'DerivedData', '.parcel-cache',
  'coverage', '.pytest_cache', '.mypy_cache', 'vendor',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.pdf', '.zip', '.gz', '.tgz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.jar', '.wasm', '.mp3', '.mp4', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.sqlite', '.db', '.vsix', '.node', '.o', '.a', '.pyc',
]);

export function resolveWorkspacePath(cwd: string, relPath: string): string {
  const cleaned = relPath.trim().replace(/^["'`]|["'`]$/g, '').replace(/^@\//, '');
  const expanded = cleaned.startsWith('~/') ? path.join(process.env.HOME || '', cleaned.slice(2)) : cleaned;
  return path.resolve(cwd, expanded);
}

export function toPosixRelative(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath) || '.';
  return rel.split(path.sep).join('/');
}

export function isInsideWorkspace(cwd: string, absPath: string): boolean {
  const rel = path.relative(cwd, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function addLineNumbers(content: string, startLine = 1): string {
  const lines = content.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`).join('\n');
}

export interface ReadFileResult {
  text: string;
  totalLines: number;
  truncated: boolean;
}

export async function readFileTool(
  host: AgentHost,
  relPath: string,
  options: { startLine?: number; endLine?: number; maxLines: number }
): Promise<ReadFileResult> {
  const absPath = resolveWorkspacePath(host.cwd, relPath);
  const stat = await fs.promises.stat(absPath).catch(() => undefined);
  if (!stat) {
    throw new Error(`File not found: ${relPath}`);
  }
  if (stat.isDirectory()) {
    throw new Error(`${relPath} is a directory. Use list_files instead.`);
  }
  if (isBinaryPath(absPath)) {
    throw new Error(`${relPath} is a binary file and cannot be read as text.`);
  }
  if (stat.size > 5 * 1024 * 1024) {
    throw new Error(`${relPath} is larger than 5 MB. Use search_files or read a line range.`);
  }
  const content = (await host.readFile(absPath)).replace(/\r\n/g, '\n');
  const lines = content.split('\n');
  const totalLines = lines.length;
  let start = Math.max(1, options.startLine || 1);
  let end = Math.min(totalLines, options.endLine || totalLines);
  let truncated = false;
  if (!options.startLine && !options.endLine && totalLines > options.maxLines) {
    end = options.maxLines;
    truncated = true;
  }
  if (start > end) {
    start = end;
  }
  const slice = lines.slice(start - 1, end).join('\n');
  let text = addLineNumbers(slice, start);
  if (truncated) {
    text += `\n\n[Showing lines 1-${end} of ${totalLines}. Use start_line/end_line to read more, or search_files to find specific code.]`;
  }
  return { text, totalLines, truncated };
}

export async function listFilesTool(host: AgentHost, relPath: string, recursive: boolean, limit = 400): Promise<string> {
  const root = resolveWorkspacePath(host.cwd, relPath || '.');
  const stat = await fs.promises.stat(root).catch(() => undefined);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Directory not found: ${relPath}`);
  }
  const results: string[] = [];
  let hitLimit = false;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.DS_Store') {
        continue;
      }
      const abs = path.join(dir, entry.name);
      const rel = toPosixRelative(root, abs);
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        if (recursive && !IGNORED_DIRS.has(entry.name) && !(entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.vscode')) {
          queue.push(abs);
        }
      } else {
        results.push(rel);
      }
      if (results.length >= limit) {
        hitLimit = true;
        break;
      }
    }
    if (hitLimit) {
      break;
    }
  }
  if (results.length === 0) {
    return 'No files found.';
  }
  return results.join('\n') + (hitLimit ? `\n\n[File list truncated at ${limit} entries. Use list_files on a subdirectory to explore further.]` : '');
}

export async function searchFilesTool(
  host: AgentHost,
  relPath: string,
  regex: string,
  filePattern: string | undefined,
  signal: AbortSignal
): Promise<string> {
  const root = resolveWorkspacePath(host.cwd, relPath || '.');
  let compiled: RegExp;
  try {
    compiled = new RegExp(regex);
  } catch (error) {
    throw new Error(`Invalid regex: ${(error as Error).message}`);
  }

  const rg = host.ripgrepPath?.();
  if (rg && fs.existsSync(rg)) {
    try {
      const output = await runRipgrep(rg, root, regex, filePattern, signal);
      return formatRipgrepJson(output, host.cwd);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      // Fall through to the JS implementation.
    }
  }
  return jsSearch(root, compiled, filePattern, host.cwd);
}

function runRipgrep(rg: string, root: string, regex: string, filePattern: string | undefined, signal: AbortSignal): Promise<string> {
  const args = ['--json', '-e', regex, '--context', '1', '--max-columns', '300', '--max-count', '50', '--no-messages'];
  if (filePattern) {
    args.push('--glob', filePattern);
  }
  for (const dir of IGNORED_DIRS) {
    args.push('--glob', `!**/${dir}/**`);
  }
  args.push(root);
  return new Promise((resolve, reject) => {
    const child = cp.spawn(rg, args, { signal });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 4_000_000) {
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 || code === 1 || output ? resolve(output) : reject(new Error(`ripgrep exited with ${code}`))));
  });
}

function formatRipgrepJson(output: string, cwd: string): string {
  const byFile = new Map<string, string[]>();
  let matches = 0;
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let event: { type: string; data: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'match' && event.type !== 'context') {
      continue;
    }
    const file = event.data.path?.text;
    if (!file) {
      continue;
    }
    const rel = toPosixRelative(cwd, file);
    const list = byFile.get(rel) || [];
    const text = (event.data.lines?.text || '').replace(/\n$/, '');
    list.push(`${event.type === 'match' ? '>' : ' '}${String(event.data.line_number).padStart(5, ' ')} | ${text}`);
    byFile.set(rel, list);
    if (event.type === 'match') {
      matches += 1;
    }
    if (matches >= 300) {
      break;
    }
  }
  return formatSearchGroups(byFile, matches);
}

function formatSearchGroups(byFile: Map<string, string[]>, matches: number): string {
  if (matches === 0) {
    return 'Found 0 results.';
  }
  const parts = [`Found ${matches}${matches >= 300 ? '+' : ''} result(s).`];
  for (const [file, lines] of byFile) {
    parts.push(`\n# ${file}\n${lines.join('\n')}`);
  }
  return parts.join('\n');
}

async function jsSearch(root: string, regex: RegExp, filePattern: string | undefined, cwd: string): Promise<string> {
  const glob = filePattern ? globToRegex(filePattern) : undefined;
  const byFile = new Map<string, string[]>();
  let matches = 0;
  const queue = [root];
  let filesScanned = 0;
  while (queue.length > 0 && matches < 300 && filesScanned < 5000) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push(abs);
        }
        continue;
      }
      if (isBinaryPath(abs) || (glob && !glob.test(entry.name) && !glob.test(toPosixRelative(root, abs)))) {
        continue;
      }
      filesScanned += 1;
      let content: string;
      try {
        const stat = await fs.promises.stat(abs);
        if (stat.size > 1024 * 1024) {
          continue;
        }
        content = await fs.promises.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const out: string[] = [];
      lines.forEach((line, index) => {
        if (matches < 300 && regex.test(line)) {
          matches += 1;
          out.push(`>${String(index + 1).padStart(5, ' ')} | ${line.slice(0, 300)}`);
        }
      });
      if (out.length > 0) {
        byFile.set(toPosixRelative(cwd, abs), out);
      }
    }
  }
  return formatSearchGroups(byFile, matches);
}

export function globToRegex(glob: string): RegExp {
  const braces = glob.replace(/\{([^}]+)\}/g, (_, inner: string) => `(${inner.split(',').map(escapeGlobPart).join('|')})`);
  const pattern = braces
    .split(/(\([^)]*\))/)
    .map((part) => (part.startsWith('(') ? part : escapeGlobPart(part)))
    .join('');
  return new RegExp(`(^|/)${pattern}$`, 'i');
}

function escapeGlobPart(part: string): string {
  return part
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(.*/)?');
}

const DEFINITION_PATTERNS: Array<{ ext: RegExp; patterns: RegExp[] }> = [
  {
    ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/i,
    patterns: [
      /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+[A-Za-z0-9_$]+/,
      /^\s*(export\s+)?(default\s+)?(async\s+)?function\*?\s+[A-Za-z0-9_$]+/,
      /^\s*(export\s+)?(interface|type|enum)\s+[A-Za-z0-9_$]+/,
      /^\s*(export\s+)?const\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?(\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/,
      /^\s*(public|private|protected|static|async|readonly|\s)*[A-Za-z0-9_$]+\s*\([^)]*\)\s*(:\s*[^={]+)?\s*\{\s*$/,
    ],
  },
  { ext: /\.py$/i, patterns: [/^\s*(async\s+)?def\s+\w+/, /^\s*class\s+\w+/] },
  { ext: /\.go$/i, patterns: [/^func\s+(\([^)]*\)\s*)?\w+/, /^type\s+\w+\s+(struct|interface)/] },
  { ext: /\.rs$/i, patterns: [/^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+\w+/, /^\s*(pub\s+)?(struct|enum|trait|impl|mod)\b/] },
  { ext: /\.(swift)$/i, patterns: [/^\s*(public|private|internal|open|fileprivate)?\s*(final\s+)?(class|struct|enum|protocol|extension|actor)\s+\w+/, /^\s*(public|private|internal|open|fileprivate)?\s*(static\s+)?func\s+\w+/] },
  { ext: /\.(java|kt|kts|cs|scala)$/i, patterns: [/^\s*(public|private|protected|internal)?\s*(static\s+)?(final\s+|abstract\s+|data\s+|sealed\s+)?(class|interface|enum|object|record)\s+\w+/, /^\s*(public|private|protected|internal|override)\s+[\w<>[\],\s]+\s+\w+\s*\(/, /^\s*(suspend\s+)?fun\s+\w+/] },
  { ext: /\.(c|cc|cpp|cxx|h|hpp|m|mm)$/i, patterns: [/^\s*(class|struct|namespace|enum)\s+\w+/, /^[A-Za-z_][\w\s\*&:<>,]*\s+\**[A-Za-z_][\w:]*\s*\([^;]*\)\s*\{?\s*$/, /^\s*[-+]\s*\([^)]*\)\s*\w+/, /^@(interface|implementation|protocol)\s+\w+/] },
  { ext: /\.(rb)$/i, patterns: [/^\s*(def|class|module)\s+\w+/] },
  { ext: /\.(php)$/i, patterns: [/^\s*(abstract\s+|final\s+)?(class|interface|trait)\s+\w+/, /^\s*(public|private|protected|static|\s)*function\s+\w+/] },
  { ext: /\.(sh|bash|zsh)$/i, patterns: [/^\s*(function\s+)?\w+\s*\(\)\s*\{/] },
];

export async function listCodeDefinitionsTool(host: AgentHost, relPath: string): Promise<string> {
  const target = resolveWorkspacePath(host.cwd, relPath || '.');
  const stat = await fs.promises.stat(target).catch(() => undefined);
  if (!stat) {
    throw new Error(`Path not found: ${relPath}`);
  }
  const files: string[] = [];
  if (stat.isDirectory()) {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    entries.filter((entry) => entry.isFile()).forEach((entry) => files.push(path.join(target, entry.name)));
  } else {
    files.push(target);
  }
  const output: string[] = [];
  for (const file of files.slice(0, 50)) {
    const spec = DEFINITION_PATTERNS.find((entry) => entry.ext.test(file));
    if (!spec) {
      continue;
    }
    let content: string;
    try {
      content = await host.readFile(file);
    } catch {
      continue;
    }
    const definitions: string[] = [];
    content.split(/\r?\n/).forEach((line, index) => {
      if (line.length < 300 && spec.patterns.some((pattern) => pattern.test(line)) && !/^\s*(if|for|while|switch|catch|return)\b/.test(line)) {
        definitions.push(`${String(index + 1).padStart(5, ' ')} | ${line.trim()}`);
      }
    });
    if (definitions.length > 0) {
      output.push(`# ${toPosixRelative(host.cwd, file)}\n${definitions.slice(0, 200).join('\n')}`);
    }
  }
  return output.length > 0 ? output.join('\n\n') : 'No source code definitions found.';
}

export function insertContent(original: string, line: number, content: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.replace(/\r\n/g, '\n').split('\n');
  const inserted = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (line <= 0 || line > lines.length) {
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, ...inserted);
    } else {
      lines.push(...inserted);
    }
  } else {
    lines.splice(line - 1, 0, ...inserted);
  }
  return lines.join(eol);
}

export function truncateOutput(output: string, maxLines: number): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) {
    return output;
  }
  const head = Math.floor(maxLines * 0.2);
  const tail = maxLines - head;
  return [
    ...lines.slice(0, head),
    `\n[... ${lines.length - maxLines} lines omitted ...]\n`,
    ...lines.slice(lines.length - tail),
  ].join('\n');
}

/** Strips ANSI escape codes from terminal output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');
}

export function matchesCommandPrefix(command: string, prefixes: string[]): boolean {
  const normalized = command.trim();
  return prefixes.some((prefix) => {
    const trimmed = prefix.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed === '*') {
      return true;
    }
    return normalized === trimmed || normalized.startsWith(`${trimmed} `) || (/[\s/=-]$/.test(trimmed) && normalized.startsWith(trimmed));
  });
}

/** Splits chained shell commands so each segment is checked against the allow list. */
export function splitCommandChain(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      current += char;
      if (char === quote && command[i - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

export function isCommandAutoApproved(command: string, allowed: string[], denied: string[]): boolean {
  if (/\$\(|`|>\s*\/|\bsudo\b/.test(command)) {
    return false;
  }
  const segments = splitCommandChain(command);
  if (segments.length === 0) {
    return false;
  }
  return segments.every((segment) => matchesCommandPrefix(segment, allowed) && !matchesCommandPrefix(segment, denied));
}

/** Default shell runner used by the VS Code host. */
export function spawnShellCommand(
  command: string,
  cwd: string,
  options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/zsh');
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-l', '-c', command];
    let output = '';
    let timedOut = false;
    let aborted = false;
    let finished = false;
    const child = cp.spawn(shell, args, {
      cwd,
      env: { ...process.env, ...options.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', NO_COLOR: '1', CI: process.env.CI || '' },
      detached: !isWindows,
    });

    const kill = () => {
      try {
        if (!isWindows && child.pid) {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        child.kill('SIGKILL');
      }
    };

    const onData = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString());
      output += text;
      if (output.length > 2_000_000) {
        output = output.slice(-1_000_000);
      }
      options.onOutput?.(text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = options.timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal.addEventListener('abort', onAbort);

    const finish = (exitCode: number | null) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal.removeEventListener('abort', onAbort);
      resolve({ exitCode, output, timedOut, aborted });
    };
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}
