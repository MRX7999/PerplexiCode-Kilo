import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspacePath, splitCommandChain } from '../agent/tools';
import { CLAUDE_TOOL_NAMES, EDIT_TOOLS, GateToolCall, GateVerdict, META_TOOLS, PermissionMode, READ_TOOLS } from './types';

/**
 * Claude Code style permission rules: allow / ask / deny lists with `Tool(specifier)` syntax.
 *
 *   Bash                     any command
 *   Bash(npm run test:*)     prefix match ("npm run test", "npm run test -- --watch")
 *   Bash(git * main)         wildcard match
 *   Read(./.env)             path relative to the project root
 *   Read(**\/*.pem)           gitignore-like glob, patterns without "/" match at any depth
 *   Edit(src/**)             applies to write_to_file, apply_diff and insert_content
 *   Read(~/.ssh/**)          home directory;  Read(//etc/**) absolute path
 *   Task(reviewer)           delegation to a subagent / mode
 *   apply_diff(...)          native tool names work too
 *
 * Evaluation order: deny (including the built-in secrets list) > permission mode "plan" > ask >
 * allow > modes "bypassPermissions"/"acceptEdits" > no opinion (legacy auto-approve settings).
 * A compound shell command is allowed only when every segment is allowed; one denied segment
 * denies the whole command.
 */

export interface PermissionRule {
  raw: string;
  tool: string;
  specifier?: string;
}

export interface PermissionConfig {
  allow: string[];
  ask: string[];
  deny: string[];
  mode: PermissionMode;
  protectSecrets: boolean;
  additionalDirectories?: string[];
  /** Tool allow-list of a subagent (Claude names or native names). undefined = all tools. */
  toolAllowList?: string[];
}

/** Built-in secret patterns, denied for Read and Edit unless `protectSecrets: false`. */
export const SECRET_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*',
  '.ssh/**', '.aws/credentials', '.netrc', '.npmrc', '.pypirc', 'wg*.conf', '*.ovpn', 'credentials.json', '*.kdbx',
];

export function parseRule(raw: string): PermissionRule | undefined {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([A-Za-z_][\w-]*)(?:\(([\s\S]*)\))?$/);
  if (!match) {
    return undefined;
  }
  const specifier = match[2] === undefined ? undefined : match[2].trim();
  return { raw: trimmed, tool: match[1], specifier: specifier === '' || specifier === '*' ? undefined : specifier };
}

export type ToolCategory = 'read' | 'edit' | 'bash' | 'task' | 'meta' | 'other';

export function toolCategory(name: string): ToolCategory {
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (name === 'execute_command') return 'bash';
  if (name === 'new_task') return 'task';
  if (META_TOOLS.has(name)) return 'meta';
  return 'other';
}

/** Does a rule's tool name cover this native tool? */
export function ruleCoversTool(ruleTool: string, nativeName: string): boolean {
  if (ruleTool === nativeName || ruleTool === '*') {
    return true;
  }
  const category = toolCategory(nativeName);
  const lowered = ruleTool.toLowerCase();
  switch (category) {
    case 'read':
      return ['read', 'grep', 'glob', 'ls'].includes(lowered) && (lowered === 'read' || CLAUDE_TOOL_NAMES[nativeName]?.toLowerCase() === lowered);
    case 'edit':
      return ['edit', 'write', 'multiedit'].includes(lowered);
    case 'bash':
      return lowered === 'bash' || lowered === 'shell';
    case 'task':
      return lowered === 'task' || lowered === 'agent';
    default:
      return CLAUDE_TOOL_NAMES[nativeName]?.toLowerCase() === lowered;
  }
}

/** gitignore-like glob to RegExp over posix paths. */
export function pathGlobToRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        out += `(?:${glob.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = end;
      } else {
        out += '\\{';
      }
    } else {
      out += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Matches an absolute path against a rule specifier. `root` is the project root.
 * Patterns without a slash (".env", "*.pem") match the basename at any depth, like .gitignore.
 */
export function pathMatches(specifier: string, absPath: string, root: string): boolean {
  const posix = (value: string) => value.split(path.sep).join('/');
  let pattern = specifier.trim();
  let base: string;
  if (pattern.startsWith('//')) {
    base = '/';
    pattern = pattern.slice(2);
  } else if (pattern.startsWith('~/')) {
    base = os.homedir();
    pattern = pattern.slice(2);
  } else {
    base = root;
    pattern = pattern.replace(/^\.?\//, '');
  }
  const rel = posix(path.relative(base, absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  const target = rel || '.';
  if (!pattern.includes('/')) {
    const regex = pathGlobToRegex(pattern);
    return target.split('/').some((segment, index, parts) => regex.test(segment) && (index === parts.length - 1 || pattern.startsWith('.')));
  }
  const regex = pathGlobToRegex(pattern.replace(/\/$/, '/**'));
  if (regex.test(target)) {
    return true;
  }
  // "dir/**" also matches the directory itself.
  return pattern.endsWith('/**') && pathGlobToRegex(pattern.slice(0, -3)).test(target);
}

/** Claude Code Bash specifier: "cmd:*" prefix, "*" wildcards, otherwise exact. */
export function commandMatches(specifier: string, command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  const spec = specifier.trim().replace(/\s+/g, ' ');
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    return normalized === prefix || normalized.startsWith(`${prefix} `) || normalized.startsWith(prefix) && /[\s/=:-]$/.test(prefix);
  }
  if (spec.includes('*')) {
    const regex = new RegExp(`^${spec.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return regex.test(normalized);
  }
  return normalized === spec;
}

export interface ResolvedToolTarget {
  category: ToolCategory;
  /** Absolute path for read/edit tools. */
  absPath?: string;
  /** Path with symlinks resolved, when it exists. */
  realPath?: string;
  command?: string;
  subagent?: string;
  insideWorkspace: boolean;
}

export function resolveTarget(tool: GateToolCall, cwd: string, additionalDirectories: string[] = []): ResolvedToolTarget {
  const category = toolCategory(tool.name);
  const roots = [cwd, ...additionalDirectories.map((dir) => resolveWorkspacePath(cwd, dir))];
  const inside = (abs: string) => roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (category === 'read' || category === 'edit') {
    const rawPath = (tool.params.path || '.').trim() || '.';
    const absPath = resolveWorkspacePath(cwd, rawPath);
    let realPath: string | undefined;
    try {
      realPath = fs.realpathSync(absPath);
    } catch {
      // For new files resolve the parent directory, so a symlinked folder cannot escape the workspace.
      try {
        realPath = path.join(fs.realpathSync(path.dirname(absPath)), path.basename(absPath));
      } catch {
        realPath = undefined;
      }
    }
    const realRoots = roots.map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return root;
      }
    });
    const realInside = !realPath || realRoots.some((root) => {
      const rel = path.relative(root, realPath!);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    return { category, absPath, realPath, insideWorkspace: inside(absPath) && realInside };
  }
  if (category === 'bash') {
    return { category, command: (tool.params.command || '').trim(), insideWorkspace: true };
  }
  if (category === 'task') {
    return { category, subagent: (tool.params.mode || '').trim(), insideWorkspace: true };
  }
  return { category, insideWorkspace: true };
}

function ruleMatches(rule: PermissionRule, tool: GateToolCall, target: ResolvedToolTarget, cwd: string, segment?: string): boolean {
  if (!ruleCoversTool(rule.tool, tool.name)) {
    return false;
  }
  if (rule.specifier === undefined) {
    return true;
  }
  switch (target.category) {
    case 'read':
    case 'edit':
      return Boolean(target.absPath && (pathMatches(rule.specifier, target.absPath, cwd) || (target.realPath && pathMatches(rule.specifier, target.realPath, cwd))));
    case 'bash':
      return commandMatches(rule.specifier, segment ?? target.command ?? '');
    case 'task':
      return rule.specifier === target.subagent;
    default:
      return false;
  }
}

/** Shell segments that look like they touch a protected secret file. */
export function commandTouchesSecret(command: string): string | undefined {
  const tokens = command.split(/[\s"'`=<>|;&()]+/).filter(Boolean);
  for (const token of tokens) {
    const base = token.split('/').pop() || token;
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.includes('/')) {
        if (token.includes(pattern.replace('/**', '/'))) return token;
        continue;
      }
      if (pathGlobToRegex(pattern).test(base) && !/^\.env\.(example|sample|template|dist)$/i.test(base)) {
        return token;
      }
    }
  }
  return undefined;
}

function toolAllowed(list: string[] | undefined, nativeName: string): boolean {
  if (!list || toolCategory(nativeName) === 'meta') {
    return true;
  }
  return list.some((entry) => {
    const rule = parseRule(entry);
    return Boolean(rule && ruleCoversTool(rule.tool, nativeName));
  });
}

export function evaluatePermission(config: PermissionConfig, tool: GateToolCall, cwd: string): GateVerdict {
  const target = resolveTarget(tool, cwd, config.additionalDirectories);
  const parse = (list: string[]) => list.map(parseRule).filter((rule): rule is PermissionRule => Boolean(rule));
  const deny = parse(config.deny);
  const ask = parse(config.ask);
  const allow = parse(config.allow);

  if (!toolAllowed(config.toolAllowList, tool.name)) {
    return { decision: 'deny', reason: `Tool '${tool.name}' is not in this agent's tool list (${config.toolAllowList!.join(', ')}).`, source: 'agent.tools' };
  }
  if (target.category === 'meta') {
    return {};
  }

  const segments = target.category === 'bash' ? splitCommandChain(target.command || '') : [undefined];

  // 1. Deny rules win.
  for (const rule of deny) {
    if (segments.some((segment) => ruleMatches(rule, tool, target, cwd, segment))) {
      return { decision: 'deny', reason: `Blocked by permission rule ${rule.raw}.`, source: `permissions.deny: ${rule.raw}` };
    }
  }
  if (config.protectSecrets && (target.category === 'read' || target.category === 'edit') && target.absPath) {
    const explicitlyAllowed = allow.some((rule) => rule.specifier !== undefined && ruleMatches(rule, tool, target, cwd));
    const hit = SECRET_PATTERNS.find((pattern) => pathMatches(pattern, target.absPath!, cwd) || (target.realPath && pathMatches(pattern, target.realPath, cwd)));
    const isTemplate = /\.env\.(example|sample|template|dist)$/i.test(target.absPath);
    if (hit && !explicitlyAllowed && !isTemplate) {
      return { decision: 'deny', reason: `'${tool.params.path}' looks like a secret (${hit}). Secrets are protected; add an explicit allow rule such as ${CLAUDE_TOOL_NAMES[tool.name] || tool.name}(${tool.params.path}) to permit it.`, source: `secrets: ${hit}` };
    }
  }

  // 2. Plan mode is read-only.
  if (config.mode === 'plan' && (target.category === 'edit' || target.category === 'bash')) {
    return { decision: 'deny', reason: 'Plan mode is read-only: do not edit files or run commands. Investigate with read tools and present the plan with attempt_completion; the user will switch modes to execute it.', source: 'mode: plan' };
  }

  // 3. Ask rules.
  for (const rule of ask) {
    if (segments.some((segment) => ruleMatches(rule, tool, target, cwd, segment))) {
      return { decision: 'ask', reason: `Permission rule ${rule.raw} requires approval.`, source: `permissions.ask: ${rule.raw}` };
    }
  }

  // Secrets mentioned in shell commands are never auto-approved.
  if (config.protectSecrets && target.category === 'bash') {
    const secret = commandTouchesSecret(target.command || '');
    if (secret && !allow.some((rule) => rule.specifier !== undefined && segments.every((segment) => ruleMatches(rule, tool, target, cwd, segment)))) {
      return { decision: 'ask', reason: `The command references '${secret}', which looks like a secret.`, source: 'secrets: command' };
    }
  }

  // 4. Allow rules: every shell segment must be covered.
  const allowed = target.category === 'bash'
    ? segments.length > 0 && segments.every((segment) => allow.some((rule) => ruleMatches(rule, tool, target, cwd, segment)))
    : allow.some((rule) => ruleMatches(rule, tool, target, cwd));
  if (allowed) {
    const rule = allow.find((entry) => ruleMatches(entry, tool, target, cwd, segments[0]));
    if (target.category === 'edit' && !target.insideWorkspace && !(rule && rule.specifier)) {
      return { decision: 'ask', reason: 'Edits outside the workspace always need approval unless a path rule allows them.', source: 'workspace' };
    }
    return { decision: 'allow', source: `permissions.allow: ${rule?.raw || 'rules'}` };
  }

  // 5. Modes.
  if (config.mode === 'bypassPermissions') {
    return { decision: 'allow', source: 'mode: bypassPermissions' };
  }
  if (config.mode === 'acceptEdits' && target.category === 'edit' && target.insideWorkspace) {
    return { decision: 'allow', source: 'mode: acceptEdits' };
  }
  if ((target.category === 'read' || target.category === 'edit') && !target.insideWorkspace) {
    // Symlink escapes and outside paths fall back to an explicit question.
    return { decision: 'ask', reason: 'The path resolves outside the workspace.', source: 'workspace' };
  }
  return {};
}
