import * as fs from 'fs';
import * as path from 'path';
import { applyDiff, detectCodeOmission, diffStats, lineDiff } from './diffEngine';
import { editAllowedForPath, getModeBySlug, isToolAllowedForMode, MODES, ModeConfig } from './modes';
import {
  ApiMessage,
  buildFollowUpPrompt,
  buildFullPrompt,
  buildSystemPrompt,
  formatEnvironmentDetails,
  formatToolResult,
  loadWorkspaceRules,
  NO_TOOL_USED_REMINDER,
  truncateMiddle,
} from './prompts';
import {
  formatTodos,
  ParsedToolUse,
  parseAssistantMessage,
  parseFollowUpSuggestions,
  parseTodos,
  stripWrappingFence,
  TodoItem,
} from './toolParser';
import {
  AgentHost,
  globFilesTool,
  insertContent,
  isCommandAutoApproved,
  isInsideWorkspace,
  listCodeDefinitionsTool,
  listFilesTool,
  readFileTool,
  resolveWorkspacePath,
  searchAndReplaceContent,
  searchFilesTool,
  SearchReplaceOperation,
  toPosixRelative,
  truncateOutput,
  webFetchTool,
} from './tools';
import type { CompletionRequest, CompletionResult, ThreadState } from './transport';
import type { CoreEvent, GateContext, GateVerdict, ToolGate } from '../core/types';
import { EDIT_TOOLS, READ_TOOLS } from '../core/types';
import {
  AgentSettings,
  AskKind,
  CheckpointRecord,
  ModelSelection,
  PersistedTask,
  TaskStatus,
  ToolInfo,
  UiMessage,
} from './types';

export interface CompletionProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/** MCP resource entry as shown to the model. */
export interface McpResourceSummary {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * What the agent loop needs from MCP (implemented by core/mcp.ts McpRegistry). Kept as a narrow
 * interface so tests can stub it and the agent does not depend on transport details.
 */
export interface McpToolProvider {
  /** Any server configured (connected or not). When false the MCP tools are hidden from the model. */
  hasServers(): boolean;
  /** Connects servers that were not tried yet. Errors are recorded per server, never thrown. */
  ensureConnected(): Promise<void>;
  /** System prompt section listing connected servers, tools and resources ("" when none). */
  formatSystemPromptSection(): string;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  readResource(server: string, uri: string): Promise<string>;
  listResources(server?: string): Promise<McpResourceSummary[]>;
}

export interface AskResponse {
  response: 'yes' | 'no' | 'message';
  text?: string;
  images?: string[];
}

export interface TaskCallbacks {
  onMessage(task: AgentTask, message: UiMessage): void;
  onState(task: AgentTask): void;
  onRemoveMessage?(task: AgentTask, messageId: string): void;
  onModeChanged?(task: AgentTask, mode: string): void;
  /** Runs a child task to completion and resolves with its result text. */
  startSubtask?(parent: AgentTask, mode: string, message: string, todos: TodoItem[]): Promise<string>;
  onCompleted?(task: AgentTask, result: string): void;
  persist?(task: AgentTask): void;
  /** Called after a file was changed so the editor can reveal it. */
  onFileEdited?(absPath: string): void;
  /** Structured 3.0 core events (journal, verification, CLI output). */
  onEvent?(task: AgentTask, event: CoreEvent): void;
}

export interface TaskOptions {
  id?: string;
  host: AgentHost;
  provider: CompletionProvider;
  getSettings: () => AgentSettings;
  getSelection: () => ModelSelection;
  getModelLabel: (modelId: string, thinking: boolean) => string;
  callbacks: TaskCallbacks;
  mode: string;
  parentId?: string;
  restore?: PersistedTask;
  /** 3.0 policy engine: permission rules, modes, hooks, verify-before-done. */
  gate?: ToolGate;
  /** Accept new_task targets that are not built-in modes (file based subagents). */
  isSubtaskTarget?: (slug: string) => boolean;
  /** Maximum read-only tool calls executed from one answer (default 1 = 2.x behaviour). */
  readBatchSize?: () => number;
  /** 3.3: Model Context Protocol servers available to this task. */
  mcp?: McpToolProvider;
}

let idCounter = 0;
export function makeId(prefix = 'm'): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const MAX_CONSECUTIVE_MISTAKES = 3;

export class AgentTask {
  readonly id: string;
  readonly parentId?: string;
  readonly createdAt: number;
  title = '';
  mode: string;
  apiMessages: ApiMessage[] = [];
  uiMessages: UiMessage[] = [];
  todos: TodoItem[] = [];
  checkpoints: CheckpointRecord[] = [];
  thread?: ThreadState;
  status: TaskStatus = { state: 'idle', requestCount: 0 };
  completionResult?: string;
  lastModelId?: string;

  private abortController = new AbortController();
  private pendingAsk?: { id: string; kind: AskKind; resolve: (response: AskResponse) => void };
  private consecutiveMistakes = 0;
  private didAutoMistakeRecovery = false;
  private consecutiveNoTool = 0;
  private apiRetries = 0;
  private looping = false;
  private requestsSinceLimitPrompt = 0;
  private checkpointSeq = 0;
  private completionResolvers: Array<(result: string) => void> = [];
  private rulesCache?: { mode: string; text: string };
  private didEditFile = false;
  /** Verdict of the gate for the tool that is currently executing. */
  private gateVerdict?: GateVerdict;
  private stopAttempts = 0;

  constructor(private readonly options: TaskOptions) {
    const restore = options.restore;
    this.id = restore?.id || options.id || makeId('t');
    this.parentId = restore?.parentId || options.parentId;
    this.createdAt = restore?.createdAt || Date.now();
    this.mode = restore?.mode || options.mode;
    if (restore) {
      this.title = restore.title;
      this.apiMessages = restore.apiMessages;
      this.uiMessages = restore.uiMessages.map((message) => ({ ...message, partial: false }));
      this.todos = restore.todos;
      this.checkpoints = restore.checkpoints;
      this.thread = restore.thread;
      this.completionResult = restore.completionResult;
      this.lastModelId = restore.modelId;
      this.status = {
        state: restore.status === 'running' || restore.status === 'waiting' ? 'idle' : restore.status,
        requestCount: restore.requestCount,
      };
      this.checkpointSeq = this.checkpoints.reduce((max, record) => Math.max(max, record.seq), 0);
      // Unresolved asks from a previous session cannot be answered any more.
      this.uiMessages.forEach((message) => {
        if (message.ask && !message.ask.resolved) {
          message.ask.resolved = true;
          message.status = message.status === 'pending' ? 'rejected' : message.status;
        }
        if (message.command?.running) {
          message.command.running = false;
        }
      });
    }
  }

  get modeConfig(): ModeConfig {
    return getModeBySlug(this.mode);
  }

  get isBusy(): boolean {
    return this.looping;
  }

  /** Resolves when the task finishes with attempt_completion (used by parent tasks). */
  waitForCompletion(): Promise<string> {
    if (this.status.state === 'completed' && this.completionResult !== undefined) {
      return Promise.resolve(this.completionResult);
    }
    return new Promise((resolve) => this.completionResolvers.push(resolve));
  }

  // ---------------------------------------------------------------------------------------------
  // Public API used by the controller
  // ---------------------------------------------------------------------------------------------

  async start(text: string, images: string[] = []): Promise<void> {
    this.title = this.title || text.replace(/\s+/g, ' ').trim().slice(0, 140);
    this.emitEvent({ type: 'session_start', mode: this.mode, cwd: this.options.host.cwd, resumed: false });
    this.say({ type: 'user', text, images });
    const extra = await this.checkPrompt(text);
    if (extra === null) {
      return;
    }
    const content = await this.withEnvironment(`<task>\n${text}\n</task>${extra}`, true);
    this.apiMessages.push({ role: 'user', content, ts: Date.now() });
    await this.loop();
  }

  /** Text typed by the user in the chat box while this task is current. */
  async submitUserMessage(text: string, images: string[] = []): Promise<void> {
    if (this.pendingAsk) {
      this.respond(this.pendingAsk.id, { response: 'message', text, images });
      return;
    }
    if (this.looping) {
      return;
    }
    this.say({ type: 'user', text, images });
    if (this.status.state === 'aborted' || this.status.state === 'error' || this.status.state === 'completed') {
      this.abortController = new AbortController();
    }
    this.consecutiveMistakes = 0;
    const extra = await this.checkPrompt(text);
    if (extra === null) {
      return;
    }
    const content = await this.withEnvironment(`<user_message>\n${text}\n</user_message>${extra}`, false);
    this.apiMessages.push({ role: 'user', content, ts: Date.now() });
    await this.loop();
  }

  respond(askId: string, response: AskResponse): void {
    if (!this.pendingAsk || this.pendingAsk.id !== askId) {
      return;
    }
    const pending = this.pendingAsk;
    this.pendingAsk = undefined;
    const message = this.uiMessages.find((entry) => entry.id === askId);
    if (message?.ask) {
      message.ask.resolved = true;
      message.ask.response = response.response;
      if (message.status === 'pending') {
        message.status = response.response === 'no' ? 'rejected' : 'approved';
      }
      this.emit(message);
    }
    if (response.response === 'message' && response.text) {
      this.say({ type: 'user', text: response.text, images: response.images });
    }
    this.setState('running');
    pending.resolve(response);
  }

  /**
   * Re-evaluates a waiting approval prompt when auto-approve settings, allowed commands,
   * or permission mode change while a task is waiting on user confirmation.
   */
  recheckPendingApproval(): void {
    if (!this.pendingAsk) {
      return;
    }
    const settings = this.options.getSettings();
    if (!settings.autoApprove.enabled) {
      return;
    }
    const pending = this.pendingAsk;
    const message = this.uiMessages.find((entry) => entry.id === pending.id);
    if (!message) {
      return;
    }
    let shouldApprove = false;
    if (pending.kind === 'command' && message.command?.command) {
      shouldApprove =
        settings.autoApprove.execute
        && isCommandAutoApproved(message.command.command, settings.allowedCommands, settings.deniedCommands);
    } else if (pending.kind === 'mode_switch') {
      shouldApprove = settings.autoApprove.modeSwitch;
    } else if (pending.kind === 'new_task') {
      shouldApprove = settings.autoApprove.subtasks;
    } else if (pending.kind === 'tool' && message.tool) {
      const outside = Boolean(message.tool.outsideWorkspace);
      if (READ_TOOLS.has(message.tool.name)) {
        shouldApprove = outside ? settings.autoApprove.readOutsideWorkspace : settings.autoApprove.read;
      } else if (EDIT_TOOLS.has(message.tool.name)) {
        shouldApprove = settings.autoApprove.write && (!outside || settings.autoApprove.readOutsideWorkspace);
      }
    }
    if (shouldApprove) {
      if (message.ask) {
        message.ask.autoApproved = true;
      }
      this.respond(pending.id, { response: 'yes' });
    }
  }

  abort(): void {
    this.abortController.abort();
    if (this.pendingAsk) {
      const pending = this.pendingAsk;
      this.pendingAsk = undefined;
      const message = this.uiMessages.find((entry) => entry.id === pending.id);
      if (message?.ask) {
        message.ask.resolved = true;
        if (message.status === 'pending') {
          message.status = 'rejected';
        }
        this.emit(message);
      }
      pending.resolve({ response: 'no' });
    }
    this.uiMessages.filter((message) => message.partial).forEach((message) => {
      message.partial = false;
      this.emit(message);
    });
    this.setState('aborted');
  }

  async restoreCheckpoint(seq: number): Promise<number> {
    const records = this.checkpoints.filter((record) => record.seq >= seq).sort((a, b) => b.seq - a.seq);
    let restored = 0;
    for (const record of records) {
      try {
        if (record.before === null) {
          if (this.options.host.deleteFile) {
            await this.options.host.deleteFile(record.path);
          } else {
            await fs.promises.rm(record.path, { force: true });
          }
        } else {
          await this.options.host.writeFile(record.path, record.before);
        }
        restored += 1;
      } catch (error) {
        this.say({ type: 'error', text: `Could not restore ${toPosixRelative(this.options.host.cwd, record.path)}: ${(error as Error).message}` });
      }
    }
    this.checkpoints = this.checkpoints.filter((record) => record.seq < seq);
    this.uiMessages.forEach((message) => {
      if (message.type === 'checkpoint' && message.checkpoint && message.checkpoint.seq >= seq) {
        message.checkpoint.restored = true;
        this.emit(message);
      }
    });
    this.thread = undefined;
    const note = `[Files were restored to checkpoint #${seq} by the user. ${restored} file change(s) were reverted. Re-read files before editing them again.]`;
    this.apiMessages.push({ role: 'user', content: note, ts: Date.now() });
    this.apiMessages.push({ role: 'assistant', content: 'Understood. I will re-read the files before making further changes.', ts: Date.now() });
    this.say({ type: 'info', text: `Restored ${restored} file change(s) to checkpoint #${seq}.` });
    this.options.callbacks.persist?.(this);
    return restored;
  }

  setMode(mode: string): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.thread = undefined;
    this.rulesCache = undefined;
    this.emitEvent({ type: 'mode', mode });
    this.options.callbacks.onModeChanged?.(this, mode);
    this.options.callbacks.persist?.(this);
  }

  toJSON(): PersistedTask {
    let checkpointBudget = 20_000_000;
    const checkpoints = [...this.checkpoints].reverse().filter((record) => {
      checkpointBudget -= (record.before || '').length;
      return checkpointBudget > 0;
    }).reverse();
    return {
      version: 1,
      id: this.id,
      parentId: this.parentId,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      title: this.title,
      workspace: this.options.host.cwd,
      mode: this.mode,
      modelId: this.lastModelId,
      apiMessages: this.apiMessages,
      uiMessages: this.uiMessages,
      todos: this.todos,
      thread: this.thread,
      checkpoints,
      status: this.status.askKind === 'completion_result' ? 'completed' : this.status.state,
      requestCount: this.status.requestCount,
      completionResult: this.completionResult,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Agent loop
  // ---------------------------------------------------------------------------------------------

  private async loop(): Promise<void> {
    if (this.looping) {
      return;
    }
    this.looping = true;
    this.setState('running');
    try {
      while (!this.abortController.signal.aborted) {
        const settings = this.options.getSettings();
        if (this.requestsSinceLimitPrompt >= settings.maxRequests) {
          const answer = await this.ask('request_limit', {
            type: 'info',
            text: `The task has made ${this.requestsSinceLimitPrompt} requests in a row. Continue?`,
          });
          if (answer.response === 'no') {
            this.setState('idle');
            return;
          }
          this.requestsSinceLimitPrompt = 0;
          if (answer.response === 'message' && answer.text) {
            this.apiMessages.push({ role: 'user', content: `<user_message>\n${answer.text}\n</user_message>`, ts: Date.now() });
          }
        }

        const result = await this.request(settings);
        if (!result) {
          return; // aborted or the user gave up after an API failure
        }

        const outcome = await this.handleAssistantResponse(result, settings);
        if (outcome === 'stop') {
          return;
        }
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        this.say({ type: 'error', text: (error as Error).message || String(error) });
        this.setState('error');
      }
    } finally {
      this.looping = false;
      if (this.status.state === 'running') {
        this.setState('idle');
      }
      this.options.callbacks.persist?.(this);
    }
  }

  private async request(settings: AgentSettings): Promise<CompletionResult | undefined> {
    while (!this.abortController.signal.aborted) {
      const selection = this.options.getSelection();
      const mode = this.modeConfig;
      const webSearch = selection.webSearch !== undefined
        ? selection.webSearch
        : settings.webSearch === 'always' ? true : settings.webSearch === 'never' ? false : mode.webSearchDefault;
      const rules = await this.getRules();
      const mcpSection = await this.mcpSection();
      const systemPrompt = buildSystemPrompt({
        mode,
        cwd: this.options.host.cwd,
        settings: {
          customInstructions: settings.customInstructions,
          modeInstructions: settings.modeInstructions,
          language: settings.language,
          maxPromptChars: settings.maxPromptChars,
          diffEnabled: settings.diffEnabled,
        },
        rules,
        webSearch,
        mcpSection,
      });
      const full = buildFullPrompt(systemPrompt, this.apiMessages, settings.maxPromptChars);
      const latest = this.apiMessages[this.apiMessages.length - 1];
      const allowThread = settings.contextStrategy === 'thread'
        || (settings.contextStrategy === 'auto' && full.droppedMessages > 0);
      const followUpPrompt = allowThread && this.thread && latest?.role === 'user'
        ? buildFollowUpPrompt(latest, `Current mode: ${mode.slug}.`)
        : undefined;

      const startedAt = Date.now();
      const reqMessage = this.say({
        type: 'api_req',
        text: this.options.getModelLabel(selection.baseModelId, selection.thinking),
        partial: true,
        meta: {},
      });
      let streamMessage: UiMessage | undefined;
      let reasoningMessage: UiMessage | undefined;
      let lastEmit = 0;

      const onText = (fullText: string) => {
        if (fullText === '') {
          if (streamMessage) {
            streamMessage.text = '';
            this.emit(streamMessage);
          }
          return;
        }
        const now = Date.now();
        if (now - lastEmit < 80) {
          return;
        }
        lastEmit = now;
        const parsed = parseAssistantMessage(fullText, { partial: true });
        if (parsed.reasoning) {
          reasoningMessage = reasoningMessage || this.say({ type: 'reasoning', text: '', partial: true });
          reasoningMessage.text = parsed.reasoning;
          this.emit(reasoningMessage);
        }
        const preview = parsed.text + (parsed.tool ? `\n\n_${toolActivityLabel(parsed.tool.name)}…_` : '');
        if (preview.trim()) {
          streamMessage = streamMessage || this.say({ type: 'text', text: '', partial: true });
          streamMessage.text = preview;
          this.emit(streamMessage);
        }
      };

      this.emitEvent({ type: 'request_start', model: selection.baseModelId });
      try {
        const result = await this.options.provider.complete({
          fullPrompt: full.prompt,
          followUpPrompt,
          thread: this.thread,
          baseModelId: selection.baseModelId,
          thinking: selection.thinking,
          computeMode: selection.computeMode,
          webSearch,
          signal: this.abortController.signal,
          onText,
          onInfo: (text) => this.say({ type: 'info', text }),
          onAccount: (account, model) => {
            reqMessage.meta = { ...reqMessage.meta, account, model };
            reqMessage.text = model;
            this.emit(reqMessage);
          },
        });
        this.status.requestCount += 1;
        this.apiRetries = 0;
        this.requestsSinceLimitPrompt += 1;
        this.lastModelId = selection.baseModelId;
        this.thread = result.thread || this.thread;
        reqMessage.partial = false;
        reqMessage.meta = {
          ...reqMessage.meta,
          model: result.modelLabel,
          account: result.accountAlias,
          citations: result.citations.slice(0, 20),
          promptChars: result.promptChars,
          followUp: result.usedFollowUp,
          durationMs: Date.now() - startedAt,
        };
        reqMessage.text = result.modelLabel;
        this.emit(reqMessage);
        this.emitEvent({ type: 'request_end', model: result.modelLabel, account: result.accountAlias, promptChars: result.promptChars, durationMs: Date.now() - startedAt, followUp: result.usedFollowUp, ok: true });
        // The streamed preview is replaced by the final parsed content.
        this.removeMessage(streamMessage);
        this.removeMessage(reasoningMessage);
        return result;
      } catch (error) {
        this.removeMessage(streamMessage);
        this.removeMessage(reasoningMessage);
        reqMessage.partial = false;
        this.emit(reqMessage);
        const typed = error as Error & { kind?: string };
        this.emitEvent({ type: 'request_end', model: selection.baseModelId, promptChars: full.prompt.length, durationMs: Date.now() - startedAt, followUp: Boolean(followUpPrompt), ok: false, error: typed.message });
        if (this.abortController.signal.aborted || typed.kind === 'aborted') {
          this.removeMessage(reqMessage);
          return undefined;
        }
        reqMessage.status = 'error';
        this.emit(reqMessage);
        if (settings.autoApprove.enabled && settings.autoApprove.retry && typed.kind !== 'no_account' && this.apiRetries < 4) {
          this.apiRetries += 1;
          const retryDelayMs = Math.min(5000, 1500 * this.apiRetries);
          this.say({ type: 'info', text: `Request failed: ${typed.message}. Retrying (${this.apiRetries}/4)…` });
          await delay(retryDelayMs, this.abortController.signal);
          continue;
        }
        const answer = await this.ask('api_failed', { type: 'error', text: typed.message || 'Request failed.' });
        if (answer.response === 'no') {
          this.setState('error');
          return undefined;
        }
        if (answer.response === 'message' && answer.text) {
          this.apiMessages.push({ role: 'user', content: `<user_message>\n${answer.text}\n</user_message>`, ts: Date.now() });
        }
      }
    }
    return undefined;
  }

  private async handleAssistantResponse(result: CompletionResult, settings: AgentSettings): Promise<'continue' | 'stop'> {
    const parsed = parseAssistantMessage(result.text);
    if (parsed.reasoning) {
      this.say({ type: 'reasoning', text: parsed.reasoning });
    }
    if (parsed.text) {
      this.say({ type: 'text', text: parsed.text, meta: { citations: result.citations.slice(0, 20) } });
    }

    const tool = parsed.tool;
    const batchLimit = Math.max(1, this.options.readBatchSize?.() ?? 1);
    const batch = tool && !tool.partial && READ_TOOLS.has(tool.name) && batchLimit > 1
      ? (parsed.readBatch || []).slice(0, batchLimit - 1)
      : [];
    // Store a normalized assistant message: prose + the executed tool call(s).
    const source = parsed.source ?? result.text;
    const assistantContent = tool
      ? `${parsed.text ? `${parsed.text}\n\n` : ''}${[tool, ...batch].map((entry) => source.slice(entry.start, entry.end)).join('\n')}`
      : result.text.trim();
    this.apiMessages.push({ role: 'assistant', content: assistantContent, ts: Date.now() });
    this.emitEvent({ type: 'assistant', text: parsed.text.slice(0, 4000), tools: tool ? [tool, ...batch].map((entry) => entry.name) : [] });

    if (!tool) {
      return this.handleNoTool(parsed.text);
    }
    this.consecutiveNoTool = 0;

    if (tool.partial) {
      this.consecutiveMistakes += 1;
      return this.pushToolError(tool.name, 'The tool call was cut off before its closing tag. Send the complete tool call again (for large files, split the change into several apply_diff / insert_content calls).', settings);
    }

    if (!isToolAllowedForMode(tool.name, this.modeConfig)) {
      this.consecutiveMistakes += 1;
      return this.pushToolError(tool.name, `Tool '${tool.name}' is not available in ${this.modeConfig.name} mode. Use switch_mode to change to a mode that allows it, or use another tool.`, settings);
    }

    const result_ = await this.executeGated(tool, settings);
    if (result_ === 'stop') {
      return 'stop';
    }
    // Batched read-only calls: results are merged into one USER message, in order.
    for (const extra of batch) {
      if (this.abortController.signal.aborted) {
        return 'stop';
      }
      const before = this.apiMessages.length;
      const outcome = await this.executeGated(extra, settings);
      const added = this.apiMessages.splice(before);
      if (added.length > 0) {
        this.appendToLastUser(`\n\n${added.map((message) => message.content).join('\n\n')}`);
      }
      if (outcome === 'stop') {
        return 'stop';
      }
    }
    const ignored = parsed.ignoredToolCount - batch.length;
    if (ignored > 0) {
      this.appendToLastUser(`\n\n[Note: only ${batch.length > 0 ? `the first ${batch.length + 1} read-only tool calls` : 'the first tool call'} of your message ${batch.length > 0 ? 'were' : 'was'} executed. ${ignored} additional tool call(s) were ignored. Batch only read-only tools (read_file, list_files, search_files, list_code_definition_names, glob_files); use one tool per message otherwise.]`);
    }
    if (this.consecutiveMistakes >= MAX_CONSECUTIVE_MISTAKES) {
      if (settings.autoApprove.enabled && settings.autoApprove.retry && !this.didAutoMistakeRecovery) {
        this.didAutoMistakeRecovery = true;
        this.consecutiveMistakes = 0;
        this.appendToLastUser('\n\n[System recovery: Multiple consecutive tool calls failed. Re-read the target file with read_file to inspect its current contents before editing, verify all required XML parameter tags are closed, and use smaller apply_diff or write_to_file steps.]');
        return 'continue';
      }
      const answer = await this.ask('mistake_limit', {
        type: 'error',
        text: 'The model is having trouble using tools correctly. You can give guidance (for example "read the file first" or "split the change into smaller steps") or try a different model.',
      });
      this.consecutiveMistakes = 0;
      this.didAutoMistakeRecovery = false;
      if (answer.response === 'no') {
        this.setState('idle');
        return 'stop';
      }
      if (answer.response === 'message' && answer.text) {
        this.appendToLastUser(`\n\n<user_message>\n${answer.text}\n</user_message>`);
      }
    }
    return 'continue';
  }

  private async handleNoTool(text: string): Promise<'continue' | 'stop'> {
    const previousUser = [...this.apiMessages].reverse().find((message, index) => index > 0 && message.role === 'user');
    const midTask = Boolean(previousUser && /^\[[a-z_]+( for '.*')?\] Result:/.test(previousUser.content));
    const tail = text.slice(-500);
    const looksUnfinished =
      /(?:^|[^\p{L}\p{N}_])(let me|i will|i'll|i am going to|i'm going to|next,? i|now i|сейчас|теперь|далее|давайте|приступим|перейдем|перейдём|проверю|проверим|исправлю|исправим|обновлю|обновим|создам|создадим|запущу|запустим|добавлю|добавим|выполню|выполним|прочитаю|прочитаем|посмотрю|посмотрим)(?=$|[^\p{L}\p{N}_])/iu.test(tail)
      || /[:…]\s*$/.test(tail.trim())
      || /\.\.\.\s*$/.test(tail.trim())
      || /<(read_file|write_to_file|apply_diff|insert_content|search_and_replace|execute_command|list_files|search_files|list_code_definition_names|glob_files|web_fetch|use_mcp_tool|access_mcp_resource|list_mcp_resources|mcp__[a-z0-9_-]+|update_todo_list|switch_mode|new_task|attempt_completion)\b/i.test(text);
    const hasIncompleteTodos = this.todos.some((todo) => todo.status !== 'completed');
    if (midTask && (looksUnfinished || hasIncompleteTodos) && this.consecutiveNoTool < 2) {
      this.consecutiveNoTool += 1;
      this.apiMessages.push({ role: 'user', content: NO_TOOL_USED_REMINDER, ts: Date.now() });
      return 'continue';
    }
    this.consecutiveNoTool = 0;
    // A plain answer: show it and wait for the user, like a chat reply.
    if (!text.trim()) {
      this.say({ type: 'error', text: 'The model returned an empty response.' });
    }
    this.setState('idle');
    return 'stop';
  }

  private pushToolError(toolName: string, message: string, _settings: AgentSettings): 'continue' {
    this.say({ type: 'error', text: `${toolName}: ${message}` });
    this.apiMessages.push({ role: 'user', content: formatToolResult(toolName, undefined, `[ERROR] ${message}`), ts: Date.now() });
    return 'continue';
  }

  private pushToolResult(toolName: string, detail: string | undefined, result: string, extra?: { images?: string[] }): void {
    const content = formatToolResult(toolName, detail, result);
    void extra;
    this.apiMessages.push({ role: 'user', content, ts: Date.now() });
  }

  private appendToLastUser(text: string): void {
    const last = this.apiMessages[this.apiMessages.length - 1];
    if (last && last.role === 'user') {
      last.content += text;
    }
  }

  get gateContext(): GateContext {
    return { taskId: this.id, parentId: this.parentId, mode: this.mode, cwd: this.options.host.cwd };
  }

  /** Runs one tool through the 3.0 gate: PreToolUse policy/hooks, execution, PostToolUse hooks. */
  private async executeGated(tool: ParsedToolUse, settings: AgentSettings): Promise<'continue' | 'stop'> {
    const gate = this.options.gate;
    this.gateVerdict = undefined;
    if (gate?.preToolUse && tool.name !== 'attempt_completion') {
      const verdict = await gate.preToolUse(this.gateContext, { name: tool.name, params: tool.params });
      if (verdict.stopTask) {
        this.say({ type: 'info', text: `Stopped by hook: ${verdict.reason || 'continue=false'}` });
        this.emitEvent({ type: 'denied', tool: tool.name, reason: verdict.reason || 'stopped', source: verdict.source || 'hook' });
        this.setState('idle');
        return 'stop';
      }
      if (verdict.decision === 'deny') {
        const reason = verdict.reason || 'Denied by policy.';
        this.consecutiveMistakes += 1;
        this.say({ type: 'tool', tool: { name: tool.name, path: tool.params.path, title: `Blocked: ${toolActivityLabel(tool.name)}${tool.params.path ? ` ${tool.params.path}` : tool.params.command ? ` \`${tool.params.command}\`` : ''}`, content: `${reason}${verdict.source ? `\n(${verdict.source})` : ''}` }, status: 'rejected' });
        this.emitEvent({ type: 'denied', tool: tool.name, reason, source: verdict.source || 'policy' });
        this.pushToolResult(tool.name, tool.params.path || tool.params.command, `[DENIED] ${reason}\nDo not retry the same call. Choose another approach or ask the user.`);
        return 'continue';
      }
      this.gateVerdict = verdict;
    }
    this.emitEvent({ type: 'tool_start', tool: tool.name, params: tool.params });
    const before = this.apiMessages.length;
    let outcome: 'continue' | 'stop';
    try {
      outcome = await this.executeTool(tool, settings);
    } finally {
      this.gateVerdict = undefined;
    }
    const resultMessage = this.apiMessages.length > before ? this.apiMessages[this.apiMessages.length - 1] : undefined;
    const output = resultMessage?.role === 'user' ? resultMessage.content : '';
    const isError = /\] Result:\n?\[(ERROR|DENIED)\]/.test(output) || output.includes('The user denied this operation');
    this.emitEvent({ type: 'tool_end', tool: tool.name, ok: !isError, summary: output.slice(0, 300) });
    if (gate?.postToolUse && outcome === 'continue' && resultMessage && !isError && tool.name !== 'attempt_completion') {
      const post = await gate.postToolUse(this.gateContext, { name: tool.name, params: tool.params }, { output, isError });
      if (post.blockReason) {
        this.appendToLastUser(`\n\n[PostToolUse hook feedback — fix this before continuing]\n${post.blockReason}`);
        this.say({ type: 'info', text: `Hook feedback: ${post.blockReason.slice(0, 500)}` });
      }
      if (post.additionalContext) {
        this.appendToLastUser(`\n\n${post.additionalContext}`);
      }
    }
    return outcome;
  }

  private async executeTool(tool: ParsedToolUse, settings: AgentSettings): Promise<'continue' | 'stop'> {
    const params = tool.params;
    const missing = (name: string) => {
      this.consecutiveMistakes += 1;
      this.pushToolError(tool.name, `Missing value for required parameter '${name}'. Please retry with complete parameters.`, settings);
      return 'continue' as const;
    };

    switch (tool.name) {
      case 'read_file':
      case 'list_files':
      case 'search_files':
      case 'list_code_definition_names':
      case 'glob_files':
        return this.runReadTool(tool, settings, missing);
      case 'write_to_file':
      case 'apply_diff':
      case 'insert_content':
      case 'search_and_replace':
        return this.runEditTool(tool, settings, missing);
      case 'execute_command':
        return this.runCommandTool(tool, settings, missing);
      case 'web_fetch':
        return this.runWebFetchTool(tool, settings, missing);
      case 'use_mcp_tool':
      case 'access_mcp_resource':
      case 'list_mcp_resources':
        return this.runMcpTool(tool, settings, missing);
      case 'ask_followup_question': {
        const question = params.question?.trim();
        if (!question) {
          return missing('question');
        }
        const suggestions = parseFollowUpSuggestionsWithMode(params.follow_up);
        const answer = await this.ask('followup', { type: 'followup', text: question, suggestions });
        if (this.abortController.signal.aborted) {
          return 'stop';
        }
        this.consecutiveMistakes = 0;
        const reply = answer.text || (answer.response === 'yes' ? 'Yes' : 'No answer');
        const chosen = suggestions.find((entry) => entry.text === reply);
        if (chosen?.mode && MODES.some((mode) => mode.slug === chosen.mode)) {
          this.setMode(chosen.mode);
        }
        this.pushToolResult(tool.name, undefined, `<answer>\n${reply}\n</answer>`);
        await this.appendEnvironment();
        return 'continue';
      }
      case 'attempt_completion': {
        const resultText = params.result?.trim();
        if (!resultText) {
          return missing('result');
        }
        this.consecutiveMistakes = 0;
        if (this.options.gate?.stop) {
          const stop = await this.options.gate.stop(this.gateContext, resultText, this.stopAttempts);
          if (stop.continueReason && !this.abortController.signal.aborted) {
            this.stopAttempts += 1;
            this.say({ type: 'info', text: `Not done yet: ${stop.continueReason.split('\n')[0].slice(0, 300)}` });
            this.pushToolResult(tool.name, undefined, `[NOT ACCEPTED] ${stop.continueReason}`);
            return 'continue';
          }
        }
        if (this.parentId) {
          this.say({ type: 'completion', text: resultText });
          this.finishCompletion(resultText);
          return 'stop';
        }
        this.completionResult = resultText;
        const answer = await this.ask('completion_result', {
          type: 'completion',
          text: resultText,
          command: params.command ? { command: params.command } : undefined,
        });
        if (this.abortController.signal.aborted) {
          return 'stop';
        }
        if (answer.response === 'message' && answer.text) {
          this.status.state = 'running';
          this.pushToolResult(tool.name, undefined, `The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${answer.text}\n</feedback>`);
          await this.appendEnvironment();
          return 'continue';
        }
        this.finishCompletion(resultText);
        return 'stop';
      }
      case 'switch_mode': {
        const slug = params.mode_slug?.trim();
        if (!slug) {
          return missing('mode_slug');
        }
        const target = MODES.find((mode) => mode.slug === slug);
        if (!target) {
          return this.pushToolError(tool.name, `Unknown mode '${slug}'. Valid modes: ${MODES.map((mode) => mode.slug).join(', ')}.`, settings);
        }
        if (target.slug === this.mode) {
          this.pushToolResult(tool.name, slug, `Already in ${target.name} mode.`);
          return 'continue';
        }
        const approved = await this.approve('mode_switch', settings.autoApprove.modeSwitch, {
          name: tool.name,
          title: `Switch to ${target.name} mode`,
          mode: target.slug,
          reason: params.reason,
        });
        if (approved.response === 'no' || this.abortController.signal.aborted) {
          return this.denied(tool.name, slug, approved.text);
        }
        const from = this.modeConfig.name;
        this.setMode(target.slug);
        this.pushToolResult(tool.name, slug, `Successfully switched from ${from} mode to ${target.name} mode${params.reason ? ` because: ${params.reason}` : ''}.${approved.text ? `\n<feedback>\n${approved.text}\n</feedback>` : ''}`);
        await this.appendEnvironment();
        return 'continue';
      }
      case 'new_task': {
        const modeSlug = params.mode?.trim();
        const message = params.message?.trim();
        if (!modeSlug) {
          return missing('mode');
        }
        if (!message) {
          return missing('message');
        }
        if (!MODES.some((mode) => mode.slug === modeSlug) && !this.options.isSubtaskTarget?.(modeSlug)) {
          return this.pushToolError(tool.name, `Unknown mode or subagent '${modeSlug}'.`, settings);
        }
        if (!this.options.callbacks.startSubtask) {
          return this.pushToolError(tool.name, 'Subtasks are not supported in this context.', settings);
        }
        const approved = await this.approve('new_task', settings.autoApprove.subtasks, {
          name: tool.name,
          title: MODES.some((mode) => mode.slug === modeSlug) ? `New subtask in ${getModeBySlug(modeSlug).name} mode` : `Delegate to subagent ${modeSlug}`,
          mode: modeSlug,
          content: message,
        });
        if (approved.response === 'no' || this.abortController.signal.aborted) {
          return this.denied(tool.name, modeSlug, approved.text);
        }
        const subtaskMessage = this.say({ type: 'subtask', text: message, tool: { name: tool.name, title: MODES.some((mode) => mode.slug === modeSlug) ? getModeBySlug(modeSlug).name : modeSlug, mode: modeSlug }, status: 'running' });
        this.setState('waiting');
        let childResult: string;
        try {
          childResult = await this.options.callbacks.startSubtask(this, modeSlug, message, params.todos ? parseTodos(params.todos) : []);
        } catch (error) {
          subtaskMessage.status = 'error';
          this.emit(subtaskMessage);
          return this.pushToolError(tool.name, `Subtask failed: ${(error as Error).message}`, settings);
        }
        if (this.abortController.signal.aborted) {
          return 'stop';
        }
        this.setState('running');
        subtaskMessage.status = 'done';
        subtaskMessage.tool = { ...subtaskMessage.tool!, content: childResult };
        this.emit(subtaskMessage);
        this.pushToolResult(tool.name, modeSlug, `Subtask completed. Result:\n${childResult}`);
        await this.appendEnvironment();
        return 'continue';
      }
      case 'update_todo_list': {
        const todos = parseTodos(params.todos || '');
        if (todos.length === 0) {
          return this.pushToolError(tool.name, 'The todo list is empty or not a markdown checklist ([ ], [-], [x]).', settings);
        }
        this.todos = todos;
        this.consecutiveMistakes = 0;
        this.options.callbacks.onState(this);
        this.say({ type: 'tool', tool: { name: tool.name, title: 'Updated todo list', content: formatTodos(todos) }, status: 'done' });
        this.pushToolResult(tool.name, undefined, 'Todo list updated successfully.');
        return 'continue';
      }
      default:
        return this.pushToolError(tool.name, `Unknown tool '${tool.name}'.`, settings);
    }
  }

  private async runReadTool(tool: ParsedToolUse, settings: AgentSettings, missing: (name: string) => 'continue'): Promise<'continue' | 'stop'> {
    const params = tool.params;
    const host = this.options.host;
    const relPath = (params.path || '').trim() || (tool.name === 'read_file' ? '' : '.');
    if (!relPath) {
      return missing('path');
    }
    if (tool.name === 'search_files' && !params.regex) {
      return missing('regex');
    }
    if (tool.name === 'glob_files' && !(params.pattern || '').trim()) {
      return missing('pattern');
    }
    const absPath = resolveWorkspacePath(host.cwd, relPath);
    const outside = !isInsideWorkspace(host.cwd, absPath);
    const displayPath = outside ? absPath : toPosixRelative(host.cwd, absPath);
    const startLine = params.start_line ? Number(params.start_line) : undefined;
    const endLine = params.end_line ? Number(params.end_line) : undefined;
    const info: ToolInfo = {
      name: tool.name,
      path: displayPath,
      outsideWorkspace: outside,
      regex: params.regex,
      title: tool.name === 'read_file'
        ? `Read ${displayPath}${startLine || endLine ? ` (lines ${startLine || 1}-${endLine || 'end'})` : ''}`
        : tool.name === 'list_files'
          ? `List files in ${displayPath}${params.recursive === 'true' ? ' (recursive)' : ''}`
          : tool.name === 'search_files'
            ? `Search ${displayPath} for /${params.regex}/${params.file_pattern ? ` in ${params.file_pattern}` : ''}`
            : tool.name === 'glob_files'
              ? `Glob ${params.pattern} in ${displayPath}`
              : `List definitions in ${displayPath}`,
    };
    const autoApproved = settings.autoApprove.read && (!outside || settings.autoApprove.readOutsideWorkspace);
    const approved = await this.approve('tool', autoApproved, info);
    if (approved.response === 'no' || this.abortController.signal.aborted) {
      return this.denied(tool.name, displayPath, approved.text);
    }
    const message = approved.message;
    try {
      let output: string;
      if (tool.name === 'read_file') {
        output = (await readFileTool(host, absPath, { startLine, endLine, maxLines: settings.maxReadLines })).text;
      } else if (tool.name === 'list_files') {
        output = await listFilesTool(host, absPath, params.recursive === 'true');
      } else if (tool.name === 'search_files') {
        output = await searchFilesTool(host, absPath, params.regex!, params.file_pattern, this.abortController.signal);
      } else if (tool.name === 'glob_files') {
        output = await globFilesTool(host, relPath, params.pattern!.trim());
      } else {
        output = await listCodeDefinitionsTool(host, absPath);
      }
      this.consecutiveMistakes = 0;
      message.status = 'done';
      message.tool = { ...message.tool!, content: truncateMiddle(output, 4000) };
      this.emit(message);
      this.pushToolResult(tool.name, displayPath, `${truncateMiddle(output, Math.max(20_000, Math.floor(settings.maxPromptChars * 0.5)))}${approved.text ? `\n\n<feedback>\n${approved.text}\n</feedback>` : ''}`);
    } catch (error) {
      this.consecutiveMistakes += 1;
      message.status = 'error';
      message.tool = { ...message.tool!, content: (error as Error).message };
      this.emit(message);
      this.pushToolResult(tool.name, displayPath, `[ERROR] ${(error as Error).message}`);
    }
    return 'continue';
  }

  private async runEditTool(tool: ParsedToolUse, settings: AgentSettings, missing: (name: string) => 'continue'): Promise<'continue' | 'stop'> {
    const params = tool.params;
    const host = this.options.host;
    const relPath = (params.path || '').trim();
    if (!relPath) {
      return missing('path');
    }
    const absPath = resolveWorkspacePath(host.cwd, relPath);
    const outside = !isInsideWorkspace(host.cwd, absPath);
    const displayPath = outside ? absPath : toPosixRelative(host.cwd, absPath);
    if (!editAllowedForPath(this.modeConfig, displayPath)) {
      this.consecutiveMistakes += 1;
      return this.pushToolError(tool.name, `${this.modeConfig.name} mode cannot edit '${displayPath}'. Allowed: ${this.modeConfig.groups.map((entry) => (Array.isArray(entry) ? `${entry[0]} (${entry[1].description || entry[1].fileRegex})` : entry)).join(', ')}. Use switch_mode to change mode.`, settings);
    }

    let original: string | null = null;
    try {
      original = await host.readFile(absPath);
    } catch {
      original = null;
    }

    let next: string;
    if (tool.name === 'write_to_file') {
      if (params.content === undefined) {
        return missing('content');
      }
      next = stripWrappingFence(params.content);
      next = next.replace(/^\n/, '');
      if (/^\s*\d+ \| /.test(next) && next.split('\n').every((line) => !line.trim() || /^\s*\d+ \| /.test(line))) {
        next = next.split('\n').map((line) => line.replace(/^\s*\d+ \| /, '')).join('\n');
      }
      if (original !== null && original.endsWith('\n') && !next.endsWith('\n')) {
        next += '\n';
      } else if (original === null && next.length > 0 && !next.endsWith('\n')) {
        next += '\n';
      }
      if (original !== null && detectCodeOmission(original, next)) {
        this.consecutiveMistakes += 1;
        return this.pushToolError(tool.name, 'The content contains a placeholder such as "// rest of code unchanged". write_to_file requires the COMPLETE file. Provide the full content, or use apply_diff for targeted edits.', settings);
      }
      const expected = params.line_count ? Number(params.line_count) : undefined;
      const actualLines = next.replace(/\n$/, '').split('\n').length;
      if (expected && expected > 50 && actualLines < expected * 0.7) {
        this.consecutiveMistakes += 1;
        return this.pushToolError(tool.name, `The content looks truncated: line_count says ${expected} but only ${actualLines} lines were received. Split the file into smaller edits (write a smaller file, then use insert_content / apply_diff).`, settings);
      }
    } else if (tool.name === 'apply_diff') {
      if (!params.diff) {
        return missing('diff');
      }
      if (original === null) {
        this.consecutiveMistakes += 1;
        return this.pushToolError(tool.name, `File '${displayPath}' does not exist. Use write_to_file to create it.`, settings);
      }
      const applied = applyDiff(original, stripWrappingFence(params.diff));
      if (!applied.content) {
        this.consecutiveMistakes += 1;
        const failureMessage = this.say({ type: 'tool', tool: { name: tool.name, path: displayPath, title: `Edit failed: ${displayPath}`, content: applied.failures.join('\n') }, status: 'error' });
        void failureMessage;
        this.pushToolResult(tool.name, displayPath, `[ERROR] Unable to apply diff:\n${applied.failures.join('\n')}\n\nUse read_file to get the latest content, then retry with SEARCH blocks that match exactly.`);
        return 'continue';
      }
      next = applied.content;
      if (applied.failures.length > 0) {
        this.say({ type: 'info', text: `${applied.applied} block(s) applied, ${applied.failures.length} failed.` });
      }
      (tool as ParsedToolUse & { partialFailures?: string[] }).partialFailures = applied.failures;
    } else if (tool.name === 'search_and_replace') {
      if (original === null) {
        this.consecutiveMistakes += 1;
        return this.pushToolError(tool.name, `File '${displayPath}' does not exist. Use write_to_file to create it.`, settings);
      }
      const operations = parseSearchReplaceOperationsParam(params.operations);
      if (operations === null) {
        this.consecutiveMistakes += 1;
        return this.pushToolError(tool.name, 'The <operations> parameter must be a JSON array of {"search", "replace"} objects.', settings);
      }
      if (operations.length === 0 && !params.search) {
        return missing('search');
      }
      try {
        const replaced = searchAndReplaceContent(original, {
          search: params.search,
          replace: params.replace,
          useRegex: params.use_regex === 'true',
          ignoreCase: params.ignore_case === 'true',
          startLine: params.start_line ? Number(params.start_line) : undefined,
          endLine: params.end_line ? Number(params.end_line) : undefined,
          operations,
        });
        next = replaced.content;
        (tool as ParsedToolUse & { replacements?: number }).replacements = replaced.replacements;
      } catch (error) {
        this.consecutiveMistakes += 1;
        this.say({ type: 'tool', tool: { name: tool.name, path: displayPath, title: `Replace failed: ${displayPath}`, content: (error as Error).message }, status: 'error' });
        this.pushToolResult(tool.name, displayPath, `[ERROR] ${(error as Error).message}\nUse read_file to check the current content, then retry with a search string that matches exactly (or use apply_diff).`);
        return 'continue';
      }
    } else {
      if (params.content === undefined) {
        return missing('content');
      }
      if (params.line === undefined || Number.isNaN(Number(params.line))) {
        return missing('line');
      }
      next = insertContent(original ?? '', Number(params.line), stripWrappingFence(params.content));
    }

    if (original !== null && original === next) {
      this.pushToolResult(tool.name, displayPath, 'No changes were needed: the new content is identical to the current file.');
      return 'continue';
    }

    const stats = diffStats(original ?? '', next);
    const info: ToolInfo = {
      name: tool.name,
      path: displayPath,
      outsideWorkspace: outside,
      isNewFile: original === null,
      title: `${original === null ? 'Create' : 'Edit'} ${displayPath}`,
      diff: lineDiff(original ?? '', next, 3).slice(0, 1500),
      added: stats.added,
      removed: stats.removed,
    };
    const approved = await this.approve('tool', settings.autoApprove.write && (!outside || settings.autoApprove.readOutsideWorkspace), info);
    if (approved.response === 'no' || this.abortController.signal.aborted) {
      return this.denied(tool.name, displayPath, approved.text);
    }
    const message = approved.message;

    try {
      const seq = ++this.checkpointSeq;
      this.checkpoints.push({ seq, path: absPath, before: original, ts: Date.now() });
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await host.writeFile(absPath, next);
      this.didEditFile = true;
      this.options.callbacks.onFileEdited?.(absPath);
      message.status = 'done';
      this.emit(message);
      this.say({ type: 'checkpoint', checkpoint: { seq }, text: displayPath });
      this.emitEvent({ type: 'file_edit', path: displayPath, created: original === null, added: stats.added, removed: stats.removed, checkpoint: seq });
      this.consecutiveMistakes = 0;
      const problems = host.getDiagnostics ? await host.getDiagnostics(absPath) : '';
      const partialFailures = (tool as ParsedToolUse & { partialFailures?: string[] }).partialFailures || [];
      const replacements = (tool as ParsedToolUse & { replacements?: number }).replacements;
      const lines = [
        `The ${original === null ? 'new file was created' : 'changes were applied'} successfully: ${displayPath} (+${stats.added} -${stats.removed})${replacements ? `, ${replacements} replacement(s)` : ''}.`,
        partialFailures.length > 0 ? `However, some SEARCH blocks failed and were NOT applied:\n${partialFailures.join('\n')}` : '',
        problems ? `New problems detected after saving the file:\n${problems}` : '',
        approved.text ? `<feedback>\n${approved.text}\n</feedback>` : '',
      ].filter(Boolean);
      this.pushToolResult(tool.name, displayPath, lines.join('\n\n'));
    } catch (error) {
      this.consecutiveMistakes += 1;
      message.status = 'error';
      this.emit(message);
      this.pushToolResult(tool.name, displayPath, `[ERROR] Could not write the file: ${(error as Error).message}`);
    }
    return 'continue';
  }

  private async runCommandTool(tool: ParsedToolUse, settings: AgentSettings, missing: (name: string) => 'continue'): Promise<'continue' | 'stop'> {
    const command = (tool.params.command || '').trim();
    if (!command) {
      return missing('command');
    }
    const host = this.options.host;
    const cwd = tool.params.cwd ? resolveWorkspacePath(host.cwd, tool.params.cwd) : host.cwd;
    const gateDecision = this.gateVerdict?.decision;
    const legacyAuto = settings.autoApprove.enabled && settings.autoApprove.execute && isCommandAutoApproved(command, settings.allowedCommands, settings.deniedCommands);
    const autoApproved = gateDecision === 'allow' || (gateDecision !== 'ask' && legacyAuto);
    const askId = makeId();
    const commandMessage: UiMessage = {
      id: askId,
      ts: Date.now(),
      type: 'command',
      command: { command, cwd: cwd === host.cwd ? undefined : toPosixRelative(host.cwd, cwd) },
      status: autoApproved ? 'approved' : 'pending',
    };
    let feedback: string | undefined;
    if (autoApproved) {
      commandMessage.ask = { kind: 'command', resolved: true, autoApproved: true };
      this.pushUi(commandMessage);
    } else {
      commandMessage.ask = { kind: 'command', resolved: false };
      const answer = await this.waitAsk(commandMessage);
      if (answer.response === 'no' || this.abortController.signal.aborted) {
        return this.denied(tool.name, command, answer.text);
      }
      feedback = answer.text;
    }

    commandMessage.command!.running = true;
    commandMessage.command!.output = '';
    commandMessage.status = 'running';
    this.emit(commandMessage);
    let lastEmit = 0;
    this.emitEvent({ type: 'command_start', command, cwd: toPosixRelative(host.cwd, cwd) });
    const result = await host.runCommand(command, cwd, {
      signal: this.abortController.signal,
      timeoutMs: settings.commandTimeoutSec * 1000,
      onOutput: (chunk) => {
        commandMessage.command!.output = truncateOutput((commandMessage.command!.output || '') + chunk, 400);
        const now = Date.now();
        if (now - lastEmit > 150) {
          lastEmit = now;
          this.emit(commandMessage);
        }
      },
    });
    commandMessage.command!.running = false;
    commandMessage.command!.exitCode = result.exitCode;
    commandMessage.command!.output = truncateOutput(result.output, 400);
    commandMessage.status = result.exitCode === 0 ? 'done' : 'error';
    this.emit(commandMessage);
    this.emitEvent({ type: 'command_end', command, exitCode: result.exitCode, timedOut: result.timedOut, outputTail: result.output.trim().split('\n').slice(-40).join('\n').slice(-4000) });
    if (this.abortController.signal.aborted) {
      return 'stop';
    }
    const output = truncateOutput(result.output.trim(), settings.terminalOutputLines) || '(no output)';
    const status = result.timedOut
      ? `The command timed out after ${settings.commandTimeoutSec}s and was terminated.`
      : `Exit code: ${result.exitCode}`;
    this.consecutiveMistakes = 0;
    this.pushToolResult(tool.name, command, `Command executed in ${toPosixRelative(host.cwd, cwd)}.\n${status}\nOutput:\n${output}${feedback ? `\n\n<feedback>\n${feedback}\n</feedback>` : ''}`);
    return 'continue';
  }

  private async runWebFetchTool(tool: ParsedToolUse, settings: AgentSettings, missing: (name: string) => 'continue'): Promise<'continue' | 'stop'> {
    const url = (tool.params.url || '').trim();
    if (!url) {
      return missing('url');
    }
    if (!/^https?:\/\//i.test(url)) {
      this.consecutiveMistakes += 1;
      return this.pushToolError(tool.name, `web_fetch needs a full http:// or https:// URL (got '${url}').`, settings);
    }
    const info: ToolInfo = { name: tool.name, url, title: `Fetch ${url}` };
    const approved = await this.approve('tool', settings.autoApprove.web, info);
    if (approved.response === 'no' || this.abortController.signal.aborted) {
      return this.denied(tool.name, url, approved.text);
    }
    const message = approved.message;
    message.status = 'running';
    this.emit(message);
    try {
      const text = await webFetchTool(url, { signal: this.abortController.signal, maxChars: Math.max(10_000, Math.floor(settings.maxPromptChars * 0.3)) });
      if (this.abortController.signal.aborted) {
        return 'stop';
      }
      this.consecutiveMistakes = 0;
      message.status = 'done';
      message.tool = { ...message.tool!, content: truncateMiddle(text, 3000) };
      this.emit(message);
      const prompt = (tool.params.prompt || '').trim();
      this.pushToolResult(tool.name, url, `${prompt ? `<prompt>${prompt}</prompt>\n` : ''}<content url="${url}">\n${text}\n</content>${approved.text ? `\n\n<feedback>\n${approved.text}\n</feedback>` : ''}`);
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return 'stop';
      }
      this.consecutiveMistakes += 1;
      message.status = 'error';
      message.tool = { ...message.tool!, content: (error as Error).message };
      this.emit(message);
      this.pushToolResult(tool.name, url, `[ERROR] ${(error as Error).message}`);
    }
    return 'continue';
  }

  private async runMcpTool(tool: ParsedToolUse, settings: AgentSettings, missing: (name: string) => 'continue'): Promise<'continue' | 'stop'> {
    const mcp = this.options.mcp;
    const params = tool.params;
    if (!mcp || !mcp.hasServers()) {
      this.consecutiveMistakes += 1;
      return this.pushToolError(tool.name, 'No MCP servers are configured. Add one with `pcode mcp add <name> -- <command>` (or .mcp.json / ~/.claude.json) and start a new task.', settings);
    }
    const server = (params.server_name || '').trim();
    if (tool.name !== 'list_mcp_resources' && !server) {
      return missing('server_name');
    }

    if (tool.name === 'list_mcp_resources') {
      const info: ToolInfo = { name: tool.name, server: server || undefined, title: server ? `List MCP resources of ${server}` : 'List MCP resources' };
      const approved = await this.approve('tool', settings.autoApprove.mcp || settings.autoApprove.read, info);
      if (approved.response === 'no' || this.abortController.signal.aborted) {
        return this.denied(tool.name, server || undefined, approved.text);
      }
      const message = approved.message;
      try {
        const resources = await mcp.listResources(server || undefined);
        const text = resources.length === 0
          ? 'No resources are exposed by the connected MCP servers.'
          : resources.map((entry) => `- ${entry.uri} [${entry.server}] ${entry.name}${entry.mimeType ? ` (${entry.mimeType})` : ''}${entry.description ? `: ${entry.description}` : ''}`).join('\n');
        this.consecutiveMistakes = 0;
        message.status = 'done';
        message.tool = { ...message.tool!, content: truncateMiddle(text, 3000) };
        this.emit(message);
        this.pushToolResult(tool.name, server || undefined, truncateMiddle(text, 20_000));
      } catch (error) {
        this.consecutiveMistakes += 1;
        message.status = 'error';
        message.tool = { ...message.tool!, content: (error as Error).message };
        this.emit(message);
        this.pushToolResult(tool.name, server || undefined, `[ERROR] ${(error as Error).message}`);
      }
      return 'continue';
    }

    if (tool.name === 'access_mcp_resource') {
      const uri = (params.uri || '').trim();
      if (!uri) {
        return missing('uri');
      }
      const info: ToolInfo = { name: tool.name, server, url: uri, title: `Read MCP resource ${uri} from ${server}` };
      const approved = await this.approve('tool', settings.autoApprove.mcp, info);
      if (approved.response === 'no' || this.abortController.signal.aborted) {
        return this.denied(tool.name, `${server}:${uri}`, approved.text);
      }
      const message = approved.message;
      message.status = 'running';
      this.emit(message);
      try {
        const text = await mcp.readResource(server, uri);
        if (this.abortController.signal.aborted) {
          return 'stop';
        }
        this.consecutiveMistakes = 0;
        message.status = 'done';
        message.tool = { ...message.tool!, content: truncateMiddle(text, 3000) };
        this.emit(message);
        this.pushToolResult(tool.name, `${server}:${uri}`, `${truncateMiddle(text, Math.max(20_000, Math.floor(settings.maxPromptChars * 0.4)))}${approved.text ? `\n\n<feedback>\n${approved.text}\n</feedback>` : ''}`);
      } catch (error) {
        if (this.abortController.signal.aborted) {
          return 'stop';
        }
        this.consecutiveMistakes += 1;
        message.status = 'error';
        message.tool = { ...message.tool!, content: (error as Error).message };
        this.emit(message);
        this.pushToolResult(tool.name, `${server}:${uri}`, `[ERROR] ${(error as Error).message}`);
      }
      return 'continue';
    }

    // use_mcp_tool
    const toolName = (params.tool_name || '').trim();
    if (!toolName) {
      return missing('tool_name');
    }
    const parsedArgs = parseMcpArgumentsParam(params.arguments);
    if (parsedArgs === null) {
      this.consecutiveMistakes += 1;
      return this.pushToolError(tool.name, 'The <arguments> parameter must be a JSON object, for example {"query": "hello"}. Use {} when the tool takes no parameters.', settings);
    }
    const argsPreview = JSON.stringify(parsedArgs, null, 2);
    const info: ToolInfo = {
      name: tool.name,
      server,
      title: `MCP ${server} / ${toolName}`,
      content: argsPreview === '{}' ? undefined : argsPreview,
    };
    const approved = await this.approve('tool', settings.autoApprove.mcp, info);
    if (approved.response === 'no' || this.abortController.signal.aborted) {
      return this.denied(tool.name, `${server}/${toolName}`, approved.text);
    }
    const message = approved.message;
    message.status = 'running';
    this.emit(message);
    try {
      const result = await mcp.callTool(server, toolName, parsedArgs);
      if (this.abortController.signal.aborted) {
        return 'stop';
      }
      const body = result.content.trim() || '(the tool returned no content)';
      message.status = result.isError ? 'error' : 'done';
      message.tool = { ...message.tool!, content: truncateMiddle(`${argsPreview === '{}' ? '' : `${argsPreview}\n\n`}${body}`, 4000) };
      this.emit(message);
      if (result.isError) {
        this.consecutiveMistakes += 1;
        this.pushToolResult(tool.name, `${server}/${toolName}`, `[ERROR] The MCP tool reported an error:\n${truncateMiddle(body, 8000)}`);
      } else {
        this.consecutiveMistakes = 0;
        this.pushToolResult(tool.name, `${server}/${toolName}`, `${truncateMiddle(body, Math.max(20_000, Math.floor(settings.maxPromptChars * 0.4)))}${approved.text ? `\n\n<feedback>\n${approved.text}\n</feedback>` : ''}`);
      }
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return 'stop';
      }
      this.consecutiveMistakes += 1;
      message.status = 'error';
      message.tool = { ...message.tool!, content: (error as Error).message };
      this.emit(message);
      this.pushToolResult(tool.name, `${server}/${toolName}`, `[ERROR] ${(error as Error).message}`);
    }
    return 'continue';
  }

  /** MCP section of the system prompt; connects configured servers on first use. */
  private async mcpSection(): Promise<string> {
    const mcp = this.options.mcp;
    if (!mcp || !mcp.hasServers()) {
      return '';
    }
    try {
      await mcp.ensureConnected();
    } catch {
      // Connection problems are reported per server inside the section / tool results.
    }
    return mcp.formatSystemPromptSection();
  }

  private denied(toolName: string, detail: string | undefined, feedback?: string): 'continue' | 'stop' {
    if (this.abortController.signal.aborted) {
      return 'stop';
    }
    this.pushToolResult(
      toolName,
      detail,
      feedback
        ? `The user denied this operation and provided the following feedback:\n<feedback>\n${feedback}\n</feedback>`
        : 'The user denied this operation.'
    );
    return 'continue';
  }

  private finishCompletion(result: string): void {
    this.completionResult = result;
    this.emitEvent({ type: 'completion', result });
    this.setState('completed');
    const resolvers = this.completionResolvers;
    this.completionResolvers = [];
    resolvers.forEach((resolve) => resolve(result));
    this.options.callbacks.onCompleted?.(this, result);
  }

  // ---------------------------------------------------------------------------------------------
  // Asks and UI helpers
  // ---------------------------------------------------------------------------------------------

  private async approve(kind: AskKind, autoApproved: boolean, info: ToolInfo): Promise<AskResponse & { message: UiMessage }> {
    const settings = this.options.getSettings();
    const message: UiMessage = { id: makeId(), ts: Date.now(), type: 'tool', tool: info, status: 'pending' };
    const gateDecision = kind === 'tool' || kind === 'new_task' ? this.gateVerdict?.decision : undefined;
    const explicitOutsideAllow =
      !info.outsideWorkspace
      || !READ_TOOLS.has(info.name)
      || (settings.autoApprove.enabled && settings.autoApprove.readOutsideWorkspace)
      || this.gateVerdict?.source === 'mode: bypassPermissions'
      || Boolean(this.gateVerdict?.source?.includes('('));
    const auto =
      (gateDecision === 'allow' && explicitOutsideAllow)
      || (gateDecision !== 'ask' && autoApproved && settings.autoApprove.enabled);
    if (auto) {
      message.status = 'approved';
      message.ask = { kind, resolved: true, autoApproved: true };
      this.pushUi(message);
      return { response: 'yes', message };
    }
    message.ask = { kind, resolved: false };
    const answer = await this.waitAsk(message);
    return { ...answer, message };
  }

  private ask(kind: AskKind, partial: Partial<UiMessage> & { type: UiMessage['type'] }): Promise<AskResponse> {
    const message: UiMessage = { id: makeId(), ts: Date.now(), ...partial, ask: { kind, resolved: false } };
    return this.waitAsk(message);
  }

  private waitAsk(message: UiMessage): Promise<AskResponse> {
    if (this.abortController.signal.aborted) {
      return Promise.resolve({ response: 'no' });
    }
    this.pushUi(message);
    return new Promise((resolve) => {
      this.pendingAsk = { id: message.id, kind: message.ask!.kind, resolve };
      this.status.askId = message.id;
      this.status.askKind = message.ask!.kind;
      this.setState('waiting');
      this.options.callbacks.persist?.(this);
    });
  }

  say(partial: Partial<UiMessage> & { type: UiMessage['type'] }): UiMessage {
    const message: UiMessage = { id: makeId(), ts: Date.now(), ...partial };
    this.pushUi(message);
    return message;
  }

  private pushUi(message: UiMessage): void {
    this.uiMessages.push(message);
    this.emit(message);
  }

  private removeMessage(message: UiMessage | undefined): void {
    if (!message) {
      return;
    }
    const index = this.uiMessages.indexOf(message);
    if (index >= 0) {
      this.uiMessages.splice(index, 1);
      this.options.callbacks.onRemoveMessage?.(this, message.id);
    }
  }

  private emit(message: UiMessage): void {
    this.options.callbacks.onMessage(this, message);
  }

  private setState(state: TaskStatus['state']): void {
    if (this.status.state !== state) {
      this.emitEvent({ type: 'state', state });
    }
    this.status.state = state;
    if (state !== 'waiting') {
      this.status.askId = undefined;
      this.status.askKind = undefined;
    }
    this.options.callbacks.onState(this);
  }

  private async getRules(): Promise<string> {
    if (this.rulesCache && this.rulesCache.mode === this.mode) {
      return this.rulesCache.text;
    }
    const rules = await loadWorkspaceRules(this.options.host.cwd, this.mode).catch(() => '');
    const extra = this.options.gate?.sessionContext ? await this.options.gate.sessionContext(this.gateContext).catch(() => '') : '';
    const text = [rules, extra].filter(Boolean).join('\n\n');
    this.rulesCache = { mode: this.mode, text };
    return text;
  }

  /** UserPromptSubmit hooks. Returns extra context, or null when the prompt was blocked. */
  private async checkPrompt(text: string): Promise<string | null> {
    this.emitEvent({ type: 'user', text: text.slice(0, 4000) });
    if (!this.options.gate?.userPromptSubmit) {
      return '';
    }
    const outcome = await this.options.gate.userPromptSubmit(this.gateContext, text);
    if (outcome.block) {
      this.say({ type: 'error', text: `Prompt blocked by hook: ${outcome.block}` });
      this.setState('idle');
      this.options.callbacks.persist?.(this);
      return null;
    }
    return outcome.additionalContext ? `\n\n<hook_context>\n${outcome.additionalContext}\n</hook_context>` : '';
  }

  private emitEvent(event: CoreEvent): void {
    this.options.callbacks.onEvent?.(this, event);
  }

  /** Adds a note for the model, for example after a resume (used by the core runner). */
  addNote(text: string): void {
    this.apiMessages.push({ role: 'user', content: text, ts: Date.now() });
    this.apiMessages.push({ role: 'assistant', content: 'Understood.', ts: Date.now() });
    this.options.callbacks.persist?.(this);
  }

  /** Replaces the model transcript (used by /compact). The Perplexity thread is reset. */
  replaceHistory(messages: ApiMessage[]): void {
    this.apiMessages = messages;
    this.thread = undefined;
    this.rulesCache = undefined;
    this.options.callbacks.persist?.(this);
  }

  /** Signals session start for resumed tasks (journal). */
  markResumed(): void {
    this.emitEvent({ type: 'session_start', mode: this.mode, cwd: this.options.host.cwd, resumed: true });
  }

  private async withEnvironment(content: string, includeFiles: boolean): Promise<string> {
    const settings = this.options.getSettings();
    const env = await this.environmentDetails(includeFiles && settings.includeFileListOnStart);
    return `${content}\n\n${env}`;
  }

  private async appendEnvironment(): Promise<void> {
    this.appendToLastUser(`\n\n${await this.environmentDetails(false)}`);
  }

  private async environmentDetails(includeFiles: boolean): Promise<string> {
    const host = this.options.host;
    const selection = this.options.getSelection();
    let fileList: string | undefined;
    if (includeFiles) {
      fileList = await listFilesTool(host, host.cwd, true, 200).catch(() => undefined);
    }
    return formatEnvironmentDetails({
      cwd: host.cwd,
      mode: this.modeConfig,
      modelLabel: this.options.getModelLabel(selection.baseModelId, selection.thinking),
      visibleFiles: host.visibleFiles?.() || [],
      openTabs: host.openTabs?.() || [],
      todos: this.todos.length > 0 ? formatTodos(this.todos) : undefined,
      includeFileList: fileList,
    });
  }

  /** Whether the task changed files (used by the UI to offer "Review changes"). */
  get hasEdits(): boolean {
    return this.didEditFile || this.checkpoints.length > 0;
  }
}

function parseFollowUpSuggestionsWithMode(value: string | undefined): Array<{ text: string; mode?: string }> {
  if (!value) {
    return [];
  }
  const out: Array<{ text: string; mode?: string }> = [];
  const regex = /<suggest(?:\s+mode="([^"]*)")?>([\s\S]*?)<\/suggest>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const text = match[2].trim();
    if (text) {
      out.push({ text, mode: match[1] || undefined });
    }
  }
  if (out.length === 0) {
    return parseFollowUpSuggestions(value).map((text) => ({ text }));
  }
  return out;
}

export function toolActivityLabel(name: string): string {
  switch (name) {
    case 'read_file': return 'Reading file';
    case 'list_files': return 'Listing files';
    case 'search_files': return 'Searching';
    case 'list_code_definition_names': return 'Listing definitions';
    case 'write_to_file': return 'Writing file';
    case 'apply_diff': return 'Preparing edit';
    case 'insert_content': return 'Inserting content';
    case 'execute_command': return 'Preparing command';
    case 'ask_followup_question': return 'Asking a question';
    case 'attempt_completion': return 'Finishing';
    case 'switch_mode': return 'Switching mode';
    case 'new_task': return 'Creating subtask';
    case 'update_todo_list': return 'Updating todo list';
    case 'glob_files': return 'Finding files';
    case 'search_and_replace': return 'Preparing replacement';
    case 'web_fetch': return 'Fetching URL';
    case 'use_mcp_tool': return 'Calling MCP tool';
    case 'access_mcp_resource': return 'Reading MCP resource';
    case 'list_mcp_resources': return 'Listing MCP resources';
    default: return 'Working';
  }
}

/** JSON array of search/replace operations; [] when absent, null when malformed. */
function parseSearchReplaceOperationsParam(raw: string | undefined): SearchReplaceOperation[] | null {
  if (!raw || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const ops: SearchReplaceOperation[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const search = record.search ?? record.old_string ?? record.find;
      if (typeof search !== 'string') {
        return null;
      }
      const replace = record.replace ?? record.new_string ?? record.replacement ?? '';
      ops.push({
        search,
        replace: typeof replace === 'string' ? replace : String(replace),
        useRegex: record.use_regex === true || record.useRegex === true || record.regex === true,
        ignoreCase: record.ignore_case === true || record.ignoreCase === true,
      });
    }
    return ops;
  } catch {
    return null;
  }
}

/** MCP tool arguments: JSON object, {} for empty, null when malformed. Loose JSON (single quotes, trailing commas) is repaired. */
export function parseMcpArgumentsParam(raw: string | undefined): Record<string, unknown> | null {
  const text = (raw || '').trim();
  if (!text) {
    return {};
  }
  const attempt = (candidate: string): Record<string, unknown> | null | undefined => {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return undefined;
    }
  };
  const direct = attempt(text);
  if (direct !== undefined) {
    return direct;
  }
  // Common model slips: trailing commas, single-quoted strings, unquoted keys.
  const repaired = text
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_all, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  const second = attempt(repaired);
  return second === undefined ? null : second;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
