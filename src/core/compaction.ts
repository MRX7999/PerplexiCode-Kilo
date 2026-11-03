import type { ApiMessage } from '../agent/prompts';
import type { CompletionProvider } from '../agent/task';
import type { ModelSelection } from '../agent/types';

/**
 * /compact: summarise the transcript with the current model and replace it with the summary plus
 * the most recent messages. The Perplexity follow-up thread is reset because its server-side
 * context no longer matches.
 */

export const COMPACT_INSTRUCTIONS = `You are compacting the transcript of a coding-agent session so the work can continue in a fresh context.
Write a dense summary in the language of the user's task with these sections:
1. Task: the user's goal and explicit requirements, verbatim where important.
2. Decisions and constraints: choices made, things the user rejected, permission denials.
3. Work done: files created/edited (paths) and what changed; commands run with their results (exit codes, failing tests).
4. Current state: what is verified, what is broken, open errors (exact messages).
5. Next steps: the concrete remaining steps, in order.
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
}

export async function compactMessages(options: CompactOptions): Promise<{ messages: ApiMessage[]; summary: string; before: number; after: number }> {
  const keep = Math.max(0, options.keepLast ?? 2);
  const head = options.messages.slice(0, Math.max(0, options.messages.length - keep));
  const tail = options.messages.slice(head.length);
  if (head.length === 0) {
    return { messages: options.messages, summary: '', before: options.messages.length, after: options.messages.length };
  }
  const limit = options.maxTranscriptChars ?? 120_000;
  let transcript = head.map((message) => `[${message.role === 'user' ? 'USER' : 'ASSISTANT'}]\n${message.content}`).join('\n\n');
  if (transcript.length > limit) {
    // Keep the start (task) and the most recent part.
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
  // The transcript must end with a USER message for the agent loop.
  if (messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '[Context was compacted. Continue the task.]', ts: now });
  }
  return { messages, summary, before: options.messages.length, after: messages.length };
}
