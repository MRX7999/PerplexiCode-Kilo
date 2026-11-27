import { CompletionProvider } from './task';
import { lineDiff } from './diffEngine';

export interface QuickEditPromptInput {
  filePath: string;
  languageId: string;
  instruction: string;
  selectedText: string;
  prefixContext: string;
  suffixContext: string;
}

/**
 * F31: Builds a focused inline-selection transformation prompt instructing the model to stream
 * ONLY the replacement code for the selected range.
 */
export function buildQuickEditPrompt(input: QuickEditPromptInput): string {
  return [
    'You are performing an inline editor quick-edit (Cmd/Ctrl+I).',
    `File: ${input.filePath} (${input.languageId || 'plaintext'})`,
    '',
    'Instruction from user:',
    input.instruction.trim(),
    '',
    'Surrounding context BEFORE selection (read-only, DO NOT repeat in output):',
    '<<<PREFIX_CONTEXT',
    input.prefixContext,
    'PREFIX_CONTEXT>>>',
    '',
    'Selected code to replace:',
    '<<<SELECTED_CODE',
    input.selectedText,
    'SELECTED_CODE>>>',
    '',
    'Surrounding context AFTER selection (read-only, DO NOT repeat in output):',
    '<<<SUFFIX_CONTEXT',
    input.suffixContext,
    'SUFFIX_CONTEXT>>>',
    '',
    'Output ONLY the replacement code for <<<SELECTED_CODE ... SELECTED_CODE>>> inside a single fenced code block.',
    'Do not include explanations, prose, or the surrounding prefix/suffix lines.',
  ].join('\n');
}

/**
 * Extracts live replacement code from a partial or completed model response, stripping `<think>`
 * blocks and markdown code fences cleanly as chunks stream in.
 */
export function extractStreamingQuickEditCode(rawStreamedText: string, originalIndent = ''): string {
  let cleaned = (rawStreamedText || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '');

  const trimmedStart = cleaned.trimStart();
  const fenceOpen = /^```[^\r\n]*\r?\n/.exec(trimmedStart);
  if (fenceOpen) {
    let body = trimmedStart.slice(fenceOpen[0].length);
    const fenceCloseIdx = body.lastIndexOf('\n```');
    if (fenceCloseIdx !== -1 && body.slice(fenceCloseIdx + 4).trim() === '') {
      body = body.slice(0, fenceCloseIdx);
    } else if (body.endsWith('```')) {
      body = body.slice(0, -3).replace(/\r?\n$/, '');
    }
    return body;
  }

  cleaned = cleaned.replace(/^```[^\r\n]*$/m, '').trim();
  if (!cleaned && originalIndent) {
    return '';
  }
  return cleaned;
}

export interface StreamingDiffSnapshot {
  replacementCode: string;
  previewFullDocument: string;
  unifiedPreviewLines: string[];
  added: number;
  removed: number;
}

/**
 * Pure stateful streaming diff assembler for `Cmd/Ctrl+I` quick-edit.
 * Produces incremental document previews and line-level diff stats on every incoming chunk.
 */
export class QuickEditStreamAssembler {
  private latestRaw = '';

  constructor(
    private readonly fullDocumentText: string,
    private readonly selectionStartOffset: number,
    private readonly selectionEndOffset: number
  ) {}

  private get _selectedOriginal(): string {
    return this.fullDocumentText.slice(this.selectionStartOffset, this.selectionEndOffset);
  }

  update(accumulatedModelText: string): StreamingDiffSnapshot {
    this.latestRaw = accumulatedModelText;
    const replacementCode = extractStreamingQuickEditCode(accumulatedModelText);
    const before = this.fullDocumentText.slice(0, this.selectionStartOffset);
    const after = this.fullDocumentText.slice(this.selectionEndOffset);
    const previewFullDocument = `${before}${replacementCode}${after}`;

    const diff = lineDiff(this._selectedOriginal, replacementCode);
    let added = 0;
    let removed = 0;
    const unifiedPreviewLines: string[] = [];
    for (const entry of diff) {
      if (entry.type === '+') {
        added += 1;
        unifiedPreviewLines.push(`+ ${entry.text}`);
      } else if (entry.type === '-') {
        removed += 1;
        unifiedPreviewLines.push(`- ${entry.text}`);
      } else if (entry.type === ' ') {
        unifiedPreviewLines.push(`  ${entry.text}`);
      }
    }

    return {
      replacementCode,
      previewFullDocument,
      unifiedPreviewLines,
      added,
      removed,
    };
  }

  finalize(): StreamingDiffSnapshot {
    return this.update(this.latestRaw);
  }
}

export interface RunInlineQuickEditOptions {
  provider: CompletionProvider;
  baseModelId: string;
  filePath: string;
  languageId: string;
  fullDocumentText: string;
  selectionStartOffset: number;
  selectionEndOffset: number;
  instruction: string;
  signal: AbortSignal;
  onStreamSnapshot?: (snapshot: StreamingDiffSnapshot) => void;
}

export async function runInlineQuickEdit(options: RunInlineQuickEditOptions): Promise<StreamingDiffSnapshot> {
  const prefixStart = Math.max(0, options.selectionStartOffset - 2000);
  const suffixEnd = Math.min(options.fullDocumentText.length, options.selectionEndOffset + 2000);
  const selectedText = options.fullDocumentText.slice(options.selectionStartOffset, options.selectionEndOffset);
  const prompt = buildQuickEditPrompt({
    filePath: options.filePath,
    languageId: options.languageId,
    instruction: options.instruction,
    selectedText,
    prefixContext: options.fullDocumentText.slice(prefixStart, options.selectionStartOffset),
    suffixContext: options.fullDocumentText.slice(options.selectionEndOffset, suffixEnd),
  });

  const assembler = new QuickEditStreamAssembler(
    options.fullDocumentText,
    options.selectionStartOffset,
    options.selectionEndOffset
  );

  const completion = await options.provider.complete({
    fullPrompt: prompt,
    baseModelId: options.baseModelId,
    thinking: false,
    webSearch: false,
    computeMode: 'search',
    signal: options.signal,
    onText: (accumulatedText: string) => {
      const snap = assembler.update(accumulatedText);
      options.onStreamSnapshot?.(snap);
    },
  });

  const finalSnap = assembler.update(completion.text);
  options.onStreamSnapshot?.(finalSnap);
  return finalSnap;
}
