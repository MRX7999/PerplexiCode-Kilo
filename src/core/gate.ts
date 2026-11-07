import * as os from 'os';
import * as path from 'path';
import type { CommandResult } from '../agent/tools';
import { formatSessionContext } from './agents';
import { HookEngine, HookInputBase, HookRunner, toClaudeToolInput } from './hooks';
import { evaluatePermission, pathMatches } from './permissions';
import { CoreSettings, HookEvent } from './settings';
import {
  claudeToolName,
  CoreEvent,
  GateContext,
  GateToolCall,
  GateVerdict,
  PermissionMode,
  PostToolOutcome,
  PromptOutcome,
  StopOutcome,
  ToolGate,
} from './types';

export interface CoreGateOptions {
  cwd: string;
  settings: CoreSettings;
  permissionMode: () => PermissionMode;
  /** Extra allow/deny rules from CLI flags (--allowedTools / --disallowedTools). */
  extraAllow?: string[];
  extraDeny?: string[];
  /** Tool allow-list of a subagent. */
  toolAllowList?: string[];
  /** Subagent system prompt or other fixed context. */
  extraContext?: string;
  /** List subagents in the system prompt (false inside subagents to avoid recursion). */
  includeAgents?: boolean;
  transcriptPath?: (taskId: string) => string | undefined;
  hookRunner?: HookRunner;
  /** Runs the verify command; usually AgentHost.runCommand. */
  runCommand?: (command: string, cwd: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<CommandResult>;
  /** Whether the task edited files (verify runs only then). */
  hasEdits?: (taskId: string) => boolean;
  onEvent?: (taskId: string, event: CoreEvent) => void;
  log?: (line: string) => void;
  home?: string;
}

/**
 * The 3.0 policy engine: permission rules + permission modes + Claude Code compatible hooks +
 * verify-before-done. Shared by the extension and the CLI.
 */
export class CoreGate implements ToolGate {
  readonly hooks: HookEngine;
  private sessionStartContext?: Promise<string>;
  private readonly verifyAttempts = new Map<string, number>();

  constructor(private readonly options: CoreGateOptions) {
    this.hooks = new HookEngine(options.settings.hooks, options.cwd, options.settings.env, options.hookRunner, options.log);
  }

  get mode(): PermissionMode {
    return this.options.permissionMode();
  }

  private base(ctx: GateContext, event: HookEvent): HookInputBase {
    return {
      session_id: ctx.taskId,
      transcript_path: this.options.transcriptPath?.(ctx.taskId),
      cwd: ctx.cwd,
      permission_mode: this.mode,
      hook_event_name: event,
    };
  }

  async preToolUse(ctx: GateContext, tool: GateToolCall): Promise<GateVerdict> {
    const { settings } = this.options;
    const verdict = evaluatePermission({
      allow: [...settings.permissions.allow, ...(this.options.extraAllow || []), ...this.knowledgeReadRules()],
      ask: settings.permissions.ask,
      deny: [...settings.permissions.deny, ...(this.options.extraDeny || [])],
      mode: this.mode,
      protectSecrets: settings.permissions.protectSecrets,
      additionalDirectories: settings.permissions.additionalDirectories,
      toolAllowList: this.options.toolAllowList,
    }, tool, ctx.cwd);
    if (verdict.decision === 'deny') {
      return verdict;
    }
    if (!this.hooks.has('PreToolUse')) {
      return verdict;
    }
    const result = await this.hooks.run('PreToolUse', {
      ...this.base(ctx, 'PreToolUse'),
      tool_name: claudeToolName(tool),
      tool_input: toClaudeToolInput(tool, ctx.cwd),
      native_tool: tool.name,
      native_params: tool.params,
    }, tool.name, tool);
    if (result.stopTask) {
      return { decision: 'deny', reason: result.stopReason, source: 'hook: continue=false', stopTask: true };
    }
    if (result.permission) {
      return { decision: result.permission, reason: result.reason || verdict.reason, source: 'hook: PreToolUse' };
    }
    return verdict;
  }

  async postToolUse(ctx: GateContext, tool: GateToolCall, outcome: { output: string; isError: boolean }): Promise<PostToolOutcome> {
    if (!this.hooks.has('PostToolUse')) {
      return {};
    }
    const result = await this.hooks.run('PostToolUse', {
      ...this.base(ctx, 'PostToolUse'),
      tool_name: claudeToolName(tool),
      tool_input: toClaudeToolInput(tool, ctx.cwd),
      tool_response: { output: outcome.output.slice(0, 20000), success: !outcome.isError },
      native_tool: tool.name,
    }, tool.name, tool);
    return {
      additionalContext: result.additionalContext,
      blockReason: result.block ? result.reason || 'A PostToolUse hook reported a problem with this change.' : undefined,
    };
  }

  async userPromptSubmit(ctx: GateContext, prompt: string): Promise<PromptOutcome> {
    if (!this.hooks.has('UserPromptSubmit')) {
      return {};
    }
    const result = await this.hooks.run('UserPromptSubmit', { ...this.base(ctx, 'UserPromptSubmit'), prompt });
    return { block: result.block ? result.reason || 'Prompt blocked by a hook.' : undefined, additionalContext: result.additionalContext };
  }

  async stop(ctx: GateContext, resultText: string, attempt: number): Promise<StopOutcome> {
    const event: HookEvent = ctx.parentId ? 'SubagentStop' : 'Stop';
    if (this.hooks.has(event)) {
      const result = await this.hooks.run(event, { ...this.base(ctx, event), stop_hook_active: attempt > 0, last_result: resultText });
      if (result.block && attempt < 5) {
        return { continueReason: result.reason || 'A Stop hook asked you to continue.' };
      }
    }
    const verify = this.options.settings.verify;
    const used = this.verifyAttempts.get(ctx.taskId) || 0;
    if (verify.command && this.options.runCommand && used < verify.maxAttempts && (this.options.hasEdits?.(ctx.taskId) ?? true)) {
      this.verifyAttempts.set(ctx.taskId, used + 1);
      this.options.onEvent?.(ctx.taskId, { type: 'command_start', command: verify.command, cwd: ctx.cwd });
      const controller = new AbortController();
      const run = await this.options.runCommand(verify.command, ctx.cwd, { signal: controller.signal, timeoutMs: verify.timeoutSec * 1000 });
      const tail = run.output.trim().split('\n').slice(-60).join('\n');
      this.options.onEvent?.(ctx.taskId, { type: 'command_end', command: verify.command, exitCode: run.exitCode, timedOut: run.timedOut, outputTail: tail.slice(-4000) });
      if (run.exitCode !== 0) {
        return {
          continueReason: `Verification command \`${verify.command}\` ${run.timedOut ? 'timed out' : `failed with exit code ${run.exitCode}`} (attempt ${used + 1}/${verify.maxAttempts}). Fix the problem, then call attempt_completion again.\nOutput (tail):\n${tail}`,
        };
      }
    }
    return {};
  }

  async sessionContext(ctx: GateContext): Promise<string> {
    const parts: string[] = [];
    const context = formatSessionContext(ctx.cwd, { home: this.options.home, includeAgents: this.options.includeAgents });
    if (context) parts.push(context);
    if (this.options.extraContext) parts.push(this.options.extraContext);
    if (this.mode !== 'default') parts.push(permissionModeNote(this.mode));
    if (this.hooks.has('SessionStart')) {
      this.sessionStartContext = this.sessionStartContext || this.hooks.run('SessionStart', { ...this.base(ctx, 'SessionStart'), source: 'startup' })
        .then((result) => result.additionalContext || '')
        .catch(() => '');
      const extra = await this.sessionStartContext;
      if (extra) parts.push(`# Context from SessionStart hooks:\n${extra}`);
    }
    return parts.join('\n\n');
  }

  async sessionEnd(ctx: GateContext, reason: string): Promise<void> {
    if (this.hooks.has('SessionEnd')) {
      await this.hooks.run('SessionEnd', { ...this.base(ctx, 'SessionEnd'), reason }).catch(() => undefined);
    }
  }

  /** Subagent and skill definitions may always be read (they live in ~/.claude or ~/.perplexicode). */
  private knowledgeReadRules(): string[] {
    const home = this.options.home || os.homedir();
    const toRule = (dir: string) => `Read(//${dir.replace(/^\//, '')}/**)`;
    return [
      path.join(home, '.perplexicode', 'skills'), path.join(home, '.claude', 'skills'),
      path.join(home, '.perplexicode', 'agents'), path.join(home, '.claude', 'agents'),
    ].map(toRule);
  }
}

export function permissionModeNote(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return '# Permission mode: plan\nYou are in PLAN mode. Only read and search. Do not edit files or run commands (they will be denied). Finish by calling attempt_completion with a concrete, step-by-step implementation plan (files, changes, commands, verification).';
    case 'acceptEdits':
      return '# Permission mode: acceptEdits\nFile edits inside the workspace are applied without asking. Commands still follow the permission rules.';
    case 'bypassPermissions':
      return '# Permission mode: bypassPermissions\nTools run without approval except explicit deny rules. Be careful with destructive commands.';
    default:
      return '';
  }
}

export { pathMatches };
