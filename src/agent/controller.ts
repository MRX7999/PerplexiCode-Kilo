import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatQuotaSummary, getQuotaItem, setPlanOverride } from '../api/capabilityFetcher';
import {
  compareModels,
  getBundledSnapshotDate,
  getModelLabel,
  ModelInfo,
} from '../api/modelCatalog';
import { ModelFetcher } from '../api/modelFetcher';
import { RotationEngine } from '../api/rotationEngine';
import { AccountPlan, RotationStrategy } from '../api/types';
import { AccountManager } from '../storage/accountManager';
import { DEFAULT_MODE_SLUG, getModeBySlug, MODES } from './modes';
import { AgentTask, AskResponse } from './task';
import { TaskStore } from './taskStore';
import { listFilesTool, readFileTool, resolveWorkspacePath, toPosixRelative } from './tools';
import { PerplexityTransport, TransportError } from './transport';
import { AgentSettings, ModelSelection, PersistedTask, UiMessage } from './types';
import type { TodoItem } from './toolParser';
import * as os from 'os';
import { VsCodeAgentHost } from './vscodeHost';

type WebviewTarget = vscode.Webview;

const SELECTION_KEY = 'perplexicode.agent.selection';

interface StoredSelection {
  modelId: string;
  thinking: boolean;
  webSearch: boolean | null;
  mode: string;
}

/**
 * Owns the agent tasks and synchronises every PerplexiCode webview (sidebar and editor tabs).
 */
export class AgentController implements vscode.Disposable {
  private readonly webviews = new Set<WebviewTarget>();
  private readonly tasks = new Map<string, AgentTask>();
  /** Stack of tasks; the last element is the one shown in the UI (child tasks on top). */
  private stack: AgentTask[] = [];
  private selection: StoredSelection;
  private models: ModelInfo[] = [];
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private stateTimer?: NodeJS.Timeout;
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the UI state (selection, task, models) is re-published. */
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accountManager: AccountManager,
    private readonly rotationEngine: RotationEngine,
    private readonly modelFetcher: ModelFetcher,
    private readonly transport: PerplexityTransport,
    private readonly store: TaskStore,
    output: vscode.OutputChannel
  ) {
    this.output = output;
    const stored = context.globalState.get<StoredSelection>(SELECTION_KEY);
    const configuredDefault = vscode.workspace.getConfiguration('perplexicode').get<string>('defaultModel', 'turbo');
    this.selection = {
      modelId: stored?.modelId || configuredDefault || 'turbo',
      thinking: stored?.thinking ?? false,
      webSearch: stored?.webSearch ?? null,
      mode: stored?.mode || DEFAULT_MODE_SLUG,
    };
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('perplexicode')) {
        this.applyPlanOverride();
        this.postState();
      }
    }));
    this.applyPlanOverride();
  }

  dispose(): void {
    this.stateEmitter.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.stack.forEach((task) => task.abort());
  }

  // ---------------------------------------------------------------------------------------------
  // Webview wiring
  // ---------------------------------------------------------------------------------------------

  attachWebview(webview: vscode.Webview, onDispose: (listener: () => void) => void): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.getHtml(webview);
    this.webviews.add(webview);
    const subscription = webview.onDidReceiveMessage((message) => {
      void this.handleMessage(webview, message).catch((error) => {
        this.output.appendLine(`[webview] ${(error as Error).stack || error}`);
        void vscode.window.showErrorMessage(`PerplexiCode: ${(error as Error).message}`);
      });
    });
    onDispose(() => {
      subscription.dispose();
      this.webviews.delete(webview);
    });
  }

  private post(message: unknown, target?: WebviewTarget): void {
    const targets = target ? [target] : [...this.webviews];
    for (const webview of targets) {
      void webview.postMessage(message);
    }
  }

  async refreshModels(models: ModelInfo[]): Promise<void> {
    this.models = models;
    this.postState();
  }

  /** Recomputes the merged model list across accounts. */
  async reloadModels(): Promise<void> {
    const accounts = this.accountManager.getAccounts().filter((account) => account.status !== 'disabled' && account.status !== 'expired');
    if (accounts.length === 0) {
      this.models = this.modelFetcher.getFallbackModels();
    } else {
      const merged = new Map<string, ModelInfo>();
      for (const list of await Promise.all(accounts.map((account) => this.modelFetcher.getModels(account)))) {
        for (const model of list) {
          const existing = merged.get(model.id);
          if (!existing || (existing.selectable === false && model.selectable !== false)) {
            merged.set(model.id, model);
          }
        }
      }
      this.models = [...merged.values()].sort(compareModels);
    }
    if (!this.models.some((model) => model.id === this.selection.modelId)) {
      this.selection.modelId = this.models.find((model) => model.selectable !== false)?.id || 'turbo';
    }
    this.postState();
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  getSettings(): AgentSettings {
    const config = vscode.workspace.getConfiguration('perplexicode.agent');
    return {
      autoApprove: {
        enabled: config.get<boolean>('autoApprove.enabled', true),
        read: config.get<boolean>('autoApprove.read', true),
        readOutsideWorkspace: config.get<boolean>('autoApprove.readOutsideWorkspace', false),
        write: config.get<boolean>('autoApprove.write', false),
        execute: config.get<boolean>('autoApprove.execute', false),
        modeSwitch: config.get<boolean>('autoApprove.modeSwitch', true),
        subtasks: config.get<boolean>('autoApprove.subtasks', true),
        todo: config.get<boolean>('autoApprove.todo', true),
        retry: config.get<boolean>('autoApprove.retry', true),
      },
      allowedCommands: config.get<string[]>('allowedCommands', []),
      deniedCommands: config.get<string[]>('deniedCommands', []),
      maxRequests: clamp(config.get<number>('maxRequestsPerTask', 40), 1, 500),
      maxReadLines: clamp(config.get<number>('maxReadFileLines', 500), 50, 20000),
      commandTimeoutSec: clamp(config.get<number>('commandTimeoutSeconds', 120), 0, 3600),
      terminalOutputLines: clamp(config.get<number>('terminalOutputLineLimit', 300), 20, 5000),
      webSearch: config.get<'auto' | 'always' | 'never'>('webSearch', 'auto'),
      contextStrategy: config.get<'auto' | 'full' | 'thread'>('contextStrategy', 'auto'),
      maxPromptChars: clamp(config.get<number>('maxPromptChars', 60000), 8000, 400000),
      language: config.get<string>('language', 'auto'),
      customInstructions: config.get<string>('customInstructions', ''),
      modeInstructions: config.get<Record<string, string>>('modeInstructions', {}),
      diffEnabled: config.get<boolean>('diffEnabled', true),
      includeFileListOnStart: config.get<boolean>('includeFileListOnStart', true),
    };
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    const [section, ...rest] = key.split('.');
    if (section === 'root') {
      await vscode.workspace.getConfiguration('perplexicode').update(rest.join('.'), value, vscode.ConfigurationTarget.Global);
      return;
    }
    await vscode.workspace.getConfiguration('perplexicode.agent').update(key, value, vscode.ConfigurationTarget.Global);
  }

  private applyPlanOverride(): void {
    const plan = vscode.workspace.getConfiguration('perplexicode').get<string>('subscriptionPlan', 'auto');
    setPlanOverride(plan === 'auto' ? undefined : (plan as AccountPlan));
  }

  getSelection(): ModelSelection {
    const model = this.models.find((entry) => entry.id === this.selection.modelId);
    return {
      baseModelId: this.selection.modelId,
      thinking: Boolean(this.selection.thinking && model?.supportsThinking),
      webSearch: this.selection.webSearch === null ? undefined : this.selection.webSearch,
    };
  }

  getModels(): ModelInfo[] {
    return this.models;
  }

  getModeSlug(): string {
    return this.selection.mode;
  }

  get isBusy(): boolean {
    return Boolean(this.currentTask?.isBusy);
  }

  async setModel(modelId: string, thinking?: boolean): Promise<void> {
    this.selection.modelId = modelId;
    if (typeof thinking === 'boolean') {
      this.selection.thinking = thinking;
    }
    await this.saveSelection();
    this.postState();
  }

  async setMode(mode: string): Promise<void> {
    if (!MODES.some((entry) => entry.slug === mode)) {
      return;
    }
    this.selection.mode = mode;
    await this.saveSelection();
    if (this.currentTask && !this.currentTask.isBusy) {
      this.currentTask.setMode(mode);
    }
    this.postState();
  }

  /** Switches the visible view in every attached webview. */
  showView(view: 'chat' | 'history' | 'settings'): void {
    this.post({ type: 'view', view });
  }

  private async saveSelection(): Promise<void> {
    await this.context.globalState.update(SELECTION_KEY, this.selection);
  }

  // ---------------------------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------------------------

  get currentTask(): AgentTask | undefined {
    return this.stack[this.stack.length - 1];
  }

  private workspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    return folders[0].uri.fsPath;
  }

  private buildTask(options: { mode: string; parentId?: string; restore?: PersistedTask; cwd?: string }): AgentTask {
    const cwd = options.restore?.workspace || options.cwd || this.workspaceRoot() || os.homedir();
    const host = new VsCodeAgentHost(cwd, () => vscode.workspace.getConfiguration('perplexicode.agent').get<boolean>('revealEditedFiles', true));
    const task = new AgentTask({
      host,
      provider: this.transport,
      getSettings: () => this.getSettings(),
      getSelection: () => this.getSelection(),
      getModelLabel: (modelId, thinking) => getModelLabel(modelId, thinking),
      mode: options.mode,
      parentId: options.parentId,
      restore: options.restore,
      callbacks: {
        onMessage: (owner, message) => {
          if (this.currentTask === owner) {
            this.post({ type: 'messageUpdated', taskId: owner.id, message });
          }
        },
        onRemoveMessage: (owner, id) => {
          if (this.currentTask === owner) {
            this.post({ type: 'messageRemoved', taskId: owner.id, id });
          }
        },
        onState: (owner) => {
          if (this.currentTask === owner) {
            this.schedulePostState();
          }
        },
        onModeChanged: (owner, mode) => {
          if (this.currentTask === owner) {
            this.selection.mode = mode;
            void this.saveSelection();
            this.postState();
          }
        },
        startSubtask: (parent, mode, message, todos) => this.startSubtask(parent, mode, message, todos),
        persist: (owner) => this.store.save(owner.toJSON()),
        onCompleted: (owner) => {
          this.store.save(owner.toJSON());
          this.postState();
        },
      },
    });
    this.tasks.set(task.id, task);
    return task;
  }

  private async startSubtask(parent: AgentTask, mode: string, message: string, todos: TodoItem[]): Promise<string> {
    const child = this.buildTask({ mode, parentId: parent.id, cwd: (parent.toJSON().workspace) });
    child.todos = todos;
    this.stack.push(child);
    this.postState(true);
    const completion = child.waitForCompletion();
    void child.start(message);
    const result = await completion;
    this.store.save(child.toJSON());
    // Return to the parent.
    const index = this.stack.indexOf(child);
    if (index >= 0) {
      this.stack.splice(index, 1);
    }
    this.postState(true);
    return result;
  }

  async newTask(text: string, images: string[] = [], mode?: string): Promise<void> {
    await this.clearTask();
    if (!this.workspaceRoot()) {
      void vscode.window.showWarningMessage('PerplexiCode: open a folder or workspace so the agent can work with files. The task will run in your home directory.');
    }
    if (mode && MODES.some((entry) => entry.slug === mode)) {
      this.selection.mode = mode;
      await this.saveSelection();
    }
    const task = this.buildTask({ mode: this.selection.mode });
    this.stack = [task];
    this.postState(true);
    await task.start(text, images);
  }

  async clearTask(): Promise<void> {
    for (const task of this.stack) {
      if (task.isBusy || task.status.state === 'waiting') {
        if (task.status.askKind === 'completion_result' && task.status.askId) {
          task.respond(task.status.askId, { response: 'yes' });
        } else {
          task.abort();
        }
      }
      this.store.save(task.toJSON());
    }
    this.stack = [];
    this.postState(true);
  }

  async openTask(id: string): Promise<void> {
    const persisted = await this.store.load(id);
    if (!persisted) {
      void vscode.window.showErrorMessage('PerplexiCode: this task could not be loaded.');
      return;
    }
    await this.clearTask();
    const existing = this.tasks.get(id);
    const task = existing && !existing.isBusy ? existing : this.buildTask({ mode: persisted.mode, restore: persisted });
    this.selection.mode = task.mode;
    this.stack = [task];
    this.post({ type: 'view', view: 'chat' });
    this.postState(true);
  }

  /** Text from the chat box: continue the current task or start a new one. */
  async sendMessage(text: string, images: string[] = []): Promise<void> {
    const processed = await this.expandMentions(text);
    const task = this.currentTask;
    if (!task) {
      await this.newTask(processed, images);
      return;
    }
    if (task.mode !== this.selection.mode) {
      task.setMode(this.selection.mode);
    }
    await task.submitUserMessage(processed, images);
  }

  // ---------------------------------------------------------------------------------------------
  // Mentions and context helpers
  // ---------------------------------------------------------------------------------------------

  /** Expands @/path, @problems, @git-changes, @terminal mentions into attached context. */
  async expandMentions(text: string): Promise<string> {
    const root = this.workspaceRoot();
    if (!root) {
      return text;
    }
    const attachments: string[] = [];
    const seen = new Set<string>();
    const regex = /(^|\s)@(\/[^\s]+|problems|git-changes|selection)(?=\s|$|[,.;:!?])/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const mention = match[2];
      if (seen.has(mention)) {
        continue;
      }
      seen.add(mention);
      try {
        if (mention === 'problems') {
          const host = new VsCodeAgentHost(root, () => false);
          attachments.push(`<workspace_diagnostics>\n${await host.getWorkspaceProblems()}\n</workspace_diagnostics>`);
        } else if (mention === 'git-changes') {
          const diff = await runGit(root, ['--no-pager', 'diff', 'HEAD', '--stat', '--patch', '--no-color']);
          attachments.push(`<git_working_state>\n${(await runGit(root, ['status', '--short'])).trim()}\n\n${truncate(diff, 40000)}\n</git_working_state>`);
        } else if (mention === 'selection') {
          const editor = vscode.window.activeTextEditor;
          if (editor && !editor.selection.isEmpty) {
            const rel = toPosixRelative(root, editor.document.uri.fsPath);
            attachments.push(`<selection path="${rel}" lines="${editor.selection.start.line + 1}-${editor.selection.end.line + 1}">\n${editor.document.getText(editor.selection)}\n</selection>`);
          }
        } else {
          const rel = mention.slice(1);
          const abs = resolveWorkspacePath(root, rel);
          const host = new VsCodeAgentHost(root, () => false);
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
          if (stat.type & vscode.FileType.Directory) {
            attachments.push(`<folder_content path="${rel}">\n${await listFilesTool(host, abs, false)}\n</folder_content>`);
          } else {
            const content = await readFileTool(host, abs, { maxLines: this.getSettings().maxReadLines });
            attachments.push(`<file_content path="${rel}">\n${content.text}\n</file_content>`);
          }
        }
      } catch (error) {
        attachments.push(`<mention_error mention="@${mention}">${(error as Error).message}</mention_error>`);
      }
    }
    return attachments.length > 0 ? `${text}\n\n${attachments.join('\n\n')}` : text;
  }

  private async searchMentions(query: string): Promise<Array<{ label: string; value: string; kind: string }>> {
    const root = this.workspaceRoot();
    const specials = [
      { label: 'problems', value: '@problems', kind: 'special' },
      { label: 'git-changes', value: '@git-changes', kind: 'special' },
      { label: 'selection', value: '@selection', kind: 'special' },
    ].filter((entry) => entry.label.startsWith(query.toLowerCase()));
    if (!root) {
      return specials;
    }
    const pattern = query ? `**/*${query.replace(/[\[\]{}*?]/g, '')}*` : '**/*';
    const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,dist,out,build,.next}/**', 60);
    const results = files
      .map((uri) => toPosixRelative(root, uri.fsPath))
      .sort((a, b) => a.length - b.length)
      .slice(0, 30)
      .map((rel) => ({ label: rel, value: `@/${rel}`, kind: 'file' }));
    return [...specials, ...results];
  }

  async addToContext(text: string): Promise<void> {
    await vscode.commands.executeCommand('perplexicode.chatView.focus');
    this.post({ type: 'addToInput', text });
  }

  async runCodeAction(kind: 'explain' | 'fix' | 'improve' | 'add', editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) {
      void vscode.window.showWarningMessage('PerplexiCode: open a file first.');
      return;
    }
    const root = this.workspaceRoot();
    const selection = editor.selection.isEmpty
      ? new vscode.Range(0, 0, editor.document.lineCount, 0)
      : new vscode.Range(editor.selection.start, editor.selection.end);
    const code = editor.document.getText(selection);
    const rel = root ? toPosixRelative(root, editor.document.uri.fsPath) : editor.document.fileName;
    const lines = `${selection.start.line + 1}-${selection.end.line + 1}`;
    const block = `@/${rel} (lines ${lines}):\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\``;
    if (kind === 'add') {
      await this.addToContext(block);
      return;
    }
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
      .filter((diagnostic) => diagnostic.range.intersection(selection))
      .map((diagnostic) => `- Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`)
      .join('\n');
    const prompts = {
      explain: `Explain the following code from file path ${rel}:${lines}\n\n${block.replace(/^@\/\S+ \(lines [^)]+\):\n/, '')}\n\nPlease provide a clear and concise explanation of what this code does, including its purpose, key components and any important patterns.`,
      fix: `Fix any issues in the following code from file path ${rel}:${lines}\n${diagnostics ? `\nCurrent problems detected:\n${diagnostics}\n` : ''}\n${block.replace(/^@\/\S+ \(lines [^)]+\):\n/, '')}\n\nPlease address all detected problems and explain the fix.`,
      improve: `Improve the following code from file path ${rel}:${lines}\n\n${block.replace(/^@\/\S+ \(lines [^)]+\):\n/, '')}\n\nSuggest improvements for readability, performance, best practices and error handling, then apply them.`,
    } as const;
    await vscode.commands.executeCommand('perplexicode.chatView.focus');
    await this.newTask(prompts[kind], [], kind === 'explain' ? 'ask' : 'code');
  }

  async generateCommitMessage(): Promise<void> {
    const gitExtension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    const api = gitExtension?.isActive ? gitExtension.exports.getAPI(1) : (await gitExtension?.activate())?.getAPI(1);
    const repo = api?.repositories?.[0];
    const root = repo?.rootUri.fsPath || this.workspaceRoot();
    if (!root) {
      void vscode.window.showWarningMessage('PerplexiCode: no git repository found.');
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Generating commit message…' }, async () => {
      let diff = await runGit(root, ['--no-pager', 'diff', '--cached', '--no-color']).catch(() => '');
      let scope = 'staged';
      if (!diff.trim()) {
        diff = await runGit(root, ['--no-pager', 'diff', '--no-color']).catch(() => '');
        scope = 'unstaged';
      }
      if (!diff.trim()) {
        void vscode.window.showInformationMessage('PerplexiCode: there are no changes to describe.');
        return;
      }
      const prompt = `Write a git commit message in Conventional Commits format for the following ${scope} changes. Reply with ONLY the commit message (a subject line up to 72 characters, a blank line, then a short bullet list body if useful). No code fences, no explanations.\n\n${truncate(diff, 30000)}`;
      const text = await this.oneShot(prompt);
      const message = text.replace(/^```[a-z]*\n?|```$/g, '').trim();
      if (repo) {
        repo.inputBox.value = message;
      } else {
        await vscode.env.clipboard.writeText(message);
        void vscode.window.showInformationMessage('PerplexiCode: commit message copied to clipboard.');
      }
    });
  }

  private async oneShot(prompt: string): Promise<string> {
    const controller = new AbortController();
    const selection = this.getSelection();
    const result = await this.transport.complete({
      fullPrompt: prompt,
      baseModelId: selection.baseModelId,
      thinking: false,
      webSearch: false,
      signal: controller.signal,
    });
    return result.text;
  }

  // ---------------------------------------------------------------------------------------------
  // Messages from the webview
  // ---------------------------------------------------------------------------------------------

  private async handleMessage(webview: WebviewTarget, message: { type: string; [key: string]: any }): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.output.appendLine(`[webview] ready (${this.webviews.size} attached)`);
        this.postState(true, webview);
        void this.reloadModels();
        break;
      case 'newTask':
        await this.newTask(await this.expandMentions(String(message.text || '')), message.images || []);
        break;
      case 'sendMessage':
        await this.sendMessage(String(message.text || ''), message.images || []);
        break;
      case 'askResponse': {
        const task = this.currentTask;
        if (task) {
          const text = message.text ? await this.expandMentions(String(message.text)) : undefined;
          task.respond(String(message.askId), { response: message.response, text, images: message.images } as AskResponse);
        }
        break;
      }
      case 'abort':
        this.currentTask?.abort();
        this.postState();
        break;
      case 'clearTask':
        await this.clearTask();
        break;
      case 'setMode':
        await this.setMode(String(message.mode));
        break;
      case 'setModel':
        await this.setModel(String(message.modelId), typeof message.thinking === 'boolean' ? message.thinking : undefined);
        break;
      case 'setThinking':
        this.selection.thinking = Boolean(message.value);
        await this.saveSelection();
        this.postState();
        break;
      case 'setWebSearch':
        this.selection.webSearch = message.value === null ? null : Boolean(message.value);
        await this.saveSelection();
        this.postState();
        break;
      case 'openTask':
        await this.openTask(String(message.id));
        break;
      case 'deleteTask':
        await this.store.delete(String(message.id));
        this.tasks.delete(String(message.id));
        if (this.currentTask?.id === message.id) {
          this.stack = [];
        }
        this.postState(true);
        break;
      case 'clearHistory': {
        const confirm = await vscode.window.showWarningMessage('Delete all PerplexiCode task history?', { modal: true }, 'Delete');
        if (confirm === 'Delete') {
          await this.store.clear();
          this.postState(true);
        }
        break;
      }
      case 'exportTask':
        await this.exportTask(String(message.id || this.currentTask?.id || ''));
        break;
      case 'restoreCheckpoint': {
        const task = this.currentTask;
        if (!task || task.isBusy) {
          void vscode.window.showWarningMessage('PerplexiCode: stop the task before restoring a checkpoint.');
          break;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Restore files to checkpoint #${message.seq}? All file edits made by the agent after this point will be reverted.`,
          { modal: true },
          'Restore'
        );
        if (confirm === 'Restore') {
          await task.restoreCheckpoint(Number(message.seq));
          this.postState(true);
        }
        break;
      }
      case 'updateSetting':
        await this.updateSetting(String(message.key), message.value);
        this.postState();
        break;
      case 'openSettingsJson':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:perplexicode.perplexicode');
        break;
      case 'addAccount':
        await vscode.commands.executeCommand('perplexicode.addAccount');
        break;
      case 'manageAccounts':
        await vscode.commands.executeCommand('perplexicode.manageAccounts');
        break;
      case 'removeAccount': {
        const account = this.accountManager.getAccounts().find((entry) => entry.id === message.id);
        if (account) {
          const confirm = await vscode.window.showWarningMessage(`Remove account "${account.alias}"?`, { modal: true }, 'Remove');
          if (confirm === 'Remove') {
            await this.accountManager.removeAccount(account.id);
            await vscode.commands.executeCommand('perplexicode.refreshModels');
          }
        }
        break;
      }
      case 'toggleAccount':
        await this.accountManager.toggleAccount(String(message.id));
        await vscode.commands.executeCommand('perplexicode.refreshModels');
        break;
      case 'refreshAccounts':
        await vscode.commands.executeCommand('perplexicode.refreshModels');
        break;
      case 'setRotation':
        this.rotationEngine.setStrategy(message.strategy as RotationStrategy);
        await this.context.globalState.update('perplexicode.rotationStrategy', message.strategy);
        this.postState();
        break;
      case 'enhancePrompt': {
        const text = String(message.text || '').trim();
        if (!text) {
          break;
        }
        try {
          const enhanced = await this.oneShot(`Generate an enhanced version of this prompt for an AI coding agent working in the user's code editor. Keep the user's language and intent, make it specific and actionable, and reply with ONLY the enhanced prompt text, without quotes, explanations or headings.\n\nPrompt:\n${text}`);
          this.post({ type: 'enhancedPrompt', text: enhanced.trim() }, webview);
        } catch (error) {
          this.post({ type: 'enhancedPrompt', text, error: error instanceof TransportError ? error.message : String((error as Error).message) }, webview);
        }
        break;
      }
      case 'searchMentions':
        this.post({ type: 'mentionResults', query: message.query, results: await this.searchMentions(String(message.query || '')) }, webview);
        break;
      case 'openFile': {
        const root = this.currentTask?.toJSON().workspace || this.workspaceRoot();
        if (!root) {
          break;
        }
        const abs = path.isAbsolute(message.path) ? message.path : resolveWorkspacePath(root, String(message.path));
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
          const editor = await vscode.window.showTextDocument(doc, { preview: true });
          if (message.line) {
            const position = new vscode.Position(Math.max(0, Number(message.line) - 1), 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
          }
        } catch {
          void vscode.window.showWarningMessage(`PerplexiCode: cannot open ${message.path}`);
        }
        break;
      }
      case 'openUrl':
        if (/^https?:\/\//.test(String(message.url))) {
          await vscode.env.openExternal(vscode.Uri.parse(String(message.url)));
        }
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(message.text || ''));
        break;
      case 'insertCode': {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await editor.edit((builder) => builder.replace(editor.selection, String(message.text || '')));
        }
        break;
      }
      case 'openInTab':
        await vscode.commands.executeCommand('perplexicode.openInTab');
        break;
      case 'runCompletionCommand': {
        const terminal = vscode.window.createTerminal({ name: 'PerplexiCode', cwd: this.currentTask?.toJSON().workspace });
        terminal.show();
        terminal.sendText(String(message.command || ''));
        break;
      }
      default:
        break;
    }
  }

  private async exportTask(id: string): Promise<void> {
    const persisted = id ? (this.tasks.get(id)?.toJSON() || await this.store.load(id)) : undefined;
    if (!persisted) {
      return;
    }
    const lines = [`# ${persisted.title}`, '', `Mode: ${persisted.mode} · ${new Date(persisted.createdAt).toISOString()}`, ''];
    for (const message of persisted.uiMessages) {
      if (message.type === 'user') {
        lines.push('## User', '', message.text || '', '');
      } else if (message.type === 'text' || message.type === 'completion' || message.type === 'followup') {
        lines.push(`## ${message.type === 'completion' ? 'Result' : 'PerplexiCode'}`, '', message.text || '', '');
      } else if (message.type === 'tool' && message.tool) {
        lines.push(`> ${message.tool.title}`, '');
      } else if (message.type === 'command' && message.command) {
        lines.push('```sh', message.command.command, '```', '', message.command.output ? `\`\`\`\n${message.command.output}\n\`\`\`\n` : '');
      }
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `perplexicode-task-${persisted.id}.md`)),
      filters: { Markdown: ['md'] },
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(lines.join('\n'), 'utf8'));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  private schedulePostState(): void {
    if (this.stateTimer) {
      return;
    }
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.postState();
    }, 50);
  }

  postState(includeMessages = false, target?: WebviewTarget): void {
    const task = this.currentTask;
    const accounts = this.accountManager.getAccounts();
    const planSetting = vscode.workspace.getConfiguration('perplexicode').get<string>('subscriptionPlan', 'auto');
    const state = {
      type: 'state',
      version: this.context.extension.packageJSON.version,
      includeMessages,
      task: task ? {
        id: task.id,
        parentId: task.parentId,
        title: task.title,
        mode: task.mode,
        status: task.status,
        todos: task.todos,
        busy: task.isBusy,
        messages: includeMessages ? task.uiMessages : undefined,
        depth: this.stack.length - 1,
        parentTitle: this.stack.length > 1 ? this.stack[this.stack.length - 2].title : undefined,
      } : null,
      mode: this.selection.mode,
      modes: MODES.map((mode) => ({ slug: mode.slug, name: mode.name, description: mode.description, icon: mode.icon })),
      models: this.models.map((model) => ({
        id: model.id,
        label: model.label,
        description: model.description,
        category: model.category,
        supportsThinking: model.supportsThinking,
        requiredPlan: model.requiredPlan,
        isNew: model.isNew === true,
        surfaced: model.surfaced !== false,
        selectable: model.selectable !== false,
        provider: model.provider || null,
      })),
      selection: {
        modelId: this.selection.modelId,
        thinking: this.getSelection().thinking,
        webSearch: this.selection.webSearch,
        modelLabel: getModelLabel(this.selection.modelId, this.getSelection().thinking),
        modeWebSearchDefault: getModeBySlug(this.selection.mode).webSearchDefault,
      },
      settings: this.getSettings(),
      general: {
        subscriptionPlan: planSetting,
        rotationStrategy: this.rotationEngine.getStrategy(),
        revealEditedFiles: vscode.workspace.getConfiguration('perplexicode.agent').get<boolean>('revealEditedFiles', true),
        modelsSnapshot: getBundledSnapshotDate(),
      },
      accounts: accounts.map((account) => ({
        id: account.id,
        alias: account.alias,
        status: account.status,
        plan: account.capabilities?.plan || 'unknown',
        email: account.capabilities?.email,
        queriesToday: account.queriestoday,
        queriesTotal: account.queriesTotalLifetime,
        lastUsedAt: account.lastUsedAt,
        quotas: {
          pro: formatQuotaSummary(account.quotas?.modes?.pro_search),
          research: formatQuotaSummary(account.quotas?.modes?.research),
          labs: formatQuotaSummary(account.quotas?.modes?.labs),
          free: formatQuotaSummary(getQuotaItem(account, 'free_queries')),
        },
      })),
      history: this.store.list().filter((item) => !item.parentId).slice(0, 200),
      workspace: this.workspaceRoot() || null,
    };
    this.post(state, target);
    this.stateEmitter.fire();
  }

  // ---------------------------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------------------------

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'agent-webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'agent-webview.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>PerplexiCode</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

interface GitApi {
  repositories: Array<{ rootUri: vscode.Uri; inputBox: { value: string } }>;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... truncated ${text.length - max} characters ...]` : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export type { UiMessage };
