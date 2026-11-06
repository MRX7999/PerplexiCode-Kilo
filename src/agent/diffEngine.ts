/**
 * SEARCH/REPLACE diff engine compatible with Kilo Code's apply_diff format:
 *
 * <<<<<<< SEARCH
 * :start_line:10
 * -------
 * old code
 * =======
 * new code
 * >>>>>>> REPLACE
 */

export interface DiffBlock {
  search: string;
  replace: string;
  startLine?: number;
}

export interface DiffApplyResult {
  success: boolean;
  content?: string;
  applied: number;
  failures: string[];
}

const BLOCK_REGEX = /<{5,9} SEARCH>?[ \t]*\n([\s\S]*?)\n?={5,9}[ \t]*\n([\s\S]*?)\n?>{5,9} REPLACE>?/g;

export function parseDiffBlocks(diff: string): DiffBlock[] {
  const normalized = diff.replace(/\r\n/g, '\n');
  const blocks: DiffBlock[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  BLOCK_REGEX.lastIndex = 0;
  while ((match = BLOCK_REGEX.exec(normalized)) !== null) {
    let search = match[1];
    let startLine: number | undefined;
    const header = search.match(/^:start_line:\s*(\d+)\s*\n(?:-{3,}\s*\n)?/);
    if (header) {
      startLine = Number(header[1]);
      search = search.slice(header[0].length);
    } else {
      search = search.replace(/^-{3,}\s*\n/, '');
    }
    const endHeader = search.match(/^:end_line:\s*\d+\s*\n(?:-{3,}\s*\n)?/);
    if (endHeader) {
      search = search.slice(endHeader[0].length);
    }
    const replace = match[2];
    const dedupKey = `${startLine ?? ''}\u0000${search}\u0000${replace}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    blocks.push({ search, replace, startLine });
  }
  return blocks;
}

export function applyDiff(original: string, diff: string): DiffApplyResult {
  const blocks = parseDiffBlocks(diff);
  if (blocks.length === 0) {
    return {
      success: false,
      applied: 0,
      failures: ['No valid SEARCH/REPLACE blocks found. Use the exact format: <<<<<<< SEARCH / :start_line:N / ------- / old / ======= / new / >>>>>>> REPLACE'],
    };
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let lines = original.replace(/\r\n/g, '\n').split('\n');
  const failures: string[] = [];
  let applied = 0;
  // Apply bottom-up when start lines are known so earlier line numbers stay valid.
  const ordered = [...blocks].map((block, index) => ({ block, index }))
    .sort((left, right) => (right.block.startLine || 0) - (left.block.startLine || 0));

  for (const { block, index } of ordered) {
    const searchLines = block.search.split('\n');
    const replaceLines = block.replace === '' ? [] : block.replace.split('\n');

    if (block.search.trim() === '') {
      if (block.startLine && block.startLine >= 1) {
        const insertAt = Math.min(lines.length, Math.max(0, block.startLine - 1));
        if (!sliceMatchesNonEmpty(lines, insertAt, replaceLines)) {
          lines.splice(insertAt, 0, ...replaceLines);
        }
        applied += 1;
        continue;
      }
      failures.push(`Block ${index + 1}: empty SEARCH section needs :start_line: to know where to insert.`);
      continue;
    }

    const location = locate(lines, searchLines, block.startLine);
    if (!location) {
      // If SEARCH was not found, check whether REPLACE is already present near start_line (idempotent retry).
      if (replaceLines.length > 0 && locate(lines, replaceLines, block.startLine)) {
        applied += 1;
        continue;
      }
      failures.push(`Block ${index + 1}: SEARCH content not found${block.startLine ? ` near line ${block.startLine}` : ''}. ${bestMatchHint(lines, searchLines)}`);
      continue;
    }

    const adjusted = location.indentDelta !== undefined
      ? reindent(replaceLines, location.indentDelta)
      : replaceLines;

    if (isAnchorExtensionAlreadyApplied(lines, location.start, searchLines, adjusted)) {
      applied += 1;
      continue;
    }

    const span = resolveReplacementSpan(lines, location.start, searchLines, adjusted);
    lines = [...lines.slice(0, span.start), ...adjusted, ...lines.slice(span.end)];
    applied += 1;
  }

  if (applied === 0) {
    return { success: false, applied, failures };
  }

  return {
    success: failures.length === 0,
    content: lines.join(eol),
    applied,
    failures,
  };
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === '') {
    end -= 1;
  }
  return lines.slice(start, end);
}

function sliceMatchesNonEmpty(lines: string[], startIndex: number, expected: string[]): boolean {
  const core = trimBlankEdges(expected);
  if (core.length === 0) {
    return false;
  }
  let cursor = startIndex;
  while (cursor < lines.length && lines[cursor].trim() === '') {
    cursor += 1;
  }
  if (cursor + core.length > lines.length) {
    return false;
  }
  return core.every((line, offset) => lines[cursor + offset].trim() === line.trim());
}

function sliceMatchesBeforeNonEmpty(lines: string[], endIndex: number, expected: string[]): boolean {
  const core = trimBlankEdges(expected);
  if (core.length === 0) {
    return false;
  }
  let cursor = endIndex;
  while (cursor > 0 && lines[cursor - 1].trim() === '') {
    cursor -= 1;
  }
  const start = cursor - core.length;
  if (start < 0) {
    return false;
  }
  return core.every((line, offset) => lines[start + offset].trim() === line.trim());
}

/**
 * Detects when a diff block extends an existing anchor (`SEARCH` is a prefix or suffix of `REPLACE`)
 * and the added lines are already present right after or before the anchor in `lines`.
 */
function isAnchorExtensionAlreadyApplied(lines: string[], start: number, searchLines: string[], replaceLines: string[]): boolean {
  if (replaceLines.length <= searchLines.length) {
    return false;
  }
  const prefixMatches = searchLines.every((line, idx) => replaceLines[idx].trim() === line.trim());
  if (prefixMatches) {
    const addedAfter = replaceLines.slice(searchLines.length);
    if (sliceMatchesNonEmpty(lines, start + searchLines.length, addedAfter)) {
      return true;
    }
  }
  const offset = replaceLines.length - searchLines.length;
  const suffixMatches = searchLines.every((line, idx) => replaceLines[offset + idx].trim() === line.trim());
  if (suffixMatches) {
    const addedBefore = replaceLines.slice(0, offset);
    if (sliceMatchesBeforeNonEmpty(lines, start, addedBefore)) {
      return true;
    }
  }
  return false;
}

export interface FunctionHeaderInfo {
  key: string;
  name: string;
  indent: string;
  lineIndex: number;
}

const FUNCTION_HEADER_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/,
  /^\s*func\s+(?:\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)\s*\)\s*)?([A-Za-z_]\w*)\s*[([]/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
];

export function parseFunctionHeaderLine(line: string): { key: string; name: string; indent: string } | undefined {
  const indent = leadingWhitespace(line);
  for (let i = 0; i < FUNCTION_HEADER_PATTERNS.length; i += 1) {
    const match = line.match(FUNCTION_HEADER_PATTERNS[i]);
    if (match) {
      if (i === 2) {
        const receiver = match[1] || '';
        const name = match[2];
        return { key: receiver ? `${receiver}.${name}` : name, name, indent };
      }
      const name = match[1];
      return { key: name, name, indent };
    }
  }
  return undefined;
}

export function extractSingleFunctionHeader(lines: string[]): FunctionHeaderInfo | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('@') || trimmed.startsWith('#[')) {
      continue;
    }
    const parsed = parseFunctionHeaderLine(lines[i]);
    return parsed ? { ...parsed, lineIndex: i } : undefined;
  }
  return undefined;
}

function countLineBraces(line: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      break;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
  }
  return depth;
}

function netBraceBalance(lines: string[]): { balance: number; sawOpen: boolean } {
  let balance = 0;
  let sawOpen = false;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '{') {
        sawOpen = true;
      }
    }
    balance += countLineBraces(line);
  }
  return { balance, sawOpen };
}

/**
 * Finds the exclusive end line index of a function block starting at `headerIndex` in `lines`.
 */
export function findFunctionBlockEnd(lines: string[], headerIndex: number): number | undefined {
  const header = parseFunctionHeaderLine(lines[headerIndex]);
  if (!header) {
    return undefined;
  }
  if (/^\s*(?:async\s+)?def\s+/.test(lines[headerIndex])) {
    let end = headerIndex + 1;
    while (end < lines.length) {
      const trimmed = lines[end].trim();
      if (!trimmed) {
        end += 1;
        continue;
      }
      const indent = leadingWhitespace(lines[end]);
      if (indent.length <= header.indent.length && !trimmed.startsWith('#')) {
        break;
      }
      end += 1;
    }
    while (end > headerIndex + 1 && lines[end - 1].trim() === '') {
      end -= 1;
    }
    return end > headerIndex ? end : undefined;
  }

  let balance = 0;
  let sawOpen = false;
  const maxEnd = Math.min(lines.length, headerIndex + 300);
  for (let i = headerIndex; i < maxEnd; i += 1) {
    const line = lines[i];
    if (line.includes('{')) {
      sawOpen = true;
    }
    balance += countLineBraces(line);
    if (sawOpen && balance === 0) {
      return i + 1;
    }
  }
  return undefined;
}

function resolveReplacementSpan(
  lines: string[],
  start: number,
  searchLines: string[],
  replaceLines: string[]
): { start: number; end: number } {
  const defaultEnd = start + searchLines.length;

  // Case 1: `SEARCH` only included the opening lines of a function (unclosed `{`), while `REPLACE`
  // provided the complete function body closing at `}` (net brace balance 0).
  const searchHeader = extractSingleFunctionHeader(searchLines);
  const replaceHeader = extractSingleFunctionHeader(replaceLines);
  if (searchHeader && replaceHeader && searchHeader.key === replaceHeader.key) {
    const searchBraces = netBraceBalance(searchLines);
    const replaceBraces = netBraceBalance(replaceLines);
    const coreReplace = trimBlankEdges(replaceLines);
    const lastReplaceLine = coreReplace[coreReplace.length - 1]?.trim() || '';
    if (searchBraces.sawOpen && searchBraces.balance > 0 && replaceBraces.sawOpen && replaceBraces.balance === 0 && lastReplaceLine === '}') {
      const fullEnd = findFunctionBlockEnd(lines, start + searchHeader.lineIndex);
      if (fullEnd !== undefined && fullEnd > defaultEnd) {
        return { start, end: fullEnd };
      }
    }
  }

  // Case 2: `REPLACE` keeps `SEARCH` as a prefix and appends a complete function `F`, while `F`
  // already exists immediately after `SEARCH` in `lines` (model used `SEARCH` as an anchor above `F`).
  if (replaceLines.length > searchLines.length && searchLines.every((line, idx) => replaceLines[idx].trim() === line.trim())) {
    const addedAfter = trimBlankEdges(replaceLines.slice(searchLines.length));
    const addedFn = extractSingleFunctionHeader(addedAfter);
    if (addedFn && addedFn.lineIndex === 0) {
      const addedEnd = findFunctionBlockEnd(addedAfter, 0);
      if (addedEnd === addedAfter.length) {
        let nextLine = defaultEnd;
        while (nextLine < lines.length && lines[nextLine].trim() === '') {
          nextLine += 1;
        }
        const existingFn = nextLine < lines.length ? parseFunctionHeaderLine(lines[nextLine]) : undefined;
        if (existingFn && existingFn.key === addedFn.key) {
          const existingEnd = findFunctionBlockEnd(lines, nextLine);
          if (existingEnd !== undefined) {
            return { start, end: existingEnd };
          }
        }
      }
    }
  }

  // Case 3: `REPLACE` keeps `SEARCH` as a suffix and prepends a complete function `F`, while `F`
  // already exists immediately before `SEARCH` in `lines`.
  const suffixOffset = replaceLines.length - searchLines.length;
  if (suffixOffset > 0 && searchLines.every((line, idx) => replaceLines[suffixOffset + idx].trim() === line.trim())) {
    const addedBefore = trimBlankEdges(replaceLines.slice(0, suffixOffset));
    const addedFn = extractSingleFunctionHeader(addedBefore);
    if (addedFn && addedFn.lineIndex === 0) {
      const addedEnd = findFunctionBlockEnd(addedBefore, 0);
      if (addedEnd === addedBefore.length) {
        for (let scan = Math.max(0, start - 200); scan < start; scan += 1) {
          const existingFn = parseFunctionHeaderLine(lines[scan]);
          if (existingFn && existingFn.key === addedFn.key) {
            const existingEnd = findFunctionBlockEnd(lines, scan);
            if (existingEnd !== undefined && lines.slice(existingEnd, start).every((l) => l.trim() === '')) {
              return { start: scan, end: defaultEnd };
            }
          }
        }
      }
    }
  }

  return { start, end: defaultEnd };
}

interface Location {
  start: number;
  indentDelta?: { from: string; to: string };
}

function locate(lines: string[], search: string[], startLine?: number): Location | undefined {
  const candidates: number[] = [];
  for (let i = 0; i + search.length <= lines.length; i += 1) {
    if (search.every((line, offset) => lines[i + offset] === line)) {
      candidates.push(i);
    }
  }
  if (candidates.length > 0) {
    return { start: nearest(candidates, startLine) };
  }

  // Trailing whitespace / indentation-insensitive match.
  const normalizedSearch = search.map((line) => line.trim());
  const loose: number[] = [];
  for (let i = 0; i + search.length <= lines.length; i += 1) {
    if (normalizedSearch.every((line, offset) => lines[i + offset].trim() === line)) {
      loose.push(i);
    }
  }
  if (loose.length > 0) {
    const start = nearest(loose, startLine);
    const firstIndex = search.findIndex((line) => line.trim() !== '');
    const from = leadingWhitespace(search[Math.max(0, firstIndex)]);
    const to = leadingWhitespace(lines[start + Math.max(0, firstIndex)]);
    return { start, indentDelta: from !== to ? { from, to } : undefined };
  }

  // Fuzzy match (>= 92% similar) within a window around start_line.
  let best = { score: 0, start: -1 };
  const target = normalizedSearch.join('\n');
  const from = startLine ? Math.max(0, startLine - 1 - 40) : 0;
  const to = startLine ? Math.min(lines.length - search.length, startLine - 1 + 40) : lines.length - search.length;
  for (let i = from; i <= to; i += 1) {
    const window = lines.slice(i, i + search.length).map((line) => line.trim()).join('\n');
    const score = similarity(window, target);
    if (score > best.score) {
      best = { score, start: i };
    }
  }
  if (best.start >= 0 && best.score >= 0.92) {
    return { start: best.start };
  }
  return undefined;
}

function nearest(candidates: number[], startLine?: number): number {
  if (!startLine) {
    return candidates[0];
  }
  return candidates.reduce((bestIndex, candidate) =>
    Math.abs(candidate - (startLine - 1)) < Math.abs(bestIndex - (startLine - 1)) ? candidate : bestIndex
  );
}

function leadingWhitespace(line: string | undefined): string {
  return (line || '').match(/^\s*/)?.[0] || '';
}

function reindent(lines: string[], delta: { from: string; to: string }): string[] {
  return lines.map((line) => {
    if (line.trim() === '') {
      return line;
    }
    if (line.startsWith(delta.from)) {
      return delta.to + line.slice(delta.from.length);
    }
    return line;
  });
}

function bestMatchHint(lines: string[], search: string[]): string {
  const firstMeaningful = search.find((line) => line.trim().length > 3)?.trim();
  if (!firstMeaningful) {
    return 'Use read_file to get the exact current content and try again.';
  }
  const hits = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(firstMeaningful))
    .slice(0, 3)
    .map(({ index }) => index + 1);
  return hits.length > 0
    ? `The first SEARCH line appears at line(s) ${hits.join(', ')}; re-read the file and copy the exact lines.`
    : 'Use read_file to get the exact current content and try again.';
}

/** Normalized Levenshtein similarity (1 = identical). */
export function similarity(left: string, right: string): number {
  if (left === right) {
    return 1;
  }
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return 1;
  }
  if (Math.abs(left.length - right.length) / maxLength > 0.2) {
    return 0;
  }
  let previous = new Array(right.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return 1 - previous[right.length] / maxLength;
}

/** Minimal line diff for previews: returns unified-style lines with +/- markers. */
export function lineDiff(before: string, after: string, context = 3): Array<{ type: ' ' | '+' | '-' | '@'; text: string }> {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > 4_000_000) {
    return [{ type: '@', text: `@@ large change: ${a.length} → ${b.length} lines @@` }];
  }
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Array<{ type: ' ' | '+' | '-'; text: string; aLine: number; bLine: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i], aLine: i + 1, bLine: j + 1 });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Prefer deletions first so a changed line shows as "- old" then "+ new".
      ops.push({ type: '-', text: a[i], aLine: i + 1, bLine: j + 1 });
      i += 1;
    } else {
      ops.push({ type: '+', text: b[j], aLine: i + 1, bLine: j + 1 });
      j += 1;
    }
  }

  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type !== ' ') {
      for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) {
        keep[k] = true;
      }
    }
  });

  const result: Array<{ type: ' ' | '+' | '-' | '@'; text: string }> = [];
  let inHunk = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      inHunk = false;
      return;
    }
    if (!inHunk) {
      let aCount = 0;
      let bCount = 0;
      for (let k = index; k < ops.length && keep[k]; k += 1) {
        if (ops[k].type !== '+') aCount += 1;
        if (ops[k].type !== '-') bCount += 1;
      }
      result.push({ type: '@', text: `@@ -${op.aLine},${aCount} +${op.bLine},${bCount} @@` });
      inHunk = true;
    }
    result.push({ type: op.type, text: op.text });
  });
  return result;
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  const diff = lineDiff(before, after, 0);
  return {
    added: diff.filter((line) => line.type === '+').length,
    removed: diff.filter((line) => line.type === '-').length,
  };
}

const OMISSION_PATTERNS = [
  /\/\/\s*\.\.\.\s*(rest|remaining|existing|previous|other)\b/i,
  /#\s*\.\.\.\s*(rest|remaining|existing|previous|other)\b/i,
  /\/\*\s*\.\.\.\s*(rest|remaining|existing|previous)\b/i,
  /<!--\s*\.\.\.\s*(rest|remaining|existing|previous)\b/i,
  /\/\/\s*(rest of (the )?(code|file)|existing code|unchanged)\b/i,
  /#\s*(rest of (the )?(code|file)|existing code|unchanged)\b/i,
];

/** Detects "// ... rest of code unchanged" style truncation in full-file writes. */
export function detectCodeOmission(original: string | undefined, next: string): boolean {
  return OMISSION_PATTERNS.some((pattern) => pattern.test(next) && !(original && pattern.test(original)));
}
