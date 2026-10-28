import * as vscode from 'vscode';
import { initSettingsStore, onDidChangeFallbackSetting } from './config/settingsStore';
import { migrateLegacySettings, runLegacyMigration } from './migration/legacyImport';
import { AgentController } from './agent/controller';
import { getModeBySlug, MODES } from './agent/modes';
import { TaskStore } from './agent/taskStore';
import { PerplexityTransport } from './agent/transport';
import { CapabilityFetcher } from './api/capabilityFetcher';
import { getModelLabel, setRuntimeModelCatalog } from './api/modelCatalog';
import { ModelFetcher } from './api/modelFetcher';
import { RotationEngine } from './api/rotationEngine';
import { RotationStrategy } from './api/types';
import { LoginProvider } from './providers/loginProvider';
import { AccountManager } from './storage/accountManager';
import { StatusBarManager } from './ui/statusBar';

const ROTATION_KEY = 'perplexicode.rotationStrategy';
const VIEW_TYPE = 'perplexicodeKilo.chatView';

let taskStore: TaskStore | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('PerplexiCode');
  context.subscriptions.push(output);
  const version = String(context.extension.packageJSON.version);
  initSettingsStore(context, (line) => output.appendLine(line));

  // Accounts are stored under the same globalState / SecretStorage keys as PerplexiCode 1.x,
  // so updating in place keeps every signed-in account.
  const accountManager = new AccountManager(context.globalState, context.secrets);
  await accountManager.initialize();

  const rotationEngine = new RotationEngine();
  const storedStrategy = context.globalState.get<RotationStrategy>(ROTATION_KEY);
  if (storedStrategy === 'round-robin' || storedStrategy === 'least-used' || storedStrategy === 'failover-only') {
    rotationEngine.setStrategy(storedStrategy);
  }

  const capabilityFetcher = new CapabilityFetcher();
  const modelFetcher = new ModelFetcher();
  const loginProvider = new LoginProvider();
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  taskStore = new TaskStore(context.globalStorageUri.fsPath, context.globalState);
  const transport = new PerplexityTransport(accountManager, rotationEngine, capabilityFetcher);
  const controller = new AgentController(context, accountManager, rotationEngine, modelFetcher, transport, taskStore, output);
  context.subscriptions.push(controller);

  const updateStatusBar = () => {
    const selection = controller.getSelection();
    statusBar.update({
      modelLabel: getModelLabel(selection.baseModelId, selection.thinking),
      modeName: getModeBySlug(controller.getModeSlug()).name,
      accountCount: accountManager.getAccounts().length,
      activeAccountCount: accountManager.getActiveCount(),
      busy: controller.isBusy,
    });
  };
  context.subscriptions.push(controller.onDidChangeState(updateStatusBar));

  const initializeModels = async (force = false) => {
    const accounts = accountManager.getAccounts();
    try {
      await capabilityFetcher.refreshAccounts(accounts, force);
      await accountManager.saveMetas();
    } catch (error) {
      output.appendLine(`[models] capability refresh failed: ${(error as Error).message}`);
    }
    const activeAccount = rotationEngine.selectAccount(accounts) || accounts.find((account) => account.status === 'active');
    const models = activeAccount ? await modelFetcher.getModels(activeAccount) : modelFetcher.getFallbackModels();
    setRuntimeModelCatalog(models);
    await controller.reloadModels();
    updateStatusBar();
  };

  // Do not block activation on network calls: the UI comes up with the bundled catalog first.
  setRuntimeModelCatalog(modelFetcher.getFallbackModels());
  void controller.reloadModels().then(updateStatusBar);
  void initializeModels().catch((error) => output.appendLine(`[models] ${(error as Error).stack || error}`));

  // Sidebar view.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, {
      resolveWebviewView(view) {
        controller.attachWebview(view.webview, (listener) => {
          view.onDidDispose(listener);
        });
      },
    }, { webviewOptions: { retainContextWhenHidden: true } })
  );

  const focusSidebar = async () => {
    await vscode.commands.executeCommand(`${VIEW_TYPE}.focus`);
  };

  const register = (command: string, callback: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (...args: any[]) => {
      try {
        await callback(...args);
      } catch (error) {
        output.appendLine(`[${command}] ${(error as Error).stack || error}`);
        void vscode.window.showErrorMessage(`PerplexiCode: ${(error as Error).message}`);
      }
    }));
  };

  // ------------------------------------------------------------------------------------------
  // Accounts
  // ------------------------------------------------------------------------------------------

  // Accounts saved by the old extension ID (perplexicode.perplexicode) live in its own SecretStorage;
  // the bundled migration bridge hands them over after the user confirms.
  const migrateLegacy = (force: boolean) => runLegacyMigration({
    context,
    accountManager,
    output,
    force,
    // Only integration tests set this variable; the bridge checks it as well before skipping its modal.
    skipBridgeConfirmation: process.env.PERPLEXICODE_BRIDGE_TEST_AUTOCONFIRM === '1',
    applyRotationStrategy: (strategy) => rotationEngine.setStrategy(strategy),
    onImported: async () => {
      await initializeModels(true);
      controller.postState();
      updateStatusBar();
    },
  });
  register('perplexicodeKilo.importLegacyAccounts', async () => {
    await migrateLegacy(true);
  });
  void migrateLegacySettings(context, output)
    .catch((error) => output.appendLine(`[migration] settings: ${(error as Error).message}`))
    .then(() => migrateLegacy(false))
    .catch((error) => output.appendLine(`[migration] ${(error as Error).stack || error}`));

  register('perplexicodeKilo.addAccount', async () => {
    const tokens = await loginProvider.login();
    if (!tokens) {
      return;
    }
    const alias = await vscode.window.showInputBox({
      title: 'Account Alias',
      prompt: 'Give this account a name (for example Personal or Work)',
      value: `Account ${accountManager.getAccounts().length + 1}`,
    });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'PerplexiCode: Adding account...' },
      async () => accountManager.addAccount(alias || 'Account', tokens.sessionToken, tokens.csrfToken, { fullCookies: tokens.fullCookies })
    );
    if (!result.success || !result.account) {
      void vscode.window.showErrorMessage(`PerplexiCode: ${result.error}`);
      return;
    }
    await capabilityFetcher.refreshAccount(result.account, true).catch(() => undefined);
    await accountManager.saveMetas();
    await initializeModels(true);
    void vscode.window.showInformationMessage(`PerplexiCode: Account "${result.account.alias}" added successfully.`);
  });

  register('perplexicodeKilo.manageAccounts', async () => {
    const accounts = accountManager.getAccounts();
    if (accounts.length === 0) {
      const action = await vscode.window.showInformationMessage('PerplexiCode: No accounts configured.', 'Add Account');
      if (action === 'Add Account') {
        void vscode.commands.executeCommand('perplexicodeKilo.addAccount');
      }
      return;
    }
    const items = accounts.map((account) => ({
      label: `[${formatAccountStatus(account.status)}] ${account.alias}`,
      description: `${account.capabilities?.plan || 'unknown'} - ${account.queriestoday} today - ${account.queriesTotalLifetime} total`,
      accountId: account.id,
    }));
    items.push({ label: '$(add) Add New Account', description: '', accountId: '__add__' });
    const selected = await vscode.window.showQuickPick(items, { title: 'PerplexiCode: Manage Accounts', placeHolder: 'Select an account to manage' });
    if (!selected) {
      return;
    }
    if (selected.accountId === '__add__') {
      void vscode.commands.executeCommand('perplexicodeKilo.addAccount');
      return;
    }
    const account = accounts.find((entry) => entry.id === selected.accountId);
    if (!account) {
      return;
    }
    const action = await vscode.window.showQuickPick([
      { label: '$(refresh) Refresh Session', action: 'refresh' },
      { label: account.status === 'disabled' ? '$(check) Enable' : '$(close) Disable', action: 'toggle' },
      { label: '$(trash) Remove', action: 'remove' },
    ], { title: `Manage: ${account.alias}` });
    if (!action) {
      return;
    }
    if (action.action === 'refresh') {
      const tokens = await loginProvider.login();
      if (!tokens) {
        return;
      }
      const success = await accountManager.updateTokens(account.id, tokens.sessionToken, tokens.csrfToken, tokens.fullCookies);
      if (!success) {
        void vscode.window.showErrorMessage('PerplexiCode: Could not update session tokens.');
        return;
      }
      await capabilityFetcher.refreshAccount(account, true).catch(() => undefined);
      await initializeModels(true);
      void vscode.window.showInformationMessage(`PerplexiCode: "${account.alias}" refreshed successfully.`);
      return;
    }
    if (action.action === 'toggle') {
      await accountManager.toggleAccount(account.id);
      await initializeModels(true);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(`Remove account "${account.alias}"?`, { modal: true }, 'Remove');
    if (confirm === 'Remove') {
      await accountManager.removeAccount(account.id);
      await initializeModels(true);
    }
  });

  register('perplexicodeKilo.refreshModels', async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'PerplexiCode: Refreshing models and quotas...' },
      async () => initializeModels(true)
    );
  });

  register('perplexicodeKilo.setRotationStrategy', async () => {
    const strategies: { label: string; description: string; strategy: RotationStrategy }[] = [
      { label: '$(sync) Round Robin', description: 'Cycle through available accounts', strategy: 'round-robin' },
      { label: '$(graph-line) Least Used', description: 'Prefer the account with the fewest queries today', strategy: 'least-used' },
      { label: '$(shield) Failover Only', description: 'Stick to the primary account until it fails', strategy: 'failover-only' },
    ];
    const current = rotationEngine.getStrategy();
    const selected = await vscode.window.showQuickPick(
      strategies.map((strategy) => ({ ...strategy, label: strategy.strategy === current ? `$(check) ${strategy.label}` : `     ${strategy.label}` })),
      { title: 'PerplexiCode: Rotation Strategy', placeHolder: 'Select how requests are distributed across accounts' }
    );
    if (selected) {
      rotationEngine.setStrategy(selected.strategy);
      await context.globalState.update(ROTATION_KEY, selected.strategy);
      controller.postState();
    }
  });

  // ------------------------------------------------------------------------------------------
  // Model and mode selection
  // ------------------------------------------------------------------------------------------

  register('perplexicodeKilo.selectModel', async () => {
    const models = controller.getModels();
    const selection = controller.getSelection();
    type Item = vscode.QuickPickItem & { modelId?: string; thinking?: boolean };
    const items: Item[] = [];
    const surfaced = models.filter((model) => model.surfaced !== false);
    const more = models.filter((model) => model.surfaced === false);
    const pushModels = (list: typeof models) => {
      for (const model of list) {
        const locked = model.selectable === false;
        const isCurrent = model.id === selection.baseModelId;
        items.push({
          label: `${locked ? '$(lock)' : isCurrent && !selection.thinking ? '$(check)' : '$(blank)'} ${model.label}`,
          description: [model.requiredPlan === 'max' ? 'Max' : '', model.isNew ? 'New' : '', locked ? `requires ${model.requiredPlan.toUpperCase()}` : ''].filter(Boolean).join(' · '),
          detail: model.description || undefined,
          modelId: model.id,
          thinking: false,
        });
        if (model.supportsThinking) {
          items.push({
            label: `${locked ? '$(lock)' : isCurrent && selection.thinking ? '$(check)' : '$(blank)'} ${model.label} · Thinking`,
            description: 'reasoning',
            modelId: model.id,
            thinking: true,
          });
        }
      }
    };
    items.push({ label: 'Models', kind: vscode.QuickPickItemKind.Separator });
    pushModels(surfaced);
    if (more.length > 0) {
      items.push({ label: 'More models', kind: vscode.QuickPickItemKind.Separator });
      pushModels(more);
    }
    items.push({ label: 'Modes', kind: vscode.QuickPickItemKind.Separator });
    for (const mode of MODES) {
      items.push({
        label: `${mode.slug === controller.getModeSlug() ? '$(check)' : '$(blank)'} ${mode.name} mode`,
        description: mode.description,
        modelId: `mode:${mode.slug}`,
      });
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'PerplexiCode: Model and Mode', placeHolder: 'Choose a Perplexity model or an agent mode', matchOnDescription: true });
    if (!picked?.modelId) {
      return;
    }
    if (picked.modelId.startsWith('mode:')) {
      await controller.setMode(picked.modelId.slice(5));
      return;
    }
    await controller.setModel(picked.modelId, picked.thinking);
  });

  register('perplexicodeKilo.cycleMode', async () => {
    const index = MODES.findIndex((mode) => mode.slug === controller.getModeSlug());
    await controller.setMode(MODES[(index + 1) % MODES.length].slug);
  });

  // ------------------------------------------------------------------------------------------
  // Views and tasks
  // ------------------------------------------------------------------------------------------

  register('perplexicodeKilo.openChat', focusSidebar);
  register('perplexicodeKilo.newTask', async () => {
    await controller.clearTask();
    await focusSidebar();
    controller.showView('chat');
  });
  register('perplexicodeKilo.history', async () => {
    await focusSidebar();
    controller.showView('history');
  });
  register('perplexicodeKilo.settings', async () => {
    await focusSidebar();
    controller.showView('settings');
  });
  register('perplexicodeKilo.openInTab', async () => {
    const panel = vscode.window.createWebviewPanel('perplexicodeKilo.tab', 'PerplexiCode', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    controller.attachWebview(panel.webview, (listener) => {
      panel.onDidDispose(listener);
    });
  });

  // ------------------------------------------------------------------------------------------
  // Editor actions (Kilo-style code actions)
  // ------------------------------------------------------------------------------------------

  register('perplexicodeKilo.explainCode', () => controller.runCodeAction('explain'));
  register('perplexicodeKilo.fixCode', () => controller.runCodeAction('fix'));
  register('perplexicodeKilo.improveCode', () => controller.runCodeAction('improve'));
  register('perplexicodeKilo.addToContext', () => controller.runCodeAction('add'));
  register('perplexicodeKilo.askAboutSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
      await controller.runCodeAction('add', editor);
      return;
    }
    await focusSidebar();
  });
  register('perplexicodeKilo.askAboutFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('PerplexiCode: No file is currently open.');
      return;
    }
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
    await focusSidebar();
    const mention = /\s/.test(relative) ? `"${relative}" (read it with read_file)` : `@/${relative}`;
    await controller.newTask(await controller.expandMentions(`Analyze and explain the file ${mention}`), [], 'ask');
  });
  register('perplexicodeKilo.addTerminalOutput', async () => {
    const before = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const selection = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(before);
    if (!selection.trim() || selection === before) {
      void vscode.window.showInformationMessage('PerplexiCode: select some text in the terminal first.');
      return;
    }
    await controller.addToContext(`Terminal output:\n\`\`\`\n${selection.trim()}\n\`\`\``);
  });
  register('perplexicodeKilo.generateCommitMessage', () => controller.generateCommitMessage());

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], new PerplexiCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('perplexicodeKilo.subscriptionPlan')) {
        void initializeModels(false);
      }
    }),
    onDidChangeFallbackSetting((key) => {
      if (key === 'perplexicodeKilo.subscriptionPlan') {
        void initializeModels(false);
      }
    })
  );

  output.appendLine(`PerplexiCode ${version} (Kilo edition) activated at ${new Date().toISOString()}`);
  output.appendLine(`Accounts: ${accountManager.getAccounts().length} configured (${accountManager.getActiveCount()} active)`);
  updateStatusBar();
}

export async function deactivate(): Promise<void> {
  await taskStore?.flush();
}

class PerplexiCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const hasProblems = context.diagnostics.length > 0;
    if (range.isEmpty && !hasProblems) {
      return actions;
    }
    const make = (title: string, command: string, kind: vscode.CodeActionKind, preferred = false) => {
      const action = new vscode.CodeAction(title, kind);
      action.command = { command, title };
      action.isPreferred = preferred;
      actions.push(action);
    };
    if (hasProblems) {
      make('PerplexiCode: Fix with agent', 'perplexicodeKilo.fixCode', vscode.CodeActionKind.QuickFix, true);
    }
    if (!range.isEmpty) {
      make('PerplexiCode: Explain code', 'perplexicodeKilo.explainCode', vscode.CodeActionKind.QuickFix);
      make('PerplexiCode: Improve code', 'perplexicodeKilo.improveCode', vscode.CodeActionKind.RefactorRewrite);
      make('PerplexiCode: Add to context', 'perplexicodeKilo.addToContext', vscode.CodeActionKind.QuickFix);
    }
    void document;
    return actions;
  }
}

function formatAccountStatus(status: string): string {
  switch (status) {
    case 'active':
      return 'ACTIVE';
    case 'rate_limited':
      return 'RATE LIMITED';
    case 'expired':
      return 'EXPIRED';
    case 'disabled':
      return 'DISABLED';
    default:
      return 'ERROR';
  }
}
