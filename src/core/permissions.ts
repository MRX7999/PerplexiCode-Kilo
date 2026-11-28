import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeShellCommand,
  commandTouchesProtectedConfig,
  hasFileOutputRedirection,
  isProtectedAgentConfigPath,
} from '../agent/shellParser';
import { resolveWorkspacePath, shellCommandPositions, splitCommandChain, stripHeredocBodies, stripLeadingCommandWrappers } from '../agent/tools';
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
  /** Optional home directory override for protected config checks. */
  home?: string;
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
      return ['read', 'grep', 'glob', 'ls', 'lsp'].includes(lowered) && (lowered === 'read' || CLAUDE_TOOL_NAMES[nativeName]?.toLowerCase() === lowered);
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
      if (nativeName === 'access_mcp_resource') {
        const seg = mcpSegment(rule.tool);
        return seg === 'read_resource' || seg === 'access_mcp_resource';
      }
      if (nativeName === 'list_mcp_resources') {
        const seg = mcpSegment(rule.tool);
        return seg === 'list_resources' || seg === 'list_mcp_resources';
      }
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

function valueGlobRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      out += '[\\s\\S]*';
    } else if (ch === '?') {
      out += '[\\s\\S]';
    } else {
      out += ch.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function getNestedField(obj: Record<string, unknown>, dottedKey: string): unknown[] {
  const parts = dottedKey.split('.').map((p) => p.trim()).filter(Boolean);
  let current: unknown[] = [obj];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const item of current) {
      if (Array.isArray(item)) {
        for (const elem of item) {
          if (elem && typeof elem === 'object' && part in (elem as Record<string, unknown>)) {
            next.push((elem as Record<string, unknown>)[part]);
          }
        }
      } else if (item && typeof item === 'object' && part in (item as Record<string, unknown>)) {
        next.push((item as Record<string, unknown>)[part]);
      }
    }
    current = next;
  }
  return current;
}

function scalarMatchesPattern(actual: unknown, rawPattern: string): boolean {
  let pattern = rawPattern.trim();
  if ((pattern.startsWith('"') && pattern.endsWith('"')) || (pattern.startsWith("'") && pattern.endsWith("'"))) {
    pattern = pattern.slice(1, -1);
  }
  if (Array.isArray(actual)) {
    return actual.some((elem) => scalarMatchesPattern(elem, rawPattern));
  }
  if (actual === undefined || actual === null) {
    return pattern === 'null' && actual === null;
  }
  const str = typeof actual === 'string' ? actual : JSON.stringify(actual);
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim();
    return str === prefix || str.startsWith(`${prefix} `) || str.startsWith(`${prefix}/`);
  }
  if (pattern.includes('*') || pattern.includes('?')) {
    return valueGlobRegex(pattern).test(str);
  }
  return str === pattern;
}

function collectLeafValues(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeafValues(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectLeafValues(v, out);
  }
  return out;
}

function splitTopLevelPredicates(spec: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < spec.length) {
        current += spec[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Evaluates MCP argument permission specifiers (`F23`):
 * - Key-value predicates: `mcp__fs__read_file(path:/etc/*)`, `mcp__github__merge(repo:org/*, force=true)`
 * - JSON object pattern: `mcp__db__query({"sql": "*DROP*", "readOnly": false})`
 * - Wildcard value pattern: `mcp__db__query(*DROP TABLE*)`
 *
 * When `failClosedOnMalformed` is true (used for `deny` and `ask` rules), malformed JSON in
 * `tool.params.arguments` cannot evade a rule: raw text fallback is also checked, and if the
 * JSON is broken while a deny rule restricts arguments on that tool, it matches conservatively.
 */
export function mcpArgumentsMatch(
  specifier: string,
  tool: GateToolCall,
  failClosedOnMalformed = false
): boolean {
  const spec = specifier.trim();
  if (!spec || spec === '*') return true;

  // Support URI matching on access_mcp_resource (`uri:file:///etc/*` or `file:///etc/*`).
  if (tool.name === 'access_mcp_resource') {
    const uri = (tool.params.uri || '').trim();
    const uriPattern = /^uri\s*[:=]\s*/i.test(spec) ? spec.replace(/^uri\s*[:=]\s*/i, '') : spec;
    return scalarMatchesPattern(uri, uriPattern);
  }

  const rawArgs = (tool.params.arguments ?? '').trim();
  let parsedArgs: Record<string, unknown> | undefined;
  if (!rawArgs) {
    parsedArgs = {};
  } else {
    try {
      const candidate = JSON.parse(rawArgs);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsedArgs = candidate as Record<string, unknown>;
      }
    } catch {
      parsedArgs = undefined;
    }
  }

  if (!parsedArgs) {
    if (!failClosedOnMalformed) {
      return false;
    }
    // Malformed JSON on a tool covered by an argument-scoped deny/ask rule: fail closed.
    return true;
  }

  // 1. JSON object pattern `{"key": "glob*", ...}`
  if (spec.startsWith('{') && spec.endsWith('}')) {
    try {
      const patternObj = JSON.parse(spec) as Record<string, unknown>;
      if (patternObj && typeof patternObj === 'object' && !Array.isArray(patternObj)) {
        return Object.entries(patternObj).every(([key, expected]) => {
          const values = getNestedField(parsedArgs!, key);
          if (values.length === 0) return false;
          const expectedPattern = typeof expected === 'string' ? expected : JSON.stringify(expected);
          return values.some((actual) => scalarMatchesPattern(actual, expectedPattern));
        });
      }
    } catch {
      return failClosedOnMalformed;
    }
  }

  // 2. Comma/semicolon-separated `field:glob` or `field=glob` predicates
  const predicates = splitTopLevelPredicates(spec);
  const kvMatches = predicates.map((pred) => /^([A-Za-z_][\w.-]*)\s*([:=])\s*([\s\S]+)$/.exec(pred));
  if (predicates.length > 0 && kvMatches.every(Boolean)) {
    return kvMatches.every((m) => {
      const field = m![1];
      const pattern = m![3].trim();
      const values = getNestedField(parsedArgs!, field);
      if (values.length === 0) return false;
      return values.some((actual) => scalarMatchesPattern(actual, pattern));
    });
  }

  // 3. Bare value/wildcard glob (matches serialized JSON or any leaf scalar value)
  const serialized = JSON.stringify(parsedArgs);
  if (scalarMatchesPattern(serialized, spec)) {
    return true;
  }
  const leaves = collectLeafValues(parsedArgs);
  return leaves.some((leaf) => scalarMatchesPattern(leaf, spec));
}

function ruleMatches(
  rule: PermissionRule,
  tool: GateToolCall,
  target: ResolvedToolTarget,
  cwd: string,
  segment?: string,
  failClosedOnMalformed = false
): boolean {
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
      // Case A: rule.tool already names an MCP server/tool (`mcp__server__tool(argSpec)` or `use_mcp_tool(argSpec)`)
      const toolRule = parseMcpRuleTool(rule.tool);
      if ((toolRule && toolRule.server !== undefined) || rule.tool === 'use_mcp_tool' || rule.tool === 'access_mcp_resource') {
        return mcpArgumentsMatch(rule.specifier, tool, failClosedOnMalformed);
      }

      // Case B: `mcp(server)` / `mcp(server__tool)` / `mcp(server:tool)` / `mcp(server__tool, key:glob)`
      const parts = splitTopLevelPredicates(rule.specifier);
      const serverToolSpec = (parts[0] || '').replace(':', '__');
      const parsed = parseMcpRuleTool(serverToolSpec.startsWith('mcp__') ? serverToolSpec : `mcp__${serverToolSpec}`);
      if (!parsed || parsed.server === undefined) {
        return false;
      }
      if (mcpSegment(parsed.server) !== mcpSegment(target.mcpServer)) {
        return false;
      }
      const toolMatches = parsed.tool === undefined || (tool.name === 'use_mcp_tool' && mcpSegment(parsed.tool) === mcpSegment(target.mcpTool));
      if (!toolMatches) {
        return false;
      }
      if (parts.length > 1) {
        return mcpArgumentsMatch(parts.slice(1).join(', '), tool, failClosedOnMalformed);
      }
      return true;
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

  const shellAnalysis = target.category === 'bash' ? analyzeShellCommand(target.command || '') : undefined;
  const rawSegments = target.category === 'bash' ? splitCommandChain(target.command || '') : [];
  // 4.2: command positions inside control flow (`if …; then X; fi`, `$(X)`, `bash -c "X"`) count too,
  // so a deny or ask rule cannot be stepped around by wrapping the command.
  const denyCheckSegments = target.category === 'bash'
    ? Array.from(new Set([...(shellAnalysis?.segments || []), ...rawSegments, ...shellCommandPositions(target.command || ''), target.command || ''].filter(Boolean)))
    : [undefined];
  const segments = target.category === 'bash'
    ? (shellAnalysis?.segments || [])
    : [undefined];

  // 1. Deny rules win (check both raw and unwrapped/recursively extracted shell segments).
  for (const rule of deny) {
    if (denyCheckSegments.some((segment) => ruleMatches(rule, tool, target, cwd, segment, true))) {
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

  // 2b. Protected agent/MCP/hooks config files ALWAYS require interactive confirmation (F09),
  // even when allow rules, acceptEdits, bypassPermissions, or autoApprove.write are active.
  if (target.category === 'edit' && target.absPath) {
    const protectedHit = isProtectedAgentConfigPath(target.absPath, cwd, config.home)
      || (target.realPath ? isProtectedAgentConfigPath(target.realPath, cwd, config.home) : undefined);
    if (protectedHit) {
      return {
        decision: 'ask',
        reason: `Protected config (${protectedHit}) always requires explicit approval.`,
        source: `protected-config: ${protectedHit}`,
      };
    }
  }
  if (target.category === 'bash') {
    const protectedCmdHit = commandTouchesProtectedConfig(target.command || '');
    if (protectedCmdHit) {
      return {
        decision: 'ask',
        reason: `The command touches a protected config (${protectedCmdHit}) and requires explicit approval.`,
        source: `protected-config: ${protectedCmdHit}`,
      };
    }
    // 2c. Unparseable or dynamic shell syntax ALWAYS requires interactive confirmation (F06).
    if (!shellAnalysis || !shellAnalysis.valid) {
      const askRule = ask.find((rule) => denyCheckSegments.some((segment) => ruleMatches(rule, tool, target, cwd, segment, true)));
      const secret = config.protectSecrets ? commandTouchesSecret(target.command || '') : undefined;
      return {
        decision: 'ask',
        reason: shellAnalysis?.reason || 'Unparseable shell syntax requires manual approval.',
        source: 'shell.unparseable',
        humanRule: askRule ? `permissions.ask: ${askRule.raw}` : secret ? 'secrets: command' : undefined,
      };
    }
  }

  // 3. Ask rules.
  for (const rule of ask) {
    if (denyCheckSegments.some((segment) => ruleMatches(rule, tool, target, cwd, segment, true))) {
      return { decision: 'ask', reason: `Permission rule ${rule.raw} requires approval.`, source: `permissions.ask: ${rule.raw}` };
    }
  }

  // Secrets mentioned in shell commands are never auto-approved.
  if (config.protectSecrets && target.category === 'bash') {
    const secret = commandTouchesSecret(target.command || '');
    if (secret && !allow.some((rule) => rule.specifier !== undefined && segments.length > 0 && segments.every((segment) => ruleMatches(rule, tool, target, cwd, segment)))) {
      return { decision: 'ask', reason: `The command references '${secret}', which looks like a secret.`, source: 'secrets: command' };
    }
  }

  // 4. Allow rules: every shell segment must be covered, and file output redirections (`> file`)
  // are only auto-allowed when wildcard Bash (`Bash` / `Bash(*)`) or `bypassPermissions` is active.
  const wildcardBashAllowed = allow.some(
    (rule) => rule.tool === 'Bash' && (!rule.specifier || rule.specifier.trim() === '*')
  );
  const redirectionBlocked =
    target.category === 'bash' && !wildcardBashAllowed && hasFileOutputRedirection(target.command || '');
  const allowed = target.category === 'bash'
    ? !redirectionBlocked && segments.length > 0 && segments.every((segment) => allow.some((rule) => ruleMatches(rule, tool, target, cwd, segment)))
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
