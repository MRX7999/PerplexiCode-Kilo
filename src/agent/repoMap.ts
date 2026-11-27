import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { IGNORED_DIRS, isBroadScanRoot, toPosixRelative } from './tools';

export interface RepoSymbol {
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method' | 'struct' | 'trait';
  name: string;
  signature: string;
  exported: boolean;
  line: number;
}

export interface RepoFileNode {
  relPath: string;
  isTest: boolean;
  symbols: RepoSymbol[];
  rawImports: string[];
  resolvedImports: string[];
  importedBy: string[];
  relatedTests: string[];
  score: number;
  priorityReason: string;
}

export interface RepoMapOptions {
  cwd: string;
  /** Hard upper bound in characters for the rendered map. Default: 6000. */
  maxChars?: number;
  /** Currently focused file in the editor (workspace-relative or absolute). */
  activeFile?: string;
  /** Currently open/visible files in the editor. */
  openFiles?: string[];
  /** Modified/untracked files from git diff or current task checkpoints. Auto-detected from git if omitted. */
  changedFiles?: string[];
  /** Optional user query text to boost files defining referenced symbols. */
  queryText?: string;
  /** Max files scanned in workspace. Default: 600. */
  maxFilesScan?: number;
  /** Max directories visited while collecting files. Default: 2000. */
  maxDirsScan?: number;
  /** Wall-clock budget for the synchronous directory walk, in ms. Default: 1500. */
  scanBudgetMs?: number;
}

/** Text used when the map is skipped because the agent runs in the home directory or a filesystem root. */
export const REPO_MAP_NO_WORKSPACE_TEXT =
  '# Repository Map (skipped: no workspace folder is open, the task runs in the home directory. Open a project folder to enable @repo.)';

export interface RepoMapResult {
  text: string;
  totalFilesScanned: number;
  includedFiles: number;
  omittedFiles: number;
  maxChars: number;
  usedChars: number;
  files: RepoFileNode[];
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.swift', '.rb', '.php',
]);

const RESOLVE_SUFFIXES = [
  '', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '.py', '.go', '.rs',
];

const MAX_FILE_BYTES = 256 * 1024;

export function isTestFilePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = path.posix.basename(lower);
  if (
    lower.startsWith('test/')
    || lower.startsWith('tests/')
    || lower.startsWith('__tests__/')
    || lower.includes('/__tests__/')
    || lower.includes('/test/')
    || lower.includes('/tests/')
  ) {
    return true;
  }
  return (
    /\.(test|spec)\.[a-z0-9]+$/.test(base)
    || /_test\.[a-z0-9]+$/.test(base)
    || /^test_[^/]+\.[a-z0-9]+$/.test(base)
  );
}

function stripTestAffixes(stem: string): string {
  return stem
    .replace(/\.(test|spec)$/i, '')
    .replace(/_test$/i, '')
    .replace(/^test_/i, '');
}

function normalizeRel(cwd: string, candidate?: string): string | undefined {
  if (!candidate || !candidate.trim()) {
    return undefined;
  }
  const cleaned = candidate.trim().replace(/^@\//, '');
  const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
  const rel = toPosixRelative(cwd, abs);
  return rel.startsWith('..') ? undefined : rel;
}

function cleanSignature(line: string, maxLen = 110): string {
  const compact = line
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\{\s*$/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s*=\s*$/, '')
    .trim();
  if (compact.length <= maxLen) {
    return compact;
  }
  return `${compact.slice(0, Math.max(16, maxLen - 3)).trimEnd()}...`;
}

export function extractSymbolsAndImports(relPath: string, content: string): {
  symbols: RepoSymbol[];
  rawImports: string[];
} {
  const ext = path.posix.extname(relPath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  const seenSymbols = new Set<string>();
  const rawImports = new Set<string>();

  const pushSym = (sym: RepoSymbol) => {
    const key = `${sym.kind}:${sym.name}`;
    if (seenSymbols.has(key) || symbols.length >= 64) {
      return;
    }
    seenSymbols.add(key);
    symbols.push(sym);
  };

  if (ext === '.py') {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const impFrom = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/.exec(line);
      if (impFrom) {
        rawImports.add(impFrom[1]);
        continue;
      }
      const impDirect = /^\s*import\s+([A-Za-z0-9_.]+)/.exec(line);
      if (impDirect) {
        rawImports.add(impDirect[1]);
        continue;
      }
      const cls = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
      if (cls) {
        pushSym({
          kind: 'class',
          name: cls[1],
          signature: cleanSignature(line),
          exported: !cls[1].startsWith('_'),
          line: i + 1,
        });
        continue;
      }
      const fn = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (fn) {
        pushSym({
          kind: 'function',
          name: fn[1],
          signature: cleanSignature(line),
          exported: !fn[1].startsWith('_'),
          line: i + 1,
        });
      }
    }
    return { symbols, rawImports: [...rawImports] };
  }

  if (ext === '.go') {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const goImp = /^\s*(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"\s*$/.exec(line);
      if (goImp && lines.slice(Math.max(0, i - 15), i + 1).some((l) => /^\s*import\b/.test(l))) {
        rawImports.add(goImp[1]);
      }
      const fn = /^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (fn) {
        const exported = /^[A-Z]/.test(fn[1]);
        pushSym({ kind: 'function', name: fn[1], signature: cleanSignature(line), exported, line: i + 1 });
        continue;
      }
      const typ = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/.exec(line);
      if (typ) {
        const exported = /^[A-Z]/.test(typ[1]);
        pushSym({
          kind: typ[2] === 'interface' ? 'interface' : 'struct',
          name: typ[1],
          signature: cleanSignature(line),
          exported,
          line: i + 1,
        });
      }
    }
    return { symbols, rawImports: [...rawImports] };
  }

  if (ext === '.rs') {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const rsUse = /^\s*(?:pub\s+)?(?:use|mod)\s+([A-Za-z0-9_:]+)/.exec(line);
      if (rsUse) {
        rawImports.add(rsUse[1]);
      }
      const fn = /^\s*(pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
      if (fn) {
        pushSym({
          kind: 'function',
          name: fn[2],
          signature: cleanSignature(line),
          exported: Boolean(fn[1]),
          line: i + 1,
        });
        continue;
      }
      const item = /^\s*(pub(?:\([^)]+\))?\s+)?(struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
      if (item) {
        pushSym({
          kind: item[2] as RepoSymbol['kind'],
          name: item[3],
          signature: cleanSignature(line),
          exported: Boolean(item[1]),
          line: i + 1,
        });
      }
    }
    return { symbols, rawImports: [...rawImports] };
  }

  // Default: TypeScript / JavaScript / C-family
  // Pre-scan CommonJS `module.exports = { a, b }` and `exports.foo =` so exported declarations rank first
  const cjsExports = new Set<string>();
  const cjsObjMatch = /module\.exports\s*=\s*\{([^}]+)\}/m.exec(content);
  if (cjsObjMatch) {
    for (const part of cjsObjMatch[1].split(',')) {
      const ident = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(part.trim());
      if (ident) {
        cjsExports.add(ident[1]);
      }
    }
  }
  for (const expMatch of content.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) {
    cjsExports.add(expMatch[1]);
  }

  let currentClass: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // ES imports & re-exports
    const esImport = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/.exec(line);
    if (esImport) {
      rawImports.add(esImport[1]);
    }
    const reqMatch = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
    if (reqMatch) {
      rawImports.add(reqMatch[1]);
    }

    const cls = /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
    if (cls) {
      currentClass = cls[2];
      pushSym({
        kind: 'class',
        name: cls[2],
        signature: cleanSignature(line),
        exported: Boolean(cls[1]) || cjsExports.has(cls[2]),
        line: i + 1,
      });
      continue;
    }
    if (/^\}\s*$/.test(line)) {
      currentClass = null;
    }

    const iface = /^\s*(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
    if (iface) {
      pushSym({
        kind: 'interface',
        name: iface[2],
        signature: cleanSignature(line),
        exported: Boolean(iface[1]),
        line: i + 1,
      });
      continue;
    }

    const typeAlias = /^\s*(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
    if (typeAlias) {
      pushSym({
        kind: 'type',
        name: typeAlias[2],
        signature: cleanSignature(line),
        exported: Boolean(typeAlias[1]),
        line: i + 1,
      });
      continue;
    }

    const enm = /^\s*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
    if (enm) {
      pushSym({
        kind: 'enum',
        name: enm[2],
        signature: cleanSignature(line),
        exported: Boolean(enm[1]),
        line: i + 1,
      });
      continue;
    }

    const fn = /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/.exec(line);
    if (fn) {
      let sigLine = line;
      if (!line.includes(')') && i + 2 < lines.length) {
        sigLine = `${line} ${lines[i + 1]} ${lines[i + 2]}`;
      }
      pushSym({
        kind: 'function',
        name: fn[2],
        signature: cleanSignature(sigLine),
        exported: Boolean(fn[1]) || cjsExports.has(fn[2]),
        line: i + 1,
      });
      continue;
    }

    const arrowConst = /^\s*(export\s+)(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.exec(line);
    if (arrowConst) {
      pushSym({
        kind: 'function',
        name: arrowConst[2],
        signature: cleanSignature(line),
        exported: true,
        line: i + 1,
      });
      continue;
    }

    const exportedConst = /^\s*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
    if (exportedConst) {
      pushSym({
        kind: 'const',
        name: exportedConst[1],
        signature: cleanSignature(line, 80),
        exported: true,
        line: i + 1,
      });
      continue;
    }

    if (currentClass && /^ {2,4}(?:public\s+|protected\s+|readonly\s+|static\s+|async\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/.test(line)) {
      const m = /^ {2,4}(?:public\s+|protected\s+|readonly\s+|static\s+|async\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/.exec(line);
      const methodName = m?.[1];
      if (
        methodName
        && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super'].includes(methodName)
        && !methodName.startsWith('_')
      ) {
        pushSym({
          kind: 'method',
          name: `${currentClass}.${methodName}`,
          signature: `${currentClass}.${cleanSignature(line, 90)}`,
          exported: true,
          line: i + 1,
        });
      }
    }
  }

  return { symbols, rawImports: [...rawImports] };
}

function collectSourceFiles(cwd: string, maxFiles: number, maxDirs = 2000, budgetMs = 1500): string[] {
  const results: string[] = [];
  const queue: string[] = [cwd];
  const deadline = Date.now() + Math.max(1, budgetMs);
  let visitedDirs = 0;
  while (queue.length > 0 && results.length < maxFiles && visitedDirs < maxDirs && Date.now() < deadline) {
    const dir = queue.shift()!;
    visitedDirs += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) {
        break;
      }
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          queue.push(abs);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext) || entry.name.endsWith('.d.ts') || entry.name.endsWith('.min.js')) {
        continue;
      }
      try {
        const stat = fs.statSync(abs);
        if (stat.size <= MAX_FILE_BYTES) {
          results.push(toPosixRelative(cwd, abs));
        }
      } catch {
        // ignore unreadable files
      }
    }
  }
  return results;
}

function hasGitDirectory(cwd: string): boolean {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return false;
}

export function detectGitChangedFiles(cwd: string): string[] {
  if (!hasGitDirectory(cwd)) {
    return [];
  }
  try {
    const statusOut = cp.execFileSync('git', ['status', '--porcelain', '-uall'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const changed = new Set<string>();
    for (const raw of statusOut.split(/\r?\n/)) {
      if (raw.length < 4) {
        continue;
      }
      const filePart = raw.slice(3).trim();
      const target = filePart.includes(' -> ') ? filePart.split(' -> ').pop()!.trim() : filePart;
      const unquoted = target.replace(/^"|"$/g, '');
      if (unquoted) {
        changed.add(unquoted.split(path.sep).join('/'));
      }
    }
    return [...changed];
  } catch {
    return [];
  }
}

function resolveRelativeImport(fromRel: string, spec: string, allFilesSet: Set<string>): string | undefined {
  if (spec.startsWith('.')) {
    const baseDir = path.posix.dirname(fromRel);
    const joined = path.posix.normalize(path.posix.join(baseDir, spec));
    const stripped = joined.replace(/\.(js|mjs|cjs)$/i, '');
    for (const candidateBase of [joined, stripped]) {
      for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = `${candidateBase}${suffix}`;
        if (allFilesSet.has(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }
  // Python dotted module inside workspace
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(spec)) {
    const slashPath = spec.replace(/\./g, '/');
    for (const candidate of [`${slashPath}.py`, `src/${slashPath}.py`, `${slashPath}/__init__.py`]) {
      if (allFilesSet.has(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function extractQueryTokens(queryText?: string): Set<string> {
  const tokens = new Set<string>();
  if (!queryText) {
    return tokens;
  }
  const matches = queryText.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [];
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'where', 'what',
    'file', 'files', 'code', 'test', 'tests', 'fix', 'add', 'update', 'function', 'class',
    'repo', 'map', 'please', 'should', 'error', 'warning',
  ]);
  for (const word of matches) {
    if (!stopWords.has(word.toLowerCase())) {
      tokens.add(word);
      tokens.add(word.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Builds a deterministic, non-vector-DB repository map (`@repo`) containing:
 * - Symbols & one-line signatures
 * - Resolved workspace imports & external package imports
 * - Related test files
 * - Priority ranking: activeFile > current diff > symbol/query match > import/test neighbors > centrality
 * - Strict hard budget in characters (`maxChars`, default 6000)
 */
export async function buildRepoMap(options: RepoMapOptions): Promise<RepoMapResult> {
  const maxChars = Math.max(120, Math.floor(options.maxChars ?? 6000));
  const maxFilesScan = options.maxFilesScan ?? 600;
  if (isBroadScanRoot(options.cwd)) {
    const skippedText = REPO_MAP_NO_WORKSPACE_TEXT.slice(0, maxChars);
    return {
      text: skippedText,
      totalFilesScanned: 0,
      includedFiles: 0,
      omittedFiles: 0,
      maxChars,
      usedChars: skippedText.length,
      files: [],
    };
  }
  const relFiles = collectSourceFiles(options.cwd, maxFilesScan, options.maxDirsScan, options.scanBudgetMs);
  const allFilesSet = new Set(relFiles);

  const activeFile = normalizeRel(options.cwd, options.activeFile);
  const openSet = new Set(
    (options.openFiles || [])
      .map((f) => normalizeRel(options.cwd, f))
      .filter((f): f is string => Boolean(f))
  );
  const rawChanged = options.changedFiles ?? detectGitChangedFiles(options.cwd);
  const changedSet = new Set(
    rawChanged
      .map((f) => normalizeRel(options.cwd, f))
      .filter((f): f is string => Boolean(f))
  );
  const queryTokens = extractQueryTokens(options.queryText);

  const nodes = new Map<string, RepoFileNode>();
  const testFilesByStem = new Map<string, string[]>();

  for (const rel of relFiles) {
    const abs = path.join(options.cwd, rel);
    let content = '';
    try {
      content = await fs.promises.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const { symbols, rawImports } = extractSymbolsAndImports(rel, content);
    const resolvedImports: string[] = [];
    for (const spec of rawImports) {
      const target = resolveRelativeImport(rel, spec, allFilesSet);
      if (target && target !== rel && !resolvedImports.includes(target)) {
        resolvedImports.push(target);
      }
    }
    const isTest = isTestFilePath(rel);
    if (isTest) {
      const rawStem = path.posix.basename(rel, path.posix.extname(rel));
      const baseStem = stripTestAffixes(rawStem).toLowerCase();
      if (baseStem) {
        const list = testFilesByStem.get(baseStem) || [];
        list.push(rel);
        testFilesByStem.set(baseStem, list);
      }
    }
    nodes.set(rel, {
      relPath: rel,
      isTest,
      symbols,
      rawImports,
      resolvedImports,
      importedBy: [],
      relatedTests: [],
      score: 0,
      priorityReason: 'workspace',
    });
  }

  // Wire reverse imports + related tests
  for (const node of nodes.values()) {
    for (const target of node.resolvedImports) {
      const targetNode = nodes.get(target);
      if (targetNode && !targetNode.importedBy.includes(node.relPath)) {
        targetNode.importedBy.push(node.relPath);
      }
      if (node.isTest && targetNode && !targetNode.relatedTests.includes(node.relPath)) {
        targetNode.relatedTests.push(node.relPath);
      }
    }
  }

  for (const node of nodes.values()) {
    if (!node.isTest) {
      const stem = path.posix.basename(node.relPath, path.posix.extname(node.relPath)).toLowerCase();
      for (const candidateTest of testFilesByStem.get(stem) || []) {
        if (!node.relatedTests.includes(candidateTest)) {
          node.relatedTests.push(candidateTest);
        }
      }
    }
  }

  // Priority neighbor sets around activeFile & changedSet
  const hotFiles = new Set<string>();
  if (activeFile && nodes.has(activeFile)) {
    hotFiles.add(activeFile);
  }
  for (const c of changedSet) {
    if (nodes.has(c)) {
      hotFiles.add(c);
    }
  }

  const neighborSet = new Set<string>();
  for (const hot of hotFiles) {
    const hotNode = nodes.get(hot);
    if (!hotNode) {
      continue;
    }
    for (const imp of hotNode.resolvedImports) {
      neighborSet.add(imp);
    }
    for (const rev of hotNode.importedBy) {
      neighborSet.add(rev);
    }
    for (const relTest of hotNode.relatedTests) {
      neighborSet.add(relTest);
    }
  }

  // Score every file
  for (const node of nodes.values()) {
    let score = 0;
    const reasons: string[] = [];

    if (activeFile && node.relPath === activeFile) {
      score += 1000;
      reasons.push('active file');
    }
    if (changedSet.has(node.relPath)) {
      score += 800;
      reasons.push('current diff');
    }

    if (queryTokens.size > 0) {
      const stem = path.posix.basename(node.relPath, path.posix.extname(node.relPath));
      let matchedQuery = queryTokens.has(stem) || queryTokens.has(stem.toLowerCase());
      if (!matchedQuery) {
        matchedQuery = node.symbols.some((sym) => {
          const bare = sym.name.includes('.') ? sym.name.split('.').pop()! : sym.name;
          return queryTokens.has(bare) || queryTokens.has(bare.toLowerCase());
        });
      }
      if (matchedQuery) {
        score += 500;
        reasons.push('symbol match');
      }
    }

    if (neighborSet.has(node.relPath) && !hotFiles.has(node.relPath)) {
      score += 350;
      reasons.push('import/test neighbor');
    }
    if (openSet.has(node.relPath) && node.relPath !== activeFile) {
      score += 200;
      reasons.push('open tab');
    }

    // Graph centrality + exported symbol density
    score += Math.min(120, node.importedBy.length * 20);
    const exportedCount = node.symbols.filter((s) => s.exported).length;
    score += Math.min(40, exportedCount * 4);
    if (node.isTest && reasons.length === 0) {
      score -= 30;
    }

    node.score = score;
    node.priorityReason = reasons[0] || (node.importedBy.length > 0 ? `imported by ${node.importedBy.length}` : 'workspace');
  }

  const ranked = [...nodes.values()].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.relPath.localeCompare(b.relPath);
  });

  if (ranked.length === 0) {
    const emptyText = '# Repository Map (no source files found)'.slice(0, maxChars);
    return {
      text: emptyText,
      totalFilesScanned: 0,
      includedFiles: 0,
      omittedFiles: 0,
      maxChars,
      usedChars: emptyText.length,
      files: [],
    };
  }

  const headerLines = ['# Repository Map'];
  if (activeFile) {
    headerLines.push(`active: ${activeFile}`);
  }
  if (changedSet.size > 0) {
    headerLines.push(`diff: ${[...changedSet].slice(0, 8).join(', ')}${changedSet.size > 8 ? ` (+${changedSet.size - 8})` : ''}`);
  }
  let body = headerLines.join('\n');
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    return {
      text: body,
      totalFilesScanned: ranked.length,
      includedFiles: 0,
      omittedFiles: ranked.length,
      maxChars,
      usedChars: body.length,
      files: ranked,
    };
  }

  let includedFiles = 0;
  for (let idx = 0; idx < ranked.length; idx += 1) {
    const node = ranked[idx];
    const remainingFilesAfter = ranked.length - (idx + 1);
    const reserveForFooter = remainingFilesAfter > 0 ? 52 : 0;

    const isHighPriority = node.score >= 300 || idx < 6;
    const fullEntry = formatRepoNodeDetailed(node, isHighPriority ? 10 : 5);
    const compactEntry = formatRepoNodeCompact(node);

    const withFullLen = body.length + 2 + fullEntry.length;
    if (withFullLen + reserveForFooter <= maxChars) {
      body = `${body}\n\n${fullEntry}`;
      includedFiles += 1;
      continue;
    }

    const withCompactLen = body.length + 1 + compactEntry.length;
    if (withCompactLen + reserveForFooter <= maxChars) {
      body = `${body}\n${compactEntry}`;
      includedFiles += 1;
      continue;
    }

    break;
  }

  const omittedFiles = Math.max(0, ranked.length - includedFiles);
  if (omittedFiles > 0) {
    const footer = `\n... +${omittedFiles} files omitted (budget ${maxChars} chars)`;
    if (body.length + footer.length <= maxChars) {
      body += footer;
    }
  }

  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
  }

  return {
    text: body,
    totalFilesScanned: ranked.length,
    includedFiles,
    omittedFiles,
    maxChars,
    usedChars: body.length,
    files: ranked,
  };
}

function formatRepoNodeDetailed(node: RepoFileNode, maxSymbols: number): string {
  const tags: string[] = [];
  if (node.priorityReason === 'active file' || node.priorityReason === 'current diff' || node.priorityReason === 'symbol match') {
    tags.push(node.priorityReason);
  }
  const tagSuffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const lines = [`## ${node.relPath}${tagSuffix}`];

  const importList = node.resolvedImports.length > 0
    ? node.resolvedImports.slice(0, 6)
    : node.rawImports.slice(0, 4);
  if (importList.length > 0) {
    lines.push(`  imports: ${importList.join(', ')}`);
  }
  if (node.relatedTests.length > 0) {
    lines.push(`  tests: ${node.relatedTests.slice(0, 3).join(', ')}`);
  }

  const prioritizedSymbols = [
    ...node.symbols.filter((s) => s.exported),
    ...node.symbols.filter((s) => !s.exported),
  ].slice(0, maxSymbols);

  for (const sym of prioritizedSymbols) {
    lines.push(`  - L${sym.line}: ${sym.signature}`);
  }
  return lines.join('\n');
}

function formatRepoNodeCompact(node: RepoFileNode): string {
  const names = node.symbols.slice(0, 5).map((s) => s.name);
  const testHint = node.relatedTests.length > 0 ? ` (test: ${node.relatedTests[0]})` : '';
  return names.length > 0
    ? `- ${node.relPath}: ${names.join(', ')}${testHint}`
    : `- ${node.relPath}${testHint}`;
}
