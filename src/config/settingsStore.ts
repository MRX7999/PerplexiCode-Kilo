import * as vscode from 'vscode';

/**
 * Settings access with a safe fallback.
 *
 * When an extension is updated while the editor window stays open (for example via
 * `antigravity-ide --install-extension`), the new code can start running while the editor still
 * holds the configuration schema of the previous version. Every write to a key that the old
 * version did not declare then fails with
 * "Unable to write to User Settings because <key> is not a registered configuration".
 *
 * In that case the value is kept in globalState instead, read back transparently, and moved into
 * the real User Settings as soon as the key becomes registered (after a window reload).
 */

const OVERRIDES_KEY = 'perplexicodeKilo.settingsOverrides';

let memento: vscode.Memento | undefined;
let warned = false;
const changeEmitter = new vscode.EventEmitter<string>();

/** Fires with the full key whenever a value is stored in the fallback layer. */
export const onDidChangeFallbackSetting = changeEmitter.event;

export function initSettingsStore(context: vscode.ExtensionContext, log?: (line: string) => void): void {
  memento = context.globalState;
  context.subscriptions.push(changeEmitter);
  void flushFallbackSettings(log);
}

function getOverrides(): Record<string, unknown> {
  const stored = memento?.get<Record<string, unknown>>(OVERRIDES_KEY);
  return stored && typeof stored === 'object' ? { ...stored } : {};
}

async function saveOverrides(overrides: Record<string, unknown>): Promise<void> {
  if (!memento) {
    return;
  }
  await memento.update(OVERRIDES_KEY, Object.keys(overrides).length ? overrides : undefined);
}

/** True when the running editor knows the key (it has a declared default value). */
export function isSettingRegistered(fullKey: string): boolean {
  const inspected = vscode.workspace.getConfiguration().inspect(fullKey);
  return inspected !== undefined && inspected.defaultValue !== undefined;
}

export function isUnregisteredConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a registered configuration/i.test(message);
}

export function readSetting<T>(fullKey: string, defaultValue: T): T {
  const overrides = getOverrides();
  if (Object.prototype.hasOwnProperty.call(overrides, fullKey)) {
    return overrides[fullKey] as T;
  }
  return vscode.workspace.getConfiguration().get<T>(fullKey, defaultValue);
}

export type SettingWriteTarget = 'settings' | 'fallback';

export async function writeSetting(fullKey: string, value: unknown): Promise<SettingWriteTarget> {
  if (isSettingRegistered(fullKey)) {
    try {
      await vscode.workspace.getConfiguration().update(fullKey, value, vscode.ConfigurationTarget.Global);
      const overrides = getOverrides();
      if (Object.prototype.hasOwnProperty.call(overrides, fullKey)) {
        delete overrides[fullKey];
        await saveOverrides(overrides);
      }
      return 'settings';
    } catch (error) {
      if (!isUnregisteredConfigurationError(error)) {
        throw error;
      }
    }
  }

  const overrides = getOverrides();
  overrides[fullKey] = value;
  await saveOverrides(overrides);
  changeEmitter.fire(fullKey);
  warnReloadOnce();
  return 'fallback';
}

/** Moves values from the fallback layer into User Settings for keys that are now registered. */
export async function flushFallbackSettings(log?: (line: string) => void): Promise<number> {
  const overrides = getOverrides();
  let moved = 0;
  for (const [fullKey, value] of Object.entries(overrides)) {
    if (!isSettingRegistered(fullKey)) {
      continue;
    }
    try {
      await vscode.workspace.getConfiguration().update(fullKey, value, vscode.ConfigurationTarget.Global);
      delete overrides[fullKey];
      moved += 1;
    } catch (error) {
      log?.(`Could not move ${fullKey} into User Settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (moved) {
    await saveOverrides(overrides);
    log?.(`Moved ${moved} setting(s) from the fallback store into User Settings.`);
  }
  return moved;
}

function warnReloadOnce(): void {
  if (warned) {
    return;
  }
  warned = true;
  void vscode.window
    .showWarningMessage(
      'PerplexiCode Kilo was updated while this window was open, so the editor still uses the old settings list. ' +
        'Your change is saved and already in effect; reload the window to finish the update.',
      'Reload Window'
    )
    .then((choice) => {
      if (choice === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}
