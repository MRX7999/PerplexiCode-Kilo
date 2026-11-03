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

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SubagentStop' | 'SessionStart' | 'SessionEnd';

export const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd'];

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
