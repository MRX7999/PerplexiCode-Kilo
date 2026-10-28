/* eslint-disable no-console */
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as mock from './mocks/vscode-settings';
import {
  flushFallbackSettings,
  initSettingsStore,
  isSettingRegistered,
  onDidChangeFallbackSetting,
  readSetting,
  writeSetting,
} from '../src/config/settingsStore';

class MemoryMemento {
  private data = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.data.keys()];
  }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, structuredClone(value));
  }
  setKeysForSync(): void {}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const KEY = 'perplexicodeKilo.agent.autoApprove.write';
let passed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main(): Promise<void> {
  mock.reset();
  const memento = new MemoryMemento();
  const context = { globalState: memento, subscriptions: [] as unknown[] } as unknown as vscode.ExtensionContext;
  initSettingsStore(context);
  const fired: string[] = [];
  onDidChangeFallbackSetting((key) => fired.push(key));

  await test('registered key is written to User Settings', async () => {
    mock.registry.set('perplexicodeKilo.agent.autoApprove.read', true);
    assert.equal(await writeSetting('perplexicodeKilo.agent.autoApprove.read', false), 'settings');
    assert.equal(mock.userValues.get('perplexicodeKilo.agent.autoApprove.read'), false);
    assert.equal(readSetting('perplexicodeKilo.agent.autoApprove.read', true), false);
    assert.equal(mock.warnings.length, 0);
  });

  await test('unregistered key (stale schema) falls back without throwing', async () => {
    assert.equal(isSettingRegistered(KEY), false);
    assert.equal(readSetting(KEY, false), false);
    assert.equal(await writeSetting(KEY, true), 'fallback');
    assert.equal(readSetting(KEY, false), true);
    assert.equal(mock.userValues.has(KEY), false);
    assert.deepEqual(fired, [KEY]);
    assert.equal(mock.warnings.length, 1);
    assert.match(mock.warnings[0], /reload the window/i);
  });

  await test('reload warning is shown only once per session', async () => {
    assert.equal(await writeSetting('perplexicodeKilo.agent.autoApprove.execute', true), 'fallback');
    assert.equal(mock.warnings.length, 1);
  });

  await test('registered by inspect but rejected by update still falls back', async () => {
    mock.registry.set('perplexicodeKilo.agent.autoApprove.subtasks', true);
    mock.failNextUpdate(new Error('Unable to write to User Settings because perplexicodeKilo.agent.autoApprove.subtasks is not a registered configuration.'));
    assert.equal(await writeSetting('perplexicodeKilo.agent.autoApprove.subtasks', false), 'fallback');
    assert.equal(readSetting('perplexicodeKilo.agent.autoApprove.subtasks', true), false);
  });

  await test('other write errors are not swallowed', async () => {
    mock.registry.set('perplexicodeKilo.agent.maxRequestsPerTask', 40);
    mock.failNextUpdate(new Error('Unable to write into user settings. Please open the user settings to correct errors/warnings in it and try again.'));
    await assert.rejects(writeSetting('perplexicodeKilo.agent.maxRequestsPerTask', 10), /correct errors/);
  });

  await test('fallback values move into User Settings once the key is registered', async () => {
    mock.registry.set(KEY, false);
    const moved = await flushFallbackSettings();
    assert.equal(moved, 2); // write + subtasks; execute is still unregistered
    assert.equal(mock.userValues.get(KEY), true);
    assert.equal(mock.userValues.get('perplexicodeKilo.agent.autoApprove.subtasks'), false);
    const left = memento.get<Record<string, unknown>>('perplexicodeKilo.settingsOverrides');
    assert.deepEqual(left, { 'perplexicodeKilo.agent.autoApprove.execute': true });
    assert.equal(readSetting(KEY, false), true);
  });

  await test('a successful write clears a stale fallback value', async () => {
    mock.registry.set('perplexicodeKilo.agent.autoApprove.execute', false);
    assert.equal(await writeSetting('perplexicodeKilo.agent.autoApprove.execute', false), 'settings');
    assert.equal(memento.get('perplexicodeKilo.settingsOverrides'), undefined);
    assert.equal(readSetting('perplexicodeKilo.agent.autoApprove.execute', true), false);
  });

  await test('Reload Window button runs the reload command', async () => {
    // Fresh module state is not available, so check the wiring through the mock directly.
    mock.setWarningChoice('Reload Window');
    const choice = await vscode.window.showWarningMessage('x', 'Reload Window');
    if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    await tick();
    assert.deepEqual(mock.executed, ['workbench.action.reloadWindow']);
  });

  console.log(`settingsStore: ${passed} tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
