import type { CompletionProvider } from '../agent/task';
import type { ApiMessage, ModelSelection, TodoItem } from '../agent/types';

/**
 * Conversation compaction (`/compact` and threshold-based structured auto-compaction).
 *
 * When a long coding session approaches `maxPromptChars`, older turns are summarized into a
 * structured state block while preserving the system prompt and the last N steps untouched.
 */

export const COMPACT_INSTRUCTIONS = `You are compacting the transcript of a coding-agent session so the work can continue in a fresh context.
Write a dense, factual Markdown summary using these four structured headings:
## Modified files
- Every file created, modified, or deleted (exact workspace-relative paths and what changed).
## Verified hypotheses
- Files inspected, commands/tests executed, exit codes, and root causes confirmed or ruled out.
## Constraints
- User goal, explicit instructions, architectural constraints, denied actions, and safety boundaries.
## Todo status
- Completed items, in-progress step, and remaining items.

Do not invent anything. Do not call tools. Output only the summary.`;

export interface CompactOptions {
  provider: CompletionProvider;
  selection: ModelSelection;
  messages: ApiMessage[];
  /** Messages kept verbatim at the end (default 2: last tool result + last answer). */
  keepLast?: number;
  focus?: string;
  signal?: AbortSignal;
  maxTranscriptChars?: number;
  todos?: readonly TodoItem[];
}

export interface CompactionResult {
  before: number;
  after: number;
  summary: string;
  messages: ApiMessage[];
}

export interface StructuredCompactionSections {
  modifiedFiles: string[];
  verifiedHypotheses: string[];
  constraints: string[];
  todoStatus: string[];
}

export interface StructuredCompactionResult extends CompactionResult {
  sections: StructuredCompactionSections;
  compactedMessages: number;
  keptMessages: number;
  keptSteps: number;
}

export interface AutoCompactCheck {
  shouldCompact: boolean;
  estimatedChars: number;
  thresholdChars: number;
  thresholdRatio: number;
}

export function estimateMessagesChars(messages: readonly ApiMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length + 32, 0);
}

/**
 * Checks whether the upcoming prompt exceeds `maxPromptChars * thresholdRatio`.
 * `thresholdRatio <= 0` disables auto-compaction.
 */
export function checkAutoCompactThreshold(params: {
  systemChars: number;
  messages: readonly ApiMessage[];
  maxPromptChars: number;
  thresholdRatio: number;
}): AutoCompactCheck {
  const ratio = Number.isFinite(params.thresholdRatio) ? params.thresholdRatio : 0.8;
  if (ratio <= 0 || params.maxPromptChars <= 0) {
    const estimatedChars = params.systemChars + estimateMessagesChars(params.messages);
    return {
      shouldCompact: false,
      estimatedChars,
      thresholdChars: params.maxPromptChars,
      thresholdRatio: ratio,
    };
  }
  const clampedRatio = Math.min(0.98, Math.max(0.3, ratio));
  const thresholdChars = Math.floor(params.maxPromptChars * clampedRatio);
  const estimatedChars = params.systemChars + estimateMessagesChars(params.messages);
  return {
    shouldCompact: estimatedChars >= thresholdChars,
    estimatedChars,
    thresholdChars,
    thresholdRatio: clampedRatio,
  };
}

function clipLine(text: string, maxLen = 180): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(20, maxLen - 3)).trimEnd()}...`;
}

function extractStructuredSections(
  headMessages: readonly ApiMessage[],
  todos?: readonly TodoItem[]
): StructuredCompactionSections {
  const modifiedMap = new Map<string, string>();
  const hypotheses: string[] = [];
  const seenHypotheses = new Set<string>();
  const constraints: string[] = [];
  const seenConstraints = new Set<string>();

  const addHypothesis = (line: string) => {
    const cleaned = clipLine(line, 190);
    if (cleaned && !seenHypotheses.has(cleaned) && hypotheses.length < 18) {
      seenHypotheses.add(cleaned);
      hypotheses.push(cleaned);
    }
  };

  const addConstraint = (line: string) => {
    const cleaned = clipLine(line, 190);
    if (cleaned && !seenConstraints.has(cleaned) && constraints.length < 12) {
      seenConstraints.add(cleaned);
      constraints.push(cleaned);
    }
  };

  for (let idx = 0; idx < headMessages.length; idx += 1) {
    const msg = headMessages[idx];
    const content = msg.content || '';

    // Carry forward facts from any earlier compacted_context block
    if (content.includes('<compacted_context')) {
      const prevModified = /## (?:Modified files|Изменённые файлы)\n([\s\S]*?)(?=\n## |\n<\/compacted_context>|$)/.exec(content);
      if (prevModified) {
        for (const raw of prevModified[1].split('\n')) {
          const item = raw.replace(/^-\s*/, '').trim();
          if (item && item !== '(no modified files)' && item !== '(нет изменённых файлов)') {
            const pathKey = item.split(':')[0].trim();
            modifiedMap.set(pathKey, item);
          }
        }
      }
      const prevHyp = /## (?:Verified hypotheses|Проверенные гипотезы)\n([\s\S]*?)(?=\n## |\n<\/compacted_context>|$)/.exec(content);
      if (prevHyp) {
        for (const raw of prevHyp[1].split('\n')) {
          const item = raw.replace(/^-\s*/, '').trim();
          if (item && item !== '(no verified hypotheses)' && item !== '(нет проверенных гипотез)') {
            addHypothesis(item);
          }
        }
      }
      const prevCon = /## (?:Constraints|Ограничения)\n([\s\S]*?)(?=\n## |\n<\/compacted_context>|$)/.exec(content);
      if (prevCon) {
        for (const raw of prevCon[1].split('\n')) {
          const item = raw.replace(/^-\s*/, '').trim();
          if (item && item !== '(no explicit constraints recorded)' && item !== '(явных ограничений не зафиксировано)') {
            addConstraint(item);
          }
        }
      }
      continue;
    }

    if (idx === 0 && msg.role === 'user') {
      const taskMatch = /<task>\s*([\s\S]*?)\s*<\/task>/.exec(content);
      const rawGoal = taskMatch ? taskMatch[1] : content;
      addConstraint(`Original task: ${clipLine(rawGoal, 220)}`);
    }

    if (msg.role === 'assistant') {
      // Detect edit tool calls
      const editToolRegex = /<(write_to_file|apply_diff|search_and_replace|insert_content|delete_file)>\s*[\s\S]*?<path>([^<]+)<\/path>/g;
      let editMatch: RegExpExecArray | null;
      while ((editMatch = editToolRegex.exec(content)) !== null) {
        const toolName = editMatch[1];
        const filePath = editMatch[2].trim();
        if (filePath && !modifiedMap.has(filePath)) {
          modifiedMap.set(filePath, `${filePath}: ${toolName}`);
        }
      }

      // Detect read/search/command hypotheses
      const readRegex = /<read_file>\s*[\s\S]*?<path>([^<]+)<\/path>/g;
      let readMatch: RegExpExecArray | null;
      while ((readMatch = readRegex.exec(content)) !== null) {
        addHypothesis(`Read file ${readMatch[1].trim()}`);
      }
      const searchRegex = /<search_files>\s*[\s\S]*?<regex>([^<]+)<\/regex>/g;
      let searchMatch: RegExpExecArray | null;
      while ((searchMatch = searchRegex.exec(content)) !== null) {
        addHypothesis(`Searched for /${clipLine(searchMatch[1], 60)}/`);
      }
    }

    if (msg.role === 'user') {
      // Successful file edit results with diff stats
      const appliedRegex = /The (new file was created|changes were applied) successfully:\s*([^\s(]+)\s*(\([^)]+\))?/g;
      let appMatch: RegExpExecArray | null;
      while ((appMatch = appliedRegex.exec(content)) !== null) {
        const kind = appMatch[1] === 'new file was created' ? 'created' : 'modified';
        const filePath = appMatch[2].trim();
        const stats = appMatch[3] ? ` ${appMatch[3]}` : '';
        modifiedMap.set(filePath, `${filePath}: ${kind}${stats}`);
      }

      // Command execution outcomes
      const cmdResultRegex = /\[execute_command for '([^']+)'\]\s*Result:\s*([\s\S]*?)(?=\n\n\[|$)/g;
      let cmdMatch: RegExpExecArray | null;
      while ((cmdMatch = cmdResultRegex.exec(content)) !== null) {
        const cmd = clipLine(cmdMatch[1], 80);
        const exitMatch = /Exit code:\s*(-?\d+|null)/i.exec(cmdMatch[2]);
        const exitInfo = exitMatch ? ` (exit ${exitMatch[1]})` : '';
        addHypothesis(`Command \`${cmd}\`${exitInfo}: ${clipLine(cmdMatch[2], 90)}`);
      }

      // Post-edit diagnostics
      if (content.includes('New problems detected after saving the file:')) {
        const diagSnippet = content.split('New problems detected after saving the file:')[1] || '';
        addHypothesis(`Diagnostics after edit: ${clipLine(diagSnippet, 120)}`);
      }

      // Explicit feedback, denials, or rule blocks
      const feedbackMatch = /<feedback>\s*([\s\S]*?)\s*<\/feedback>/.exec(content);
      if (feedbackMatch) {
        addConstraint(`User clarification: ${feedbackMatch[1]}`);
      }
      if (/Permission rule|denied this action|requires explicit confirmation|blocked by SSRF/i.test(content)) {
        addConstraint(`Safety constraint: ${clipLine(content, 150)}`);
      }
    }
  }

  let todoLines: string[] = [];
  if (todos && todos.length > 0) {
    todoLines = todos.map((item) => {
      const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[-]' : '[ ]';
      return `${mark} ${clipLine(item.text, 140)}`;
    });
  } else {
    // Fallback: inspect last <update_todo_list> in compacted messages
    for (let i = headMessages.length - 1; i >= 0; i -= 1) {
      const todoMatch = /<todos>\s*([\s\S]*?)\s*<\/todos>/.exec(headMessages[i].content);
      if (todoMatch) {
        todoLines = todoMatch[1]
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 15);
        break;
      }
    }
  }

  return {
    modifiedFiles: [...modifiedMap.values()],
    verifiedHypotheses: hypotheses,
    constraints,
    todoStatus: todoLines,
  };
}

export function formatStructuredCompactionSummary(sections: StructuredCompactionSections, maxChars = 6000): string {
  const renderList = (items: string[], emptyLabel: string) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : `- ${emptyLabel}`;

  const raw = [
    '## Modified files',
    renderList(sections.modifiedFiles, '(no modified files)'),
    '',
    '## Verified hypotheses',
    renderList(sections.verifiedHypotheses, '(no verified hypotheses)'),
    '',
    '## Constraints',
    renderList(sections.constraints, '(no explicit constraints recorded)'),
    '',
    '## Todo status',
    renderList(sections.todoStatus, '(todo list is empty)'),
  ].join('\n');

  if (raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, Math.max(200, maxChars - 32)).trimEnd()}\n... [summary truncated]`;
}

/**
 * F13: Deterministic structured auto-compaction triggered when prompt approaches `maxPromptChars`.
 * - System prompt is external and NEVER modified.
 * - The last `keepSteps` steps (each step = 1 assistant turn + 1 user/tool turn, i.e. `2 * keepSteps`
 *   messages when available) are preserved verbatim without touching a single character.
 * - Older turns are replaced by a structured summary with 4 sections:
 *   Modified files, Verified hypotheses, Constraints, Todo status.
 */
export function structuredAutoCompact(params: {
  messages: ApiMessage[];
  todos?: readonly TodoItem[];
  keepSteps?: number;
  maxSummaryChars?: number;
}): StructuredCompactionResult {
  const { messages, todos } = params;
  const keepSteps = Math.max(1, Math.floor(params.keepSteps ?? 4));
  const before = messages.reduce((sum, m) => sum + m.content.length, 0);

  // Determine untouched tail: keep last N steps (2 * keepSteps messages, or 2 * keepSteps - 1)
  const desiredTailMessages = keepSteps * 2;
  if (messages.length <= desiredTailMessages + 1) {
    const emptySections = extractStructuredSections([], todos);
    return {
      before,
      after: before,
      summary: '',
      messages: [...messages],
      sections: emptySections,
      compactedMessages: 0,
      keptMessages: messages.length,
      keptSteps: keepSteps,
    };
  }

  let tailStart = messages.length - desiredTailMessages;
  if (tailStart < 1) {
    tailStart = 1;
  }

  const head = messages.slice(0, tailStart);
  const untouchedTail = messages.slice(tailStart);

  const sections = extractStructuredSections(head, todos);
  const summary = formatStructuredCompactionSummary(sections, params.maxSummaryChars ?? 6000);
  const compactedEnvelope = [
    `<compacted_context mode="auto" compacted_messages="${head.length}" kept_steps="${keepSteps}">`,
    summary,
    '</compacted_context>',
  ].join('\n');

  const now = Date.now();
  const prefix: ApiMessage[] = untouchedTail[0]?.role === 'user'
    ? [
      { role: 'user', content: compactedEnvelope, ts: now },
      { role: 'assistant', content: 'Understood. Continuing the work from the structured context summary.', ts: now },
    ]
    : [{ role: 'user', content: compactedEnvelope, ts: now }];

  const compacted: ApiMessage[] = [...prefix, ...untouchedTail];
  const after = compacted.reduce((sum, m) => sum + m.content.length, 0);

  return {
    before,
    after,
    summary,
    messages: compacted,
    sections,
    compactedMessages: head.length,
    keptMessages: untouchedTail.length,
    keptSteps: keepSteps,
  };
}

export async function compactMessages(options: CompactOptions): Promise<{
  messages: ApiMessage[];
  summary: string;
  before: number;
  after: number;
}> {
  const keep = Math.max(0, options.keepLast ?? 2);
  const head = options.messages.slice(0, Math.max(0, options.messages.length - keep));
  const tail = options.messages.slice(head.length);
  if (head.length === 0) {
    return {
      messages: options.messages,
      summary: '',
      before: options.messages.length,
      after: options.messages.length,
    };
  }
  const limit = options.maxTranscriptChars ?? 120_000;
  let transcript = head
    .map((message) => `[${message.role === 'user' ? 'USER' : 'ASSISTANT'}]\n${message.content}`)
    .join('\n\n');
  if (transcript.length > limit) {
    transcript = `${transcript.slice(0, Math.floor(limit * 0.3))}\n\n[... ${transcript.length - limit} characters omitted ...]\n\n${transcript.slice(-Math.floor(limit * 0.7))}`;
  }
  const prompt = `${COMPACT_INSTRUCTIONS}${options.focus ? `\nFocus especially on: ${options.focus}` : ''}\n\n====\n\nTRANSCRIPT\n\n${transcript}\n\n====\n\nWrite the summary now.`;
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const result = await options.provider.complete({
    fullPrompt: prompt,
    baseModelId: options.selection.baseModelId,
    thinking: false,
    webSearch: false,
    signal: controller.signal,
  });
  const summary = result.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  if (!summary) {
    throw new Error('The model returned an empty summary; the transcript was not changed.');
  }
  const now = Date.now();
  const messages: ApiMessage[] = [
    { role: 'user', content: `<compacted_context>\nThe earlier part of this session was compacted. Summary:\n\n${summary}\n</compacted_context>`, ts: now },
    { role: 'assistant', content: 'Understood. I will continue from this summary and re-read files before editing them.', ts: now },
    ...tail,
  ];
  if (messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '[Context was compacted. Continue the task.]', ts: now });
  }
  return { messages, summary, before: options.messages.length, after: messages.length };
}
