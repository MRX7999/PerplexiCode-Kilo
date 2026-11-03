import * as vscode from 'vscode';
import { loadSubagents, SubagentDefinition } from '../core/agents';
import { CoreGate } from '../core/gate';
import { sessionsDir, SessionJournal } from '../core/journal';
import { loadSettings } from '../core/settings';
import { CoreEvent, PERMISSION_MODES, PermissionMode } from '../core/types';
import { VERIFICATION_LABELS, VerificationReport, VerificationTracker } from '../core/verification';
import { readSetting } from '../config/settingsStore';
import type { AgentTask } from './task';
import type { AgentHost } from './tools';

/**
 * Connects the VS Code controller to the 3.0 core: permission rules / modes, Claude Code compatible
 * hooks, verify-before-done, subagents and the shared JSONL journal (~/.perplexicode/sessions) that
 * `pcode --continue` can resume.
 */
export class CoreBridge {
  private readonly journals = new Map<string, SessionJournal>();
  private readonly trackers = new Map<string, VerificationTracker>();
  private readonly parents = new Map<string, string | undefined>();
  private readonly owners = new Map<string, AgentTask>();
  private permissionModeOverride?: PermissionMode;

  constructor(private readonly log: (line: string) => void) {}

  get permissionMode(): PermissionMode {
    if (this.permissionModeOverride) return this.permissionModeOverride;
    const configured = readSetting<string>('perplexicodeKilo.agent.permissionMode', 'default') as PermissionMode;
    return PERMISSION_MODES.includes(configured) ? configured : 'default';
  }

  setPermissionMode(mode: PermissionMode | undefined): void {
    this.permissionModeOverride = mode;
  }

  subagents(cwd: string): SubagentDefinition[] {
    try {
      return loadSubagents(cwd);
    } catch {
      return [];
    }
  }

  findSubagent(cwd: string, name: string): SubagentDefinition | undefined {
    return this.subagents(cwd).find((agent) => agent.name === name);
  }

  /** Builds the gate for one task. Must be called before the task exists; `register` binds it. */
  createGate(options: { cwd: string; host: AgentHost; parentId?: string; agent?: SubagentDefinition }): CoreGate {
    const trusted = vscode.workspace.isTrusted;
    const settings = loadSettings(options.cwd, { trustProjectHooks: trusted });
    if (!readSetting<boolean>('perplexicodeKilo.agent.hooks.enabled', true)) {
      settings.hooks = {};
    }
    const agent = options.agent;
    return new CoreGate({
      cwd: options.cwd,
      settings,
      permissionMode: () => this.permissionMode,
      toolAllowList: agent?.tools,
      extraContext: agent
        ? `# You are the "${agent.name}" subagent\n${agent.prompt}\n\nWork only on the brief you were given and finish with attempt_completion: a concise report the parent agent can act on.`
        : undefined,
      includeAgents: !options.parentId,
      transcriptPath: (id) => this.journals.get(id)?.logPath,
      runCommand: (command, cwd, run) => options.host.runCommand(command, cwd, run),
      hasEdits: (id) => (this.owners.get(id)?.hasEdits ?? false) || (this.rootOf(id) === id && this.tracker(id).report().editedFiles.length > 0),
      onEvent: (id, event) => {
        const owner = this.owners.get(id);
        if (owner) this.onEvent(owner, event);
      },
      log: this.log,
    });
  }

  readBatchSize(cwd: string): number {
    const configured = readSetting<number>('perplexicodeKilo.agent.readBatchSize', 0);
    if (configured > 0) return Math.min(9, configured);
    try {
      return loadSettings(cwd, { trustProjectHooks: false }).readBatchSize;
    } catch {
      return 5;
    }
  }

  register(task: AgentTask): void {
    this.owners.set(task.id, task);
    this.parents.set(task.id, task.parentId);
    if (readSetting<boolean>('perplexicodeKilo.agent.journal.enabled', true) && !this.journals.has(task.id)) {
      try {
        this.journals.set(task.id, new SessionJournal(task.id, sessionsDir()));
      } catch (error) {
        this.log(`[core] journal disabled: ${(error as Error).message}`);
      }
    }
  }

  private rootOf(taskId: string): string {
    let current = taskId;
    for (let i = 0; i < 20; i++) {
      const parent = this.parents.get(current);
      if (!parent) return current;
      current = parent;
    }
    return current;
  }

  private tracker(rootId: string): VerificationTracker {
    let tracker = this.trackers.get(rootId);
    if (!tracker) {
      const owner = this.owners.get(rootId);
      let verifyCommand = '';
      try {
        verifyCommand = owner ? loadSettings(owner.toJSON().workspace, { trustProjectHooks: false }).verify.command || '' : '';
      } catch {
        verifyCommand = '';
      }
      tracker = new VerificationTracker(verifyCommand ? [verifyCommand] : []);
      this.trackers.set(rootId, tracker);
    }
    return tracker;
  }

  onEvent(task: AgentTask, event: CoreEvent): void {
    this.journals.get(task.id)?.append(event);
    const rootId = this.rootOf(task.id);
    if (rootId === task.id || event.type === 'file_edit' || event.type === 'command_end') {
      this.tracker(rootId).observe(event);
    }
    if (event.type === 'tool_end' || event.type === 'request_end') {
      this.snapshot(task);
    }
  }

  snapshot(task: AgentTask): void {
    try {
      this.journals.get(task.id)?.snapshot(task.toJSON());
    } catch (error) {
      this.log(`[core] snapshot failed: ${(error as Error).message}`);
    }
  }

  /** Records the verification state of a finished root task and returns a status line. */
  finish(task: AgentTask): VerificationReport | undefined {
    if (task.parentId) {
      this.snapshot(task);
      return undefined;
    }
    const report = this.tracker(task.id).report();
    this.journals.get(task.id)?.append({ type: 'verification', status: report.status, detail: report.detail });
    this.snapshot(task);
    return report;
  }

  label(report: VerificationReport): string {
    return `${VERIFICATION_LABELS[report.status]}: ${report.detail}`;
  }

  forget(taskId: string): void {
    this.owners.delete(taskId);
    this.journals.delete(taskId);
  }
}
