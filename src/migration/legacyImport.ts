import * as fs from 'fs';
import * as vscode from 'vscode';
import { AccountManager } from '../storage/accountManager';
import { AccountMeta, RotationStrategy } from '../api/types';

/**
 * Moves accounts and settings from the old extension ID (perplexicode.perplexicode) to
 * PerplexiCode Kilo (MRX7999.perplexicode-kilo).
 *
 * SecretStorage is scoped to the extension ID, so the new extension cannot read the old tokens
 * directly. The bundled "migration bridge" VSIX takes over the old ID (same publisher.name,
 * higher version), reads the old storage and exports it to this extension after a modal
 * confirmation shown by the bridge itself.
 */

export const LEGACY_EXTENSION_ID = 'perplexicode.perplexicode';
export const BRIDGE_VSIX_RELATIVE_PATH = ['media', 'migration', 'perplexicode-migration-bridge.vsix'];

const DONE_KEY = 'perplexicodeKilo.migration.done';
const DISMISSED_KEY = 'perplexicodeKilo.migration.dismissed';
const PENDING_RELOAD_KEY = 'perplexicodeKilo.migration.pendingReload';
const SETTINGS_DONE_KEY = 'perplexicodeKilo.migration.settingsDone';
const ROTATION_KEY = 'perplexicode.rotationStrategy';

interface ExportedAccount {
  meta: AccountMeta;
  sessionToken: string;
  csrfToken?: string;
  fullCookies?: string;
}

interface BridgeApi {
  version: number;
  isMigrationBridge?: boolean;
  getAccountCount(): number;
  exportAccounts(requester: string, options?: { skipConfirmation?: boolean }): Promise<{
    accounts: ExportedAccount[];
    cancelled?: boolean;
    rotationStrategy?: RotationStrategy;
  }>;
}

export interface LegacyMigrationOptions {
  context: vscode.ExtensionContext;
  accountManager: AccountManager;
  output: vscode.OutputChannel;
  /** Called after accounts were imported (refresh models, UI, status bar). */
  onImported: (count: number) => Promise<void> | void;
  /** Applies a rotation strategy copied from the old extension. */
  applyRotationStrategy?: (strategy: RotationStrategy) => void;
  /** Explicit run from the command palette: ignores "don't ask again" and shows outcomes. */
  force?: boolean;
  /** Integration tests only (the bridge also requires an environment variable). */
  skipBridgeConfirmation?: boolean;
}

export type LegacyMigrationResult =
  | { status: 'no-legacy' }
  | { status: 'skipped' }
  | { status: 'bridge-installed' }
  | { status: 'cancelled' }
  | { status: 'imported'; imported: number; duplicates: number }
  | { status: 'nothing-to-import' }
  | { status: 'error'; message: string };

export function isMigrationBridge(extension: vscode.Extension<unknown> | undefined): boolean {
  return Boolean(extension && (extension.packageJSON as Record<string, unknown>)?.perplexicodeMigrationBridge === true);
}

export function getBridgeVsixUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.extensionUri, ...BRIDGE_VSIX_RELATIVE_PATH);
}

/** Copies user-level `perplexicode.*` settings into `perplexicodeKilo.*` once, without overwriting. */
export async function migrateLegacySettings(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<number> {
  if (context.globalState.get<boolean>(SETTINGS_DONE_KEY)) {
    return 0;
  }
  const config = vscode.workspace.getConfiguration();
  let copied = 0;
  for (const suffix of getDeclaredSettingSuffixes(context)) {
    const legacy = config.inspect(`perplexicode.${suffix}`);
    const target = config.inspect(`perplexicodeKilo.${suffix}`);
    if (legacy?.globalValue === undefined || target?.globalValue !== undefined || target?.defaultValue === undefined) {
      continue;
    }
    try {
      await config.update(`perplexicodeKilo.${suffix}`, legacy.globalValue, vscode.ConfigurationTarget.Global);
      copied += 1;
    } catch (error) {
      output.appendLine(`[migration] could not copy setting perplexicode.${suffix}: ${(error as Error).message}`);
    }
  }
  await context.globalState.update(SETTINGS_DONE_KEY, true);
  if (copied) {
    output.appendLine(`[migration] copied ${copied} setting(s) from perplexicode.* to perplexicodeKilo.*`);
  }
  return copied;
}

function getDeclaredSettingSuffixes(context: vscode.ExtensionContext): string[] {
  const contributes = (context.extension.packageJSON as { contributes?: { configuration?: unknown } }).contributes;
  const blocks = Array.isArray(contributes?.configuration) ? contributes?.configuration : [contributes?.configuration];
  const suffixes: string[] = [];
  for (const block of blocks as Array<{ properties?: Record<string, unknown> } | undefined>) {
    for (const key of Object.keys(block?.properties || {})) {
      if (key.startsWith('perplexicodeKilo.')) {
        suffixes.push(key.slice('perplexicodeKilo.'.length));
      }
    }
  }
  return suffixes;
}

export async function runLegacyMigration(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const { context, output, force = false } = options;
  const legacy = vscode.extensions.getExtension(LEGACY_EXTENSION_ID);
  if (!legacy) {
    if (force) {
      void vscode.window.showInformationMessage('PerplexiCode Kilo: the old PerplexiCode extension is not installed, nothing to import.');
    }
    return { status: 'no-legacy' };
  }

  if (!force && (context.globalState.get<boolean>(DONE_KEY) || context.globalState.get<boolean>(DISMISSED_KEY))) {
    return { status: 'skipped' };
  }

  try {
    if (isMigrationBridge(legacy)) {
      return await importFromBridge(options, legacy);
    }
    return await offerBridgeInstall(options);
  } catch (error) {
    const message = (error as Error).message || String(error);
    output.appendLine(`[migration] ${(error as Error).stack || message}`);
    if (force) {
      void vscode.window.showErrorMessage(`PerplexiCode Kilo: account import failed: ${message}`);
    }
    return { status: 'error', message };
  }
}

async function offerBridgeInstall(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const { context, output, force } = options;
  if (!force && context.globalState.get<boolean>(PENDING_RELOAD_KEY)) {
    // The bridge was installed already; the window just has not been reloaded yet.
    void promptReload('PerplexiCode Kilo: reload the window to finish importing your PerplexiCode accounts.');
    return { status: 'bridge-installed' };
  }

  const choice = await vscode.window.showInformationMessage(
    'PerplexiCode Kilo found the old PerplexiCode extension. Import its saved Perplexity accounts?',
    'Import accounts',
    'Not now',
    "Don't ask again"
  );
  if (choice === "Don't ask again") {
    await context.globalState.update(DISMISSED_KEY, true);
    return { status: 'skipped' };
  }
  if (choice !== 'Import accounts') {
    return { status: 'skipped' };
  }

  const vsix = getBridgeVsixUri(context);
  if (!fs.existsSync(vsix.fsPath)) {
    throw new Error(`migration bridge is missing from this build (${vsix.fsPath})`);
  }
  output.appendLine(`[migration] installing migration bridge from ${vsix.fsPath}`);
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vsix);
  await context.globalState.update(PENDING_RELOAD_KEY, true);
  await context.globalState.update(DISMISSED_KEY, undefined);
  void promptReload('PerplexiCode Kilo: the import helper is installed. Reload the window, then confirm copying your accounts.');
  return { status: 'bridge-installed' };
}

async function importFromBridge(options: LegacyMigrationOptions, legacy: vscode.Extension<unknown>): Promise<LegacyMigrationResult> {
  const { context, accountManager, output, force } = options;
  const api = (legacy.isActive ? legacy.exports : await legacy.activate()) as BridgeApi | undefined;
  if (!api || typeof api.exportAccounts !== 'function') {
    throw new Error('the migration bridge did not expose its API');
  }
  await context.globalState.update(PENDING_RELOAD_KEY, undefined);

  if (api.getAccountCount() === 0) {
    await context.globalState.update(DONE_KEY, true);
    output.appendLine('[migration] the old extension has no saved accounts');
    if (force) {
      void vscode.window.showInformationMessage('PerplexiCode Kilo: the old extension has no saved accounts.');
    }
    void offerUninstall('PerplexiCode Kilo: the old PerplexiCode extension has no accounts left to import.');
    return { status: 'nothing-to-import' };
  }

  const exported = await api.exportAccounts(context.extension.id, { skipConfirmation: options.skipBridgeConfirmation });
  if (exported.cancelled) {
    // Do not nag on every start; the command palette entry can run it again.
    await context.globalState.update(DISMISSED_KEY, true);
    output.appendLine('[migration] account import cancelled by the user');
    return { status: 'cancelled' };
  }

  let imported = 0;
  let duplicates = 0;
  for (const entry of exported.accounts || []) {
    const result = await accountManager.importAccount(entry.meta, entry.sessionToken, entry.csrfToken || 'auto', entry.fullCookies);
    if (result === 'imported') {
      imported += 1;
    } else if (result === 'duplicate') {
      duplicates += 1;
    }
  }

  const strategy = exported.rotationStrategy;
  if (
    (strategy === 'round-robin' || strategy === 'least-used' || strategy === 'failover-only') &&
    context.globalState.get(ROTATION_KEY) === undefined
  ) {
    await context.globalState.update(ROTATION_KEY, strategy);
    options.applyRotationStrategy?.(strategy);
  }

  await context.globalState.update(DONE_KEY, true);
  output.appendLine(`[migration] imported ${imported} account(s), ${duplicates} already present`);
  if (imported) {
    await options.onImported(imported);
  }
  const summary = imported
    ? `PerplexiCode Kilo: imported ${imported} account(s) from PerplexiCode${duplicates ? ` (${duplicates} already present)` : ''}.`
    : 'PerplexiCode Kilo: all accounts from PerplexiCode are already here.';
  void offerUninstall(summary);
  return { status: 'imported', imported, duplicates };
}

async function promptReload(message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, 'Reload Window');
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function offerUninstall(message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(`${message} The old extension is no longer needed.`, 'Uninstall old extension');
  if (choice === 'Uninstall old extension') {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', LEGACY_EXTENSION_ID);
  }
}
