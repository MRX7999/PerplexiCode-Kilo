/**
 * Shared contracts of the PerplexiCode 3.0 headless core.
 *
 * Nothing in src/core may import 'vscode'. The VS Code extension and the `pcode` CLI are both
 * thin clients of these contracts: the agent loop (src/agent/task.ts) calls a ToolGate before and
 * after every tool and reports CoreEvents; the clients decide where approvals, journals and UI go.
 */

export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** Claude Code compatible permission modes. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export interface GateVerdict {
  /** undefined = no opinion, the legacy auto-approve settings decide. */
  decision?: PermissionDecision;
  reason?: string;
  /** What produced the verdict, for example "permissions.deny: Read(**\/.env)" or "hook: guard.sh". */
  source?: string;
  /** A hook returned "continue": false — stop the whole task. */
  stopTask?: boolean;
}

export interface GateToolCall {
  name: string;
  params: Record<string, string>;
}

export interface GateContext {
  taskId: string;
  parentId?: string;
  /** Kilo mode slug of the task (code, architect, ask, ...). */
  mode: string;
  cwd: string;
}

export interface PostToolOutcome {
  /** Extra text appended to the tool result the model sees. */
  additionalContext?: string;
  /** A PostToolUse hook rejected the result; the reason is fed back to the model. */
  blockReason?: string;
}

export interface PromptOutcome {
  /** The prompt is blocked; the reason is shown to the user and nothing is sent to the model. */
  block?: string;
  additionalContext?: string;
}

export interface StopOutcome {
  /** The task may not finish yet; the reason is sent to the model and the loop continues. */
  continueReason?: string;
}

/**
 * Policy hook points used by AgentTask. Every method is optional so the 2.x extension behaviour is
 * unchanged when no gate is configured.
 */
export interface ToolGate {
  preToolUse?(ctx: GateContext, tool: GateToolCall): Promise<GateVerdict>;
  postToolUse?(ctx: GateContext, tool: GateToolCall, result: { output: string; isError: boolean }): Promise<PostToolOutcome>;
  userPromptSubmit?(ctx: GateContext, prompt: string): Promise<PromptOutcome>;
  stop?(ctx: GateContext, result: string, attempt: number): Promise<StopOutcome>;
  /** Extra system context (memory files, subagents, skills, SessionStart hook output). */
  sessionContext?(ctx: GateContext): Promise<string>;
}

/** Structured events emitted by the agent loop. They feed the JSONL journal and verification. */
export type CoreEvent =
  | { type: 'session_start'; mode: string; cwd: string; resumed: boolean }
  | { type: 'user'; text: string }
  | { type: 'request_start'; model: string }
  | { type: 'request_end'; model: string; account?: string; promptChars: number; durationMs: number; followUp: boolean; ok: boolean; error?: string }
  | { type: 'assistant'; text: string; tools: string[] }
  | { type: 'tool_start'; tool: string; params: Record<string, string> }
  | { type: 'tool_end'; tool: string; ok: boolean; summary: string }
  | { type: 'denied'; tool: string; reason: string; source: string }
  | { type: 'command_start'; command: string; cwd: string }
  | { type: 'command_end'; command: string; exitCode: number | null; timedOut: boolean; outputTail: string }
  | { type: 'file_edit'; path: string; created: boolean; added: number; removed: number; checkpoint: number }
  | { type: 'mode'; mode: string }
  | { type: 'compacted'; before: number; after: number }
  | { type: 'completion'; result: string }
  | { type: 'verification'; status: VerificationStatus; detail: string }
  | { type: 'state'; state: string };

export type VerificationStatus = 'verified' | 'needs_review' | 'failed' | 'blocked' | 'no_changes';

export type TimedCoreEvent = CoreEvent & { ts: number; seq: number; taskId: string };

/** Tool categories used by permissions and hooks. */
export const READ_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'list_code_definition_names', 'glob_files']);
export const EDIT_TOOLS = new Set(['write_to_file', 'apply_diff', 'insert_content', 'search_and_replace']);
export const META_TOOLS = new Set(['ask_followup_question', 'attempt_completion', 'update_todo_list', 'switch_mode']);
/** Model Context Protocol tools (3.3). */
export const MCP_TOOLS = new Set(['use_mcp_tool', 'access_mcp_resource', 'list_mcp_resources']);
/** Tools that reach the network directly (3.3). */
export const WEB_TOOLS = new Set(['web_fetch']);

/** Claude Code tool names for our native tools (used by hook matchers and permission rules). */
export const CLAUDE_TOOL_NAMES: Record<string, string> = {
  read_file: 'Read',
  list_files: 'LS',
  search_files: 'Grep',
  list_code_definition_names: 'Glob',
  glob_files: 'Glob',
  write_to_file: 'Write',
  apply_diff: 'Edit',
  insert_content: 'Edit',
  search_and_replace: 'MultiEdit',
  execute_command: 'Bash',
  web_fetch: 'WebFetch',
  new_task: 'Task',
  update_todo_list: 'TodoWrite',
  ask_followup_question: 'AskUserQuestion',
  switch_mode: 'SwitchMode',
  attempt_completion: 'AttemptCompletion',
  access_mcp_resource: 'ReadMcpResourceTool',
  list_mcp_resources: 'ListMcpResourcesTool',
};

/**
 * Claude Code tool name of a concrete call. MCP tool calls get their canonical dynamic name
 * (`mcp__<server>__<tool>`), everything else uses CLAUDE_TOOL_NAMES or the native name.
 */
export function claudeToolName(tool: GateToolCall): string {
  if (tool.name === 'use_mcp_tool') {
    const server = sanitizeMcpName(tool.params.server_name || '');
    const name = sanitizeMcpName(tool.params.tool_name || '');
    return server && name ? `mcp__${server}__${name}` : 'mcp__unknown';
  }
  return CLAUDE_TOOL_NAMES[tool.name] || tool.name;
}

function sanitizeMcpName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
}
