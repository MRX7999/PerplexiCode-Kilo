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
}

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

  return {
    text: cleanupProse(text),
    reasoning,
    tool,
    ignoredToolCount,
  };
}

function findFirstTool(source: string): { name: string; index: number } | undefined {
  let best: { name: string; index: number } | undefined;
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
      if (!best || match.index < best.index) {
        best = { name, index: match.index };
      }
      break;
    }
  }
  return best;
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

  let cursor = bodyStart;
  let closeIndex = -1;
  const bodySpans: Array<[number, number]> = [];

  // Resolve body params first: their closing tag is the first one that is followed only by
  // other params and the tool's closing tag.
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
    while (true) {
      const candidate = source.indexOf(close, searchFrom);
      if (candidate === -1) {
        break;
      }
      const after = source.slice(candidate + close.length);
      const tail = new RegExp(`^\\s*(?:<([a-z_]+)>[\\s\\S]*?<\\/\\1>\\s*)*${escapeRegex(closeTag)}`);
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
    end: closeIndex === -1 ? source.length : closeIndex + closeTag.length,
  };
}

function finalizeParams(name: string, params: Record<string, string>): Record<string, string> {
  if ((name === 'write_to_file' || name === 'insert_content') && typeof params.content === 'string') {
    params.content = stripWrappingFence(params.content);
  }
  if (params.path) {
    params.path = params.path.replace(/^["'`]|["'`]$/g, '').trim();
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
  return text
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

/** Parses a markdown checklist: [ ] pending, [-] in progress, [x] completed. */
export function parseTodos(markdown: string): TodoItem[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:[-*]\s*)?\[([ xX\-~])\]\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      text: match[2].trim(),
      status: match[1] === ' ' ? 'pending' : (match[1] === '-' || match[1] === '~') ? 'in_progress' : 'completed',
    }));
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
