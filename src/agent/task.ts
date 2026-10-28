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
  insertContent,
  isCommandAutoApproved,
  isInsideWorkspace,
  listCodeDefinitionsTool,
  listFilesTool,
  readFileTool,
  resolveWorkspacePath,
  searchFilesTool,
  toPosixRelative,
  truncateOutput,
} from './tools';
import type { CompletionRequest, CompletionResult, ThreadState } from './transport';
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
  private consecutiveNoTool = 0;
  private apiRetries = 0;
  private looping = false;
  private requestsSinceLimitPrompt = 0;
  private checkpointSeq = 0;
  private completionResolvers: Array<(result: string) => void> = [];
  private rulesCache?: { mode: string; text: string };
  private didEditFile = false;

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
    this.say({ type: 'user', text, images });
    const content = await this.withEnvironment(`<task>\n${text}\n</task>`, true);
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
    const content = await this.withEnvironment(`<user_message>\n${text}\n</user_message>`, false);
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
      status: this.status.state,
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

      try {
        const result = await this.options.provider.complete({
          fullPrompt: full.prompt,
          followUpPrompt,
          thread: this.thread,
          baseModelId: selection.baseModelId,
          thinking: selection.thinking,
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
        if (this.abortController.signal.aborted || typed.kind === 'aborted') {
          this.removeMessage(reqMessage);
          return undefined;
        }
        reqMessage.status = 'error';
        this.emit(reqMessage);
        if (settings.autoApprove.enabled && settings.autoApprove.retry && typed.kind !== 'no_account' && this.apiRetries < 2) {
          this.apiRetries += 1;
          this.say({ type: 'info', text: `Request failed: ${typed.message}. Retrying in 5 s…` });
          await delay(5000, this.abortController.signal);
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
    // Store a normalized assistant message: prose + exactly one tool call.
    const assistantContent = tool
      ? `${parsed.text ? `${parsed.text}\n\n` : ''}${result.text.slice(tool.start, tool.end)}`
      : result.text.trim();
    this.apiMessages.push({ role: 'assistant', content: assistantContent, ts: Date.now() });

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

    const result_ = await this.executeTool(tool, settings);
    if (result_ === 'stop') {
      return 'stop';
    }
    if (parsed.ignoredToolCount > 0) {
      this.appendToLastUser(`\n\n[Note: only the first tool call of your message was executed. ${parsed.ignoredToolCount} additional tool call(s) were ignored. Use one tool per message.]`);
    }
    if (this.consecutiveMistakes >= MAX_CONSECUTIVE_MISTAKES) {
      const answer = await this.ask('mistake_limit', {
        type: 'error',
        text: 'The model is having trouble using tools correctly. You can give guidance (for example "read the file first" or "split the change into smaller steps") or try a different model.',
      });
      this.consecutiveMistakes = 0;
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
    const looksUnfinished = /\b(let me|i will|i'll|next,? i|now i|сейчас|теперь|далее|давайте)\b/i.test(text.slice(-400));
    if (midTask && looksUnfinished && this.consecutiveNoTool < 1) {
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
        return this.runReadTool(tool, settings, missing);
      case 'write_to_file':
      case 'apply_diff':
      case 'insert_content':
        return this.runEditTool(tool, settings, missing);
      case 'execute_command':
        return this.runCommandTool(tool, settings, missing);
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
        if (this.parentId) {
          this.say({ type: 'completion', text: resultText });
          this.finishCompletion(resultText);
          return 'stop';
        }
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
        if (!MODES.some((mode) => mode.slug === modeSlug)) {
          return this.pushToolError(tool.name, `Unknown mode '${modeSlug}'.`, settings);
        }
        if (!this.options.callbacks.startSubtask) {
          return this.pushToolError(tool.name, 'Subtasks are not supported in this context.', settings);
        }
        const approved = await this.approve('new_task', settings.autoApprove.subtasks, {
          name: tool.name,
          title: `New subtask in ${getModeBySlug(modeSlug).name} mode`,
          mode: modeSlug,
          content: message,
        });
        if (approved.response === 'no' || this.abortController.signal.aborted) {
          return this.denied(tool.name, modeSlug, approved.text);
        }
        const subtaskMessage = this.say({ type: 'subtask', text: message, tool: { name: tool.name, title: getModeBySlug(modeSlug).name, mode: modeSlug }, status: 'running' });
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
    const approved = await this.approve('tool', settings.autoApprove.write && !outside, info);
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
      this.consecutiveMistakes = 0;
      const problems = host.getDiagnostics ? await host.getDiagnostics(absPath) : '';
      const partialFailures = (tool as ParsedToolUse & { partialFailures?: string[] }).partialFailures || [];
      const lines = [
        `The ${original === null ? 'new file was created' : 'changes were applied'} successfully: ${displayPath} (+${stats.added} -${stats.removed}).`,
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
    const autoApproved = settings.autoApprove.execute && isCommandAutoApproved(command, settings.allowedCommands, settings.deniedCommands);
    const askId = makeId();
    const commandMessage: UiMessage = {
      id: askId,
      ts: Date.now(),
      type: 'command',
      command: { command, cwd: cwd === host.cwd ? undefined : toPosixRelative(host.cwd, cwd) },
      status: autoApproved && settings.autoApprove.enabled ? 'approved' : 'pending',
    };
    let feedback: string | undefined;
    if (autoApproved && settings.autoApprove.enabled) {
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
    if (autoApproved && settings.autoApprove.enabled) {
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
    const text = await loadWorkspaceRules(this.options.host.cwd, this.mode).catch(() => '');
    this.rulesCache = { mode: this.mode, text };
    return text;
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
    default: return 'Working';
  }
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
