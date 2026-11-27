import * as os from 'os';
import * as path from 'path';

/**
 * Recursive shell command segment analyzer & protected-config path detector (F06 & F09).
 *
 * Security invariants:
 * 1. Every chained segment (`;`, `&&`, `||`, `|`, `|&`, `&`, `\n`), substitution (`$(...)`,
 *    `` `...` ``, `<(...)`, `>(...)`, including inside double quotes and unquoted heredocs),
 *    environment wrapper (`env VAR=1 ...`), and nested shell invocation (`bash -c ...`, `sh -lc ...`)
 *    is extracted and returned as an independent segment to check against allow/deny rules.
 * 2. Any unparseable or dynamic construct (unclosed quotes/parens, `eval`, `source`, `.`,
 *    dynamic command `$cmd`, `${cmd}`, `$IFS`, ANSI-C `$'...'`, `$"..."`, `env -S`,
 *    `find -exec/-delete`, `xargs` command execution, brace command expansion) sets `valid: false`
 *    so it NEVER passes auto-approval and ALWAYS requires interactive confirmation (unless a
 *    deny rule already blocks it).
 */

export interface ShellAnalysis {
  valid: boolean;
  reason?: string;
  /** Canonical unquoted/normalized segments and raw segments for rule matching. */
  segments: string[];
}

const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'csh', 'tcsh', 'fish']);
const TRANSPARENT_WRAPPERS = new Set(['command', 'builtin', 'nohup', 'time', 'nice', 'exec']);

interface HeredocStripResult {
  shellWithoutQuotedBodies: string;
  unquotedBodies: string[];
  valid: boolean;
  reason?: string;
}

/**
 * Strips heredoc bodies from a command while preserving substitutions inside UNQUOTED heredocs.
 * In POSIX sh, `<< 'EOF'` does NOT expand `$(...)` / backticks, whereas `<< EOF` DOES expand them!
 */
export function inspectHeredocs(command: string): HeredocStripResult {
  const lines = command.split(/\r?\n/);
  if (lines.length <= 1) {
    return { shellWithoutQuotedBodies: command, unquotedBodies: [], valid: true };
  }

  const kept: string[] = [];
  const unquotedBodies: string[] = [];
  let pendingDelimiter: string | undefined;
  let pendingQuoted = false;
  let pendingStripTabs = false;
  let currentBody: string[] = [];

  for (const line of lines) {
    if (pendingDelimiter !== undefined) {
      const candidate = pendingStripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate.trim() === pendingDelimiter) {
        if (!pendingQuoted && currentBody.length > 0) {
          unquotedBodies.push(currentBody.join('\n'));
        }
        pendingDelimiter = undefined;
        pendingQuoted = false;
        pendingStripTabs = false;
        currentBody = [];
      } else if (!pendingQuoted) {
        currentBody.push(line);
      }
      continue;
    }

    kept.push(line);
    // Match `<<EOF`, `<<-EOF`, `<< 'EOF'`, `<< "EOF"`, `<< \EOF`, ignoring `<<<` here-strings.
    const match = /(?:^|[^<])<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))/.exec(line);
    if (match) {
      pendingStripTabs = match[1] === '-';
      if (match[2] !== undefined || match[3] !== undefined || match[4] !== undefined) {
        pendingQuoted = true;
        pendingDelimiter = match[2] ?? match[3] ?? match[4];
      } else {
        pendingQuoted = false;
        pendingDelimiter = match[5];
      }
    }
  }

  if (pendingDelimiter !== undefined) {
    return {
      shellWithoutQuotedBodies: kept.join('\n'),
      unquotedBodies,
      valid: false,
      reason: `Unterminated heredoc (missing delimiter '${pendingDelimiter}').`,
    };
  }

  return { shellWithoutQuotedBodies: kept.join('\n'), unquotedBodies, valid: true };
}

/** Extracts `$(...)`, `` `...` ``, `<(...)`, and `>(...)` substitutions from shell text. */
function scanSubstitutions(
  text: string,
  options: { unquotedHeredocMode?: boolean } = {}
): { valid: boolean; reason?: string; subcommands: string[] } {
  const subcommands: string[] = [];
  let quote: '"' | '\'' | undefined;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (!options.unquotedHeredocMode) {
      if (quote === '\'') {
        if (ch === '\'') {
          quote = undefined;
        }
        continue;
      }

      // Reject ANSI-C `$'...'` and locale `$"..."` quoting in unquoted context: escape sequences can hide arbitrary commands.
      if (!quote && ch === '$' && (text[i + 1] === '\'' || text[i + 1] === '"')) {
        return { valid: false, reason: 'ANSI-C / locale quoting ($... ) requires manual confirmation.', subcommands: [] };
      }

      if (ch === '\\') {
        if (i + 1 >= text.length) {
          return { valid: false, reason: 'Trailing backslash escape in shell command.', subcommands: [] };
        }
        i += 1;
        continue;
      }

      if (ch === '"' || ch === '\'') {
        quote = quote === ch ? undefined : ch;
        continue;
      }
    } else if (ch === '\\') {
      if (i + 1 < text.length) {
        i += 1;
      }
      continue;
    }

    // Process substitution `<(...)` or `>(...)` (valid when unquoted)
    if (!quote && !options.unquotedHeredocMode && (ch === '<' || ch === '>') && text[i + 1] === '(') {
      const closed = findMatchingParen(text, i + 2);
      if (closed === -1) {
        return { valid: false, reason: 'Unclosed process substitution in shell command.', subcommands: [] };
      }
      const inner = text.slice(i + 2, closed).trim();
      if (!inner) {
        return { valid: false, reason: 'Empty process substitution in shell command.', subcommands: [] };
      }
      subcommands.push(inner);
      i = closed;
      continue;
    }

    // Command substitution `$(...)` or arithmetic `$((...))`
    if (ch === '$' && text[i + 1] === '(') {
      if (text[i + 2] === '(') {
        // Arithmetic expansion `$(( ... ))` — still scan inside for nested `$(...)` or backticks!
        const closedOuter = findMatchingDoubleParen(text, i + 3);
        if (closedOuter === -1) {
          return { valid: false, reason: 'Unclosed arithmetic expansion $((...)) in shell command.', subcommands: [] };
        }
        const expr = text.slice(i + 3, closedOuter);
        const nested = scanSubstitutions(expr, { unquotedHeredocMode: true });
        if (!nested.valid) {
          return nested;
        }
        subcommands.push(...nested.subcommands);
        i = closedOuter + 1;
        continue;
      }

      const closed = findMatchingParen(text, i + 2);
      if (closed === -1) {
        return { valid: false, reason: 'Unclosed command substitution $(...) in shell command.', subcommands: [] };
      }
      const inner = text.slice(i + 2, closed).trim();
      if (!inner) {
        return { valid: false, reason: 'Empty command substitution $() in shell command.', subcommands: [] };
      }
      subcommands.push(inner);
      i = closed;
      continue;
    }

    // Parameter expansion `${...}` — scan inside default/alternate expressions for nested `$(...)` or backticks
    if (ch === '$' && text[i + 1] === '{') {
      const closed = findMatchingBrace(text, i + 2);
      if (closed === -1) {
        return { valid: false, reason: 'Unclosed parameter expansion ${...} in shell command.', subcommands: [] };
      }
      const inner = text.slice(i + 2, closed);
      const nested = scanSubstitutions(inner, { unquotedHeredocMode: true });
      if (!nested.valid) {
        return nested;
      }
      subcommands.push(...nested.subcommands);
      i = closed;
      continue;
    }

    // Backtick substitution `` `...` ``
    if (ch === '`') {
      let j = i + 1;
      let inner = '';
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\' && j + 1 < text.length && (text[j + 1] === '`' || text[j + 1] === '\\' || text[j + 1] === '$')) {
          inner += text[j + 1];
          j += 2;
          continue;
        }
        inner += text[j];
        j += 1;
      }
      if (j >= text.length) {
        return { valid: false, reason: 'Unclosed backtick command substitution.', subcommands: [] };
      }
      if (!inner.trim()) {
        return { valid: false, reason: 'Empty backtick command substitution.', subcommands: [] };
      }
      subcommands.push(inner.trim());
      i = j;
    }
  }

  if (quote) {
    return { valid: false, reason: `Unclosed quote (${quote}) in shell command.`, subcommands: [] };
  }

  return { valid: true, subcommands };
}

function findMatchingParen(text: string, startAfterOpen: number): number {
  let depth = 1;
  let quote: '"' | '\'' | undefined;
  for (let i = startAfterOpen; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '\'') {
      if (ch === '\'') quote = undefined;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = quote === ch ? undefined : ch;
      continue;
    }
    if (!quote && ch === '(') depth += 1;
    else if (!quote && ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingDoubleParen(text: string, startAfterDoubleOpen: number): number {
  let depth = 1;
  for (let i = startAfterDoubleOpen; i < text.length - 1; i += 1) {
    if (text[i] === '(' && text[i + 1] === '(') {
      depth += 1;
      i += 1;
    } else if (text[i] === ')' && text[i + 1] === ')') {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
    }
  }
  return -1;
}

function findMatchingBrace(text: string, startAfterOpen: number): number {
  let depth = 1;
  let quote: '"' | '\'' | undefined;
  for (let i = startAfterOpen; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '\'') {
      if (ch === '\'') quote = undefined;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = quote === ch ? undefined : ch;
      continue;
    }
    if (!quote && ch === '{') depth += 1;
    else if (!quote && ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits top-level shell command chains (`;`, `&&`, `||`, `|`, `|&`, `&`, `\n`). */
export function splitTopLevelShellChain(shellText: string): { valid: boolean; reason?: string; segments: string[] } {
  const normalized = shellText.replace(/\\\r?\n/g, ' ');
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | '`' | undefined;
  let parenDepth = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (quote) {
      current += ch;
      if (quote !== '\'' && ch === '\\' && i + 1 < normalized.length) {
        current += normalized[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '\\') {
      if (i + 1 >= normalized.length) {
        return { valid: false, reason: 'Trailing backslash in shell command.', segments: [] };
      }
      current += ch + normalized[i + 1];
      i += 1;
      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }

    if ((ch === '$' || ch === '<' || ch === '>') && normalized[i + 1] === '(') {
      parenDepth += 1;
      current += ch + '(';
      i += 1;
      continue;
    }

    if (ch === '(') {
      parenDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      if (parenDepth === 0) {
        return { valid: false, reason: 'Unbalanced closing parenthesis in shell command.', segments: [] };
      }
      parenDepth -= 1;
      current += ch;
      continue;
    }

    if (parenDepth > 0) {
      current += ch;
      continue;
    }

    // Comment outside quotes at start of command or after whitespace
    if (ch === '#' && (current.trim().length === 0 || /\s$/.test(current))) {
      const nl = normalized.indexOf('\n', i);
      if (nl === -1) {
        break;
      }
      segments.push(current);
      current = '';
      i = nl;
      continue;
    }

    const two = normalized.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '|&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    if (
      ch === '&'
      && normalized[i - 1] !== '>'
      && normalized[i - 1] !== '<'
      && normalized[i + 1] !== '>'
      && normalized[i + 1] !== '&'
    ) {
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (quote) {
    return { valid: false, reason: `Unclosed quote (${quote}) in shell command.`, segments: [] };
  }
  if (parenDepth !== 0) {
    return { valid: false, reason: 'Unbalanced parentheses in shell command.', segments: [] };
  }

  segments.push(current);
  return {
    valid: true,
    segments: segments.map((s) => s.trim()).filter(Boolean),
  };
}

interface ParsedWord {
  value: string;
  raw: string;
  hasParameterExpansion: boolean;
  hasUnquotedGlobOrBrace: boolean;
}

/** Tokenizes a single simple command segment into words, unquoting static quotes/escapes. */
function tokenizeSegmentWords(segment: string): { valid: boolean; reason?: string; words: ParsedWord[]; hasHereString: boolean } {
  const words: ParsedWord[] = [];
  let value = '';
  let raw = '';
  let inWord = false;
  let hasParam = false;
  let hasGlobOrBrace = false;
  let hasHereString = false;
  let quote: '"' | '\'' | undefined;

  const pushWord = () => {
    if (inWord) {
      words.push({ value, raw, hasParameterExpansion: hasParam, hasUnquotedGlobOrBrace: hasGlobOrBrace });
      value = '';
      raw = '';
      inWord = false;
      hasParam = false;
      hasGlobOrBrace = false;
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote === '\'') {
      if (ch === '\'') {
        quote = undefined;
        raw += ch;
      } else {
        value += ch;
        raw += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        raw += ch;
        continue;
      }
      if (ch === '\\' && i + 1 < segment.length && ['"', '\\', '$', '`'].includes(segment[i + 1])) {
        value += segment[i + 1];
        raw += ch + segment[i + 1];
        i += 1;
        continue;
      }
      if (ch === '$' || ch === '`') {
        hasParam = true;
      }
      value += ch;
      raw += ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }

    // Redirections outside quotes: skip the operator token (e.g. 2>&1, >/tmp/out, <<<word)
    if (!inWord && /^\d*(?:<<<|>>|>&|<&|<>|>|<)/.test(segment.slice(i))) {
      const redir = /^\d*(?:<<<|>>|>&|<&|<>|>|<)/.exec(segment.slice(i))![0];
      if (redir.includes('<<<')) {
        hasHereString = true;
      }
      i += redir.length - 1;
      // Also skip the redirection target word so `cat > out.txt` keeps `cat` as argv[0]
      let j = i + 1;
      while (j < segment.length && /\s/.test(segment[j])) j += 1;
      let rq: '"' | '\'' | undefined;
      while (j < segment.length && (rq || !/\s/.test(segment[j]))) {
        if (rq === '\'') {
          if (segment[j] === '\'') rq = undefined;
        } else if (segment[j] === '\\' && j + 1 < segment.length) {
          j += 1;
        } else if (segment[j] === '\'' || segment[j] === '"') {
          rq = rq === segment[j] ? undefined : (segment[j] as '"' | '\'');
        }
        j += 1;
      }
      i = j - 1;
      continue;
    }

    inWord = true;
    if (ch === '\'' || ch === '"') {
      quote = ch;
      raw += ch;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= segment.length) {
        return { valid: false, reason: 'Trailing backslash in segment.', words: [], hasHereString };
      }
      value += segment[i + 1];
      raw += ch + segment[i + 1];
      i += 1;
      continue;
    }
    if (ch === '$' || ch === '`') {
      hasParam = true;
      // Skip balanced $(...) or ${...} inside the word so spaces inside $(...) don't split the outer word!
      if (ch === '$' && segment[i + 1] === '(') {
        const end = findMatchingParen(segment, i + 2);
        if (end === -1) {
          return { valid: false, reason: 'Unclosed $(...) in segment.', words: [], hasHereString };
        }
        const slice = segment.slice(i, end + 1);
        value += slice;
        raw += slice;
        i = end;
        continue;
      }
      if (ch === '$' && segment[i + 1] === '{') {
        const end = findMatchingBrace(segment, i + 2);
        if (end === -1) {
          return { valid: false, reason: 'Unclosed ${...} in segment.', words: [], hasHereString };
        }
        const slice = segment.slice(i, end + 1);
        value += slice;
        raw += slice;
        i = end;
        continue;
      }
    }
    if (ch === '{' || ch === '}' || ch === '*' || ch === '?' || ch === '[') {
      hasGlobOrBrace = true;
    }
    value += ch;
    raw += ch;
  }

  if (quote) {
    return { valid: false, reason: `Unclosed quote (${quote}) in segment.`, words: [], hasHereString };
  }
  pushWord();
  return { valid: true, words, hasHereString };
}

function formatCanonicalCommand(words: ParsedWord[]): string {
  return words
    .map((w, idx) => {
      if (idx === 0) {
        return w.value;
      }
      return /\s/.test(w.value) ? JSON.stringify(w.value) : w.value;
    })
    .join(' ')
    .trim();
}

export function analyzeShellCommand(command: string, depth = 0): ShellAnalysis {
  if (depth > 8) {
    return { valid: false, reason: 'Nested shell command depth exceeded.', segments: [] };
  }
  const trimmed = command.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Empty shell command.', segments: [] };
  }
  if (/[\0\r]/.test(command)) {
    return { valid: false, reason: 'Control characters in shell command require manual confirmation.', segments: [] };
  }
  // Unquoted $IFS obfuscation (`rm$IFS-rf`)
  if (/\$IFS\b|\$\{IFS\b/.test(command)) {
    return { valid: false, reason: '$IFS expansion in shell command requires manual confirmation.', segments: [] };
  }

  const heredoc = inspectHeredocs(command);
  if (!heredoc.valid) {
    return { valid: false, reason: heredoc.reason, segments: [] };
  }

  const subScan = scanSubstitutions(heredoc.shellWithoutQuotedBodies);
  if (!subScan.valid) {
    return { valid: false, reason: subScan.reason, segments: [] };
  }

  const extraSubs: string[] = [...subScan.subcommands];
  for (const body of heredoc.unquotedBodies) {
    const bodyScan = scanSubstitutions(body, { unquotedHeredocMode: true });
    if (!bodyScan.valid) {
      return { valid: false, reason: bodyScan.reason, segments: [] };
    }
    extraSubs.push(...bodyScan.subcommands);
  }

  const topChain = splitTopLevelShellChain(heredoc.shellWithoutQuotedBodies);
  if (!topChain.valid) {
    return { valid: false, reason: topChain.reason, segments: [] };
  }
  if (topChain.segments.length === 0) {
    return { valid: false, reason: 'No executable command segments found.', segments: [] };
  }

  const collectedSegments: string[] = [];

  for (const rawSeg of topChain.segments) {
    const segResult = analyzeSingleSegment(rawSeg, depth);
    if (!segResult.valid) {
      return { valid: false, reason: segResult.reason, segments: [...collectedSegments, ...segResult.segments] };
    }
    collectedSegments.push(...segResult.segments);
  }

  for (const sub of extraSubs) {
    const subAnalysis = analyzeShellCommand(sub, depth + 1);
    if (!subAnalysis.valid) {
      return { valid: false, reason: subAnalysis.reason, segments: [...collectedSegments, ...subAnalysis.segments] };
    }
    collectedSegments.push(...subAnalysis.segments);
  }

  return { valid: true, segments: collectedSegments };
}

function analyzeSingleSegment(rawSegment: string, depth: number): ShellAnalysis {
  const trimmed = rawSegment.trim();
  if (!trimmed) {
    return { valid: true, segments: [] };
  }

  // Subshell `( cmd1; cmd2 )` or group `{ cmd1; cmd2; }`
  if (trimmed.startsWith('(') && trimmed.endsWith(')') && findMatchingParen(trimmed, 1) === trimmed.length - 1) {
    return analyzeShellCommand(trimmed.slice(1, -1), depth + 1);
  }
  if (/^\{\s+[\s\S]*\}$/.test(trimmed) && findMatchingBrace(trimmed, 1) === trimmed.length - 1) {
    return analyzeShellCommand(trimmed.slice(1, -1).replace(/;\s*$/, ''), depth + 1);
  }

  const tokenized = tokenizeSegmentWords(trimmed);
  if (!tokenized.valid) {
    return { valid: false, reason: tokenized.reason, segments: [trimmed] };
  }
  const words = tokenized.words;
  if (words.length === 0) {
    // Pure redirection like `> file.txt`
    return { valid: false, reason: 'Standalone shell redirection requires manual confirmation.', segments: [trimmed] };
  }

  // Strip leading `KEY=VALUE` assignments and wrappers (`env`, `command`, `nohup`, `time`, `nice`, `timeout`)
  let idx = 0;
  while (idx < words.length) {
    const w = words[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value) && !w.value.startsWith('=')) {
      idx += 1;
      continue;
    }
    const base = path.posix.basename(w.value.replace(/\\/g, '/'));
    if (base === 'env') {
      idx += 1;
      while (idx < words.length) {
        const arg = words[idx].value;
        if (arg === '--') {
          idx += 1;
          break;
        }
        if (arg === '-S' || arg.startsWith('--split-string')) {
          return { valid: false, reason: 'env -S split-string execution requires manual confirmation.', segments: [trimmed] };
        }
        if (arg === '-u' || arg === '-C' || arg === '--unset' || arg === '--chdir') {
          idx += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          idx += 1;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          idx += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (TRANSPARENT_WRAPPERS.has(base)) {
      idx += 1;
      while (idx < words.length && words[idx].value.startsWith('-')) {
        // `command -v foo` / `command -V foo` is a read-only lookup, keep `command -v ...` intact
        if (base === 'command' && (words[idx].value === '-v' || words[idx].value === '-V')) {
          idx -= 1;
          break;
        }
        if (base === 'nice' && words[idx].value === '-n') {
          idx += 2;
          continue;
        }
        idx += 1;
      }
      if (base === 'command' && idx < words.length && (words[idx + 1]?.value === '-v' || words[idx + 1]?.value === '-V')) {
        break;
      }
      continue;
    }
    if (base === 'timeout') {
      idx += 1;
      while (idx < words.length && words[idx].value.startsWith('-')) {
        if (['-k', '-s', '--kill-after', '--signal'].includes(words[idx].value)) {
          idx += 2;
        } else {
          idx += 1;
        }
      }
      if (idx < words.length) {
        idx += 1; // duration argument
      }
      continue;
    }
    break;
  }

  // Pure environment assignment (`FOO=bar`)
  if (idx >= words.length) {
    return { valid: true, segments: [trimmed] };
  }

  const effectiveWords = words.slice(idx);
  const cmdWord = effectiveWords[0];

  // Dynamic or globbed command word (`$CMD`, `${SHELL}`, `{rm,-rf}`, `/bin/r?`) is never auto-approved.
  if (cmdWord.hasParameterExpansion || cmdWord.hasUnquotedGlobOrBrace) {
    return {
      valid: false,
      reason: `Dynamic or globbed command '${cmdWord.raw}' requires manual confirmation.`,
      segments: [trimmed],
    };
  }

  const exeName = path.posix.basename(cmdWord.value.replace(/\\/g, '/'));

  // Meta-execution commands that evaluate arbitrary strings or files
  if (exeName === 'eval' || exeName === 'source' || cmdWord.value === '.') {
    return {
      valid: false,
      reason: `Shell '${cmdWord.value}' dynamically evaluates commands and requires manual confirmation.`,
      segments: [formatCanonicalCommand(effectiveWords)],
    };
  }

  // `find ... -exec` / `-execdir` / `-ok` / `-delete`
  if (exeName === 'find' && effectiveWords.slice(1).some((w) => ['-exec', '-execdir', '-ok', '-okdir', '-delete'].includes(w.value))) {
    return {
      valid: false,
      reason: 'find with -exec/-delete executes or removes targets and requires manual confirmation.',
      segments: [formatCanonicalCommand(effectiveWords)],
    };
  }

  // `xargs` invokes commands on stdin items — never treat as transparent
  if (exeName === 'xargs') {
    return {
      valid: false,
      reason: 'xargs invokes subcommands and requires manual confirmation.',
      segments: [formatCanonicalCommand(effectiveWords)],
    };
  }

  // Nested shells (`bash -c "..."`, `/bin/sh -lc '...'`, `zsh -ec ...`, `sh <<< "..."`)
  if (SHELL_BINARIES.has(exeName)) {
    if (tokenized.hasHereString) {
      return {
        valid: false,
        reason: `${exeName} with a here-string (<<<) requires manual confirmation.`,
        segments: [formatCanonicalCommand(effectiveWords)],
      };
    }
    for (let k = 1; k < effectiveWords.length; k += 1) {
      const flag = effectiveWords[k].value;
      if (flag === '--') {
        break;
      }
      if (flag === '-c' || (/^-[A-Za-z]+$/.test(flag) && flag.includes('c'))) {
        const scriptArg = effectiveWords[k + 1];
        if (!scriptArg) {
          return { valid: false, reason: `${exeName} ${flag} missing command string.`, segments: [formatCanonicalCommand(effectiveWords)] };
        }
        if (scriptArg.hasParameterExpansion) {
          return {
            valid: false,
            reason: `${exeName} ${flag} with dynamic variable expansion requires manual confirmation.`,
            segments: [formatCanonicalCommand(effectiveWords)],
          };
        }
        const inner = analyzeShellCommand(scriptArg.value, depth + 1);
        if (!inner.valid) {
          return { valid: false, reason: inner.reason, segments: [formatCanonicalCommand(effectiveWords), ...inner.segments] };
        }
        return { valid: true, segments: inner.segments };
      }
    }
  }

  // Normalize command word: if user wrote `/bin/rm` or `r'm'` or `\rm`, include canonical `rm ...` as well if path-qualified
  const canonical = formatCanonicalCommand(effectiveWords);
  const outSegments = [canonical];
  if (cmdWord.value.includes('/') && exeName !== cmdWord.value) {
    const basenameCanonical = formatCanonicalCommand([{ ...cmdWord, value: exeName }, ...effectiveWords.slice(1)]);
    if (basenameCanonical !== canonical) {
      outSegments.push(basenameCanonical);
    }
  }
  return { valid: true, segments: outSegments };
}

/**
 * F09: Checks whether an absolute file path (or its symlink target) is a protected agent/MCP/hooks
 * configuration file that MUST ALWAYS require explicit interactive user confirmation before editing.
 */
export function isProtectedAgentConfigPath(absPath: string, cwd: string, home = os.homedir()): string | undefined {
  const normalizedAbs = path.resolve(absPath);
  const roots = [path.resolve(cwd), path.resolve(home)];

  for (const root of roots) {
    const rel = path.relative(root, normalizedAbs).replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    if (rel === '.claude' || rel.startsWith('.claude/')) {
      return rel;
    }
    if (rel === '.claude.json') {
      return rel;
    }
    if (rel === '.mcp.json' || rel === '.mcp.local.json') {
      return rel;
    }
    if (
      rel === '.perplexicode/settings.json'
      || rel === '.perplexicode/settings.local.json'
      || rel === '.perplexicode/mcp.json'
      || rel === '.perplexicode/hooks'
      || rel.startsWith('.perplexicode/hooks/')
      || rel === 'hooks'
      || rel.startsWith('hooks/')
    ) {
      return rel;
    }
  }

  const base = path.basename(normalizedAbs);
  if (base === '.mcp.json' || base === '.mcp.local.json' || base === '.claude.json') {
    return base;
  }
  const posixAbs = normalizedAbs.replace(/\\/g, '/');
  if (/(?:^|\/)\.claude(?:\/|$)/.test(posixAbs)) {
    return '.claude/';
  }
  if (/(?:^|\/)\.perplexicode\/(?:settings(?:\.local)?\.json|mcp\.json|hooks(?:\/|$))/.test(posixAbs)) {
    return '.perplexicode/';
  }
  return undefined;
}

/**
 * F09: Detects whether a shell command references a protected config path (`.perplexicode/settings.json`,
 * `hooks`, `.mcp.json`, `.claude/`) with any non-pure-read or redirection operation.
 */
export function commandTouchesProtectedConfig(command: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/(?:^|[\s"'=<>|;&/])\.claude(?:\/|[\s"';&|<>)]|$)/, '.claude/'],
    [/(?:^|[\s"'=<>|;&/])\.claude\.json(?:[\s"';&|<>)]|$)/, '.claude.json'],
    [/(?:^|[\s"'=<>|;&/])\.mcp(?:\.local)?\.json(?:[\s"';&|<>)]|$)/, '.mcp.json'],
    [/(?:^|[\s"'=<>|;&/])\.perplexicode\/(?:settings(?:\.local)?\.json|mcp\.json|hooks\b)/, '.perplexicode/settings.json'],
    [/(?:^|[\s"'=<>|;&])(?:\.\/)?hooks\/[^\s"';&|<>)]*/, 'hooks/'],
  ];
  for (const [regex, label] of patterns) {
    if (regex.test(command)) {
      return label;
    }
  }
  return undefined;
}

/**
 * F06: Detects unquoted shell file output redirections (`>`, `>>`, `&>`, `>|`), ignoring safe fd
 * duplications (`2>&1`, `>&2`, `>&-`) and `/dev/null` discards. Prefix allow rules like `echo` or
 * `git status` must not auto-approve arbitrary file writes via redirection unless `*` is allowed.
 */
export function hasFileOutputRedirection(command: string): boolean {
  const { shellWithoutQuotedBodies } = inspectHeredocs(command);
  let quote: '"' | '\'' | undefined;
  for (let i = 0; i < shellWithoutQuotedBodies.length; i += 1) {
    const ch = shellWithoutQuotedBodies[i];
    if (quote === '\'') {
      if (ch === '\'') quote = undefined;
      continue;
    }
    if (ch === '\\' && i + 1 < shellWithoutQuotedBodies.length) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (!quote && ch === '\'' ) {
      quote = '\'';
      continue;
    }
    if (quote) {
      continue;
    }
    if (ch === '>') {
      // Ignore process substitution `>(...)` (already rejected by scanSubstitutions)
      if (shellWithoutQuotedBodies[i + 1] === '(') {
        continue;
      }
      let j = i + 1;
      if (shellWithoutQuotedBodies[j] === '>' || shellWithoutQuotedBodies[j] === '|') {
        j += 1;
      } else if (shellWithoutQuotedBodies[j] === '&') {
        const afterAmp = shellWithoutQuotedBodies.slice(j + 1);
        if (/^(?:\d+|-)(?=\s|[;&|)]|$)/.test(afterAmp)) {
          continue;
        }
        j += 1;
      }
      while (j < shellWithoutQuotedBodies.length && /[ \t]/.test(shellWithoutQuotedBodies[j])) {
        j += 1;
      }
      let target = '';
      while (j < shellWithoutQuotedBodies.length && !/[\s;&|<>()]/.test(shellWithoutQuotedBodies[j])) {
        target += shellWithoutQuotedBodies[j];
        j += 1;
      }
      const unquotedTarget = target.replace(/^['"]|['"]$/g, '');
      if (unquotedTarget === '/dev/null' || unquotedTarget === 'NUL') {
        i = j - 1;
        continue;
      }
      return true;
    }
  }
  return false;
}
