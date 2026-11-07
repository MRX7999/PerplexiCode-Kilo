import * as cp from 'child_process';
import * as path from 'path';
import { resolveWorkspacePath } from '../agent/tools';
import { HookEvent, HookMatcher } from './settings';
import { CLAUDE_TOOL_NAMES, claudeToolName, GateToolCall, PermissionDecision, PermissionMode } from './types';

/**
 * Claude Code compatible command hooks.
 *
 * The hook receives one JSON object on stdin (session_id, cwd, hook_event_name, tool_name,
 * tool_input, tool_response, prompt, ...). Results:
 *   exit 0            success; stdout JSON is parsed when present (decision / hookSpecificOutput)
 *                     for UserPromptSubmit and SessionStart plain stdout becomes extra context
 *   exit 2            blocking error; stderr is fed back to the model (PreToolUse blocks the tool,
 *                     PostToolUse reports the problem, Stop forces the agent to continue)
 *   any other code    non-blocking error, logged and ignored
 *
 * Environment: CLAUDE_PROJECT_DIR and PERPLEXICODE_PROJECT_DIR point at the project root.
 */

export interface HookInputBase {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode: PermissionMode;
  hook_event_name: HookEvent;
}

export interface HookRunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface HookDecision {
  /** PreToolUse permission decision. */
  permission?: PermissionDecision;
  /** Block / deny reason (exit 2 stderr or JSON reason). */
  reason?: string;
  /** Stop and PostToolUse: "block" asks the agent to continue / fix. */
  block?: boolean;
  additionalContext?: string;
  /** JSON "continue": false stops the whole task. */
  stopTask?: boolean;
  stopReason?: string;
  results: HookRunResult[];
}

export type HookRunner = (command: string, input: string, options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<HookRunResult>;

export const defaultHookRunner: HookRunner = (command, input, options) => new Promise((resolve) => {
  const startedAt = Date.now();
  const isWindows = process.platform === 'win32';
  const child = cp.spawn(isWindows ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh', isWindows ? ['/d', '/s', '/c', command] : ['-c', command], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 1_000_000) stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 1_000_000) stderr += chunk.toString();
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    resolve({ command, exitCode: null, stdout, stderr: stderr || error.message, timedOut, durationMs: Date.now() - startedAt });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ command, exitCode: timedOut ? null : code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
});

/** Claude Code shaped tool_input for our native tools. */
export function toClaudeToolInput(tool: GateToolCall, cwd: string): Record<string, unknown> {
  const p = tool.params;
  const filePath = p.path ? resolveWorkspacePath(cwd, p.path) : undefined;
  switch (tool.name) {
    case 'read_file':
      return { file_path: filePath, offset: p.start_line ? Number(p.start_line) : undefined, limit: p.end_line && p.start_line ? Number(p.end_line) - Number(p.start_line) + 1 : undefined };
    case 'write_to_file':
      return { file_path: filePath, content: p.content };
    case 'apply_diff': {
      const block = (p.diff || '').match(/<<<<<<< SEARCH\s*\n(?::start_line:\s*\d+\s*\n-------\s*\n)?([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/);
      return { file_path: filePath, old_string: block?.[1], new_string: block?.[2], diff: p.diff };
    }
    case 'insert_content':
      return { file_path: filePath, line: p.line ? Number(p.line) : undefined, new_string: p.content };
    case 'execute_command':
      return { command: p.command, cwd: p.cwd ? resolveWorkspacePath(cwd, p.cwd) : cwd, description: '' };
    case 'search_files':
      return { pattern: p.regex, path: filePath, glob: p.file_pattern };
    case 'list_files':
      return { path: filePath, recursive: p.recursive === 'true' };
    case 'list_code_definition_names':
      return { path: filePath };
    case 'new_task':
      return { subagent_type: p.mode, prompt: p.message, description: (p.message || '').slice(0, 80) };
    case 'glob_files':
      return { pattern: p.pattern, path: filePath };
    case 'search_and_replace': {
      const edits = parseSearchReplaceOperations(p);
      return { file_path: filePath, edits };
    }
    case 'web_fetch':
      return { url: p.url, prompt: p.prompt || '' };
    case 'use_mcp_tool':
      return parseMcpArguments(p.arguments);
    case 'access_mcp_resource':
      return { server: p.server_name, uri: p.uri };
    case 'list_mcp_resources':
      return { server: p.server_name };
    default:
      return { ...p };
  }
}

/** `<operations>` JSON array or the single search/replace pair, as MultiEdit `edits`. */
export function parseSearchReplaceOperations(p: Record<string, string>): Array<{ old_string: string; new_string: string; use_regex?: boolean; ignore_case?: boolean }> {
  if (p.operations) {
    try {
      const parsed = JSON.parse(p.operations);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
          .map((entry) => ({
            old_string: String(entry.search ?? entry.old_string ?? ''),
            new_string: String(entry.replace ?? entry.new_string ?? ''),
            use_regex: entry.use_regex === true || entry.useRegex === true || entry.regex === true,
            ignore_case: entry.ignore_case === true || entry.ignoreCase === true,
          }));
      }
    } catch {
      // fall through to the single pair
    }
  }
  return [{ old_string: p.search ?? '', new_string: p.replace ?? '', use_regex: p.use_regex === 'true', ignore_case: p.ignore_case === 'true' }];
}

/** MCP tool arguments: a JSON object string; invalid or empty input becomes {} (the task reports the error). */
export function parseMcpArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

export function matcherApplies(matcher: string | undefined, nativeName: string | undefined, tool?: GateToolCall): boolean {
  if (!matcher || matcher === '*' || matcher.trim() === '') {
    return true;
  }
  if (!nativeName) {
    return true;
  }
  const names = [nativeName, CLAUDE_TOOL_NAMES[nativeName]].filter(Boolean) as string[];
  if (tool) {
    names.push(claudeToolName(tool));
  }
  if (nativeName === 'apply_diff' || nativeName === 'insert_content' || nativeName === 'search_and_replace') {
    names.push('MultiEdit', 'Edit');
  }
  try {
    const regex = new RegExp(`^(?:${matcher})$`);
    return names.some((name) => regex.test(name));
  } catch {
    return names.includes(matcher);
  }
}

export class HookEngine {
  constructor(
    private readonly hooks: Partial<Record<HookEvent, HookMatcher[]>>,
    private readonly projectDir: string,
    private readonly env: Record<string, string> = {},
    private readonly runner: HookRunner = defaultHookRunner,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  has(event: HookEvent): boolean {
    return (this.hooks[event] || []).length > 0;
  }

  count(): number {
    return Object.values(this.hooks).reduce((sum, list) => sum + (list || []).reduce((inner, entry) => inner + entry.hooks.length, 0), 0);
  }

  async run(event: HookEvent, input: HookInputBase & Record<string, unknown>, toolName?: string, tool?: GateToolCall): Promise<HookDecision> {
    const decision: HookDecision = { results: [] };
    const matchers = (this.hooks[event] || []).filter((entry) => matcherApplies(entry.matcher, toolName, tool));
    if (matchers.length === 0) {
      return decision;
    }
    const payload = JSON.stringify(input);
    const env = {
      ...process.env,
      ...this.env,
      CLAUDE_PROJECT_DIR: this.projectDir,
      PERPLEXICODE_PROJECT_DIR: this.projectDir,
      PERPLEXICODE_HOOK_EVENT: event,
    };
    const contexts: string[] = [];
    const reasons: string[] = [];
    // Hooks of one event run in parallel like in Claude Code; the strictest decision wins.
    const commands = matchers.flatMap((entry) => entry.hooks);
    const results = await Promise.all(commands.map((hook) => this.runner(hook.command, payload, {
      cwd: this.projectDir,
      timeoutMs: Math.max(1, hook.timeout ?? 60) * 1000,
      env,
    })));
    for (const result of results) {
      decision.results.push(result);
      const label = path.basename(result.command.split(/\s+/)[0] || result.command);
      if (result.timedOut) {
        this.log(`[hook ${event}] ${label} timed out`);
        continue;
      }
      if (result.exitCode === 2) {
        const reason = result.stderr.trim() || `Blocked by hook ${label}.`;
        reasons.push(reason);
        if (event === 'PreToolUse') {
          decision.permission = 'deny';
        } else if (event === 'Stop' || event === 'SubagentStop' || event === 'PostToolUse' || event === 'UserPromptSubmit') {
          decision.block = true;
        }
        continue;
      }
      if (result.exitCode !== 0) {
        this.log(`[hook ${event}] ${label} exited with ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`);
        continue;
      }
      const stdout = result.stdout.trim();
      const json = parseJsonOutput(stdout);
      if (!json) {
        if (stdout && (event === 'UserPromptSubmit' || event === 'SessionStart')) {
          contexts.push(stdout);
        }
        continue;
      }
      if (json.continue === false) {
        decision.stopTask = true;
        decision.stopReason = typeof json.stopReason === 'string' ? json.stopReason : 'Stopped by hook.';
      }
      const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput as Record<string, unknown> : undefined;
      const permission = (specific?.permissionDecision ?? legacyDecision(json.decision)) as string | undefined;
      const reason = (specific?.permissionDecisionReason ?? json.reason) as string | undefined;
      if (event === 'PreToolUse' && (permission === 'allow' || permission === 'deny' || permission === 'ask')) {
        decision.permission = strictest(decision.permission, permission);
        if (reason) reasons.push(String(reason));
      } else if (json.decision === 'block') {
        decision.block = true;
        if (reason) reasons.push(String(reason));
      }
      const extra = specific?.additionalContext;
      if (typeof extra === 'string' && extra.trim()) {
        contexts.push(extra.trim());
      }
    }
    if (reasons.length > 0) {
      decision.reason = reasons.join('\n');
    }
    if (contexts.length > 0) {
      decision.additionalContext = contexts.join('\n\n');
    }
    return decision;
  }
}

function parseJsonOutput(stdout: string): Record<string, unknown> | undefined {
  if (!stdout.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code's older PreToolUse output: decision "approve" | "block". */
function legacyDecision(value: unknown): string | undefined {
  if (value === 'approve') return 'allow';
  if (value === 'block') return 'deny';
  return undefined;
}

function strictest(current: PermissionDecision | undefined, next: PermissionDecision): PermissionDecision {
  const order: PermissionDecision[] = ['allow', 'ask', 'deny'];
  if (!current) return next;
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}
