import { MODES } from '../agent/modes';
import { AgentTask, AskResponse, CompletionProvider, McpToolProvider } from '../agent/task';
import type { TodoItem } from '../agent/toolParser';
import type { AgentHost } from '../agent/tools';
import type { AgentSettings, ModelSelection, PersistedTask, UiMessage } from '../agent/types';
import { loadSubagents, SubagentDefinition } from './agents';
import { compactMessages } from './compaction';
import { CoreGate } from './gate';
import { detectInterruptedWork, findSession, resumeNote, SessionJournal, sessionsDir } from './journal';
import { NodeAgentHost } from './nodeHost';
import { CoreSettings, loadSettings } from './settings';
import { CoreEvent, PermissionMode } from './types';
import { VerificationReport, VerificationTracker } from './verification';

/**
 * CoreSession: one root task plus its subtasks, wired to the 3.0 policy engine, the JSONL journal
 * and verification. The CLI uses it directly; the extension uses the same pieces through its
 * controller. No vscode import.
 */

export interface CoreSessionOptions {
  cwd: string;
  provider: CompletionProvider;
  agentSettings: AgentSettings;
  selection: ModelSelection;
  mode?: string;
  /** Subagent (by name) the root task runs as, e.g. from a task preset. */
  agent?: string;
  permissionMode?: PermissionMode;
  settings?: CoreSettings;
  host?: AgentHost;
  extraAllow?: string[];
  extraDeny?: string[];
  journal?: boolean;
  journalDir?: string;
  getModelLabel?: (modelId: string, thinking: boolean) => string;
  /** Approval / question UI. Called once per unresolved ask. */
  onAsk: (task: AgentTask, message: UiMessage) => Promise<AskResponse>;
  onMessage?: (task: AgentTask, message: UiMessage) => void;
  onEvent?: (task: AgentTask, event: CoreEvent) => void;
  onRemoveMessage?: (task: AgentTask, id: string) => void;
  log?: (line: string) => void;
  home?: string;
  trustProjectHooks?: boolean;
  /** 3.3: MCP servers (core/mcp.ts McpRegistry). Omit to run without MCP. */
  mcp?: McpToolProvider;
}

export interface RunResult {
  taskId: string;
  status: string;
  result?: string;
  lastText?: string;
  verification: VerificationReport;
  requests: number;
  journal?: string;
}

export class CoreSession {
  readonly settings: CoreSettings;
  root?: AgentTask;
  permissionMode: PermissionMode;
  selection: ModelSelection;
  private readonly tasks = new Map<string, AgentTask>();
  private readonly journals = new Map<string, SessionJournal>();
  private readonly handledAsks = new Set<string>();
  private readonly tracker: VerificationTracker;
  private readonly agents: SubagentDefinition[];
  private readonly host: AgentHost;
  private readonly editsByTask = new Map<string, number>();

  constructor(private readonly options: CoreSessionOptions) {
    this.settings = options.settings || loadSettings(options.cwd, { home: options.home, trustProjectHooks: options.trustProjectHooks });
    this.permissionMode = options.permissionMode || this.settings.permissions.defaultMode;
    this.selection = { ...options.selection };
    this.host = options.host || new NodeAgentHost(options.cwd, this.settings.env);
    this.agents = loadSubagents(options.cwd, options.home);
    this.tracker = new VerificationTracker(this.settings.verify.command ? [this.settings.verify.command] : []);
  }

  get subagents(): SubagentDefinition[] {
    return this.agents;
  }

  get currentTask(): AgentTask | undefined {
    return this.root;
  }

  journalPath(taskId: string): string | undefined {
    return this.journals.get(taskId)?.logPath;
  }

  createTask(options: { mode: string; parentId?: string; restore?: PersistedTask; agent?: SubagentDefinition }): AgentTask {
    const agent = options.agent;
    const gate = new CoreGate({
      cwd: this.options.cwd,
      settings: this.settings,
      permissionMode: () => this.permissionMode,
      extraAllow: this.options.extraAllow,
      extraDeny: this.options.extraDeny,
      toolAllowList: agent?.tools,
      extraContext: agent
        ? options.parentId
          ? `# You are the "${agent.name}" subagent\n${agent.prompt}\n\nWork only on the brief you were given and finish with attempt_completion: a concise report the parent agent can act on.`
          : `# You are the "${agent.name}" agent\n${agent.prompt}\n\nThe user started this task with the "${agent.name}" agent. Follow the instructions above and finish with attempt_completion.`
        : undefined,
      includeAgents: !options.parentId,
      transcriptPath: (id) => this.journalPath(id),
      runCommand: (command, cwd, run) => this.host.runCommand(command, cwd, run),
      hasEdits: (id) => (this.editsByTask.get(id) || 0) > 0 || (id === this.root?.id && this.tracker.report().editedFiles.length > 0),
      onEvent: (id, event) => {
        const owner = this.tasks.get(id);
        if (owner) this.handleEvent(owner, event);
      },
      log: this.options.log,
      home: this.options.home,
    });
    const selection = () => {
      if (agent?.model) {
        return { ...this.selection, baseModelId: agent.model };
      }
      return this.selection;
    };
    const task = new AgentTask({
      host: this.host,
      provider: this.options.provider,
      getSettings: () => this.options.agentSettings,
      getSelection: selection,
      getModelLabel: this.options.getModelLabel || ((modelId) => modelId),
      mode: options.mode,
      parentId: options.parentId,
      restore: options.restore,
      gate,
      isSubtaskTarget: (slug) => this.agents.some((entry) => entry.name === slug),
      readBatchSize: () => this.settings.readBatchSize,
      mcp: this.options.mcp,
      callbacks: {
        onMessage: (owner, message) => {
          this.options.onMessage?.(owner, message);
          if (message.ask && !message.ask.resolved && !this.handledAsks.has(message.id)) {
            this.handledAsks.add(message.id);
            void this.options.onAsk(owner, message).then((response) => owner.respond(message.id, response));
          }
        },
        onRemoveMessage: (owner, id) => this.options.onRemoveMessage?.(owner, id),
        onState: () => undefined,
        onEvent: (owner, event) => this.handleEvent(owner, event),
        startSubtask: (parent, mode, message, todos) => this.runSubtask(parent, mode, message, todos),
        persist: (owner) => this.snapshot(owner),
        onCompleted: (owner) => this.snapshot(owner),
      },
    });
    this.tasks.set(task.id, task);
    if (this.options.journal !== false) {
      this.journals.set(task.id, new SessionJournal(task.id, this.options.journalDir || sessionsDir()));
    }
    return task;
  }

  private handleEvent(task: AgentTask, event: CoreEvent): void {
    this.journals.get(task.id)?.append(event);
    if (task === this.root) {
      this.tracker.observe(event);
    } else if (event.type === 'file_edit' || event.type === 'command_end') {
      // Subtask edits and checks count for the root task's verification.
      this.tracker.observe(event);
    }
    if (event.type === 'file_edit') {
      this.editsByTask.set(task.id, (this.editsByTask.get(task.id) || 0) + 1);
    }
    if (event.type === 'tool_end' || event.type === 'request_end') {
      this.snapshot(task);
    }
    this.options.onEvent?.(task, event);
  }

  private snapshot(task: AgentTask): void {
    try {
      this.journals.get(task.id)?.snapshot(task.toJSON());
    } catch (error) {
      this.options.log?.(`Could not write the session snapshot: ${(error as Error).message}`);
    }
  }

  private async runSubtask(parent: AgentTask, mode: string, message: string, todos: TodoItem[]): Promise<string> {
    const agent = this.agents.find((entry) => entry.name === mode);
    const child = this.createTask({ mode: agent ? agent.mode : mode, parentId: parent.id, agent });
    child.todos = todos;
    child.title = `${agent ? agent.name : mode}: ${message.replace(/\s+/g, ' ').slice(0, 100)}`;
    await child.start(message);
    this.snapshot(child);
    if (child.completionResult !== undefined) {
      return child.completionResult;
    }
    const lastText = [...child.uiMessages].reverse().find((entry) => entry.type === 'text' && entry.text)?.text;
    return `The subtask ended without attempt_completion (state: ${child.status.state}).${lastText ? ` Its last message:\n${lastText}` : ''}`;
  }

  async run(prompt: string): Promise<RunResult> {
    const rootAgent = this.options.agent ? this.agents.find((entry) => entry.name === this.options.agent) : undefined;
    if (this.options.agent && !rootAgent) {
      this.options.log?.(`Subagent '${this.options.agent}' is not installed; running in ${this.options.mode || 'code'} mode (pcode agents add ${this.options.agent}).`);
    }
    const task = this.root || this.createTask({ mode: rootAgent ? rootAgent.mode : this.options.mode || 'code', agent: rootAgent });
    this.root = task;
    if (task.uiMessages.length === 0) {
      await task.start(prompt);
    } else {
      await task.submitUserMessage(prompt);
    }
    return this.finish(task);
  }

  /** Resumes a saved session (CLI or extension). `ref` = id, unique prefix or "latest". */
  async resume(ref: string, prompt?: string): Promise<RunResult> {
    const dir = this.options.journalDir || sessionsDir();
    const found = findSession(ref, { dir, workspace: this.options.cwd });
    if (!found) {
      throw new Error(ref === 'latest' ? `No saved session for ${this.options.cwd}.` : `Session '${ref}' not found.`);
    }
    const snapshot = SessionJournal.loadSnapshot(found.id, dir);
    if (!snapshot) {
      throw new Error(`Session '${found.id}' has no readable snapshot.`);
    }
    const task = this.createTask({ mode: snapshot.mode, restore: snapshot });
    this.root = task;
    const work = detectInterruptedWork(SessionJournal.events(found.id, dir));
    task.markResumed();
    if (work.unknownCommands.length > 0 || work.unfinishedTools.length > 0) {
      task.addNote(resumeNote(work));
      this.options.log?.(resumeNote(work));
    }
    await task.submitUserMessage(prompt || 'Continue the task from where it stopped. If it was already complete, say so briefly.');
    return this.finish(task);
  }

  /** Compacts the root task transcript with the current model. */
  async compact(focus?: string): Promise<{ before: number; after: number }> {
    const task = this.root;
    if (!task || task.isBusy) {
      throw new Error(task ? 'The task is running; compact it when it is idle.' : 'Nothing to compact yet.');
    }
    const compacted = await compactMessages({ provider: this.options.provider, selection: this.selection, messages: task.apiMessages, focus });
    task.replaceHistory(compacted.messages);
    this.handleEvent(task, { type: 'compacted', before: compacted.before, after: compacted.after });
    return { before: compacted.before, after: compacted.after };
  }

  verification(): VerificationReport {
    return this.tracker.report();
  }

  private finish(task: AgentTask): RunResult {
    const verification = this.tracker.report();
    this.handleEvent(task, { type: 'verification', status: verification.status, detail: verification.detail });
    this.snapshot(task);
    const lastText = [...task.uiMessages].reverse().find((entry) => entry.type === 'text' && entry.text)?.text;
    return {
      taskId: task.id,
      status: task.status.state,
      result: task.completionResult,
      lastText,
      verification,
      requests: task.status.requestCount,
      journal: this.journalPath(task.id),
    };
  }

  abort(): void {
    for (const task of this.tasks.values()) {
      if (task.isBusy || task.status.state === 'waiting') task.abort();
    }
  }

  static isKnownMode(slug: string): boolean {
    return MODES.some((mode) => mode.slug === slug);
  }
}
