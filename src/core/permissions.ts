import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspacePath, splitCommandChain, stripHeredocBodies, stripLeadingCommandWrappers } from '../agent/tools';
import { CLAUDE_TOOL_NAMES, claudeToolName, EDIT_TOOLS, GateToolCall, GateVerdict, MCP_TOOLS, META_TOOLS, PermissionMode, READ_TOOLS, WEB_TOOLS } from './types';

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
 *   mcp__github__get_issue   one MCP tool (Claude Code naming);  mcp__github / mcp__github__*  whole server
 *   mcp                      every MCP tool, resource read and resource listing
 *   WebFetch(domain:x.com)   web_fetch of that host (and subdomains);  WebFetch  any URL
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
  // Tool names may contain `.` and `*` for MCP rules such as mcp__server__* or mcp__srv__tool.v2.
  const match = trimmed.match(/^([A-Za-z_][\w.*-]*)(?:\(([\s\S]*)\))?$/);
  if (!match) {
    return undefined;
  }
  const specifier = match[2] === undefined ? undefined : match[2].trim();
  return { raw: trimmed, tool: match[1], specifier: specifier === '' || specifier === '*' ? undefined : specifier };
}

export type ToolCategory = 'read' | 'edit' | 'bash' | 'task' | 'meta' | 'mcp' | 'web' | 'other';

export function toolCategory(name: string): ToolCategory {
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (name === 'execute_command') return 'bash';
  if (name === 'new_task') return 'task';
  if (META_TOOLS.has(name)) return 'meta';
  if (MCP_TOOLS.has(name)) return 'mcp';
  if (WEB_TOOLS.has(name)) return 'web';
  return 'other';
}

/** `mcp__server__tool`, `mcp__server__*`, `mcp__server` or `mcp`. */
export function parseMcpRuleTool(ruleTool: string): { server?: string; tool?: string } | undefined {
  const lowered = ruleTool.toLowerCase();
  if (lowered === 'mcp') {
    return {};
  }
  const match = ruleTool.match(/^mcp__([a-zA-Z0-9_-]+?)(?:__([a-zA-Z0-9_.*-]+))?$/);
  if (!match) {
    return undefined;
  }
  return { server: match[1], tool: match[2] && match[2] !== '*' ? match[2] : undefined };
}

function mcpSegment(value: string | undefined): string {
  return (value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();
}

/** Does a rule's tool name cover this native tool? `tool` is needed for MCP rules (server/tool names). */
export function ruleCoversTool(ruleTool: string, nativeName: string, tool?: GateToolCall): boolean {
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
    case 'mcp': {
      const rule = parseMcpRuleTool(ruleTool);
      if (!rule) {
        return CLAUDE_TOOL_NAMES[nativeName]?.toLowerCase() === lowered;
      }
      if (rule.server === undefined) {
        return true;
      }
      const server = mcpSegment(tool?.params.server_name);
      if (!server || mcpSegment(rule.server) !== server) {
        return false;
      }
      if (rule.tool === undefined) {
        return true;
      }
      // Resource tools are covered by server-wide rules only.
      return nativeName === 'use_mcp_tool' && mcpSegment(rule.tool) === mcpSegment(tool?.params.tool_name);
    }
    case 'web':
      return lowered === 'webfetch' || lowered === 'web' || lowered === 'fetch';
    default:
      return CLAUDE_TOOL_NAMES[nativeName]?.toLowerCase() === lowered;
  }
}

/** Claude Code WebFetch specifier: `domain:example.com` (also matches subdomains) or a URL glob. */
export function urlMatches(specifier: string, url: string): boolean {
  const spec = specifier.trim();
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (/^domain:/i.test(spec)) {
    const domain = spec.slice('domain:'.length).trim().toLowerCase().replace(/^\*\./, '');
    return Boolean(host) && (host === domain || host.endsWith(`.${domain}`));
  }
  if (spec.includes('*')) {
    const regex = new RegExp(`^${spec.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    return regex.test(url) || regex.test(host);
  }
  return url === spec || host === spec.toLowerCase();
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
  const unwrapped = stripLeadingCommandWrappers(normalized).replace(/\s+/g, ' ');
  const candidates = unwrapped && unwrapped !== normalized ? [normalized, unwrapped] : [normalized];
  const spec = specifier.trim().replace(/\s+/g, ' ');
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    return candidates.some(
      (candidate) =>
        candidate === prefix ||
        candidate.startsWith(`${prefix} `) ||
        (candidate.startsWith(prefix) && /[\s/=:-]$/.test(prefix))
    );
  }
  if (spec.includes('*')) {
    const regex = new RegExp(`^${spec.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return candidates.some((candidate) => regex.test(candidate));
  }
  return candidates.some((candidate) => candidate === spec);
}

export interface ResolvedToolTarget {
  category: ToolCategory;
  /** Absolute path for read/edit tools. */
  absPath?: string;
  /** Path with symlinks resolved, when it exists. */
  realPath?: string;
  command?: string;
  subagent?: string;
  /** MCP server / tool names (use_mcp_tool, access_mcp_resource, list_mcp_resources). */
  mcpServer?: string;
  mcpTool?: string;
  /** Target URL of web_fetch. */
  url?: string;
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
  if (category === 'mcp') {
    return { category, mcpServer: (tool.params.server_name || '').trim(), mcpTool: (tool.params.tool_name || '').trim(), insideWorkspace: true };
  }
  if (category === 'web') {
    return { category, url: (tool.params.url || '').trim(), insideWorkspace: true };
  }
  return { category, insideWorkspace: true };
}

function ruleMatches(rule: PermissionRule, tool: GateToolCall, target: ResolvedToolTarget, cwd: string, segment?: string): boolean {
  if (!ruleCoversTool(rule.tool, tool.name, tool)) {
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
    case 'mcp': {
      // mcp(server) / mcp(server__tool) / mcp(server:tool)
      const spec = rule.specifier.replace(':', '__');
      const parsed = parseMcpRuleTool(spec.startsWith('mcp__') ? spec : `mcp__${spec}`);
      if (!parsed || parsed.server === undefined) {
        return false;
      }
      if (mcpSegment(parsed.server) !== mcpSegment(target.mcpServer)) {
        return false;
      }
      return parsed.tool === undefined || (tool.name === 'use_mcp_tool' && mcpSegment(parsed.tool) === mcpSegment(target.mcpTool));
    }
    case 'web':
      return Boolean(target.url && urlMatches(rule.specifier, target.url));
    default:
      return false;
  }
}

/** Shell segments that look like they touch a protected secret file. */
export function commandTouchesSecret(command: string): string | undefined {
  const shellOnly = stripHeredocBodies(command)
    .replace(/(?:^|\s)-m\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, ' ');
  const tokens = shellOnly.split(/[\s"'`=<>|;&()]+/).filter(Boolean);
  for (const token of tokens) {
    if (/[{}[\],:;!?+*]/.test(token)) {
      continue;
    }
    const base = token.split('/').pop() || token;
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.includes('/')) {
        if (token.includes(pattern.replace('/**', '/'))) return token;
        continue;
      }
      if (pattern === '*.key' && !token.includes('/')) {
        if (/^(?:private|secret|server|client|tls|ssl|ca|host|auth|master|root|signing|cert|service|api|id)[-_.]?.*\.key$/i.test(base)) {
          return token;
        }
        continue;
      }
      if (pathGlobToRegex(pattern).test(base) && !/^\.env\.(example|sample|template|dist|schema|test)$/i.test(base)) {
        return token;
      }
    }
  }
  return undefined;
}

function toolAllowed(list: string[] | undefined, tool: GateToolCall): boolean {
  const nativeName = tool.name;
  if (!list || toolCategory(nativeName) === 'meta') {
    return true;
  }
  return list.some((entry) => {
    const rule = parseRule(entry);
    return Boolean(rule && ruleCoversTool(rule.tool, nativeName, tool));
  });
}

export function evaluatePermission(config: PermissionConfig, tool: GateToolCall, cwd: string): GateVerdict {
  const target = resolveTarget(tool, cwd, config.additionalDirectories);
  const parse = (list: string[]) => list.map(parseRule).filter((rule): rule is PermissionRule => Boolean(rule));
  const deny = parse(config.deny);
  const ask = parse(config.ask);
  const allow = parse(config.allow);

  if (!toolAllowed(config.toolAllowList, tool)) {
    return { decision: 'deny', reason: `Tool '${claudeToolName(tool)}' is not in this agent's tool list (${config.toolAllowList!.join(', ')}).`, source: 'agent.tools' };
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
  // MCP tools may have side effects; in plan mode they need an explicit allow rule (resource reads are fine).
  if (config.mode === 'plan' && tool.name === 'use_mcp_tool' && !allow.some((rule) => ruleMatches(rule, tool, target, cwd))) {
    return { decision: 'deny', reason: `Plan mode: MCP tool ${claudeToolName(tool)} is not allowed unless a permission rule allows it explicitly. Read MCP resources or present the plan instead.`, source: 'mode: plan' };
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
