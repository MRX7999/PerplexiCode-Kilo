import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatQuotaSummary, getQuotaItem, setPlanOverride } from '../api/capabilityFetcher';
import {
  compareModels,
  COMPUTE_MODES,
  getBundledSnapshotDate,
  getComputeModeOption,
  getModelLabel,
  isValidComputeModeInput,
  ModelInfo,
  normalizeComputeMode,
  resolveComputeRoute,
} from '../api/modelCatalog';
import { ModelFetcher } from '../api/modelFetcher';
import { RotationEngine } from '../api/rotationEngine';
import { AccountPlan, ComputeMode, RotationStrategy } from '../api/types';
import { loadMcpServers, McpRegistry, McpServerState, parseMcpPromptArgs, removeMcpServerConfig, saveMcpServerConfig } from '../core/mcp';
import { buildMcpCatalogConfig, findMcpCatalogEntry, installMcpCatalogEntry, MCP_CATALOG } from '../core/mcpCatalog';
import { McpCredentialCache } from '../core/mcpCredentials';
import { createMcpOAuthRuntimeProvider, performMcpOAuthLogin, SecretStorageMcpOAuthStore } from '../core/mcpOAuth';
import { RemoteCoreClient } from '../core/remoteCore';
import { AccountManager } from '../storage/accountManager';
import { runInlineQuickEdit } from './inlineQuickEdit';
import { DEFAULT_MODE_SLUG, getModeBySlug, MODES } from './modes';
import { AgentTask, AskResponse } from './task';
import { CoreBridge } from './coreBridge';
import { compactMessages } from '../core/compaction';
import { buildDiagnosticBundle, serializeDiagnosticBundle } from '../core/diagnostics';
import { loadSettings } from '../core/settings';
import { describeResolvedSkill, installedSkillOrigins, installResolvedSkill, ResolvedSkill, resolveSkillSource, scanResolvedSkill, searchSkills } from '../core/skillSources';
import {
  applyWorktreeChanges,
  buildWorktreeResultCard,
  createIsolatedWorktree,
  discardWorktreeChanges,
  inspectMainCheckoutDirty,
  IsolatedWorktreeHandle,
  isReadOnlySubagentTarget,
  runWithConcurrencyLimit,
} from '../core/worktree';
import {
  applyPresetPrompt,
  createCustomAgent,
  createCustomSkill,
  deletePresetFromFile,
  installAgentPreset,
  installSkillPreset,
  LibraryScope,
  LibrarySnapshot,
  librarySnapshot,
  normalizeName,
  removeLibraryItem,
  savePresetToFile,
  WriteResult,
} from '../core/library';
import { TaskStore } from './taskStore';
import { listFilesTool, readFileTool, replaceExistingFunctionOnInsert, resolveWorkspacePath, toPosixRelative } from './tools';
import { PerplexityTransport, TransportError } from './transport';
import { AgentSettings, ModelSelection, PersistedTask, UiMessage } from './types';
import type { TodoItem } from './toolParser';
import * as os from 'os';
import { VsCodeAgentHost } from './vscodeHost';
import { onDidChangeFallbackSetting, readSetting, writeSetting } from '../config/settingsStore';

type WebviewTarget = vscode.Webview;

const SELECTION_KEY = 'perplexicode.agent.selection';

interface StoredSelection {
  modelId: string;
  thinking: boolean;
  webSearch: boolean | null;
  mode: string;
  /** 3.3: Perplexity compute mode (search | light | standard | high | ultra | research | labs). */
  computeMode?: ComputeMode;
}

/**
 * Owns the agent tasks and synchronises every PerplexiCode webview (sidebar and editor tabs).
 */
export class AgentController implements vscode.Disposable {
  private readonly webviews = new Set<WebviewTarget>();
  private readonly tasks = new Map<string, AgentTask>();
  /** Subagent name a task runs as (presets / agent picker / delegation). */
  private readonly taskAgents = new Map<string, string>();
  /** 3.7 (F16/F17): Active isolated git worktrees keyed by task ID. */
  private readonly taskWorktrees = new Map<string, IsolatedWorktreeHandle>();
  /** 3.0 core: permissions, hooks, verify, subagents, shared session journal. */
  readonly core: CoreBridge;
  /** Stack of tasks; the last element is the one shown in the UI (child tasks on top). */
  private stack: AgentTask[] = [];
  private selection: StoredSelection;
  private models: ModelInfo[] = [];
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private stateTimer?: NodeJS.Timeout;
  /** 3.1 library snapshot (installed subagents/skills, catalog, task presets). Refreshed on change. */
  private library?: LibrarySnapshot;
  private libraryTimer?: NodeJS.Timeout;
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the UI state (selection, task, models) is re-published. */
  readonly onDidChangeState = this.stateEmitter.event;
  /** 3.3 MCP registries, one per workspace folder (servers from ~/.claude.json, .mcp.json, settings). */
  private readonly mcpRegistries = new Map<string, McpRegistry>();
  private mcpTimer?: NodeJS.Timeout;
  private readonly mcpCredentials: McpCredentialCache;
  private readonly mcpOAuthStore: SecretStorageMcpOAuthStore;
  private readonly mcpOAuthAuthenticated = new Set<string>();
  private mcpCatalogInstalling = false;

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
    this.mcpCredentials = new McpCredentialCache(context.secrets);
    this.mcpOAuthStore = new SecretStorageMcpOAuthStore(context.secrets);
    this.core = new CoreBridge((line) => this.output.appendLine(line));
    const stored = context.globalState.get<StoredSelection>(SELECTION_KEY);
    const configuredDefault = readSetting<string>('perplexicodeKilo.defaultModel', 'turbo');
    const configuredCompute = readSetting<string>('perplexicodeKilo.computeMode', 'search');
    this.selection = {
      modelId: stored?.modelId || configuredDefault || 'turbo',
      thinking: stored?.thinking ?? false,
      webSearch: stored?.webSearch ?? null,
      mode: stored?.mode || DEFAULT_MODE_SLUG,
      computeMode: stored?.computeMode && isValidComputeModeInput(stored.computeMode)
        ? normalizeComputeMode(stored.computeMode)
        : isValidComputeModeInput(configuredCompute) ? normalizeComputeMode(configuredCompute) : 'search',
    };
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('perplexicodeKilo')) {
        this.applyPlanOverride();
        this.postState();
      }
    }));
    this.disposables.push(onDidChangeFallbackSetting(() => {
      this.applyPlanOverride();
      this.postState();
    }));
    this.applyPlanOverride();
    // Keep the library in sync with files edited by hand, by `pcode` or by Claude Code.
    const watcher = vscode.workspace.createFileSystemWatcher('**/{.perplexicode,.claude}/{agents,skills,presets.json}{,/**}');
    const onLibraryFile = () => this.scheduleLibraryRefresh();
    watcher.onDidCreate(onLibraryFile);
    watcher.onDidChange(onLibraryFile);
    watcher.onDidDelete(onLibraryFile);
    this.disposables.push(watcher);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleLibraryRefresh()));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('perplexicodeKilo.taskPresets')) {
        this.scheduleLibraryRefresh();
      }
      if (event.affectsConfiguration('perplexicodeKilo.mcp')) {
        this.scheduleMcpReload();
      }
    }));
    // MCP server definitions edited by hand, by `pcode mcp add` or by Claude Code.
    const mcpWatcher = vscode.workspace.createFileSystemWatcher('**/{.mcp.json,.mcp.local.json,.claude/.mcp.json,.claude/mcp.json,.perplexicode/mcp.json,.claude/settings.json,.claude/settings.local.json,.perplexicode/settings.json,.perplexicode/settings.local.json}');
    const onMcpFile = () => this.scheduleMcpReload();
    mcpWatcher.onDidCreate(onMcpFile);
    mcpWatcher.onDidChange(onMcpFile);
    mcpWatcher.onDidDelete(onMcpFile);
    this.disposables.push(mcpWatcher);
    this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
      for (const registry of this.mcpRegistries.values()) {
        registry.setTrustProject(true);
      }
      this.scheduleMcpReload();
    }));
  }

  dispose(): void {
    this.stateEmitter.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.stack.forEach((task) => task.abort());
    this.remoteClient?.close();
    this.remoteClient = undefined;
    for (const registry of this.mcpRegistries.values()) {
      void registry.closeAll().catch(() => undefined);
    }
    this.mcpRegistries.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // 4.0 Remote Core (`pcode serve`, F26) & Inline Quick Edit (`Cmd/Ctrl+I`, F31)
  // ---------------------------------------------------------------------------------------------

  private remoteClient?: RemoteCoreClient;
  private quickEditDocs = new Map<string, string>();
  private quickEditEmitter?: vscode.EventEmitter<vscode.Uri>;

  get isRemoteConnected(): boolean {
    return Boolean(this.remoteClient?.connected);
  }

  async connectRemoteCore(): Promise<void> {
    const configuredUrl = readSetting<string>('perplexicodeKilo.remote.url', '').trim();
    const endpoint =
      configuredUrl
      || (
        await vscode.window.showInputBox({
          title: 'Connect to Remote Core (pcode serve)',
          prompt: 'Enter Unix socket (unix:///path/to/serve.sock) or WebSocket URL (ws://127.0.0.1:4190)',
          placeHolder: 'unix:///Users/you/.perplexicode/serve.sock or ws://127.0.0.1:4190',
        })
      )?.trim();
    if (!endpoint) {
      return;
    }

    const secretKey = 'perplexicode.remote.token';
    let token = (await this.context.secrets.get(secretKey))?.trim() || '';
    if (!token) {
      const entered = await vscode.window.showInputBox({
        title: 'Remote Core Bearer Token',
        prompt: 'Paste the bearer token for pcode serve (stored in OS SecretStorage; Perplexity cookies stay local)',
        password: true,
      });
      if (!entered || !entered.trim()) {
        return;
      }
      token = entered.trim();
      await this.context.secrets.store(secretKey, token);
    }

    this.remoteClient?.close();
    const client = new RemoteCoreClient({
      endpoint,
      token,
      localCompletionProvider: this.transport,
    });
    await client.connect();
    this.remoteClient = client;
    if (configuredUrl !== endpoint) {
      await writeSetting('perplexicodeKilo.remote.url', endpoint);
    }
    this.output.appendLine(`[remote] Connected to pcode serve at ${endpoint} (remote cwd: ${client.cwd}); Perplexity sessions stay local.`);
    void vscode.window.showInformationMessage(`PerplexiCode: Connected to remote core (${client.cwd}). Perplexity sessions remain local.`);
    this.postState();
  }

  async disconnectRemoteCore(clearSavedToken = false): Promise<void> {
    this.remoteClient?.close();
    this.remoteClient = undefined;
    if (clearSavedToken) {
      await this.context.secrets.delete('perplexicode.remote.token');
    }
    this.output.appendLine('[remote] Disconnected from remote core.');
    void vscode.window.showInformationMessage('PerplexiCode: Disconnected from remote core.');
    this.postState();
  }

  private ensureQuickEditProvider(): vscode.EventEmitter<vscode.Uri> {
    if (!this.quickEditEmitter) {
      this.quickEditEmitter = new vscode.EventEmitter<vscode.Uri>();
      const provider = vscode.workspace.registerTextDocumentContentProvider('perplexicode-quickedit', {
        onDidChange: this.quickEditEmitter.event,
        provideTextDocumentContent: (uri) => this.quickEditDocs.get(uri.toString()) ?? '',
      });
      this.disposables.push(this.quickEditEmitter, provider);
    }
    return this.quickEditEmitter;
  }

  async quickEditSelection(editorArg?: vscode.TextEditor): Promise<void> {
    const editor = editorArg || vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('PerplexiCode: Select some code in the editor to use Quick Edit (Cmd/Ctrl+I).');
      return;
    }

    const instruction = await vscode.window.showInputBox({
      title: 'PerplexiCode: Quick Edit Selection (Cmd/Ctrl+I)',
      prompt: 'Describe how to change the selected code',
      placeHolder: 'For example: rewrite with async/await and add error handling',
    });
    if (!instruction || !instruction.trim()) {
      return;
    }

    const doc = editor.document;
    const selectionRange = new vscode.Range(editor.selection.start, editor.selection.end);
    const fullText = doc.getText();
    const startOffset = doc.offsetAt(selectionRange.start);
    const endOffset = doc.offsetAt(selectionRange.end);
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);

    const emitter = this.ensureQuickEditProvider();
    const sessionKey = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const beforeUri = vscode.Uri.parse(`perplexicode-quickedit:/before/${sessionKey}/${encodeURIComponent(path.basename(doc.fileName))}`);
    const afterUri = vscode.Uri.parse(`perplexicode-quickedit:/after/${sessionKey}/${encodeURIComponent(path.basename(doc.fileName))}`);
    this.quickEditDocs.set(beforeUri.toString(), fullText);
    this.quickEditDocs.set(afterUri.toString(), fullText);

    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      `PerplexiCode Quick Edit: ${path.basename(doc.fileName)} (streaming diff)`,
      { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside }
    );

    const selection = this.getSelection();
    let finalReplacement: string | undefined;
    let diffStatsLabel = '';

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `PerplexiCode: Editing ${relPath}…`,
          cancellable: true,
        },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const snapshot = await runInlineQuickEdit({
            provider: this.transport,
            baseModelId: selection.baseModelId,
            filePath: relPath,
            languageId: doc.languageId,
            fullDocumentText: fullText,
            selectionStartOffset: startOffset,
            selectionEndOffset: endOffset,
            instruction,
            signal: abort.signal,
            onStreamSnapshot: (snap) => {
              this.quickEditDocs.set(afterUri.toString(), snap.previewFullDocument);
              emitter.fire(afterUri);
              progress.report({ message: `+${snap.added} / -${snap.removed} lines` });
            },
          });
          if (!abort.signal.aborted) {
            finalReplacement = snapshot.replacementCode;
            diffStatsLabel = `+${snapshot.added} / -${snapshot.removed}`;
          }
        }
      );

      if (finalReplacement === undefined) {
        return;
      }

      const choice = await vscode.window.showInformationMessage(
        `PerplexiCode: Apply the quick edit to ${relPath} (${diffStatsLabel})?`,
        'Apply Edit',
        'Cancel'
      );
      if (choice === 'Apply Edit') {
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(doc.uri, selectionRange, finalReplacement);
        await vscode.workspace.applyEdit(wsEdit);
      }
    } finally {
      this.quickEditDocs.delete(beforeUri.toString());
      this.quickEditDocs.delete(afterUri.toString());
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 3.3 MCP servers
  // ---------------------------------------------------------------------------------------------

  private mcpEnabled(): boolean {
    return readSetting<boolean>('perplexicodeKilo.mcp.enabled', true);
  }

  /** Registry for a workspace folder; created lazily, servers connect on the first request that needs them. */
  mcpFor(cwd: string): McpRegistry | undefined {
    if (!this.mcpEnabled()) {
      return undefined;
    }
    const key = path.resolve(cwd);
    let registry = this.mcpRegistries.get(key);
    if (!registry) {
      registry = new McpRegistry({
        cwd: key,
        trustProject: vscode.workspace.isTrusted,
        extraConfigs: readSetting<string[]>('perplexicodeKilo.mcp.extraConfigs', []),
        serverEnv: (name, _scope, file, raw) => this.mcpCredentials.env(file, name, raw),
        oauthProvider: createMcpOAuthRuntimeProvider(this.mcpOAuthStore),
        log: (line) => this.output.appendLine(line),
      });
      this.mcpRegistries.set(key, registry);
    }
    return registry;
  }

  private scheduleMcpReload(): void {
    if (this.mcpTimer) {
      clearTimeout(this.mcpTimer);
    }
    this.mcpTimer = setTimeout(() => {
      this.mcpTimer = undefined;
      if (!this.mcpEnabled()) {
        for (const registry of this.mcpRegistries.values()) {
          void registry.closeAll().catch(() => undefined);
        }
        this.mcpRegistries.clear();
      } else {
        for (const registry of this.mcpRegistries.values()) {
          registry.reloadConfigs();
        }
      }
      this.postState();
    }, 300);
  }

  private mcpStates(): McpServerState[] {
    const cwd = this.currentTask?.toJSON().workspace || this.workspaceRoot() || os.homedir();
    const registry = this.mcpFor(cwd);
    if (!registry) {
      return [];
    }
    registry.reloadConfigs();
    const states = registry.getStates();
    void this.refreshMcpOAuthFlags(states);
    return states;
  }

  private async refreshMcpOAuthFlags(states: McpServerState[]): Promise<void> {
    let changed = false;
    for (const s of states) {
      if (s.config.type === 'stdio' || !s.config.url) continue;
      const key = `${s.config.name}::${s.config.url}`;
      const existing = await this.mcpOAuthStore.get(s.config.name, s.config.url).catch(() => undefined);
      const hasToken = Boolean(existing?.accessToken);
      if (hasToken !== this.mcpOAuthAuthenticated.has(key)) {
        if (hasToken) this.mcpOAuthAuthenticated.add(key);
        else this.mcpOAuthAuthenticated.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.postState();
    }
  }

  /** F21: OAuth 2.0 + PKCE login for an HTTP/SSE MCP server, storing tokens in VS Code SecretStorage. */
  async mcpOAuthLogin(name?: string): Promise<void> {
    const cwd = this.currentTask?.toJSON().workspace || this.workspaceRoot() || os.homedir();
    const extraConfigs = readSetting<string[]>('perplexicodeKilo.mcp.extraConfigs', []);
    const servers = loadMcpServers(cwd, { extraConfigs }).filter((s) => s.type !== 'stdio' && Boolean(s.url));
    if (servers.length === 0) {
      void vscode.window.showInformationMessage('PerplexiCode: no HTTP/SSE MCP servers are configured for OAuth sign-in.');
      return;
    }
    let targetName = name;
    if (!targetName) {
      const picked = await vscode.window.showQuickPick(
        servers.map((s) => ({ label: s.name, description: s.url, detail: `${s.type} · ${s.scope}` })),
        { placeHolder: 'Pick an HTTP/SSE MCP server to sign in with OAuth' }
      );
      if (!picked) return;
      targetName = picked.label;
    }
    const server = servers.find((s) => s.name === targetName);
    if (!server || !server.url) {
      void vscode.window.showErrorMessage(`PerplexiCode: HTTP/SSE MCP server '${targetName}' not found.`);
      return;
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `PerplexiCode: OAuth sign-in to MCP '${server.name}' (waiting for the browser)…`,
          cancellable: true,
        },
        async (_progress, cancellationToken) => {
          const abort = new AbortController();
          cancellationToken.onCancellationRequested(() => abort.abort());
          await performMcpOAuthLogin({
            serverName: server.name,
            serverUrl: server.url!,
            store: this.mcpOAuthStore,
            oauthConfig: server.oauth,
            signal: abort.signal,
            openAuthorizationUrl: async (authUrl) => {
              await vscode.env.openExternal(vscode.Uri.parse(authUrl));
            },
          });
        }
      );
      this.mcpOAuthAuthenticated.add(`${server.name}::${server.url}`);
      void vscode.window.showInformationMessage(`PerplexiCode: OAuth token for MCP '${server.name}' saved to SecretStorage.`);
      await this.mcpConnect(server.name);
    } catch (error) {
      const msg = (error as Error).message || String(error);
      this.output.appendLine(`[mcp-oauth] login error (${server.name}): ${msg}`);
      void vscode.window.showErrorMessage(`PerplexiCode: OAuth sign-in to '${server.name}' failed: ${msg}`);
    } finally {
      this.postState();
    }
  }

  /** F21: Removes stored MCP OAuth tokens from VS Code SecretStorage. */
  async mcpOAuthLogout(name?: string): Promise<void> {
    const cwd = this.currentTask?.toJSON().workspace || this.workspaceRoot() || os.homedir();
    const extraConfigs = readSetting<string[]>('perplexicodeKilo.mcp.extraConfigs', []);
    const servers = loadMcpServers(cwd, { extraConfigs }).filter((s) => s.type !== 'stdio' && Boolean(s.url));
    if (servers.length === 0) {
      void vscode.window.showInformationMessage('PerplexiCode: no HTTP/SSE MCP servers are configured.');
      return;
    }
    let targetName = name;
    if (!targetName) {
      const picked = await vscode.window.showQuickPick(
        servers.map((s) => ({ label: s.name, description: s.url, detail: `${s.type} · ${s.scope}` })),
        { placeHolder: 'Pick an HTTP/SSE MCP server to remove its OAuth token' }
      );
      if (!picked) return;
      targetName = picked.label;
    }
    const server = servers.find((s) => s.name === targetName);
    if (!server || !server.url) return;
    await this.mcpOAuthStore.remove(server.name, server.url);
    this.mcpOAuthAuthenticated.delete(`${server.name}::${server.url}`);
    void vscode.window.showInformationMessage(`PerplexiCode: OAuth token for MCP '${server.name}' removed from SecretStorage.`);
    this.postState();
  }

  /** F22: Resolves an MCP prompt (`/server:skill`) and dispatches its expanded text to the agent. */
  private async runMcpPrompt(serverName: string, promptName: string, rawArgs: string): Promise<void> {
    const cwd = this.currentTask?.toJSON().workspace || this.workspaceRoot() || os.homedir();
    await this.restoreMcpCredentials(cwd);
    const registry = this.mcpFor(cwd);
    if (!registry) {
      void vscode.window.showErrorMessage('PerplexiCode: MCP is turned off (perplexicodeKilo.mcp.enabled).');
      return;
    }
    try {
      await registry.ensureConnected();
      const promptDef = registry.getAllPrompts().find((p) => p.server === serverName && p.name === promptName);
      const parsedArgs = parseMcpPromptArgs(rawArgs || '', promptDef?.arguments);
      const expanded = await registry.getPrompt(serverName, promptName, parsedArgs);
      await this.sendMessage(expanded, []);
    } catch (error) {
      const msg = (error as Error).message || String(error);
      this.output.appendLine(`[mcp-prompt] ${serverName}:${promptName} failed: ${msg}`);
      void vscode.window.showErrorMessage(`PerplexiCode: MCP prompt ${serverName}:${promptName} failed: ${msg}`);
    }
  }

  /** Connects every configured server (or one) and republishes the state. */
  async mcpConnect(name?: string): Promise<void> {
    const cwd = this.currentTask?.toJSON().workspace || this.workspaceRoot() || os.homedir();
    await this.restoreMcpCredentials(cwd);
    const registry = this.mcpFor(cwd);
    if (!registry) {
      void vscode.window.showInformationMessage('PerplexiCode: MCP is disabled (perplexicodeKilo.mcp.enabled).');
      return;
    }
    try {
      registry.reloadConfigs();
      if (name) {
        await registry.connectServer(name);
      } else {
        await registry.connectAll();
      }
    } catch (error) {
      this.output.appendLine(`[mcp] ${(error as Error).message}`);
    } finally {
      this.postState();
    }
  }

  private async restoreMcpCredentials(cwd: string): Promise<void> {
    const files = [
      path.join(os.homedir(), '.perplexicode', 'mcp.json'),
      path.join(cwd, '.mcp.json'),
      path.join(cwd, '.perplexicode', 'settings.local.json'),
    ];
    for (const entry of MCP_CATALOG) {
      const variables = entry.inputs.filter((input) => input.secret).map((input) => input.key);
      if (!variables.length) continue;
      for (const file of files) await this.mcpCredentials.restore(file, entry.id, variables);
    }
    this.mcpRegistries.get(path.resolve(cwd))?.reloadConfigs();
  }

  /** Native prompts keep credentials out of webview messages, settings and the transcript. */
  private async mcpCatalogInstall(id: string, requestedScope: string): Promise<void> {
    if (this.mcpCatalogInstalling) return;
    this.mcpCatalogInstalling = true;
    try {
      const entry = findMcpCatalogEntry(id);
      if (!entry) throw new Error('Unknown MCP catalog entry.');
      if (!entry.config) {
        await vscode.env.openExternal(vscode.Uri.parse(entry.docsUrl));
        return;
      }
      const cwd = this.workspaceRoot() || os.homedir();
      const scope = requestedScope === 'user' ? 'user' : requestedScope === 'local' ? 'local' : 'project';
      if (scope !== 'user' && !this.workspaceRoot()) throw new Error('Open a workspace or choose Global.');
      if (loadMcpServers(cwd).some((server) => server.name === id)) {
        throw new Error('This server is already configured. Remove it explicitly before installing a catalog replacement.');
      }
      const confirm = await vscode.window.showWarningMessage(
        `Add ${entry.title} to ${scope === 'user' ? 'all projects' : 'this project'}? ${entry.requirements.join('; ')}. ${entry.notes} This saves an enabled configuration only. Your next task may connect this server and download/run the declared npm/uv package. Tool permissions are unchanged.`,
        { modal: true }, 'Add configuration'
      );
      if (confirm !== 'Add configuration') return;
      const values: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const input of entry.inputs) {
        if (input.secret) {
          const value = await vscode.window.showInputBox({
            title: `${entry.title}: ${input.label}`,
            prompt: `${input.key}: stored in VS Code SecretStorage, not in config. Leave empty to use your environment; CLI must supply its own environment.`,
            password: true, ignoreFocusOut: true,
          });
          if (value === undefined) return;
          if (value) secrets[input.key] = value;
        } else {
          const fallback = (input.default || '').replace(/\{cwd\}/g, () => cwd);
          const value = await vscode.window.showInputBox({
            title: `${entry.title}: ${input.label}`,
            value: fallback, ignoreFocusOut: true,
            validateInput: (value) => input.required && !value.trim() ? `${input.label} is required.` : undefined,
          });
          if (value === undefined) return;
          if (value.trim()) values[input.key] = value.trim();
        }
      }
      // Validate everything before modifying files or persisting secrets.
      buildMcpCatalogConfig(id, values, cwd);
      const file = installMcpCatalogEntry(id, scope, { cwd, values });
      try {
        await this.mcpCredentials.save(file, id, secrets);
      } catch {
        // Do not leave a newly enabled config after credential storage fails.
        await this.mcpCredentials.remove(file, id, Object.keys(secrets)).catch(() => undefined);
        const rollback = removeMcpServerConfig(cwd, id, scope);
        throw new Error(rollback.removed
          ? 'Credential storage failed; the new MCP configuration was removed. Retry or supply tokens through your environment.'
          : 'Credential storage failed. Remove the new MCP configuration before retrying.');
      }
      this.scheduleMcpReload();
      void vscode.window.showInformationMessage(`${entry.title}: configuration added. No server started and tool permissions are unchanged.`);
    } catch (error) {
      // Error text comes from validation / file writes, never includes entered secret values.
      void vscode.window.showErrorMessage(`PerplexiCode MCP catalog: ${(error as Error).message}`);
    } finally {
      this.mcpCatalogInstalling = false;
      this.postState();
    }
  }

  private async mcpAdd(message: { name?: string; target?: string; scope?: string; transport?: string; env?: string; headers?: string }): Promise<void> {
    const name = String(message.name || '').trim();
    const target = String(message.target || '').trim();
    if (!name || !target) {
      void vscode.window.showWarningMessage('PerplexiCode: an MCP server needs a name and a command or URL.');
      return;
    }
    const cwd = this.workspaceRoot();
    const scope = message.scope === 'user' || !cwd ? 'user' : message.scope === 'local' ? 'local' : 'project';
    const isUrl = /^https?:\/\//i.test(target);
    const transport = message.transport === 'http' || message.transport === 'sse' || message.transport === 'stdio'
      ? message.transport
      : isUrl ? 'http' : 'stdio';
    if (transport === 'stdio' && isUrl) {
      void vscode.window.showWarningMessage('PerplexiCode: stdio servers need a command, not a URL.');
      return;
    }
    if (transport !== 'stdio' && !isUrl) {
      void vscode.window.showWarningMessage('PerplexiCode: http/sse servers need an http(s) URL.');
      return;
    }
    const parsePairs = (text: string | undefined, separator: '=' | ':'): Record<string, string> | undefined => {
      const result: Record<string, string> = {};
      for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const index = trimmed.indexOf(separator);
        if (index <= 0) throw new Error(`Expected KEY${separator}VALUE, got '${trimmed}'.`);
        result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
      }
      return Object.keys(result).length > 0 ? result : undefined;
    };
    try {
      const parts = transport === 'stdio' ? splitCommandLine(target) : [target];
      const file = saveMcpServerConfig(cwd || os.homedir(), name, {
        type: transport,
        command: transport === 'stdio' ? parts[0] : undefined,
        args: transport === 'stdio' ? parts.slice(1) : undefined,
        url: transport !== 'stdio' ? target : undefined,
        env: parsePairs(message.env, '='),
        headers: parsePairs(message.headers, ':'),
      }, scope);
      this.output.appendLine(`[mcp] saved ${name} (${transport}, ${scope}) → ${file}`);
      await this.mcpConnect(name);
    } catch (error) {
      void vscode.window.showErrorMessage(`PerplexiCode: ${(error as Error).message}`);
    }
  }

  private async mcpRemove(name: string, scope?: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(`Remove MCP server "${name}" from the configuration files?`, { modal: true }, 'Remove');
    if (confirm !== 'Remove') {
      return;
    }
    const cwd = this.workspaceRoot() || os.homedir();
    const entry = findMcpCatalogEntry(name);
    const variables = entry?.inputs.filter((input) => input.secret).map((input) => input.key) || [];
    const files = [
      ...(scope === 'user' || !scope ? [path.join(os.homedir(), '.perplexicode', 'mcp.json')] : []),
      ...(scope === 'project' || !scope ? [path.join(cwd, '.mcp.json')] : []),
      ...(scope === 'local' || !scope ? [path.join(cwd, '.perplexicode', 'settings.local.json')] : []),
    ];
    try {
      const result = removeMcpServerConfig(cwd, name, scope === 'user' || scope === 'project' || scope === 'local' ? scope : undefined);
      if (result.removed) {
        for (const file of files) await this.mcpCredentials.remove(file, name, variables);
      }
      if (!result.removed) {
        void vscode.window.showWarningMessage(`PerplexiCode: "${name}" was not found in a writable MCP config (it may come from ~/.claude.json).`);
      }
    } finally {
      this.scheduleMcpReload();
    }
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
    const config = { get: <T>(key: string, defaultValue: T): T => readSetting<T>(`perplexicodeKilo.agent.${key}`, defaultValue) };
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
        mcp: config.get<boolean>('autoApprove.mcp', false),
        web: config.get<boolean>('autoApprove.web', false),
      },
      allowedCommands: config.get<string[]>('allowedCommands', [
        'git status',
        'git diff',
        'git log',
        'npm test',
        'npm run lint',
        'npm run build',
        'tsc --noEmit',
      ]),
      deniedCommands: config.get<string[]>('deniedCommands', ['rm -rf /', 'sudo rm', ':(){:|:&};:']),
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
      stopOnFallback: config.get<boolean>('stopOnFallback', false),
      repoMapEnabled: config.get<boolean>('repoMapEnabled', true),
      repoMapMaxChars: clamp(config.get<number>('repoMapMaxChars', 6000), 500, 60000),
      autoCompactThreshold: (() => {
        const raw = config.get<number>('autoCompactThreshold', 0.8);
        return raw <= 0 ? 0 : Math.min(0.98, Math.max(0.3, raw));
      })(),
      autoCompactKeepSteps: clamp(config.get<number>('autoCompactKeepSteps', 4), 1, 20),
      worktreeEnabled: config.get<boolean>('worktreeEnabled', false),
      maxParallelSubtasks: clamp(config.get<number>('maxParallelSubtasks', 3), 1, 16),
      crossModelReview: config.get<boolean>('crossModelReview', false),
      crossModelReviewModel: config.get<string>('crossModelReviewModel', '').trim() || undefined,
      autoSkills: config.get<boolean>('autoSkills', false),
      skillRegistries: config.get<Array<'clawhub' | 'skills-sh'>>('skillRegistries', ['clawhub', 'skills-sh']),
    };
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    if (key === 'permissionMode') {
      this.core.setPermissionMode(undefined);
    }
    const [section, ...rest] = key.split('.');
    const fullKey = section === 'root' ? `perplexicodeKilo.${rest.join('.')}` : `perplexicodeKilo.agent.${key}`;
    const target = await writeSetting(fullKey, value);
    if (target === 'fallback') {
      this.output.appendLine(`Saved ${fullKey} in the fallback store (setting not registered in this window yet; reload to finish the update).`);
    }
    this.currentTask?.recheckPendingApproval();
  }

  private applyPlanOverride(): void {
    const plan = readSetting<string>('perplexicodeKilo.subscriptionPlan', 'auto');
    setPlanOverride(plan === 'auto' ? undefined : (plan as AccountPlan));
  }

  getSelection(): ModelSelection {
    const model = this.models.find((entry) => entry.id === this.selection.modelId);
    return {
      baseModelId: this.selection.modelId,
      thinking: Boolean(this.selection.thinking && model?.supportsThinking),
      webSearch: this.selection.webSearch === null ? undefined : this.selection.webSearch,
      computeMode: this.selection.computeMode && this.selection.computeMode !== 'search' ? this.selection.computeMode : undefined,
    };
  }

  getComputeMode(): ComputeMode {
    return this.selection.computeMode || 'search';
  }

  /** "GPT-6 Astra · Computer high" style label for the status bar and request rows. */
  getSelectionLabel(): string {
    const selection = this.getSelection();
    const base = getModelLabel(selection.baseModelId, selection.thinking);
    return selection.computeMode ? `${base} · ${getComputeModeOption(selection.computeMode).label}` : base;
  }

  async setComputeMode(mode: string): Promise<void> {
    if (!isValidComputeModeInput(mode)) {
      return;
    }
    this.selection.computeMode = normalizeComputeMode(mode);
    await this.saveSelection();
    this.postState();
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
    if (this.currentTask && (!this.currentTask.isBusy || this.currentTask.status.askKind === 'completion_result')) {
      this.currentTask.setMode(mode);
    }
    this.postState();
  }

  /** Switches the visible view in every attached webview. */
  showView(view: 'chat' | 'history' | 'settings' | 'library'): void {
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

  /** Summarises the current task transcript with the selected model (Claude Code /compact). */
  async compactCurrentTask(focus?: string): Promise<{ before: number; after: number } | undefined> {
    const task = this.currentTask;
    if (!task) {
      return undefined;
    }
    if (task.isBusy && task.status.askKind === 'completion_result' && task.status.askId) {
      task.respond(task.status.askId, { response: 'yes' });
    }
    if (task.isBusy && task.status.askKind !== 'completion_result') {
      throw new Error('The task is running; compact it when it is idle.');
    }
    const compacted = await compactMessages({ provider: this.transport, selection: this.getSelection(), messages: task.apiMessages, focus });
    task.replaceHistory(compacted.messages);
    this.core.onEvent(task, { type: 'compacted', before: compacted.before, after: compacted.after });
    task.say({ type: 'info', text: `Context compacted: ${compacted.before} → ${compacted.after} messages.` });
    this.store.save(task.toJSON());
    this.postState();
    return { before: compacted.before, after: compacted.after };
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

  private buildTask(options: {
    mode: string;
    parentId?: string;
    restore?: PersistedTask;
    cwd?: string;
    agent?: string;
    worktree?: IsolatedWorktreeHandle;
  }): AgentTask {
    const baseCwd =
      options.restore?.workspace
      || options.cwd
      || (this.remoteClient?.connected ? this.remoteClient.cwd : undefined)
      || this.workspaceRoot()
      || os.homedir();
    const activeWorktree = options.worktree;
    const effectiveCwd = activeWorktree ? activeWorktree.worktreePath : baseCwd;
    const host =
      this.remoteClient?.connected && !activeWorktree
        ? this.remoteClient.createAgentHost()
        : new VsCodeAgentHost(effectiveCwd, () => readSetting<boolean>('perplexicodeKilo.agent.revealEditedFiles', true));
    const agent = options.agent ? this.core.findSubagent(effectiveCwd, options.agent) : undefined;
    const worktreeIsolation = activeWorktree
      ? {
          name: activeWorktree.name,
          worktreeRoot: activeWorktree.worktreePath,
          mainRepoRoot: activeWorktree.mainRepoRoot,
          baseCommit: activeWorktree.baseCommit,
          warningMessage: !options.parentId ? activeWorktree.warningMessage : undefined,
        }
      : undefined;
    const gate = this.core.createGate({
      cwd: effectiveCwd,
      host,
      parentId: options.parentId,
      agent,
      worktreeIsolation: worktreeIsolation
        ? { worktreeRoot: worktreeIsolation.worktreeRoot, mainRepoRoot: worktreeIsolation.mainRepoRoot }
        : undefined,
    });
    const readBatchSize = this.core.readBatchSize(effectiveCwd);
    const task = new AgentTask({
      gate,
      isSubtaskTarget: (slug) => this.core.subagents(effectiveCwd).some((entry) => entry.name === slug),
      readBatchSize: () => readBatchSize,
      host,
      provider: this.transport,
      getSettings: () => this.getSettings(),
      getSelection: () => this.getSelection(),
      getModelLabel: (modelId, thinking) => {
        const compute = this.getSelection().computeMode;
        return compute ? `${getModelLabel(modelId, thinking)} · ${getComputeModeOption(compute).label}` : getModelLabel(modelId, thinking);
      },
      mcp: this.mcpFor(effectiveCwd),
      mode: agent ? agent.mode : options.mode,
      parentId: options.parentId,
      restore: options.restore,
      worktreeIsolation,
      callbacks: {
        onEvent: (owner, event) => this.core.onEvent(owner, event),
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
        startParallelSubtasks: (parent, items, maxParallel) =>
          this.startParallelSubtasks(parent, items, maxParallel),
        persist: (owner) => this.store.save(owner.toJSON()),
        onCompleted: (owner) => {
          const report = this.core.finish(owner);
          if (report && report.status !== 'no_changes') {
            owner.say({ type: 'info', text: `Verification — ${this.core.label(report)}` });
            this.output.appendLine(`[core] ${owner.id} ${this.core.label(report)}`);
          }
          const wt = this.taskWorktrees.get(owner.id);
          if (wt && fs.existsSync(wt.worktreePath)) {
            const card = buildWorktreeResultCard(
              wt,
              report || { status: 'no_changes', detail: 'No edits', editedFiles: [], checks: [] },
              owner.status.worktreeCard?.state || 'pending',
              owner.status.worktreeCard?.conflictFiles || [],
              owner.status.worktreeCard?.statusMessage
            );
            owner.setWorktreeCard(card);
          }
          this.store.save(owner.toJSON());
          this.postState();
        },
      },
    });
    this.core.register(task);
    this.tasks.set(task.id, task);
    if (activeWorktree) {
      this.taskWorktrees.set(task.id, activeWorktree);
    } else if (
      options.restore?.worktreePath
      && options.restore.mainRepoRoot
      && options.restore.worktreeName
      && fs.existsSync(options.restore.worktreePath)
    ) {
      this.taskWorktrees.set(task.id, {
        name: options.restore.worktreeName,
        worktreePath: options.restore.worktreePath,
        mainRepoRoot: options.restore.mainRepoRoot,
        gitCommonDir: path.join(options.restore.mainRepoRoot, '.git'),
        baseCommit: options.restore.worktreeBaseCommit || 'HEAD',
        createdByHook: false,
        dirtyMainCheckout: Boolean(options.restore.worktreeWarning),
        dirtyMainFiles: [],
        warningMessage: options.restore.worktreeWarning,
      });
    }
    if (agent) {
      this.taskAgents.set(task.id, agent.name);
    }
    return task;
  }

  private async startSubtask(parent: AgentTask, mode: string, message: string, todos: TodoItem[]): Promise<string> {
    const cwd = parent.toJSON().workspace;
    const isAgent = !MODES.some((entry) => entry.slug === mode) && !!this.core.findSubagent(cwd, mode);
    const child = this.buildTask({ mode: isAgent ? 'code' : mode, parentId: parent.id, cwd, agent: isAgent ? mode : undefined });
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

  /**
   * 3.7 (F18): Parallel Orchestrator subagents in IDE.
   * Read-only subagents execute in the main tree; writing subagents each execute in an isolated git worktree.
   */
  private async startParallelSubtasks(
    parent: AgentTask,
    items: Array<{ mode: string; message: string; todos: TodoItem[] }>,
    maxParallel: number
  ): Promise<Array<{ mode: string; result: string; error?: string }>> {
    const parentSnap = parent.toJSON();
    const mainTreeCwd = parentSnap.mainRepoRoot || parentSnap.workspace;
    return runWithConcurrencyLimit(items, maxParallel, async (item, index) => {
      const subagent = !MODES.some((entry) => entry.slug === item.mode)
        ? this.core.findSubagent(mainTreeCwd, item.mode)
        : undefined;
      const readOnly = isReadOnlySubagentTarget(item.mode, subagent);
      let childWorktree: IsolatedWorktreeHandle | undefined;
      try {
        if (!readOnly) {
          childWorktree = await createIsolatedWorktree({
            cwd: mainTreeCwd,
            name: `sub-${index + 1}-${item.mode}`,
            taskId: `${parent.id}-sub-${index + 1}`,
            hooks: this.core.createHooksEngine(mainTreeCwd),
            permissionMode: this.core.permissionMode,
          });
        }
        const child = this.buildTask({
          mode: subagent ? subagent.mode : item.mode,
          parentId: parent.id,
          cwd: mainTreeCwd,
          agent: subagent?.name,
          worktree: childWorktree,
        });
        child.todos = item.todos;
        await child.start(item.message);
        this.store.save(child.toJSON());
        let textResult = child.completionResult
          ?? ([...child.uiMessages].reverse().find((m) => m.type === 'text' && m.text)?.text
            || `Subtask finished with state ${child.status.state}.`);
        if (childWorktree && fs.existsSync(childWorktree.worktreePath)) {
          const card = buildWorktreeResultCard(childWorktree, {
            status: child.hasEdits ? 'needs_review' : 'no_changes',
            detail: `Isolated subagent worktree '${childWorktree.name}'`,
            editedFiles: [],
            checks: [],
          });
          child.setWorktreeCard(card);
          textResult += `\n[Worktree: ${card.worktreeName} (${card.worktreePath}) | files: ${card.changedFiles.length}, +${card.totalAdditions}/-${card.totalDeletions}]`;
        }
        return { mode: item.mode, result: textResult };
      } catch (err) {
        return { mode: item.mode, result: '', error: (err as Error).message };
      }
    });
  }

  async newTask(text: string, images: string[] = [], mode?: string, agent?: string, worktreeName?: string): Promise<void> {
    await this.clearTask();
    if (!this.workspaceRoot()) {
      void vscode.window.showWarningMessage('PerplexiCode: open a folder or workspace so the agent can work with files. The task will run in your home directory.');
    }
    if (mode && MODES.some((entry) => entry.slug === mode)) {
      this.selection.mode = mode;
      await this.saveSelection();
    }
    const cwd = this.workspaceRoot();
    await this.restoreMcpCredentials(cwd || os.homedir());
    const resolvedAgent = agent ? this.core.findSubagent(cwd || os.homedir(), agent) : undefined;
    if (agent && !resolvedAgent) {
      this.output.appendLine(`[library] subagent "${agent}" is not installed; running in ${this.selection.mode} mode`);
    }
    let worktreeHandle: IsolatedWorktreeHandle | undefined;
    const useWorktree = Boolean(worktreeName || this.getSettings().worktreeEnabled);
    if (useWorktree && cwd) {
      try {
        worktreeHandle = await createIsolatedWorktree({
          cwd,
          name: worktreeName,
          hooks: this.core.createHooksEngine(cwd),
          permissionMode: this.core.permissionMode,
        });
        if (worktreeHandle.dirtyMainCheckout && worktreeHandle.warningMessage) {
          this.output.appendLine(`[worktree] ${worktreeHandle.warningMessage}`);
          void vscode.window.showWarningMessage(`PerplexiCode: ${worktreeHandle.warningMessage}`);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`PerplexiCode worktree: ${(error as Error).message}`);
        return;
      }
    }
    const task = this.buildTask({ mode: this.selection.mode, agent: resolvedAgent?.name, worktree: worktreeHandle });
    this.stack = [task];
    this.postState(true);
    await task.start(text, images);
    if (worktreeHandle && fs.existsSync(worktreeHandle.worktreePath) && !task.status.worktreeCard) {
      const report = this.core.finish(task) || { status: 'no_changes', detail: 'No edits', editedFiles: [], checks: [] };
      task.setWorktreeCard(buildWorktreeResultCard(worktreeHandle, report));
      this.store.save(task.toJSON());
      this.postState();
    }
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
    await this.restoreMcpCredentials(persisted.workspace || this.workspaceRoot() || os.homedir());
    const existing = this.tasks.get(id);
    const isFreshRestore = !(existing && !existing.isBusy);
    const task = !isFreshRestore && existing ? existing : this.buildTask({ mode: persisted.mode, restore: persisted });
    if (isFreshRestore) {
      this.core.resumeCheck(task);
    }
    this.selection.mode = task.mode;
    this.stack = [task];
    this.post({ type: 'view', view: 'chat' });
    this.postState(true);
  }

  /** Text from the chat box: continue the current task or start a new one. */
  async sendMessage(text: string, images: string[] = [], agent?: string): Promise<void> {
    const processed = await this.expandMentions(text);
    const task = this.currentTask;
    if (!task) {
      await this.newTask(processed, images, undefined, agent);
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
      { label: 'repo', value: '@repo', kind: 'special' },
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
    await vscode.commands.executeCommand('perplexicodeKilo.chatView.focus');
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
    await vscode.commands.executeCommand('perplexicodeKilo.chatView.focus');
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
        await this.sendMessage(String(message.text || ''), message.images || [], typeof message.agent === 'string' && message.agent ? message.agent : undefined);
        break;
      case 'refreshLibrary':
        this.refreshLibrary();
        break;
      case 'skillSearch':
        await this.searchOnlineSkills(String(message.query || ''));
        break;
      case 'skillInstall':
        if (!String(message.source || '').trim()) {
          await vscode.commands.executeCommand('perplexicodeKilo.installSkillFromSource');
        } else {
          await this.installSkillFromSource(String(message.source), message.scope === 'user' ? 'user' : 'project');
        }
        break;
      case 'installPreset':
        await this.installPreset(message.kind === 'skill' ? 'skill' : 'agent', String(message.id), message.scope === 'user' ? 'user' : 'project');
        break;
      case 'installPresetBundle':
        await this.installBundle(Array.isArray(message.agents) ? message.agents.map(String) : [], Array.isArray(message.skills) ? message.skills.map(String) : [], message.scope === 'user' ? 'user' : 'project');
        break;
      case 'removeLibraryItem':
        await this.removeLibraryItem(message.kind === 'skill' ? 'skill' : 'agent', String(message.file), String(message.name || ''));
        break;
      case 'openLibraryFile':
        if (this.isLibraryFile(String(message.file))) {
          await vscode.window.showTextDocument(vscode.Uri.file(String(message.file)), { preview: false });
        }
        break;
      case 'createLibraryItem':
        await this.createLibraryItem(message);
        break;
      case 'runPreset':
        await this.runPreset(String(message.id), String(message.text || ''));
        break;
      case 'savePreset':
        await this.saveTaskPreset(message);
        break;
      case 'deletePreset':
        await this.deleteTaskPreset(String(message.id), String(message.source || 'user'));
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
      case 'setComputeMode':
        await this.setComputeMode(String(message.mode || 'search'));
        break;
      case 'mcpConnect':
        await this.mcpConnect(typeof message.name === 'string' && message.name ? message.name : undefined);
        break;
      case 'mcpOAuthLogin':
        await this.mcpOAuthLogin(typeof message.name === 'string' && message.name ? message.name : undefined);
        break;
      case 'mcpOAuthLogout':
        await this.mcpOAuthLogout(typeof message.name === 'string' && message.name ? message.name : undefined);
        break;
      case 'runMcpPrompt':
        await this.runMcpPrompt(String(message.server || ''), String(message.name || ''), String(message.rawArgs || ''));
        break;
      case 'mcpAdd':
        await this.mcpAdd({ name: message.name, target: message.target, scope: message.scope, transport: message.transport, env: message.env, headers: message.headers });
        break;
      case 'mcpCatalogInstall':
        await this.mcpCatalogInstall(String(message.id || ''), String(message.scope || 'project'));
        break;
      case 'mcpParrotGuide':
        await vscode.window.showTextDocument(vscode.Uri.joinPath(this.context.extensionUri, 'docs', 'MCP-SECURITY-PARROT.md'), { preview: false });
        break;
      case 'mcpRemove':
        await this.mcpRemove(String(message.name || ''), typeof message.scope === 'string' ? message.scope : undefined);
        break;
      case 'openMcpFile':
        if (typeof message.file === 'string' && /(?:^|[\\/])(?:\.?mcp(?:\.local)?\.json|\.claude\.json|settings(?:\.local)?\.json)$/.test(message.file)) {
          await vscode.window.showTextDocument(vscode.Uri.file(String(message.file)), { preview: false });
        }
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
        if (task && task.isBusy && task.status.askKind === 'completion_result' && task.status.askId) {
          task.respond(task.status.askId, { response: 'yes' });
        }
        if (!task || (task.isBusy && task.status.askKind !== 'completion_result')) {
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
        try {
          await this.updateSetting(String(message.key), message.value);
        } finally {
          // Always resync, so the checkboxes never show a value that was not saved.
          this.postState();
        }
        break;
      case 'openSettingsJson':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:MRX7999.perplexicode-kilo');
        break;
      case 'addAccount':
        await vscode.commands.executeCommand('perplexicodeKilo.addAccount');
        break;
      case 'manageAccounts':
        await vscode.commands.executeCommand('perplexicodeKilo.manageAccounts');
        break;
      case 'removeAccount': {
        const account = this.accountManager.getAccounts().find((entry) => entry.id === message.id);
        if (account) {
          const confirm = await vscode.window.showWarningMessage(`Remove account "${account.alias}"?`, { modal: true }, 'Remove');
          if (confirm === 'Remove') {
            await this.accountManager.removeAccount(account.id);
            await vscode.commands.executeCommand('perplexicodeKilo.refreshModels');
          }
        }
        break;
      }
      case 'toggleAccount':
        await this.accountManager.toggleAccount(String(message.id));
        await vscode.commands.executeCommand('perplexicodeKilo.refreshModels');
        break;
      case 'refreshAccounts':
        await vscode.commands.executeCommand('perplexicodeKilo.refreshModels');
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
      case 'requestDiagnosticsPreview':
        this.post(
          {
            type: 'diagnosticsPreview',
            json: this.buildDiagnosticsJson(typeof message.taskId === 'string' && message.taskId ? message.taskId : undefined),
          },
          webview
        );
        break;
      case 'requestContextInspection': {
        const task =
          (typeof message.taskId === 'string' && message.taskId ? this.tasks.get(message.taskId) : undefined) ||
          this.currentTask;
        const report = task ? await task.inspectContext() : null;
        this.post({ type: 'contextInspection', report }, webview);
        break;
      }
      case 'setContextItemExcluded': {
        const task =
          (typeof message.taskId === 'string' && message.taskId ? this.tasks.get(message.taskId) : undefined) ||
          this.currentTask;
        if (task && typeof message.id === 'string' && message.id) {
          task.setContextItemExcluded(message.id, Boolean(message.excluded));
          const report = await task.inspectContext();
          this.post({ type: 'contextInspection', report }, webview);
          this.postState();
        }
        break;
      }
      case 'toggleWorktree': {
        const nextEnabled = typeof message.enabled === 'boolean' ? message.enabled : !this.getSettings().worktreeEnabled;
        await this.updateSetting('worktreeEnabled', nextEnabled);
        this.postState();
        break;
      }
      case 'applyWorktree': {
        const task =
          (typeof message.taskId === 'string' && message.taskId ? this.tasks.get(message.taskId) : undefined) ||
          this.currentTask;
        if (!task) {
          break;
        }
        const handle = this.taskWorktrees.get(task.id);
        if (!handle) {
          this.post({ type: 'toast', text: 'The worktree for this task is already closed or missing' }, webview);
          break;
        }
        try {
          const res = await applyWorktreeChanges(handle, {
            removeAfterApply: true,
            hooks: this.core.createHooksEngine(handle.mainRepoRoot),
            taskId: task.id,
            permissionMode: this.core.permissionMode,
          });
          if (task.status.worktreeCard) {
            task.setWorktreeCard({
              ...task.status.worktreeCard,
              state: res.state,
              conflictFiles: res.conflictFiles,
              statusMessage: res.message,
            });
          }
          this.store.save(task.toJSON());
          this.post({ type: 'toast', text: res.message }, webview);
          this.postState();
        } catch (err) {
          void vscode.window.showErrorMessage(`PerplexiCode worktree apply: ${(err as Error).message}`);
        }
        break;
      }
      case 'discardWorktree': {
        const task =
          (typeof message.taskId === 'string' && message.taskId ? this.tasks.get(message.taskId) : undefined) ||
          this.currentTask;
        if (!task) {
          break;
        }
        const handle = this.taskWorktrees.get(task.id);
        if (!handle) {
          this.post({ type: 'toast', text: 'The worktree for this task is already removed' }, webview);
          break;
        }
        try {
          const res = await discardWorktreeChanges(handle, {
            hooks: this.core.createHooksEngine(handle.mainRepoRoot),
            taskId: task.id,
            permissionMode: this.core.permissionMode,
          });
          this.taskWorktrees.delete(task.id);
          if (task.status.worktreeCard) {
            task.setWorktreeCard({
              ...task.status.worktreeCard,
              state: 'discarded',
              conflictFiles: [],
              statusMessage: res.message,
            });
          }
          this.store.save(task.toJSON());
          this.post({ type: 'toast', text: res.message }, webview);
          this.postState();
        } catch (err) {
          void vscode.window.showErrorMessage(`PerplexiCode worktree discard: ${(err as Error).message}`);
        }
        break;
      }
      case 'insertCode': {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const snippet = String(message.text || '');
          if (editor.selection.isEmpty) {
            const docText = editor.document.getText();
            const replaced = replaceExistingFunctionOnInsert(docText, editor.selection.active.line + 1, snippet);
            if (replaced !== null) {
              const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(docText.length)
              );
              await editor.edit((builder) => builder.replace(fullRange, replaced));
              break;
            }
          }
          await editor.edit((builder) => builder.replace(editor.selection, snippet));
        }
        break;
      }
      case 'openInTab':
        await vscode.commands.executeCommand('perplexicodeKilo.openInTab');
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

  /** F08: Builds a redacted diagnostic bundle JSON (no cookies, headers, prompts, code, or terminal output). */
  buildDiagnosticsJson(taskId?: string): string {
    const targetId = taskId || this.currentTask?.id;
    const task = targetId ? this.tasks.get(targetId) : this.currentTask;
    const events = targetId ? this.core.journalEvents(targetId) : [];
    const accounts = this.accountManager.getAccounts();
    const mcpServers = this.mcpStates();
    const coreSettings = loadSettings(this.workspaceRoot() || process.cwd());
    const uiSettings = this.getSettings();
    const bundle = buildDiagnosticBundle({
      version: String(this.context.extension.packageJSON.version || '3.5.0'),
      client: 'vscode',
      ideVersion: vscode.version,
      permissionMode: this.core.permissionMode,
      protectSecrets: coreSettings.permissions.protectSecrets,
      stopOnFallback: Boolean(uiSettings.stopOnFallback),
      computeMode: String(this.selection.computeMode || 'search'),
      contextStrategy: uiSettings.contextStrategy,
      maxPromptChars: uiSettings.maxPromptChars,
      hasVerifyCommand: Boolean(coreSettings.verify.command),
      ruleCounts: {
        allow: coreSettings.permissions.allow.length,
        ask: coreSettings.permissions.ask.length,
        deny: coreSettings.permissions.deny.length,
      },
      hookEventCount: Object.keys(coreSettings.hooks || {}).length,
      accountPlans: accounts
        .filter((entry) => entry.status === 'active')
        .map((entry) => String(entry.capabilities?.plan || 'unknown')),
      mcpServers: mcpServers.map((entry) => ({
        type: entry.config.type,
        scope: entry.config.scope,
        status: entry.status,
      })),
      task: task
        ? {
            id: task.id,
            mode: task.mode,
            state: task.status.state,
            requestCount: task.status.requestCount,
            routeLine: task.status.routeLine,
            banner: task.status.banner,
          }
        : undefined,
      events,
    });
    return serializeDiagnosticBundle(bundle);
  }

  async openDiagnosticsPreview(): Promise<void> {
    await vscode.commands.executeCommand('perplexicodeKilo.chatView.focus');
    this.post({ type: 'diagnosticsPreview', json: this.buildDiagnosticsJson() });
  }

  async openContextInspector(): Promise<void> {
    await vscode.commands.executeCommand('perplexicodeKilo.chatView.focus');
    const report = this.currentTask ? await this.currentTask.inspectContext() : null;
    this.post({ type: 'contextInspection', report });
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
    const mcpServers = this.mcpStates();
    const planSetting = readSetting<string>('perplexicodeKilo.subscriptionPlan', 'auto');
    const state = {
      type: 'state',
      version: this.context.extension.packageJSON.version,
      includeMessages,
      task: task ? {
        id: task.id,
        parentId: task.parentId,
        title: task.title,
        mode: task.mode,
        agent: this.taskAgents.get(task.id),
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
        computeMode: this.getComputeMode(),
        computeRoute: (() => {
          const route = resolveComputeRoute(this.selection.modelId, this.getSelection().thinking, this.getComputeMode());
          return { modelId: route.modelId, requiredPlan: route.requiredPlan, quotaBucket: route.quotaBucket };
        })(),
      },
      computeModes: COMPUTE_MODES.map((mode) => ({
        id: mode.id,
        label: mode.label,
        shortLabel: mode.shortLabel,
        description: mode.description,
        requiredPlan: mode.requiredPlan,
        quotaBucket: mode.quotaBucket,
      })),
      mcp: {
        enabled: this.mcpEnabled(),
        trusted: vscode.workspace.isTrusted,
        catalog: MCP_CATALOG.map((entry) => ({
          id: entry.id, title: entry.title, description: entry.description, category: entry.category,
          docsUrl: entry.docsUrl, requirements: entry.requirements, notes: entry.notes, risk: entry.risk,
          inputs: entry.inputs, checkedAt: entry.checkedAt, installable: Boolean(entry.config),
          installed: mcpServers.some((server) => server.config.name === entry.id),
        })),
        servers: mcpServers.map((entry) => ({
          name: entry.config.name,
          type: entry.config.type,
          scope: entry.config.scope,
          sourceFile: entry.config.sourceFile,
          target: entry.config.type === 'stdio' ? [entry.config.command, ...(entry.config.args || [])].filter(Boolean).join(' ') : entry.config.url || '',
          status: entry.status,
          error: entry.error,
          serverInfo: entry.serverInfo,
          oauthAuthenticated: entry.config.type !== 'stdio' && Boolean(entry.config.url)
            ? this.mcpOAuthAuthenticated.has(`${entry.config.name}::${entry.config.url}`)
            : false,
          tools: entry.tools.map((tool) => ({ name: tool.name, qualifiedName: tool.qualifiedName, description: tool.description || '' })),
          resources: entry.resources.map((resource) => ({ uri: resource.uri, name: resource.name, description: resource.description || '' })),
          prompts: entry.prompts.map((prompt) => ({
            name: prompt.name,
            description: prompt.description || '',
            arguments: prompt.arguments,
          })),
        })),
      },
      settings: this.getSettings(),
      general: {
        subscriptionPlan: planSetting,
        rotationStrategy: this.rotationEngine.getStrategy(),
        revealEditedFiles: readSetting<boolean>('perplexicodeKilo.agent.revealEditedFiles', true),
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
          computer: formatQuotaSummary(getQuotaItem(account, 'computer')),
          free: formatQuotaSummary(getQuotaItem(account, 'free_queries')),
        },
      })),
      history: this.store.list().filter((item) => !item.parentId).slice(0, 200),
      workspace: this.workspaceRoot() || null,
      library: this.getLibrary(),
      permissionMode: this.core.permissionMode,
      worktree: (() => {
        const enabled = Boolean(this.getSettings().worktreeEnabled);
        let preStartWarning: string | undefined;
        const root = this.workspaceRoot();
        if (enabled && !task && root) {
          const dirty = inspectMainCheckoutDirty(root);
          if (dirty.dirty) {
            preStartWarning = dirty.warningMessage;
          }
        }
        return { enabled, preStartWarning };
      })(),
    };
    this.post(state, target);
    this.stateEmitter.fire();
  }

  // ---------------------------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------------------------

  // ---------------------------------------------------------------------------------------------
  // 3.1 library: subagents, skills, task presets
  // ---------------------------------------------------------------------------------------------

  private libraryPaths(): { cwd?: string; home: string } {
    return { cwd: this.workspaceRoot(), home: os.homedir() };
  }

  private getLibrary(): LibrarySnapshot {
    if (!this.library || this.library.workspace !== (this.workspaceRoot() || null)) {
      this.library = this.computeLibrary();
    }
    return this.library;
  }

  private computeLibrary(): LibrarySnapshot {
    try {
      const snapshot = librarySnapshot(this.libraryPaths(), readSetting<unknown[]>('perplexicodeKilo.taskPresets', []) || []);
      let origins: ReturnType<typeof installedSkillOrigins> = {};
      try { origins = installedSkillOrigins(this.libraryPaths()); } catch { /* unreadable lock file: no badges */ }
      for (const skill of snapshot.skills) {
        const origin = origins[`${skill.scope}:${skill.name}`];
        if (origin && path.dirname(skill.file).split(path.sep).includes('.perplexicode')) skill.origin = origin.source;
      }
      return snapshot;
    } catch (error) {
      this.output.appendLine(`[library] ${(error as Error).message}`);
      return { workspace: this.workspaceRoot() || null, agents: [], skills: [], agentPresets: [], skillPresets: [], taskPresets: [] };
    }
  }

  taskPresets(): LibrarySnapshot['taskPresets'] {
    return this.getLibrary().taskPresets;
  }

  refreshLibrary(): void {
    this.library = this.computeLibrary();
    this.postState();
  }

  private scheduleLibraryRefresh(): void {
    if (this.libraryTimer) clearTimeout(this.libraryTimer);
    this.libraryTimer = setTimeout(() => {
      this.libraryTimer = undefined;
      this.refreshLibrary();
    }, 150);
  }

  private isLibraryFile(file: string): boolean {
    const library = this.getLibrary();
    return library.agents.some((agent) => agent.file === file) || library.skills.some((skill) => skill.file === file);
  }

  private resolveScope(scope: LibraryScope): LibraryScope | undefined {
    if (scope === 'project' && !this.workspaceRoot()) {
      void vscode.window.showWarningMessage('PerplexiCode: open a folder to install into the project, or choose "Global".');
      return undefined;
    }
    return scope;
  }

  /** Runs a write; on "already exists" asks before overwriting. */
  private async writeWithConfirm(label: string, write: (overwrite: boolean) => WriteResult): Promise<WriteResult | undefined> {
    try {
      return write(false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const answer = await vscode.window.showWarningMessage(`PerplexiCode: ${label} already exists. Overwrite it?`, { modal: true }, 'Overwrite');
      return answer === 'Overwrite' ? write(true) : undefined;
    }
  }

  async installPreset(kind: 'agent' | 'skill', id: string, requestedScope: LibraryScope): Promise<void> {
    const scope = this.resolveScope(requestedScope);
    if (!scope) return;
    const paths = this.libraryPaths();
    const result = await this.writeWithConfirm(`${kind === 'agent' ? 'Subagent' : 'Skill'} "${id}"`, (overwrite) => kind === 'agent' ? installAgentPreset(id, scope, paths, overwrite) : installSkillPreset(id, scope, paths, overwrite));
    if (result) {
      this.output.appendLine(`[library] installed ${kind} ${id} → ${result.file}`);
      this.post({ type: 'toast', text: `${kind === 'agent' ? 'Subagent' : 'Skill'} "${id}" installed (${scope === 'project' ? 'project' : 'global'})` });
    }
    this.refreshLibrary();
  }

  /** 4.1 Auto Skill: search ClawHub / skills.sh for the Library tab. */
  async searchOnlineSkills(query: string): Promise<void> {
    const trimmed = query.trim().slice(0, 200);
    if (!trimmed) {
      this.post({ type: 'skillSearchResults', query: trimmed, results: [], errors: [] });
      return;
    }
    const config = vscode.workspace.getConfiguration('perplexicodeKilo.agent');
    try {
      const found = await searchSkills(trimmed, { registries: config.get<Array<'clawhub' | 'skills-sh'>>('skillRegistries', ['clawhub', 'skills-sh']), limit: 12 });
      this.post({ type: 'skillSearchResults', query: trimmed, results: found.results, errors: found.errors });
    } catch (error) {
      this.post({ type: 'skillSearchResults', query: trimmed, results: [], errors: [{ registry: 'all', message: (error as Error).message }] });
    }
  }

  /**
   * 4.1 Auto Skill: download, scan and install a skill from ClawHub, skills.sh, GitHub or a URL.
   * Always shows a modal with the pinned source, files and scan before writing anything.
   */
  async installSkillFromSource(source: string, requestedScope: LibraryScope): Promise<boolean> {
    const spec = source.trim();
    if (!spec) return false;
    const scope = this.workspaceRoot() ? requestedScope : 'user';
    const paths = this.libraryPaths();
    let skill: ResolvedSkill;
    try {
      skill = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `PerplexiCode: downloading skill ${spec}…` }, () => resolveSkillSource(spec, { cwd: paths.cwd }));
    } catch (error) {
      void vscode.window.showErrorMessage(`PerplexiCode: could not download ${spec}: ${(error as Error).message}`);
      return false;
    }
    const scan = scanResolvedSkill(skill);
    const detail = describeResolvedSkill(skill, scan);
    const target = `${scope === 'user' ? '~/.perplexicode' : '.perplexicode'}/skills/${skill.name}`;
    let allowRisky = false;
    if (scan.verdict === 'blocked') {
      const answer = await vscode.window.showErrorMessage(`PerplexiCode: the security scan blocked skill "${skill.name}". Install anyway only if you have read the files and trust the publisher.`, { modal: true, detail }, 'Install anyway');
      if (answer !== 'Install anyway') return false;
      allowRisky = true;
    } else {
      const answer = await vscode.window.showWarningMessage(`PerplexiCode: install skill "${skill.name}" to ${target}?`, { modal: true, detail }, 'Install');
      if (answer !== 'Install') return false;
    }
    try {
      const result = await this.writeWithConfirm(`Skill "${skill.name}"`, (overwrite) => {
        const installed = installResolvedSkill(skill, { scope, paths, overwrite, allowRisky, scan });
        return { file: installed.file, created: !installed.replaced };
      });
      if (!result) return false;
      this.output.appendLine(`[library] installed skill ${skill.name} from ${skill.source} (${skill.resolved}) → ${result.file}`);
      this.post({ type: 'toast', text: `Skill "${skill.name}" installed (${scope === 'project' ? 'project' : 'global'})` });
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(`PerplexiCode: ${(error as Error).message}`);
      return false;
    } finally {
      this.refreshLibrary();
    }
  }

  private async installBundle(agents: string[], skills: string[], requestedScope: LibraryScope): Promise<void> {
    const scope = this.resolveScope(requestedScope);
    if (!scope) return;
    const paths = this.libraryPaths();
    const installed: string[] = [];
    for (const id of agents) {
      try { installAgentPreset(id, scope, paths, false); installed.push(id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') this.output.appendLine(`[library] ${(error as Error).message}`); }
    }
    for (const id of skills) {
      try { installSkillPreset(id, scope, paths, false); installed.push(id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') this.output.appendLine(`[library] ${(error as Error).message}`); }
    }
    this.output.appendLine(`[library] bundle installed (${scope}): ${installed.join(', ') || 'nothing new'}`);
    this.post({ type: 'toast', text: installed.length ? `Installed: ${installed.join(', ')}` : 'Everything is already installed' });
    this.refreshLibrary();
  }

  private async removeLibraryItem(kind: 'agent' | 'skill', file: string, name: string): Promise<void> {
    if (!this.isLibraryFile(file)) {
      this.refreshLibrary();
      return;
    }
    const answer = await vscode.window.showWarningMessage(`PerplexiCode: delete ${kind === 'agent' ? 'subagent' : 'skill'} "${name}"?`, { modal: true, detail: file }, 'Delete');
    if (answer !== 'Delete') return;
    const removed = removeLibraryItem(kind, file, this.libraryPaths());
    this.output.appendLine(`[library] removed ${removed}`);
    this.refreshLibrary();
  }

  private async createLibraryItem(message: Record<string, any>): Promise<void> {
    const scope = this.resolveScope(message.scope === 'user' ? 'user' : 'project');
    if (!scope) return;
    const paths = this.libraryPaths();
    const name = normalizeName(String(message.name || ''));
    try {
      const result = await this.writeWithConfirm(`"${name}"`, (overwrite) => message.kind === 'skill'
        ? createCustomSkill({ name, description: String(message.description || ''), body: String(message.body || '') }, scope, paths, overwrite)
        : createCustomAgent({
          name,
          description: String(message.description || ''),
          tools: String(message.tools || '').split(/,(?![^(]*\))/).map((entry: string) => entry.trim()).filter(Boolean),
          mode: String(message.mode || ''),
          model: String(message.model || ''),
          prompt: String(message.body || ''),
        }, scope, paths, overwrite));
      if (result) {
        this.post({ type: 'libraryCreated', kind: message.kind === 'skill' ? 'skill' : 'agent', name });
        await vscode.window.showTextDocument(vscode.Uri.file(result.file), { preview: false, preserveFocus: true });
      }
    } catch (error) {
      this.post({ type: 'toast', text: (error as Error).message });
    }
    this.refreshLibrary();
  }

  /** Starts a new task from a preset; offers to install missing subagents/skills first. */
  async runPreset(id: string, text: string): Promise<void> {
    const library = this.getLibrary();
    const preset = library.taskPresets.find((entry) => entry.id === id);
    if (!preset) {
      void vscode.window.showErrorMessage(`PerplexiCode: preset "${id}" not found.`);
      return;
    }
    const missingAgents = preset.missing.agents.filter((name) => library.agentPresets.some((entry) => entry.id === name));
    const missingSkills = preset.missing.skills.filter((name) => library.skillPresets.some((entry) => entry.id === name));
    if (missingAgents.length + missingSkills.length > 0) {
      const items = [...missingAgents, ...missingSkills].join(', ');
      const choice = await vscode.window.showInformationMessage(
        `PerplexiCode: "${preset.title}" works best with ${items}. Install them?`,
        { modal: true },
        ...(this.workspaceRoot() ? ['Install to project'] : []),
        'Install globally',
        'Run without',
      );
      if (!choice) return;
      if (choice !== 'Run without') {
        await this.installBundle(missingAgents, missingSkills, choice === 'Install globally' ? 'user' : 'project');
      }
    }
    if (MODES.some((entry) => entry.slug === preset.mode)) {
      this.selection.mode = preset.mode;
      await this.saveSelection();
    }
    const prompt = applyPresetPrompt(preset, await this.expandMentions(text));
    await this.newTask(prompt, [], preset.mode, preset.agent);
  }

  private async saveTaskPreset(message: Record<string, any>): Promise<void> {
    const raw = {
      id: message.id ? String(message.id) : undefined,
      title: String(message.title || '').trim(),
      description: String(message.description || ''),
      mode: String(message.mode || 'code'),
      prompt: String(message.prompt || ''),
      agent: message.agent ? String(message.agent) : undefined,
    };
    if (!raw.title || !raw.prompt.trim()) {
      this.post({ type: 'toast', text: 'A preset needs a title and a prompt' });
      return;
    }
    if (message.scope === 'project') {
      if (!this.resolveScope('project')) return;
      savePresetToFile(raw, 'project', this.libraryPaths());
    } else {
      const current = (readSetting<unknown[]>('perplexicodeKilo.taskPresets', []) || []).filter((entry) => normalizeName(String((entry as any)?.id || (entry as any)?.title || '')) !== normalizeName(raw.id || raw.title));
      await writeSetting('perplexicodeKilo.taskPresets', [...current, { ...raw, id: normalizeName(raw.id || raw.title) }]);
    }
    this.post({ type: 'toast', text: `Preset "${raw.title}" saved` });
    this.refreshLibrary();
  }

  private async deleteTaskPreset(id: string, source: string): Promise<void> {
    if (source === 'project') {
      deletePresetFromFile(id, 'project', this.libraryPaths());
    } else if (source === 'user') {
      const current = readSetting<unknown[]>('perplexicodeKilo.taskPresets', []) || [];
      const next = current.filter((entry) => normalizeName(String((entry as any)?.id || (entry as any)?.title || '')) !== id);
      if (next.length !== current.length) {
        await writeSetting('perplexicodeKilo.taskPresets', next);
      } else {
        deletePresetFromFile(id, 'user', this.libraryPaths());
      }
    }
    this.refreshLibrary();
  }

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

/** Splits "npx -y @scope/server --flag 'a b'" into argv, honouring single/double quotes. */
export function splitCommandLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: string | undefined;
  let hasToken = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && i + 1 < line.length) {
        current += line[++i];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        result.push(current);
        current = '';
        hasToken = false;
      }
    } else if (char === '\\' && i + 1 < line.length) {
      current += line[++i];
      hasToken = true;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) {
    result.push(current);
  }
  return result;
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
