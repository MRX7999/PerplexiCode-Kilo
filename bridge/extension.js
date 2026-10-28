'use strict';
// PerplexiCode migration bridge.
// VS Code-based editors scope SecretStorage to the extension ID, so PerplexiCode Kilo
// (MRX7999.perplexicode-kilo) cannot read accounts saved by perplexicode.perplexicode.
// This tiny extension takes over the old ID, reads the old storage and hands it to the
// new extension after an explicit confirmation. It sends nothing over the network.
const vscode = require('vscode');

const NEW_EXTENSION_ID = 'MRX7999.perplexicode-kilo';
const ACCOUNTS_META_KEY = 'perplexicode.accounts';
const SESSION_KEY_PREFIX = 'perplexicode.session.';
const CSRF_KEY_PREFIX = 'perplexicode.csrf.';
const COOKIES_KEY_PREFIX = 'perplexicode.cookies.';
const ROTATION_KEY = 'perplexicode.rotationStrategy';

function sameId(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function activate(context) {
  if (!vscode.extensions.getExtension(NEW_EXTENSION_ID)) {
    void vscode.window
      .showInformationMessage(
        'PerplexiCode has moved to PerplexiCode Kilo (MRX7999.perplexicode-kilo). Install it to keep using your accounts.',
        'Install PerplexiCode Kilo'
      )
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('workbench.extensions.installExtension', NEW_EXTENSION_ID);
        }
      });
  }

  function getMetas() {
    const metas = context.globalState.get(ACCOUNTS_META_KEY, []);
    return Array.isArray(metas) ? metas.filter((meta) => meta && typeof meta.id === 'string') : [];
  }

  async function readAccounts() {
    const accounts = [];
    for (const meta of getMetas()) {
      const sessionToken = await context.secrets.get(SESSION_KEY_PREFIX + meta.id);
      if (!sessionToken) {
        continue;
      }
      const csrfToken = (await context.secrets.get(CSRF_KEY_PREFIX + meta.id)) || 'auto';
      const fullCookies = (await context.secrets.get(COOKIES_KEY_PREFIX + meta.id)) || undefined;
      accounts.push({ meta, sessionToken, csrfToken, fullCookies });
    }
    return accounts;
  }

  return {
    version: 1,
    isMigrationBridge: true,
    getAccountCount() {
      return getMetas().length;
    },
    async exportAccounts(requester, options) {
      if (!sameId(requester, NEW_EXTENSION_ID)) {
        throw new Error('Accounts can only be exported to ' + NEW_EXTENSION_ID + '.');
      }
      const accounts = await readAccounts();
      if (!accounts.length) {
        return { accounts: [], rotationStrategy: context.globalState.get(ROTATION_KEY) };
      }
      // Integration tests launch the editor with this variable to skip the modal; normal use always asks.
      const autoConfirm = process.env.PERPLEXICODE_BRIDGE_TEST_AUTOCONFIRM === '1' && options && options.skipConfirmation === true;
      if (!autoConfirm) {
        const names = accounts.map((account) => account.meta.alias || account.meta.id).join(', ');
        const choice = await vscode.window.showInformationMessage(
          'Copy ' + accounts.length + ' Perplexity account(s) from PerplexiCode to PerplexiCode Kilo?',
          { modal: true, detail: 'Accounts: ' + names + '\n\nSession tokens stay on this computer: they are copied from the old extension storage into the new one.' },
          'Copy accounts'
        );
        if (choice !== 'Copy accounts') {
          return { accounts: [], cancelled: true, rotationStrategy: undefined };
        }
      }
      return { accounts, rotationStrategy: context.globalState.get(ROTATION_KEY) };
    },
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
