import {
  AccountPlan,
  PerplexityModelsConfigSnapshot,
  PerplexityRequestMode,
  PerplexitySearchMode,
  QuotaBucket,
} from './types';
import { normalizeModelsConfigPayload } from './modelsConfigFetcher';
import bundledModelsConfig from './bundledModelsConfig.json';

export interface ModelInfo {
  id: string;
  label: string;
  category: string;
  description: string;
  searchMode: PerplexitySearchMode;
  requestMode: PerplexityRequestMode;
  quotaBucket: QuotaBucket;
  requiredPlan: AccountPlan;
  supportsThinking: boolean;
  thinkingModelId?: string;
  selectable?: boolean;
  provider?: string | null;
  sortOrder?: number;
  surfaced?: boolean;
  isNew?: boolean;
}

interface ModelTemplate extends ModelInfo {
  aliases: string[];
  thinkingAliases?: string[];
  fallbackVisible?: boolean;
}

const MODEL_TEMPLATES: ModelTemplate[] = [
  {
    id: 'turbo',
    label: 'Best',
    category: 'Search Models',
    description: 'Selects your best available model automatically.',
    searchMode: 'search',
    requestMode: 'CONCISE',
    quotaBucket: 'free_queries',
    requiredPlan: 'free',
    supportsThinking: false,
    aliases: ['default', 'best', 'baseline', 'turbo', 'pplx_pro'],
  },
  {
    id: 'gpt6_1_sol',
    label: 'GPT-6.1 Sol',
    category: 'OpenAI',
    description: "OpenAI's versatile model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: true,
    thinkingModelId: 'gpt6_1_sol_thinking',
    aliases: ['gpt61sol', 'gpt-6.1-sol', 'gpt 6.1 sol', 'gpt61'],
    thinkingAliases: ['gpt6_1_sol_thinking', 'gpt61solthinking'],
  },
  {
    id: 'gpt6_astra',
    label: 'GPT-6 Astra',
    category: 'OpenAI',
    description: "OpenAI's most capable model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'max',
    supportsThinking: true,
    thinkingModelId: 'gpt6_astra_thinking',
    aliases: ['gpt6astra', 'gpt-6-astra', 'gpt 6 astra'],
    thinkingAliases: ['gpt6_astra_thinking', 'gpt6astrathinking'],
  },
  {
    id: 'gemini4argon',
    label: 'Gemini 4 Argon',
    category: 'Google',
    description: "Google's most powerful model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'max',
    supportsThinking: true,
    thinkingModelId: 'gemini4argonthinking',
    aliases: ['gemini-4-argon', 'gemini 4 argon'],
    thinkingAliases: ['gemini4argonthinking', 'gemini4argon_thinking'],
  },
  {
    id: 'gemini38flash',
    label: 'Gemini 3.8 Flash',
    category: 'Google',
    description: "Google's fast model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: true,
    thinkingModelId: 'gemini38flashthinking',
    aliases: ['gemini-3.8-flash', 'gemini 3.8 flash'],
    thinkingAliases: ['gemini38flashthinking', 'gemini38flash_thinking'],
  },
  {
    id: 'claude55sonnet',
    label: 'Claude Sonnet 5.5',
    category: 'Anthropic',
    description: "Anthropic's fast model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: true,
    thinkingModelId: 'claude55sonnetthinking',
    aliases: ['claude-sonnet-5.5', 'claude sonnet 5.5', 'claudesonnet55'],
    thinkingAliases: ['claude55sonnetthinking', 'claude55sonnet_thinking'],
  },
  {
    id: 'claude55opus',
    label: 'Claude Opus 5.5',
    category: 'Anthropic',
    description: "Anthropic's latest model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'max',
    supportsThinking: true,
    thinkingModelId: 'claude55opusthinking',
    aliases: ['claude-opus-5.5', 'claude opus 5.5', 'claudeopus55'],
    thinkingAliases: ['claude55opusthinking', 'claude55opus_thinking'],
  },
  {
    id: 'claudefable51',
    label: 'Claude Fable 5.1',
    category: 'Anthropic',
    description: "Anthropic's most capable model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'max',
    supportsThinking: true,
    thinkingModelId: 'claudefable51thinking',
    aliases: ['claude-fable-5.1', 'claude fable 5.1', 'claudefable'],
    thinkingAliases: ['claudefable51thinking', 'claudefable51_thinking'],
  },
  {
    id: 'kimik3thinking',
    label: 'Kimi K3',
    category: 'Moonshot AI',
    description: "Moonshot AI's latest model. Hosted in the US.",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: false,
    aliases: ['kimi-k3', 'kimi k3', 'kimik3'],
  },
  {
    id: 'glm_5_3_thinking',
    label: 'GLM 5.3',
    category: 'Z.ai',
    description: "Z.ai's most advanced model. Hosted in the US.",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: false,
    aliases: ['glm-5.3', 'glm 5.3', 'glm53'],
  },
  {
    id: 'grok47',
    label: 'Grok 4.7',
    category: 'xAI',
    description: "xAI's most advanced model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: true,
    thinkingModelId: 'grok47thinking',
    aliases: ['grok-4.7', 'grok 4.7'],
    thinkingAliases: ['grok47thinking', 'grok47_thinking'],
  },
  {
    id: 'nv_nemotron_3_5_super',
    label: 'Nemotron 3.5 Super VL',
    category: 'NVIDIA',
    description: "NVIDIA's Nemotron 3.5 Super VL model",
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: false,
    aliases: ['nemotron-3.5-super', 'nemotron 3.5 super', 'nemotron35super'],
  },
  {
    id: 'experimental',
    label: 'Sonar 2',
    category: 'Perplexity',
    description: 'Perplexity Sonar for fast web search and summarization.',
    searchMode: 'search',
    requestMode: 'COPILOT',
    quotaBucket: 'pro_search',
    requiredPlan: 'pro',
    supportsThinking: false,
    aliases: ['experimental', 'sonar', 'sonar2'],
    fallbackVisible: false,
  },
];

let runtimeCatalog = new Map<string, ModelInfo>();

export function setRuntimeModelCatalog(models: ModelInfo[]): void {
  runtimeCatalog = new Map(models.map((model) => [model.id, { ...model }]));
}

let bundledCatalogCache: ModelInfo[] | undefined;
let buildingBundledCatalog = false;

/**
 * Snapshot of https://www.perplexity.ai/rest/models/config shipped with the extension.
 * Used when the live config cannot be fetched (for example, Cloudflare blocks Node on macOS).
 */
export function getBundledModelsConfig(): PerplexityModelsConfigSnapshot | undefined {
  return normalizeModelsConfigPayload(bundledModelsConfig);
}

export function getBundledSnapshotDate(): string {
  return (bundledModelsConfig as { snapshot_date?: string }).snapshot_date || 'unknown';
}

export function getFallbackModelCatalog(): ModelInfo[] {
  if (bundledCatalogCache) {
    return bundledCatalogCache.map((model) => ({ ...model }));
  }

  const templates = MODEL_TEMPLATES
    .filter((template) => template.fallbackVisible !== false)
    .map(stripTemplateMetadata);

  if (buildingBundledCatalog) {
    return templates;
  }

  const bundled = getBundledModelsConfig();
  if (!bundled) {
    return templates;
  }

  buildingBundledCatalog = true;
  try {
    const built = buildModelsFromConfig(bundled, 'unknown');
    bundledCatalogCache = built.length > 0 ? built : templates;
  } finally {
    buildingBundledCatalog = false;
  }
  return bundledCatalogCache.map((model) => ({ ...model }));
}

export function buildModelsFromAvailableIds(
  availableModelIds: string[],
  accountPlan: AccountPlan = 'unknown'
): ModelInfo[] {
  const rawIds = uniqueStrings(availableModelIds);
  if (rawIds.length === 0) {
    return getFallbackModelCatalog();
  }

  const models = new Map<string, ModelInfo>();

  for (const rawId of rawIds) {
    const match = matchTemplate(rawId);
    if (!match) {
      continue;
    }

    if (match.kind === 'thinking') {
      const baseAvailable = rawIds.some((candidate) => {
        const candidateMatch = matchTemplate(candidate);
        return candidateMatch?.kind === 'base' && candidateMatch.template.id === match.template.id;
      });

      if (baseAvailable) {
        continue;
      }

      const explicitThinkingVariant = toThinkingVariant(match.template, rawId);
      models.set(explicitThinkingVariant.id, explicitThinkingVariant);
      continue;
    }

    const modelId = isRequestId(rawId) ? rawId.trim() : match.template.id;
    const thinkingModelId = match.template.supportsThinking
      ? resolveThinkingModelId(match.template, modelId, rawIds)
      : undefined;

    models.set(modelId, {
      ...stripTemplateMetadata(match.template),
      id: modelId,
      supportsThinking: Boolean(thinkingModelId),
      thinkingModelId,
      requiredPlan: inferRequiredPlan(match.template, accountPlan),
    });
  }

  if (models.size === 0) {
    return getFallbackModelCatalog();
  }

  return [...models.values()].sort(compareModels);
}

export function buildModelsFromConfig(
  modelsConfig: PerplexityModelsConfigSnapshot,
  accountPlan: AccountPlan = 'unknown'
): ModelInfo[] {
  const modelDefinitions = modelsConfig.models || {};
  const models = new Map<string, ModelInfo>();
  const representedIds = new Set<string>();
  const familyPlanHints = new Map<string, AccountPlan>();
  let order = 0;

  const bestModel = buildBestModelFromConfig(modelDefinitions, modelsConfig.default_models?.search);
  if (bestModel) {
    models.set(bestModel.id, {
      ...bestModel,
      sortOrder: order++,
    });
    for (const aliasId of ['turbo', 'pplx_pro', 'pplx_pro_upgraded']) {
      if (modelDefinitions[aliasId]?.mode === 'search') {
        representedIds.add(aliasId);
      }
    }
    familyPlanHints.set(toFamilyKey(bestModel.label), bestModel.requiredPlan);
  }

  for (const entry of modelsConfig.config || []) {
    const nonReasoningId = normalizeConfigModelId(entry.non_reasoning_model);
    const reasoningId = normalizeConfigModelId(entry.reasoning_model);
    const primaryId = nonReasoningId || reasoningId;
    if (!primaryId) {
      continue;
    }

    const primaryDefinition = modelDefinitions[primaryId];
    const reasoningDefinition = reasoningId ? modelDefinitions[reasoningId] : undefined;
    const mode = primaryDefinition?.mode || reasoningDefinition?.mode;
    if (mode !== 'search') {
      continue;
    }

    const label = firstNonEmptyString(entry.label, primaryDefinition?.label, reasoningDefinition?.label, primaryId);
    const description = firstNonEmptyString(
      entry.description,
      primaryDefinition?.description,
      reasoningDefinition?.description,
      `${label} on Perplexity.`
    );
    const requiredPlan = normalizeRequiredPlan(entry.subscription_tier, accountPlan);
    const familyKey = toFamilyKey(label);
    familyPlanHints.set(familyKey, requiredPlan);

    if (nonReasoningId) {
      models.set(nonReasoningId, {
        id: nonReasoningId,
        label,
        category: 'Featured Search Models',
        description,
        searchMode: 'search',
        requestMode: 'COPILOT',
        quotaBucket: nonReasoningId === 'turbo' ? 'free_queries' : 'pro_search',
        requiredPlan,
        supportsThinking: Boolean(reasoningId),
        thinkingModelId: reasoningId || undefined,
        provider: primaryDefinition?.provider || reasoningDefinition?.provider || null,
        sortOrder: order++,
        surfaced: true,
        isNew: entry.has_new_tag === true,
      });
      representedIds.add(nonReasoningId);
      if (reasoningId) {
        representedIds.add(reasoningId);
      }
      continue;
    }

    if (!reasoningId) {
      continue;
    }

    models.set(reasoningId, {
      id: reasoningId,
      label,
      category: 'Featured Search Models',
      description,
      searchMode: 'search',
      requestMode: 'COPILOT',
      quotaBucket: 'pro_search',
      requiredPlan,
      supportsThinking: false,
      provider: reasoningDefinition?.provider || primaryDefinition?.provider || null,
      sortOrder: order++,
      surfaced: true,
      isNew: entry.has_new_tag === true,
    });
    representedIds.add(reasoningId);
  }

  const additionalDefinitions = Object.entries(modelDefinitions)
    .filter(([modelId, definition]) => definition.mode === 'search' && !representedIds.has(modelId))
    .filter(([modelId]) => !looksLikeInternalModel(modelId))
    .sort((left, right) => left[1].label.localeCompare(right[1].label));

  for (const [modelId, definition] of additionalDefinitions) {
    const label = firstNonEmptyString(definition.label, modelId);
    models.set(modelId, {
      id: modelId,
      label,
      category: getAdditionalCategory(definition.provider),
      description: firstNonEmptyString(
        definition.description,
        `${label} is available in Perplexity's authenticated model config.`
      ),
      searchMode: 'search',
      requestMode: 'COPILOT',
      quotaBucket: modelId === 'turbo' ? 'free_queries' : 'pro_search',
      requiredPlan: inferAdditionalModelPlan(label, familyPlanHints, accountPlan),
      supportsThinking: false,
      provider: definition.provider || null,
      sortOrder: 1_000 + order++,
      surfaced: false,
      isNew: false,
    });
  }

  if (models.size === 0) {
    return getFallbackModelCatalog();
  }

  return [...models.values()].sort(compareModels);
}

export function getModelCatalog(): ModelInfo[] {
  const merged = new Map<string, ModelInfo>();
  for (const model of getFallbackModelCatalog()) {
    merged.set(model.id, model);
  }
  for (const model of runtimeCatalog.values()) {
    merged.set(model.id, model);
  }
  return [...merged.values()];
}

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return modelId;
  }

  const exact = getMergedCatalog().find((model) => model.id === trimmed || model.thinkingModelId === trimmed);
  if (exact) {
    return trimmed;
  }

  const templateMatch = matchTemplate(trimmed);
  if (!templateMatch) {
    return trimmed;
  }

  if (templateMatch.kind === 'thinking') {
    return templateMatch.template.thinkingModelId || trimmed;
  }

  return templateMatch.template.id;
}

export function getModelById(modelId: string): ModelInfo | undefined {
  const baseModelId = getBaseModelId(modelId);
  return getMergedCatalog().find((model) => model.id === baseModelId);
}

export function modelSupportsThinking(modelId: string): boolean {
  return Boolean(getModelById(getBaseModelId(modelId))?.supportsThinking);
}

export function getBaseModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return modelId;
  }

  const exact = getMergedCatalog().find((model) => model.id === trimmed);
  if (exact) {
    return exact.id;
  }

  const runtimeVariant = getMergedCatalog().find((model) => model.thinkingModelId === trimmed);
  if (runtimeVariant) {
    return runtimeVariant.id;
  }

  const templateMatch = matchTemplate(trimmed);
  if (templateMatch?.kind === 'thinking') {
    return templateMatch.template.id;
  }

  const normalized = normalizeModelId(trimmed);
  const normalizedVariant = getMergedCatalog().find((model) => model.thinkingModelId === normalized);
  return normalizedVariant?.id || normalized;
}

export function isThinkingModelId(modelId: string): boolean {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return false;
  }

  const exact = getMergedCatalog().find((model) => model.id === trimmed);
  if (exact) {
    return false;
  }

  const runtimeVariant = getMergedCatalog().find((model) => model.thinkingModelId === trimmed);
  if (runtimeVariant) {
    return true;
  }

  return matchTemplate(trimmed)?.kind === 'thinking';
}

export function getResolvedModelId(modelId: string, thinkingEnabled: boolean): string {
  const model = getModelById(getBaseModelId(modelId));
  if (!model) {
    return normalizeModelId(modelId);
  }

  if (thinkingEnabled && model.thinkingModelId) {
    return model.thinkingModelId;
  }

  return model.id;
}

export function getModelLabel(modelId: string, thinkingEnabled = false): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return modelId;
  }

  const exact = getMergedCatalog().find((model) => model.id === trimmed);
  if (exact) {
    return exact.label;
  }

  const runtimeVariant = getMergedCatalog().find((model) => model.thinkingModelId === trimmed);
  if (runtimeVariant) {
    return `${runtimeVariant.label} Thinking`;
  }

  const templateMatch = matchTemplate(trimmed);
  if (templateMatch?.kind === 'thinking') {
    return `${templateMatch.template.label} Thinking`;
  }

  const normalized = normalizeModelId(trimmed);
  const model = getMergedCatalog().find((entry) => entry.id === normalized);
  if (!model) {
    return trimmed;
  }

  const isThinkingVariant = thinkingEnabled && model.supportsThinking;
  return isThinkingVariant ? `${model.label} Thinking` : model.label;
}

export function getDefaultSourcesForModel(_modelId: string): ('web' | 'scholar' | 'social')[] {
  return ['web'];
}

export function getCategoryOrder(category: string): number {
  const order = [
    'Featured Search Models',
    'Perplexity',
    'OpenAI',
    'Anthropic',
    'Google',
    'Moonshot AI',
    'xAI',
    'NVIDIA',
    'Z.ai',
    'Additional Search Models',
    'Search Models',
    'Max Models',
  ];
  const index = order.indexOf(category);
  return index === -1 ? order.length : index;
}

export function compareModels(left: ModelInfo, right: ModelInfo): number {
  const sortOrder = compareOptionalNumber(left.sortOrder, right.sortOrder);
  if (sortOrder !== 0) {
    return sortOrder;
  }

  const categoryOrder = getCategoryOrder(left.category) - getCategoryOrder(right.category);
  if (categoryOrder !== 0) {
    return categoryOrder;
  }

  const templateOrder = getTemplateSortRank(left) - getTemplateSortRank(right);
  if (templateOrder !== 0) {
    return templateOrder;
  }

  return left.label.localeCompare(right.label);
}

function stripTemplateMetadata(template: ModelTemplate): ModelInfo {
  const { aliases: _aliases, thinkingAliases: _thinkingAliases, fallbackVisible: _fallbackVisible, ...model } = template;
  return { ...model };
}

function getMergedCatalog(): ModelInfo[] {
  const merged = new Map<string, ModelInfo>();
  for (const template of MODEL_TEMPLATES) {
    merged.set(template.id, stripTemplateMetadata(template));
  }
  for (const model of runtimeCatalog.values()) {
    merged.set(model.id, model);
  }
  return [...merged.values()];
}

function getTemplateSortRank(model: Pick<ModelInfo, 'id'>): number {
  const match = matchTemplate(model.id);
  if (!match) {
    return MODEL_TEMPLATES.length;
  }

  const index = MODEL_TEMPLATES.findIndex((template) => template.id === match.template.id);
  return index === -1 ? MODEL_TEMPLATES.length : index;
}

function matchTemplate(modelId: string): { template: ModelTemplate; kind: 'base' | 'thinking' } | undefined {
  const token = normalizeLookupToken(modelId);
  if (!token) {
    return undefined;
  }

  const baseMatch = MODEL_TEMPLATES.find((template) =>
    [template.id, ...template.aliases].some((candidate) => normalizeLookupToken(candidate) === token)
  );
  if (baseMatch) {
    return { template: baseMatch, kind: 'base' };
  }

  const thinkingMatch = MODEL_TEMPLATES.find((template) =>
    (template.thinkingAliases || []).some((candidate) => normalizeLookupToken(candidate) === token)
    || normalizeLookupToken(template.thinkingModelId || '') === token
  );

  return thinkingMatch ? { template: thinkingMatch, kind: 'thinking' } : undefined;
}

function resolveThinkingModelId(template: ModelTemplate, baseId: string, availableIds: string[]): string | undefined {
  if (!template.supportsThinking) {
    return undefined;
  }

  const exact = availableIds.find((candidate) => {
    const token = normalizeLookupToken(candidate);
    return normalizeLookupToken(template.thinkingModelId || '') === token
      || (template.thinkingAliases || []).some((alias) => normalizeLookupToken(alias) === token);
  });
  if (exact && isRequestId(exact)) {
    return exact.trim();
  }

  if (isRequestId(baseId)) {
    return baseId.endsWith('_thinking') ? baseId : `${baseId}_thinking`;
  }

  return template.thinkingModelId;
}

function toThinkingVariant(template: ModelTemplate, rawId: string): ModelInfo {
  const modelId = isRequestId(rawId)
    ? rawId.trim()
    : (template.thinkingModelId || `${template.id}_thinking`);

  return {
    ...stripTemplateMetadata(template),
    id: modelId,
    label: `${template.label} Thinking`,
    description: `${template.label} thinking variant for deeper technical analysis.`,
    supportsThinking: false,
    thinkingModelId: undefined,
  };
}

function inferRequiredPlan(template: ModelTemplate, accountPlan: AccountPlan): AccountPlan {
  if (template.requiredPlan === 'max' || template.requiredPlan === 'enterprise') {
    return template.requiredPlan;
  }

  if (accountPlan === 'max' || accountPlan === 'enterprise') {
    return template.requiredPlan;
  }

  return template.requiredPlan;
}

function uniqueStrings(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    unique.set(trimmed.toLowerCase(), trimmed);
  }
  return [...unique.values()];
}

function isRequestId(value: string): boolean {
  return /^[a-z0-9_.-]+$/i.test(value.trim());
}

function normalizeLookupToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  if (typeof left === 'number') {
    return -1;
  }
  if (typeof right === 'number') {
    return 1;
  }
  return 0;
}

function normalizeConfigModelId(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() || '';
}

function normalizeRequiredPlan(value: string | null | undefined, accountPlan: AccountPlan): AccountPlan {
  const normalized = (value || '').trim().toLowerCase();
  switch (normalized) {
    case 'free':
    case 'pro':
    case 'max':
    case 'enterprise':
      return normalized;
    default:
      return accountPlan === 'free' ? 'pro' : 'pro';
  }
}

function toFamilyKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+(thinking|low thinking)$/i, '')
    .replace(/\s+\d+(\.\d+)?$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function inferAdditionalModelPlan(
  label: string,
  familyPlanHints: Map<string, AccountPlan>,
  _accountPlan: AccountPlan
): AccountPlan {
  const familyHint = familyPlanHints.get(toFamilyKey(label));
  if (familyHint) {
    return familyHint;
  }

  return /\bopus\b/i.test(label) ? 'max' : 'pro';
}

function getAdditionalCategory(provider: string | null | undefined): string {
  switch ((provider || '').trim().toUpperCase()) {
    case 'PERPLEXITY':
    case 'SONAR':
      return 'Perplexity';
    case 'OPENAI':
      return 'OpenAI';
    case 'ANTHROPIC':
      return 'Anthropic';
    case 'GOOGLE':
      return 'Google';
    case 'MOONSHOT_AI':
      return 'Moonshot AI';
    case 'XAI':
      return 'xAI';
    case 'NVIDIA':
      return 'NVIDIA';
    case 'ZAI':
      return 'Z.ai';
    default:
      return 'Additional Search Models';
  }
}

const NON_CHAT_MODEL_IDS = new Set([
  'pplx_pro',
  'pplx_pro_upgraded',
  'chatgpt_tools',
  'claudecode',
  'codex',
  'nanobananapro',
  'nanobanana2',
  'sora2',
  'sora2pro',
  'veo31',
  'veo31fast',
]);

function looksLikeInternalModel(modelId: string): boolean {
  const lowered = modelId.toLowerCase();
  return lowered.includes('internal_testing') || NON_CHAT_MODEL_IDS.has(lowered);
}

function buildBestModelFromConfig(
  modelDefinitions: Record<string, { label: string; description?: string | null; mode: PerplexitySearchMode; provider?: string | null }>,
  defaultSearchModelId: string | undefined
): ModelInfo | undefined {
  const preferredIds = [
    normalizeConfigModelId(defaultSearchModelId),
    'turbo',
    'pplx_pro',
    'pplx_pro_upgraded',
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);

  const definitionId = preferredIds.find((candidate) => modelDefinitions[candidate]?.mode === 'search');
  if (!definitionId) {
    return undefined;
  }

  const definition = modelDefinitions[definitionId];
  return {
    id: modelDefinitions.turbo?.mode === 'search' ? 'turbo' : definitionId,
    label: 'Best',
    category: 'Featured Search Models',
    description: firstNonEmptyString(
      definition.description,
      'Automatically selects the best Perplexity model for the query.'
    ),
    searchMode: 'search',
    requestMode: 'CONCISE',
    quotaBucket: 'free_queries',
    requiredPlan: 'free',
    supportsThinking: false,
    provider: definition.provider || 'PERPLEXITY',
    surfaced: true,
    isNew: false,
  };
}
