import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PERMISSION_MODES, PermissionMode } from './types';

/**
 * Layered project settings, compatible with Claude Code's settings.json shape:
 *
 *   ~/.claude/settings.json            (user, Claude Code compat)
 *   ~/.perplexicode/settings.json      (user)
 *   <project>/.claude/settings.json    (project, Claude Code compat)
 *   <project>/.perplexicode/settings.json
 *   <project>/.claude/settings.local.json
 *   <project>/.perplexicode/settings.local.json   (personal, git-ignored)
 *
 * Arrays (permission rules, hooks) are concatenated across layers; scalars take the last value.
 */

export interface HookCommand {
  type: 'command';
  command: string;
  /** Seconds, default 60. */
  timeout?: number;
}

export interface HookMatcher {
  /** Regex tested against the Claude Code tool name and the native tool name. Empty or "*" matches all. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionStart'
  | 'SessionEnd'
  | 'WorktreeCreate'
  | 'WorktreeRemove';

export const HOOK_EVENTS: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'WorktreeCreate',
  'WorktreeRemove',
];

export interface CoreSettings {
  permissions: {
    allow: string[];
    ask: string[];
    deny: string[];
    defaultMode: PermissionMode;
    /** Built-in deny list for secrets (.env, keys, VPN configs). Default true. */
    protectSecrets: boolean;
    additionalDirectories: string[];
  };
  hooks: Partial<Record<HookEvent, HookMatcher[]>>;
  /** Command that must pass before attempt_completion is accepted (for example "npm test"). */
  verify: { command?: string; maxAttempts: number; timeoutSec: number };
  model?: string;
  /** 3.3: default Perplexity compute mode (search, light, standard, high, ultra, research, labs). */
  computeMode?: string;
  /** 3.5 (F04): stop task instead of falling back to another model/compute mode. */
  stopOnFallback?: boolean;
  /** 3.6 (F11/F14): attach @repo repository map automatically. */
  repoMapEnabled?: boolean;
  /** 3.6 (F11): hard character budget for @repo map. */
  repoMapMaxChars?: number;
  /** 3.6 (F13): threshold ratio of maxPromptChars triggering structured auto-compaction. */
  autoCompactThreshold?: number;
  /** 3.6 (F13): number of latest dialogue steps kept untouched during auto-compaction. */
  autoCompactKeepSteps?: number;
  /** 3.6 (F15): conservative per-account requests-per-minute ceiling. */
  maxRequestsPerMinute?: number;
  /** 3.7 (F18): maximum concurrent subtasks run in parallel by Orchestrator (default 3). */
  maxParallelSubtasks?: number;
  /** 3.8 (F24): run cross-family model review on diff + verify before attempt_completion (default false). */
  crossModelReview?: boolean;
  /** 3.8 (F24): optional preferred reviewer model ID (must differ in family from author, else auto-selected). */
  crossModelReviewModel?: string;
  env: Record<string, string>;
  /** Execute up to N read-only tool calls from one model answer. 1 disables batching. */
  readBatchSize: number;
  /** Which files contributed, for `pcode doctor` and the journal. */
  sources: Array<{ file: string; scope: 'user' | 'project' | 'local'; hooks: number; rules: number }>;
}

export function defaultSettings(): CoreSettings {
  return {
    permissions: { allow: [], ask: [], deny: [], defaultMode: 'default', protectSecrets: true, additionalDirectories: [] },
    hooks: {},
    verify: { maxAttempts: 2, timeoutSec: 600 },
    crossModelReview: false,
    env: {},
    readBatchSize: 5,
    sources: [],
  };
}

export interface SettingsLayer {
  file: string;
  scope: 'user' | 'project' | 'local';
}

export function settingsLayers(cwd: string, home = os.homedir()): SettingsLayer[] {
  return [
    { file: path.join(home, '.claude', 'settings.json'), scope: 'user' },
    { file: path.join(home, '.perplexicode', 'settings.json'), scope: 'user' },
    { file: path.join(cwd, '.claude', 'settings.json'), scope: 'project' },
    { file: path.join(cwd, '.perplexicode', 'settings.json'), scope: 'project' },
    { file: path.join(cwd, '.claude', 'settings.local.json'), scope: 'local' },
    { file: path.join(cwd, '.perplexicode', 'settings.local.json'), scope: 'local' },
  ];
}

export interface LoadSettingsOptions {
  home?: string;
  /** Project and local layers can define hooks (arbitrary commands). Skip their hooks when the project is untrusted. */
  trustProjectHooks?: boolean;
  /** Ignore ~/.claude and <project>/.claude layers. */
  ignoreClaudeLayers?: boolean;
}

export function loadSettings(cwd: string, options: LoadSettingsOptions = {}): CoreSettings {
  const settings = defaultSettings();
  for (const layer of settingsLayers(cwd, options.home)) {
    if (options.ignoreClaudeLayers && layer.file.includes(`${path.sep}.claude${path.sep}`)) {
      continue;
    }
    const raw = readJson(layer.file);
    if (!raw) {
      continue;
    }
    const allowHooks = layer.scope === 'user' || options.trustProjectHooks !== false;
    const counts = mergeLayer(settings, raw, allowHooks);
    settings.sources.push({ file: layer.file, scope: layer.scope, ...counts });
  }
  return settings;
}

/** Merges a parsed settings object into `target`. Exported for tests and CLI flags. */
export function mergeLayer(target: CoreSettings, raw: Record<string, unknown>, allowHooks = true): { hooks: number; rules: number } {
  let rules = 0;
  let hooks = 0;
  const permissions = asObject(raw.permissions);
  if (permissions) {
    for (const key of ['allow', 'ask', 'deny'] as const) {
      const list = asStringArray(permissions[key]);
      target.permissions[key].push(...list);
      rules += list.length;
    }
    if (typeof permissions.defaultMode === 'string' && (PERMISSION_MODES as string[]).includes(permissions.defaultMode)) {
      target.permissions.defaultMode = permissions.defaultMode as PermissionMode;
    }
    if (typeof permissions.protectSecrets === 'boolean') {
      target.permissions.protectSecrets = permissions.protectSecrets;
    }
    target.permissions.additionalDirectories.push(...asStringArray(permissions.additionalDirectories));
  }
  const rawHooks = asObject(raw.hooks);
  if (rawHooks && allowHooks) {
    for (const [event, value] of Object.entries(rawHooks)) {
      if (!(HOOK_EVENTS as string[]).includes(event) || !Array.isArray(value)) {
        continue;
      }
      const list = target.hooks[event as HookEvent] || [];
      for (const entry of value) {
        const matcher = asObject(entry);
        if (!matcher || !Array.isArray(matcher.hooks)) {
          continue;
        }
        const commands = (matcher.hooks as unknown[])
          .map(asObject)
          .filter((hook): hook is Record<string, unknown> => Boolean(hook && hook.type === 'command' && typeof hook.command === 'string'))
          .map((hook) => ({ type: 'command' as const, command: String(hook.command), timeout: typeof hook.timeout === 'number' ? hook.timeout : undefined }));
        if (commands.length > 0) {
          list.push({ matcher: typeof matcher.matcher === 'string' ? matcher.matcher : undefined, hooks: commands });
          hooks += commands.length;
        }
      }
      target.hooks[event as HookEvent] = list;
    }
  }
  const verify = asObject(raw.verify);
  if (verify) {
    if (typeof verify.command === 'string' && verify.command.trim()) {
      target.verify.command = verify.command.trim();
    }
    if (typeof verify.maxAttempts === 'number') {
      target.verify.maxAttempts = Math.max(0, Math.min(10, Math.floor(verify.maxAttempts)));
    }
    if (typeof verify.timeoutSec === 'number') {
      target.verify.timeoutSec = Math.max(5, Math.min(3600, Math.floor(verify.timeoutSec)));
    }
  }
  if (typeof raw.model === 'string') {
    target.model = raw.model;
  }
  if (typeof raw.computeMode === 'string' && raw.computeMode.trim()) {
    target.computeMode = raw.computeMode.trim();
  }
  if (typeof raw.stopOnFallback === 'boolean') {
    target.stopOnFallback = raw.stopOnFallback;
  }
  if (typeof raw.repoMapEnabled === 'boolean') {
    target.repoMapEnabled = raw.repoMapEnabled;
  }
  if (typeof raw.repoMapMaxChars === 'number' && Number.isFinite(raw.repoMapMaxChars)) {
    target.repoMapMaxChars = Math.max(200, Math.min(30_000, Math.floor(raw.repoMapMaxChars)));
  }
  if (typeof raw.autoCompactThreshold === 'number' && Number.isFinite(raw.autoCompactThreshold)) {
    target.autoCompactThreshold = raw.autoCompactThreshold <= 0
      ? 0
      : Math.max(0.3, Math.min(0.98, raw.autoCompactThreshold));
  }
  if (typeof raw.autoCompactKeepSteps === 'number' && Number.isFinite(raw.autoCompactKeepSteps)) {
    target.autoCompactKeepSteps = Math.max(1, Math.min(20, Math.floor(raw.autoCompactKeepSteps)));
  }
  if (typeof raw.maxRequestsPerMinute === 'number' && Number.isFinite(raw.maxRequestsPerMinute)) {
    target.maxRequestsPerMinute = Math.max(1, Math.min(120, Math.floor(raw.maxRequestsPerMinute)));
  }
  if (typeof raw.maxParallelSubtasks === 'number' && Number.isFinite(raw.maxParallelSubtasks)) {
    target.maxParallelSubtasks = Math.max(1, Math.min(8, Math.floor(raw.maxParallelSubtasks)));
  }
  if (typeof raw.crossModelReview === 'boolean') {
    target.crossModelReview = raw.crossModelReview;
  }
  if (typeof raw.crossModelReviewModel === 'string' && raw.crossModelReviewModel.trim()) {
    target.crossModelReviewModel = raw.crossModelReviewModel.trim();
  }
  if (typeof raw.readBatchSize === 'number') {
    target.readBatchSize = Math.max(1, Math.min(10, Math.floor(raw.readBatchSize)));
  }
  const env = asObject(raw.env);
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        target.env[key] = value;
      }
    }
  }
  return { hooks, rules };
}

/** True when the project or local layers define hooks (used to ask for trust once). */
export function projectDefinesHooks(cwd: string): boolean {
  return settingsLayers(cwd).filter((layer) => layer.scope !== 'user').some((layer) => {
    const raw = readJson(layer.file);
    const hooks = raw ? asObject(raw.hooks) : undefined;
    return Boolean(hooks && Object.keys(hooks).length > 0);
  });
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()) : [];
}
