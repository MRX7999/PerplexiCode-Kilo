import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { extractSingleFunctionHeader, findFunctionBlockEnd, parseFunctionHeaderLine } from './diffEngine';

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

/**
 * If `content` is a complete function/method definition that already exists in `original`
 * (or is already present verbatim at `line`), returns the updated file content with the
 * existing function replaced in-place instead of duplicated. Returns `null` when normal
 * insertion should proceed.
 */
export function replaceExistingFunctionOnInsert(original: string, line: number, content: string): string | null {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const normalizedOriginal = original.replace(/\r\n/g, '\n');
  const lines = normalizedOriginal.split('\n');
  const inserted = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

  const isAppend = line <= 0 || line > lines.length;
  const targetIndex = isAppend
    ? (lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length)
    : line - 1;

  // Idempotency guard: if the exact block is already present at or right before targetIndex, do not duplicate it.
  if (inserted.length > 0) {
    const matchesAt = (start: number): boolean => {
      if (start < 0 || start + inserted.length > lines.length) {
        return false;
      }
      for (let i = 0; i < inserted.length; i += 1) {
        if (lines[start + i].trimEnd() !== inserted[i].trimEnd()) {
          return false;
        }
      }
      return true;
    };
    if (matchesAt(targetIndex) || matchesAt(targetIndex - inserted.length)) {
      return original;
    }
  }

  // Function-definition guard: if inserting a complete function/method that already exists, replace it in place.
  const fnHeader = extractSingleFunctionHeader(inserted);
  const insertedEnd = fnHeader ? findFunctionBlockEnd(inserted, fnHeader.lineIndex) : undefined;
  const trailingNonEmpty = insertedEnd !== undefined
    ? inserted.slice(insertedEnd).some((line) => line.trim() !== '')
    : true;
  if (fnHeader && insertedEnd !== undefined && !trailingNonEmpty) {
    const candidates: Array<{ start: number; end: number; distance: number }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      const parsed = parseFunctionHeaderLine(lines[i]);
      if (parsed && parsed.key === fnHeader.key) {
        const end = findFunctionBlockEnd(lines, i);
        if (end !== undefined) {
          const distance = targetIndex >= i && targetIndex <= end
            ? 0
            : Math.min(Math.abs(i - targetIndex), Math.abs(end - targetIndex));
          candidates.push({ start: i, end, distance });
        }
      }
    }
    const nearCandidate = candidates.find((c) => c.distance <= 15);
    const uniqueCandidate = candidates.length === 1 ? candidates[0] : undefined;
    const chosen = nearCandidate || uniqueCandidate;
    if (chosen) {
      lines.splice(chosen.start, chosen.end - chosen.start, ...inserted);
      return lines.join(eol);
    }
  }

  return null;
}

export function insertContent(original: string, line: number, content: string): string {
  const replaced = replaceExistingFunctionOnInsert(original, line, content);
  if (replaced !== null) {
    return replaced;
  }
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const normalizedOriginal = original.replace(/\r\n/g, '\n');
  const lines = normalizedOriginal.split('\n');
  const inserted = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

  const isAppend = line <= 0 || line > lines.length;
  const targetIndex = isAppend
    ? (lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length)
    : line - 1;

  if (isAppend) {
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, ...inserted);
    } else {
      lines.push(...inserted);
    }
  } else {
    lines.splice(targetIndex, 0, ...inserted);
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

/**
 * Strips heredoc body lines (`<<EOF ... EOF`) from a shell command while keeping the command header
 * lines intact so heredoc payloads are never mistaken for shell segments or secret file arguments.
 */
export function stripHeredocBodies(command: string): string {
  let out = '';
  let quote: string | undefined;
  const pendingDelimiters: string[] = [];
  let i = 0;

  while (i < command.length) {
    const char = command[i];
    if (quote) {
      out += char;
      if (char === quote && (quote === '\'' || command[i - 1] !== '\\')) {
        quote = undefined;
      }
      i += 1;
      continue;
    }

    if (char === '\\' && i + 1 < command.length) {
      out += char + command[i + 1];
      i += 2;
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      out += char;
      i += 1;
      continue;
    }

    if (
      char === '<' &&
      command[i + 1] === '<' &&
      command[i - 1] !== '<' &&
      command[i + 2] !== '<'
    ) {
      const rest = command.slice(i);
      const match = /^<<-?\s*(?:(['"])([A-Za-z_][\w-]*)\1|\\?([A-Za-z_][\w-]*))/.exec(rest);
      if (match) {
        const delimiter = match[2] || match[3];
        if (delimiter) {
          pendingDelimiters.push(delimiter);
        }
        out += match[0];
        i += match[0].length;
        continue;
      }
    }

    if (char === '\n') {
      out += '\n';
      i += 1;
      while (pendingDelimiters.length > 0 && i < command.length) {
        const delimiter = pendingDelimiters.shift()!;
        while (i < command.length) {
          const lineEnd = command.indexOf('\n', i);
          const rawLine = lineEnd === -1 ? command.slice(i) : command.slice(i, lineEnd);
          i = lineEnd === -1 ? command.length : lineEnd + 1;
          if (rawLine.replace(/\r$/, '').trim() === delimiter) {
            break;
          }
        }
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * Strips leading shell comments, subshell/group brackets, `env`/`command`/`time`/`nohup` wrappers,
 * and leading `KEY=VALUE` variable assignments from a single command segment.
 */
export function stripLeadingCommandWrappers(command: string): string {
  let s = command.trim();
  while (s.startsWith('#')) {
    const nl = s.indexOf('\n');
    if (nl === -1) {
      return '';
    }
    s = s.slice(nl + 1).trim();
  }
  s = s.replace(/^[({]+/, '').replace(/[)}]+$/, '').trim();

  let changed = true;
  while (changed) {
    changed = false;
    const wrapperMatch = /^(?:env|command|time|nohup)\s+/.exec(s);
    if (wrapperMatch) {
      s = s.slice(wrapperMatch[0].length).trimStart();
      changed = true;
    }
    const envMatch = /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"']*)\s+/.exec(s);
    if (envMatch) {
      s = s.slice(envMatch[0].length).trimStart();
      changed = true;
    }
  }
  return s.replace(/^[({]+/, '').replace(/[)}]+$/, '').trim();
}

export function matchesCommandPrefix(command: string, prefixes: string[]): boolean {
  const normalized = command.trim();
  const unwrapped = stripLeadingCommandWrappers(normalized);
  const candidates = unwrapped && unwrapped !== normalized ? [normalized, unwrapped] : [normalized];
  return prefixes.some((prefix) => {
    const trimmed = prefix.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed === '*') {
      return true;
    }
    return candidates.some(
      (candidate) =>
        candidate === trimmed ||
        candidate.startsWith(`${trimmed} `) ||
        (/[\s/=-]$/.test(trimmed) && candidate.startsWith(trimmed))
    );
  });
}

/** Splits chained shell commands so each segment is checked against the allow list. */
export function splitCommandChain(command: string): string[] {
  const withoutHeredocs = stripHeredocBodies(command).replace(/\\\r?\n/g, ' ');
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  let subshellDepth = 0;

  for (let i = 0; i < withoutHeredocs.length; i += 1) {
    const char = withoutHeredocs[i];
    if (quote) {
      current += char;
      if (char === quote && (quote === '\'' || withoutHeredocs[i - 1] !== '\\')) {
        quote = undefined;
      }
      continue;
    }
    if (char === '\\' && i + 1 < withoutHeredocs.length) {
      current += char + withoutHeredocs[i + 1];
      i += 1;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '$' && withoutHeredocs[i + 1] === '(') {
      subshellDepth += 1;
      current += '$(';
      i += 1;
      continue;
    }
    if (subshellDepth > 0) {
      if (char === '(') {
        subshellDepth += 1;
      } else if (char === ')') {
        subshellDepth -= 1;
      }
      current += char;
      continue;
    }
    const two = withoutHeredocs.slice(i, i + 2);
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
    if (
      char === '&' &&
      withoutHeredocs[i - 1] !== '>' &&
      withoutHeredocs[i - 1] !== '<' &&
      withoutHeredocs[i + 1] !== '>' &&
      withoutHeredocs[i + 1] !== '&'
    ) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments
    .map((segment) => {
      let s = segment.trim();
      while (s.startsWith('#')) {
        const nl = s.indexOf('\n');
        if (nl === -1) {
          return '';
        }
        s = s.slice(nl + 1).trim();
      }
      return s;
    })
    .filter(Boolean);
}

function extractCommandSubstitutions(shellCommand: string): { valid: boolean; subcommands: string[] } {
  const subcommands: string[] = [];
  let quote: '"' | '\'' | undefined;

  for (let i = 0; i < shellCommand.length; i += 1) {
    const ch = shellCommand[i];
    if (quote === '\'') {
      if (ch === '\'') {
        quote = undefined;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < shellCommand.length) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = quote === ch ? undefined : ch;
      continue;
    }
    if (ch === '$' && shellCommand[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let innerQuote: '"' | '\'' | undefined;
      while (j < shellCommand.length && depth > 0) {
        const c = shellCommand[j];
        if (innerQuote === '\'') {
          if (c === '\'') {
            innerQuote = undefined;
          }
          j += 1;
          continue;
        }
        if (c === '\\' && j + 1 < shellCommand.length) {
          j += 2;
          continue;
        }
        if (c === '"' || c === '\'') {
          innerQuote = innerQuote === c ? undefined : c;
          j += 1;
          continue;
        }
        if (c === '(') {
          depth += 1;
        } else if (c === ')') {
          depth -= 1;
        }
        j += 1;
      }
      if (depth !== 0) {
        return { valid: false, subcommands: [] };
      }
      const inner = shellCommand.slice(i + 2, j - 1).trim();
      if (!inner) {
        return { valid: false, subcommands: [] };
      }
      subcommands.push(inner);
      const nested = extractCommandSubstitutions(inner);
      if (!nested.valid) {
        return { valid: false, subcommands: [] };
      }
      subcommands.push(...nested.subcommands);
      i = j - 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < shellCommand.length) {
        if (shellCommand[j] === '\\' && j + 1 < shellCommand.length) {
          j += 2;
          continue;
        }
        if (shellCommand[j] === '`') {
          break;
        }
        j += 1;
      }
      if (j >= shellCommand.length) {
        return { valid: false, subcommands: [] };
      }
      const inner = shellCommand.slice(i + 1, j).trim();
      if (!inner) {
        return { valid: false, subcommands: [] };
      }
      subcommands.push(inner);
      i = j;
    }
  }
  return { valid: true, subcommands };
}

const DEFAULT_SAFE_DEV_PREFIXES = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'git show',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run build',
  'npm run check',
  'npm run typecheck',
  'npx tsc',
  'tsc --noEmit',
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'go test',
  'go vet',
  'cargo test',
  'cargo check',
  'cargo clippy',
];

function isPureEnvAssignment(segment: string): boolean {
  const s = segment.trim().replace(/^[({]+/, '').replace(/[)}]+$/, '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"']*)$/.test(s);
}

function isSafeNavigationSegment(segment: string): boolean {
  const s = stripLeadingCommandWrappers(segment);
  return /^(?:cd(?:\s+[^;&|`$()]+)?|pwd|true|:)$/.test(s);
}

export function isCommandAutoApproved(command: string, allowed: string[], denied: string[]): boolean {
  const shellPart = stripHeredocBodies(command);
  const subs = extractCommandSubstitutions(shellPart);
  if (!subs.valid) {
    return false;
  }

  const mainSegments = splitCommandChain(shellPart);
  if (mainSegments.length === 0) {
    return false;
  }

  const subSegments: string[] = [];
  for (const sub of subs.subcommands) {
    const parts = splitCommandChain(sub);
    if (parts.length === 0) {
      return false;
    }
    subSegments.push(...parts);
  }

  const allSegments = [...mainSegments, ...subSegments];
  const explicitSudoAllowed = allowed.some((p) => {
    const t = p.trim();
    return t === 'sudo' || t.startsWith('sudo ');
  });

  for (const segment of allSegments) {
    if (matchesCommandPrefix(segment, denied)) {
      return false;
    }
    const unwrapped = stripLeadingCommandWrappers(segment);
    if (/^sudo(?:\s|$)/.test(unwrapped) && !explicitSudoAllowed) {
      return false;
    }
  }

  const allowAll = allowed.some((p) => p.trim() === '*');
  if (allowAll) {
    return true;
  }

  // In prefix mode, reject arbitrary root redirects except safe targets (/dev/null, /tmp/*, /var/tmp/*).
  if (/(?:^|[^\d])>{1,2}\s*\/(?!dev\/null\b|tmp\/|var\/tmp\/)/.test(shellPart)) {
    return false;
  }

  const effectiveAllowed = [...allowed, ...DEFAULT_SAFE_DEV_PREFIXES];
  const hasActionMain = mainSegments.some((seg) => !isPureEnvAssignment(seg) && !isSafeNavigationSegment(seg));
  if (!hasActionMain) {
    return mainSegments.every((seg) => isSafeNavigationSegment(seg) || matchesCommandPrefix(seg, effectiveAllowed));
  }

  return allSegments.every(
    (segment) =>
      isPureEnvAssignment(segment)
      || isSafeNavigationSegment(segment)
      || matchesCommandPrefix(segment, effectiveAllowed)
  );
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

/**
 * Claude Code compatible `Glob` tool: finds files matching a glob pattern in the workspace.
 */
export async function globFilesTool(
  host: AgentHost,
  relPath: string,
  pattern: string,
  limit = 400
): Promise<string> {
  const root = resolveWorkspacePath(host.cwd, relPath || '.');
  const stat = await fs.promises.stat(root).catch(() => undefined);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Directory not found: ${relPath || '.'}`);
  }
  const cleanPattern = (pattern || '**/*').trim();
  const matcher = globToRegex(cleanPattern);
  const results: Array<{ rel: string; mtimeMs: number }> = [];
  const queue: string[] = [root];
  let scanned = 0;

  while (queue.length > 0 && scanned < 10_000) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !(entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.vscode' && entry.name !== '.claude' && entry.name !== '.perplexicode')) {
          queue.push(abs);
        }
        continue;
      }
      scanned += 1;
      const relFromRoot = toPosixRelative(root, abs);
      const relFromCwd = toPosixRelative(host.cwd, abs);
      if (matcher.test(relFromRoot) || matcher.test(entry.name) || matcher.test(relFromCwd)) {
        const fileStat = await fs.promises.stat(abs).catch(() => undefined);
        results.push({ rel: relFromCwd, mtimeMs: fileStat?.mtimeMs || 0 });
      }
    }
  }

  if (results.length === 0) {
    return 'No matching files found.';
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
  const sliced = results.slice(0, limit).map((item) => item.rel);
  const suffix = results.length > limit ? `\n\n[Showing ${limit} of ${results.length} matching files.]` : '';
  return sliced.join('\n') + suffix;
}

export interface SearchReplaceOperation {
  search: string;
  replace: string;
  useRegex?: boolean;
  ignoreCase?: boolean;
}

/**
 * Performs one or more search/replace operations (`search_and_replace` / `MultiEdit`).
 */
export function searchAndReplaceContent(
  original: string,
  options: {
    search?: string;
    replace?: string;
    useRegex?: boolean;
    ignoreCase?: boolean;
    startLine?: number;
    endLine?: number;
    operations?: SearchReplaceOperation[];
  }
): { content: string; replacements: number } {
  const crlf = original.includes('\r\n');
  const normalized = original.replace(/\r\n/g, '\n');
  const ops: SearchReplaceOperation[] = Array.isArray(options.operations) && options.operations.length > 0
    ? options.operations
    : options.search !== undefined
      ? [{
        search: options.search,
        replace: options.replace ?? '',
        useRegex: options.useRegex,
        ignoreCase: options.ignoreCase,
      }]
      : [];

  if (ops.length === 0 || ops.every((op) => !op.search)) {
    throw new Error('search_and_replace requires a non-empty <search> string or <operations> JSON array.');
  }

  const lines = normalized.split('\n');
  const startIdx = options.startLine ? Math.max(0, options.startLine - 1) : 0;
  const endIdx = options.endLine ? Math.min(lines.length, options.endLine) : lines.length;
  let targetSlice = lines.slice(startIdx, endIdx).join('\n');
  let totalReplacements = 0;

  for (const op of ops) {
    if (!op.search) continue;
    const normSearch = op.search.replace(/\r\n/g, '\n');
    const normReplace = (op.replace ?? '').replace(/\r\n/g, '\n');
    const flags = `g${op.ignoreCase ? 'i' : ''}`;
    let regex: RegExp;
    try {
      regex = op.useRegex
        ? new RegExp(normSearch, flags)
        : new RegExp(normSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch (error) {
      throw new Error(`Invalid regular expression in search_and_replace: ${(error as Error).message}`);
    }
    const matches = targetSlice.match(regex);
    if (matches && matches.length > 0) {
      totalReplacements += matches.length;
      // Literal mode must not interpret $& / $1 in the replacement; regex mode keeps back-references.
      targetSlice = op.useRegex ? targetSlice.replace(regex, normReplace) : targetSlice.replace(regex, () => normReplace);
    }
  }

  if (totalReplacements === 0) {
    throw new Error('No matches found for search_and_replace.');
  }

  const rebuilt = [
    ...lines.slice(0, startIdx),
    targetSlice,
    ...lines.slice(endIdx),
  ].join('\n');

  return {
    content: crlf ? rebuilt.replace(/\n/g, '\r\n') : rebuilt,
    replacements: totalReplacements,
  };
}

/**
 * Claude Code compatible `WebFetch` tool: fetches an HTTP/HTTPS URL and converts HTML to readable text.
 */
export async function webFetchTool(
  rawUrl: string,
  options: { maxChars?: number; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  const maxChars = options.maxChars || 30_000;
  const timeoutMs = options.timeoutMs || 20_000;
  let currentUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(currentUrl)) {
    throw new Error(`web_fetch requires an http:// or https:// URL (got '${rawUrl}').`);
  }
  if (options.signal?.aborted) {
    throw new Error('Aborted');
  }

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsedUrl = new URL(currentUrl);
    const result = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const req = client.request(
        {
          method: 'GET',
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          headers: {
            'User-Agent': 'PerplexiCode-Kilo/3.3 (+https://github.com/MRX7999/PerplexiCode-Kilo)',
            'Accept': 'text/markdown, text/html, application/json, text/plain;q=0.9, */*;q=0.8',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (data.length < maxChars * 6) {
              data += chunk;
            }
          });
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data }));
          res.on('error', reject);
        }
      );
      if (options.signal) {
        options.signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
      }
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Request to ${currentUrl} timed out`)));
      req.end();
    });

    if ([301, 302, 303, 307, 308].includes(result.statusCode) && result.headers.location) {
      currentUrl = new URL(result.headers.location, currentUrl).toString();
      continue;
    }

    if (result.statusCode >= 400 || result.statusCode === 0) {
      throw new Error(`HTTP ${result.statusCode} when fetching ${currentUrl}`);
    }

    const contentType = String(result.headers['content-type'] || '').toLowerCase();
    let text = result.body;
    if (contentType.includes('application/json')) {
      try {
        text = JSON.stringify(JSON.parse(result.body), null, 2);
      } catch {
        // keep raw
      }
    } else if (contentType.includes('text/html') || /<html|<body|<div|<p\b/i.test(result.body)) {
      text = htmlToReadableText(result.body);
    }

    if (text.length > maxChars) {
      return `${text.slice(0, maxChars)}\n\n[Content truncated at ${maxChars} chars from ${currentUrl}]`;
    }
    return text || '(empty response)';
  }

  throw new Error(`Too many redirects when fetching ${rawUrl}`);
}

export function htmlToReadableText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|header|footer|main|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

