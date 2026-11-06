/**
 * Parser for Kilo/Roo-style XML tool calls embedded in a model answer.
 * Perplexity has no native function calling, so the agent protocol is plain text:
 *
 *   <read_file>
 *   <path>src/app.ts</path>
 *   </read_file>
 */

export const TOOL_PARAMS: Record<string, string[]> = {
  read_file: ['path', 'start_line', 'end_line'],
  list_files: ['path', 'recursive'],
  search_files: ['path', 'regex', 'file_pattern'],
  list_code_definition_names: ['path'],
  write_to_file: ['path', 'content', 'line_count'],
  apply_diff: ['path', 'diff'],
  insert_content: ['path', 'line', 'content'],
  execute_command: ['command', 'cwd'],
  ask_followup_question: ['question', 'follow_up'],
  attempt_completion: ['result', 'command'],
  switch_mode: ['mode_slug', 'reason'],
  new_task: ['mode', 'message', 'todos'],
  update_todo_list: ['todos'],
};

export const TOOL_NAMES = Object.keys(TOOL_PARAMS);

/** Parameters whose value may legitimately contain markup, newlines or other tags. */
const BODY_PARAMS = new Set(['content', 'diff', 'result', 'message', 'todos', 'follow_up', 'question']);

export interface ParsedToolUse {
  name: string;
  params: Record<string, string>;
  partial: boolean;
  start: number;
  end: number;
}

export interface ParsedAssistantMessage {
  /** Prose shown to the user (text before the tool call, thinking removed). */
  text: string;
  reasoning: string;
  tool?: ParsedToolUse;
  /** Number of extra tool calls after the first one (they are ignored, one tool per turn). */
  ignoredToolCount: number;
  /** Complete read-only tool calls that directly follow a read-only first tool (3.0 batching). */
  readBatch?: ParsedToolUse[];
  /** The text the offsets refer to (differs from the raw answer when entities were decoded). */
  source?: string;
}

const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'list_code_definition_names']);

export function parseAssistantMessage(raw: string, options: { partial?: boolean } = {}): ParsedAssistantMessage {
  let source = raw;
  let found = findFirstTool(source);

  if (!found && /&lt;\/?[a-z_]+&gt;/.test(source)) {
    // Some renderers HTML-escape angle brackets; recover the raw protocol.
    source = decodeEntities(source);
    found = findFirstTool(source);
  }

  const before = found ? source.slice(0, found.index) : source;
  const { text, reasoning } = splitThinking(before, Boolean(options.partial && !found));

  if (!found) {
    return { text: cleanupProse(text), reasoning, ignoredToolCount: 0 };
  }

  const tool = extractTool(source, found.name, found.index);
  const rest = tool.partial ? '' : source.slice(tool.end);
  const ignoredToolCount = tool.partial ? 0 : countTools(rest);

  const readBatch: ParsedToolUse[] = [];
  if (!tool.partial && READ_ONLY_TOOLS.has(tool.name)) {
    let cursor = tool.end;
    while (readBatch.length < 9) {
      const next = findFirstTool(source.slice(cursor));
      if (!next || !READ_ONLY_TOOLS.has(next.name)) {
        break;
      }
      // Only whitespace or short prose may separate batched calls.
      const gap = source.slice(cursor, cursor + next.index);
      if (gap.trim().length > 200) {
        break;
      }
      const extra = extractTool(source, next.name, cursor + next.index);
      if (extra.partial) {
        break;
      }
      readBatch.push(extra);
      cursor = extra.end;
    }
  }

  return {
    text: cleanupProse(text),
    reasoning,
    tool,
    ignoredToolCount,
    readBatch,
    source,
  };
}

/**
 * Ranges covered by <thinking>…</thinking> (an unclosed block runs to the end). Thinking models
 * often draft the tool call inside their reasoning; such drafts must never be parsed as the call,
 * otherwise the draft's opening tag and the real closing tag merge into one doubled value
 * (e.g. a todo list with every item twice).
 */
function thinkingRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  while (true) {
    const open = source.indexOf('<thinking>', from);
    if (open === -1) {
      break;
    }
    const close = source.indexOf('</thinking>', open);
    const end = close === -1 ? source.length : close + '</thinking>'.length;
    ranges.push([open, end]);
    from = end;
  }
  return ranges;
}

function fencedRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const regex = /```[^\n]*\n[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function findFirstTool(source: string): { name: string; index: number } | undefined {
  const thinking = thinkingRanges(source);
  const fences = fencedRanges(source);
  const insideThinking = (index: number) => thinking.some(([from, to]) => index >= from && index < to);
  const insideFence = (index: number) => fences.some(([from, to]) => index >= from && index < to);

  let bestUnfenced: { name: string; index: number } | undefined;
  let bestFenced: { name: string; index: number } | undefined;

  for (const name of TOOL_NAMES) {
    const regex = new RegExp(`<${name}>`, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      // Ignore inline mentions inside backticks such as `<read_file>`.
      const prev = source[match.index - 1];
      const next = source[match.index + match[0].length];
      if (prev === '`' && next === '`') {
        continue;
      }
      if (insideThinking(match.index)) {
        continue;
      }
      if (insideFence(match.index)) {
        if (!bestFenced || match.index < bestFenced.index) {
          bestFenced = { name, index: match.index };
        }
        continue;
      }
      if (!bestUnfenced || match.index < bestUnfenced.index) {
        bestUnfenced = { name, index: match.index };
      }
      break;
    }
  }
  return bestUnfenced || bestFenced;
}

function countTools(source: string): number {
  let count = 0;
  for (const name of TOOL_NAMES) {
    const matches = source.match(new RegExp(`<${name}>`, 'g'));
    count += matches ? matches.length : 0;
  }
  return count;
}

function extractTool(source: string, name: string, start: number): ParsedToolUse {
  const openTag = `<${name}>`;
  const closeTag = `</${name}>`;
  const bodyStart = start + openTag.length;
  const params: Record<string, string> = {};
  const paramNames = TOOL_PARAMS[name] || [];
  const siblingPattern = paramNames.length > 0 ? paramNames.map(escapeRegex).join('|') : '[a-z_]+';

  let cursor = bodyStart;
  let closeIndex = -1;
  const bodySpans: Array<[number, number]> = [];

  // Resolve body params first: their closing tag is the first one that is followed only by
  // other params of this tool and the tool's closing tag.
  for (const param of paramNames.filter((entry) => BODY_PARAMS.has(entry))) {
    const open = `<${param}>`;
    const close = `</${param}>`;
    const openIndex = source.indexOf(open, bodyStart);
    if (openIndex === -1) {
      continue;
    }
    const valueStart = openIndex + open.length;
    let searchFrom = valueStart;
    let chosen = -1;
    const tail = new RegExp(`^\\s*(?:<(${siblingPattern})>[\\s\\S]*?<\\/\\1>\\s*)*${escapeRegex(closeTag)}`);
    while (true) {
      const candidate = source.indexOf(close, searchFrom);
      if (candidate === -1) {
        break;
      }
      const after = source.slice(candidate + close.length);
      if (tail.test(after)) {
        chosen = candidate;
        break;
      }
      searchFrom = candidate + close.length;
    }
    if (chosen === -1) {
      // Fallback: first closing tag (or partial value while streaming).
      const first = source.indexOf(close, valueStart);
      if (first === -1) {
        params[param] = trimBody(source.slice(valueStart));
        return { name, params: finalizeParams(name, params), partial: true, start, end: source.length };
      }
      chosen = first;
    }
    params[param] = trimBody(source.slice(valueStart, chosen));
    bodySpans.push([valueStart, chosen]);
    cursor = Math.max(cursor, chosen + close.length);
  }

  closeIndex = source.indexOf(closeTag, cursor);

  // If another `<name>` opens after `cursor` before `closeTag`, the first block had its closing
  // tag corrupted and was followed by a clean repeated tool call; prefer the clean block.
  const nextOpen = source.indexOf(openTag, cursor);
  if (nextOpen !== -1 && (closeIndex === -1 || nextOpen < closeIndex)) {
    const nextClose = source.indexOf(closeTag, nextOpen + openTag.length);
    if (nextClose !== -1) {
      return extractTool(source, name, nextOpen);
    }
  }

  let closeLength = closeTag.length;
  if (closeIndex === -1 && name.length >= 6) {
    // Recover when a mid-stream splice corrupted the outer closing tag (e.g. `</apply_d...iff>`)
    // after all inner parameters were already closed.
    const prefix = escapeRegex(name.slice(0, 4));
    const suffix = escapeRegex(name.slice(-3));
    const corruptedClose = new RegExp(`^(\\s*(?:<(${siblingPattern})>[\\s\\S]*?<\\/\\2>\\s*)*)<\\/${prefix}[^>]{1,120}?${suffix}>`);
    const match = source.slice(cursor).match(corruptedClose);
    if (match) {
      closeIndex = cursor + match[1].length;
      closeLength = match[0].length - match[1].length;
    }
  }

  // Mask body params so a "<path>" inside file content cannot shadow the real parameter.
  let toolBody = source.slice(bodyStart, closeIndex === -1 ? source.length : closeIndex);
  for (const [from, to] of bodySpans) {
    const relFrom = from - bodyStart;
    const relTo = to - bodyStart;
    if (relFrom >= 0 && relTo <= toolBody.length) {
      toolBody = toolBody.slice(0, relFrom) + ' '.repeat(relTo - relFrom) + toolBody.slice(relTo);
    }
  }

  for (const param of paramNames.filter((entry) => !BODY_PARAMS.has(entry))) {
    const match = toolBody.match(new RegExp(`<${param}>([\\s\\S]*?)<\\/${param}>`));
    if (match) {
      params[param] = match[1].trim();
    } else if (closeIndex === -1) {
      const partial = toolBody.match(new RegExp(`<${param}>([\\s\\S]*)$`));
      if (partial) {
        params[param] = partial[1].trim();
      }
    }
  }

  return {
    name,
    params: finalizeParams(name, params),
    partial: closeIndex === -1,
    start,
    end: closeIndex === -1 ? source.length : closeIndex + closeLength,
  };
}

/**
 * Unwraps Markdown links `[https://...](https://...)` injected by Perplexity's post-processor
 * when the link label and target URL are identical.
 */
export function unwrapAutoLinkedUrls(value: string): string {
  return value.replace(/\[(https?:\/\/[^\s\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (full, label: string, href: string) => {
    const normLabel = label.replace(/\/+$/, '');
    const normHref = href.replace(/\/+$/, '');
    return normLabel === normHref ? label : full;
  });
}

function finalizeParams(name: string, params: Record<string, string>): Record<string, string> {
  if (params.path) {
    params.path = unwrapAutoLinkedUrls(decodeEntities(params.path)).replace(/^["'`]|["'`]$/g, '').trim();
  }
  if (params.cwd) {
    params.cwd = unwrapAutoLinkedUrls(decodeEntities(params.cwd)).replace(/^["'`]|["'`]$/g, '').trim();
  }
  if (typeof params.command === 'string') {
    params.command = unwrapAutoLinkedUrls(decodeEntities(params.command));
  }
  const isMarkdownPath = Boolean(params.path && /\.(md|mdx|markdown)$/i.test(params.path));
  if ((name === 'write_to_file' || name === 'insert_content') && typeof params.content === 'string') {
    params.content = stripWrappingFence(params.content);
    if (!isMarkdownPath) {
      params.content = unwrapAutoLinkedUrls(params.content);
    }
  }
  if (name === 'apply_diff' && typeof params.diff === 'string' && !isMarkdownPath) {
    params.diff = unwrapAutoLinkedUrls(params.diff);
  }
  return params;
}

function trimBody(value: string): string {
  return value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/** Models sometimes wrap file content in a markdown fence inside <content>. */
export function stripWrappingFence(content: string): string {
  const match = content.match(/^\s*```[^\n`]*\n([\s\S]*?)\n```\s*$/);
  return match ? match[1] : content;
}

function splitThinking(text: string, partial: boolean): { text: string; reasoning: string } {
  const reasoningParts: string[] = [];
  let output = text.replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_all, inner: string) => {
    reasoningParts.push(inner.trim());
    return '';
  });
  const unclosed = output.indexOf('<thinking>');
  if (unclosed !== -1) {
    reasoningParts.push(output.slice(unclosed + '<thinking>'.length).trim());
    output = output.slice(0, unclosed);
  }
  if (partial) {
    // Hide a tool tag that is still being streamed ("<read_fi").
    output = output.replace(/<[a-z_]*$/, '');
  }
  return { text: output, reasoning: reasoningParts.filter(Boolean).join('\n\n') };
}

function cleanupProse(text: string): string {
  const toolNamesGroup = TOOL_NAMES.map(escapeRegex).join('|');
  const echoedFence = new RegExp(`\`\`\`(?:xml|html)?\\s*<(${toolNamesGroup})>[\\s\\S]*?<\\/\\1>\\s*\`\`\``, 'gi');
  return text
    .replace(echoedFence, '')
    .replace(/```(?:xml|html)?\s*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const STATUS_RANK: Record<TodoItem['status'], number> = { pending: 0, in_progress: 1, completed: 2 };

/**
 * Parses a markdown checklist: [ ] pending, [-] in progress, [x] completed.
 * Items with the same text are merged (first position, most advanced status): a repeated block
 * from a streaming glitch or a model echo must not show every step twice.
 */
export function parseTodos(markdown: string): TodoItem[] {
  const items: TodoItem[] = [];
  const byKey = new Map<string, TodoItem>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:[-*]\s*|\d+[.)]\s*)?\[([ xX\-~])\]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const text = match[2].trim();
    const status: TodoItem['status'] = match[1] === ' ' ? 'pending' : (match[1] === '-' || match[1] === '~') ? 'in_progress' : 'completed';
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    const existing = byKey.get(key);
    if (existing) {
      if (STATUS_RANK[status] > STATUS_RANK[existing.status]) {
        existing.status = status;
      }
      continue;
    }
    const item = { text, status };
    byKey.set(key, item);
    items.push(item);
  }
  return items;
}

export function formatTodos(todos: TodoItem[]): string {
  return todos
    .map((todo) => `[${todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '-' : ' '}] ${todo.text}`)
    .join('\n');
}

export function parseFollowUpSuggestions(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const suggestions: string[] = [];
  const regex = /<suggest(?:\s+mode="[^"]*")?>([\s\S]*?)<\/suggest>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const text = match[1].trim();
    if (text) {
      suggestions.push(text);
    }
  }
  return suggestions;
}
