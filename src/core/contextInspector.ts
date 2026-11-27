import { truncateMiddle } from '../agent/prompts';
import { ApiMessage } from '../agent/types';
import { scrubSecretsFromText } from './diagnostics';

export type ContextItemCategory =
  | 'system'
  | 'rules'
  | 'mcp'
  | 'repo_map'
  | 'compacted'
  | 'message'
  | 'tool_result';

export type ContextItemStatus = 'included' | 'compacted' | 'omitted' | 'excluded';

export interface ContextInspectionItem {
  id: string;
  category: ContextItemCategory;
  label: string;
  chars: number;
  originalChars: number;
  status: ContextItemStatus;
  reason: string;
  compactionDetail?: string;
  canExclude: boolean;
  excluded: boolean;
  preview: string;
}

export interface ContextInspectionReport {
  totalChars: number;
  maxPromptChars: number;
  usageRatio: number;
  autoCompactThresholdRatio: number;
  autoCompactThresholdChars: number;
  compactedCharsSaved: number;
  excludedCount: number;
  items: ContextInspectionItem[];
}

export interface PromptAssemblyInputs {
  baseSystemPrompt: string;
  /** True when `baseSystemPrompt` already embeds non-excluded `rulesBlock` and `mcpSection`. */
  systemIncludesRulesAndMcp?: boolean;
  rulesBlock?: string;
  mcpSection?: string;
  repoMapBlock?: string;
  repoMapReason?: string;
  repoMapOmittedFiles?: number;
  messages: readonly ApiMessage[];
  maxPromptChars: number;
  autoCompactThresholdRatio?: number;
  autoCompactKeepSteps?: number;
  excludedIds?: ReadonlySet<string>;
  lastCompactionStats?: { before: number; after: number; compactedMessages: number };
}

function safePreview(text: string, maxLen = 140): string {
  const scrubbed = scrubSecretsFromText(text || '').replace(/\s+/g, ' ').trim();
  if (scrubbed.length <= maxLen) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, Math.max(20, maxLen - 3)).trimEnd()}...`;
}

function describeMessageLabelAndReason(
  msg: ApiMessage,
  index: number,
  totalMessages: number,
  keepSteps: number
): { category: ContextItemCategory; label: string; reason: string; canExclude: boolean } {
  const content = msg.content || '';
  if (content.includes('<compacted_context')) {
    return {
      category: 'compacted',
      label: `Сжатая сводка истории (#${index})`,
      reason: 'Структурированная сводка предыдущих шагов (изменённые файлы, гипотезы, ограничения, todo)',
      canExclude: true,
    };
  }

  if (index === 0) {
    return {
      category: 'message',
      label: 'Исходная задача (#0)',
      reason: 'Постановка задачи и стартовый контекст рабочей директории',
      canExclude: false,
    };
  }

  const isRecentTail = index >= Math.max(1, totalMessages - keepSteps * 2);
  const isVeryLastUserTurn = index === totalMessages - 1 && msg.role === 'user';

  const toolResultMatch = /\[([a-z_]+)(?:\s+for\s+'([^']+)')?\]\s*Result:/i.exec(content);
  if (toolResultMatch) {
    const toolName = toolResultMatch[1];
    const target = toolResultMatch[2] ? ` (${toolResultMatch[2]})` : '';
    return {
      category: 'tool_result',
      label: `Результат ${toolName}${target} (#${index})`,
      reason: isVeryLastUserTurn
        ? 'Актуальный результат последнего инструмента для следующего шага'
        : isRecentTail
          ? `Входит в последние ${keepSteps} шагов (не сжимается автоматически)`
          : 'Исторический результат вызова инструмента в окне контекста',
      canExclude: !isVeryLastUserTurn,
    };
  }

  if (msg.role === 'assistant') {
    const toolCallMatch = /<(read_file|write_to_file|apply_diff|search_and_replace|execute_command|search_files|list_files|attempt_completion|ask_followup_question|web_fetch|use_mcp_tool)\b/.exec(content);
    const callHint = toolCallMatch ? `: ${toolCallMatch[1]}` : '';
    return {
      category: 'message',
      label: `Ответ агента${callHint} (#${index})`,
      reason: isRecentTail
        ? `Входит в последние ${keepSteps} шагов (сохраняется дословно)`
        : 'Предыдущий шаг рассуждений и вызова инструмента агента',
      canExclude: true,
    };
  }

  return {
    category: 'message',
    label: `Сообщение пользователя (#${index})`,
    reason: isVeryLastUserTurn
      ? 'Текущий запрос пользователя к модели'
      : 'Уточнение пользователя в ходе диалога',
    canExclude: !isVeryLastUserTurn,
  };
}

/**
 * Assembles the exact full prompt for the next LLM turn AND produces the Context Inspector report
 * explaining what goes into the prompt, why, what was compacted/truncated, and what can be excluded.
 */
export function assembleAndInspectPrompt(inputs: PromptAssemblyInputs): {
  fullPrompt: string;
  systemPrompt: string;
  report: ContextInspectionReport;
} {
  const excludedIds = inputs.excludedIds || new Set<string>();
  const maxPromptChars = Math.max(2000, inputs.maxPromptChars);
  const keepSteps = Math.max(1, inputs.autoCompactKeepSteps ?? 4);
  const thresholdRatio = inputs.autoCompactThresholdRatio ?? 0.8;
  const thresholdChars = thresholdRatio > 0
    ? Math.floor(maxPromptChars * Math.min(0.98, Math.max(0.3, thresholdRatio)))
    : maxPromptChars;

  const items: ContextInspectionItem[] = [];
  let compactedCharsSaved = 0;

  // 1. Base system prompt (never excludable)
  const embeddedRulesLen = inputs.systemIncludesRulesAndMcp && inputs.rulesBlock && !excludedIds.has('rules')
    ? inputs.rulesBlock.length
    : 0;
  const embeddedMcpLen = inputs.systemIncludesRulesAndMcp && inputs.mcpSection && !excludedIds.has('mcp')
    ? inputs.mcpSection.length
    : 0;
  const pureBaseLen = Math.max(0, inputs.baseSystemPrompt.length - embeddedRulesLen - embeddedMcpLen);

  const systemParts: string[] = [inputs.baseSystemPrompt];
  items.push({
    id: 'system_base',
    category: 'system',
    label: 'Системный промпт и схемы инструментов',
    chars: pureBaseLen,
    originalChars: pureBaseLen,
    status: 'included',
    reason: 'Определяет роль режима, формат XML-инструментов и правила безопасности (обязателен)',
    canExclude: false,
    excluded: false,
    preview: safePreview(inputs.baseSystemPrompt),
  });

  // 2. Workspace / user rules
  if (inputs.rulesBlock && inputs.rulesBlock.trim()) {
    const rawLen = inputs.rulesBlock.length;
    const isExcluded = excludedIds.has('rules');
    if (!isExcluded && !inputs.systemIncludesRulesAndMcp) {
      systemParts.push(inputs.rulesBlock);
    }
    items.push({
      id: 'rules',
      category: 'rules',
      label: 'Правила проекта и инструкции (CLAUDE.md / rules)',
      chars: isExcluded ? 0 : rawLen,
      originalChars: rawLen,
      status: isExcluded ? 'excluded' : 'included',
      reason: isExcluded
        ? 'Исключено пользователем через инспектор контекста'
        : 'Локальные правила репозитория, навыки и пользовательские инструкции',
      canExclude: true,
      excluded: isExcluded,
      preview: safePreview(inputs.rulesBlock),
    });
  }

  // 3. MCP section
  if (inputs.mcpSection && inputs.mcpSection.trim()) {
    const rawLen = inputs.mcpSection.length;
    const isExcluded = excludedIds.has('mcp');
    if (!isExcluded && !inputs.systemIncludesRulesAndMcp) {
      systemParts.push(inputs.mcpSection);
    }
    items.push({
      id: 'mcp',
      category: 'mcp',
      label: 'Инструменты и ресурсы MCP',
      chars: isExcluded ? 0 : rawLen,
      originalChars: rawLen,
      status: isExcluded ? 'excluded' : 'included',
      reason: isExcluded
        ? 'Исключено пользователем через инспектор контекста'
        : 'Схемы подключённых MCP-серверов',
      canExclude: true,
      excluded: isExcluded,
      preview: safePreview(inputs.mcpSection),
    });
  }

  // 4. Repository map (@repo) — either passed as repoMapBlock or embedded as <repo_map> in messages
  let inlineRepoMapContent: string | undefined;
  if (!inputs.repoMapBlock) {
    for (const m of inputs.messages) {
      const match = /<repo_map>\s*([\s\S]*?)\s*<\/repo_map>/.exec(m.content || '');
      if (match) {
        inlineRepoMapContent = match[1];
        break;
      }
    }
  }
  const effectiveRepoMap = inputs.repoMapBlock || inlineRepoMapContent;
  const repoMapFromSystem = Boolean(inputs.repoMapBlock && inputs.repoMapBlock.trim());
  const repoMapExcluded = excludedIds.has('repo_map');

  if (effectiveRepoMap && effectiveRepoMap.trim()) {
    const wrappedRepo = `<repo_map>\n${effectiveRepoMap}\n</repo_map>`;
    if (repoMapFromSystem && !repoMapExcluded) {
      systemParts.push(wrappedRepo);
    }
    const omittedFiles = inputs.repoMapOmittedFiles
      || (/\+(\d+)\s+files omitted/.exec(effectiveRepoMap)?.[1] ? Number(/\+(\d+)\s+files omitted/.exec(effectiveRepoMap)![1]) : 0);
    items.push({
      id: 'repo_map',
      category: 'repo_map',
      label: 'Карта репозитория (@repo)',
      chars: repoMapExcluded ? 0 : wrappedRepo.length,
      originalChars: wrappedRepo.length,
      status: repoMapExcluded ? 'excluded' : omittedFiles > 0 ? 'compacted' : 'included',
      reason: repoMapExcluded
        ? 'Исключено пользователем через инспектор контекста'
        : inputs.repoMapReason || 'Символы, сигнатуры, импорты и связанные тесты с приоритетом активного файла и diff',
      compactionDetail: !repoMapExcluded && omittedFiles > 0
        ? `Скрыто ${omittedFiles} низкоприоритетных файлов по жёсткому бюджету карты`
        : undefined,
      canExclude: true,
      excluded: repoMapExcluded,
      preview: safePreview(effectiveRepoMap),
    });
  }

  const systemPrompt = systemParts.join('\n\n');

  // 5. Messages budget & windowing (strip inline <repo_map> when excluded or avoid double counting)
  const msgs = inputs.messages.map((m) => {
    if (!inlineRepoMapContent || !m.content.includes('<repo_map>')) {
      return m;
    }
    if (repoMapExcluded) {
      return {
        ...m,
        content: m.content.replace(/<repo_map>[\s\S]*?<\/repo_map>\s*/g, '').trim(),
      };
    }
    return m;
  });
  if (msgs.length === 0) {
    return {
      fullPrompt: systemPrompt,
      systemPrompt,
      report: {
        totalChars: systemPrompt.length,
        maxPromptChars,
        usageRatio: Math.min(1, systemPrompt.length / maxPromptChars),
        autoCompactThresholdRatio: thresholdRatio,
        autoCompactThresholdChars: thresholdChars,
        compactedCharsSaved: 0,
        excludedCount: items.filter((i) => i.excluded).length,
        items,
      },
    };
  }

  const budget = Math.max(8_000, maxPromptChars - systemPrompt.length - 400);
  const firstMsg = msgs[0];
  const firstFormatted = formatTurn('USER (TASK)', truncateMiddle(firstMsg.content, Math.floor(budget * 0.35)));
  const firstTruncated = firstFormatted.length < formatTurn('USER (TASK)', firstMsg.content).length;

  const selectedTailIndices = new Set<number>();
  const renderedByIndex = new Map<number, { formatted: string; wasMiddleTruncated: boolean }>();
  renderedByIndex.set(0, { formatted: firstFormatted, wasMiddleTruncated: firstTruncated });

  let used = firstFormatted.length;
  let omittedMiddleCount = 0;

  for (let i = msgs.length - 1; i >= 1; i -= 1) {
    const id = `msg:${i}`;
    if (excludedIds.has(id)) {
      continue;
    }
    const rawTurn = formatTurn(msgs[i].role === 'assistant' ? 'ASSISTANT' : 'USER', msgs[i].content);
    const entry = formatTurn(
      msgs[i].role === 'assistant' ? 'ASSISTANT' : 'USER',
      truncateMiddle(msgs[i].content, Math.floor(budget * 0.45))
    );
    const wasMiddleTruncated = entry.length < rawTurn.length;
    if (used + entry.length > budget && selectedTailIndices.size >= 2) {
      omittedMiddleCount += 1;
      continue;
    }
    selectedTailIndices.add(i);
    renderedByIndex.set(i, { formatted: entry, wasMiddleTruncated });
    used += entry.length;
  }

  // Record every message item in chronological order for transparent inspection
  const transcriptBlocks: string[] = [firstFormatted];

  for (let i = 0; i < msgs.length; i += 1) {
    const id = `msg:${i}`;
    const msg = msgs[i];
    const meta = describeMessageLabelAndReason(msg, i, msgs.length, keepSteps);
    const rawLen = msg.content.length;
    const isExcluded = i > 0 && excludedIds.has(id);

    if (isExcluded) {
      items.push({
        id,
        category: meta.category,
        label: meta.label,
        chars: 0,
        originalChars: rawLen,
        status: 'excluded',
        reason: 'Исключено пользователем через инспектор контекста',
        canExclude: true,
        excluded: true,
        preview: safePreview(msg.content),
      });
      continue;
    }

    if (i > 0 && !selectedTailIndices.has(i)) {
      compactedCharsSaved += rawLen;
      items.push({
        id,
        category: meta.category,
        label: meta.label,
        chars: 0,
        originalChars: rawLen,
        status: 'omitted',
        reason: 'Пропущено окном бюджета maxPromptChars (старый шаг вне лимита)',
        compactionDetail: `Сэкономлено ${rawLen} симв.`,
        canExclude: meta.canExclude,
        excluded: false,
        preview: safePreview(msg.content),
      });
      continue;
    }

    const rendered = renderedByIndex.get(i)!;
    if (i > 0) {
      if (i === 1 && omittedMiddleCount > 0) {
        // Insert omission marker right before the first kept tail message if earlier ones were dropped
      }
      transcriptBlocks.push(rendered.formatted);
    }

    const isCompactedSummary = meta.category === 'compacted';
    let compactionDetail: string | undefined;
    if (isCompactedSummary && inputs.lastCompactionStats) {
      const saved = Math.max(0, inputs.lastCompactionStats.before - inputs.lastCompactionStats.after);
      compactedCharsSaved += saved;
      compactionDetail = `Сжато ${inputs.lastCompactionStats.compactedMessages} сообщ. (${inputs.lastCompactionStats.before} → ${inputs.lastCompactionStats.after} симв.)`;
    } else if (rendered.wasMiddleTruncated) {
      const saved = Math.max(0, rawLen - rendered.formatted.length);
      compactedCharsSaved += saved;
      compactionDetail = `Усечена середина длинного сообщения (${rawLen} → ${rendered.formatted.length} симв.)`;
    }

    items.push({
      id,
      category: meta.category,
      label: meta.label,
      chars: rendered.formatted.length,
      originalChars: isCompactedSummary && inputs.lastCompactionStats
        ? inputs.lastCompactionStats.before
        : rawLen,
      status: isCompactedSummary || rendered.wasMiddleTruncated ? 'compacted' : 'included',
      reason: meta.reason,
      compactionDetail,
      canExclude: meta.canExclude,
      excluded: false,
      preview: safePreview(msg.content),
    });
  }

  // Rebuild transcript with omission notice in exact position
  const orderedTail: string[] = [];
  for (let i = 1; i < msgs.length; i += 1) {
    if (selectedTailIndices.has(i)) {
      orderedTail.push(renderedByIndex.get(i)!.formatted);
    }
  }
  const omissionNote = omittedMiddleCount > 0
    ? [`[... ${omittedMiddleCount} earlier message(s) omitted to stay within context budget ...]`]
    : [];
  const transcript = [firstFormatted, ...omissionNote, ...orderedTail].join('\n\n');

  const fullPrompt = [
    systemPrompt,
    '==================== CONVERSATION ====================',
    transcript,
    '==================== NEXT ASSISTANT RESPONSE ====================',
    'Respond now as the coding agent. Remember: emit plain Markdown explanation (optional) followed by AT MOST ONE XML tool call (`read_file`, `write_to_file`, `apply_diff`, `search_and_replace`, `insert_content`, `delete_file`, `list_files`, `search_files`, `execute_command`, `web_fetch`, `ask_followup_question`, `attempt_completion`, `update_todo_list`, `switch_mode`, `new_task`, `use_mcp_tool`, `access_mcp_resource`). Wait for the tool result in the next turn before continuing.',
  ].join('\n\n');

  return {
    fullPrompt,
    systemPrompt,
    report: {
      totalChars: fullPrompt.length,
      maxPromptChars,
      usageRatio: Math.min(1, fullPrompt.length / maxPromptChars),
      autoCompactThresholdRatio: thresholdRatio,
      autoCompactThresholdChars: thresholdChars,
      compactedCharsSaved,
      excludedCount: items.filter((i) => i.excluded).length,
      items,
    },
  };
}

function formatTurn(speaker: string, content: string): string {
  return `--- ${speaker} ---\n${content.trim()}`;
}

export function formatContextReportForCli(report: ContextInspectionReport): string {
  const pct = Math.round(report.usageRatio * 100);
  const lines: string[] = [
    `Инспектор контекста: ${report.totalChars} / ${report.maxPromptChars} симв. (${pct}%), порог авто-сжатия: ${report.autoCompactThresholdChars} симв.`,
  ];
  if (report.compactedCharsSaved > 0) {
    lines.push(`Сэкономлено сжатием/окном: ${report.compactedCharsSaved} симв.`);
  }
  lines.push('');
  for (const item of report.items) {
    const statusLabel = item.status === 'included'
      ? 'включено'
      : item.status === 'compacted'
        ? 'сжато'
        : item.status === 'excluded'
          ? 'исключено'
          : 'пропущено';
    const exclTag = item.canExclude ? ` [можно исключить: ${item.id}]` : ' [обязательно]';
    lines.push(`- [${statusLabel}] ${item.id} (${item.chars} симв.) — ${item.label}${exclTag}`);
    lines.push(`    почему: ${item.reason}`);
    if (item.compactionDetail) {
      lines.push(`    сжатие: ${item.compactionDetail}`);
    }
  }
  return lines.join('\n');
}
