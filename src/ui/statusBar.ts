import * as vscode from 'vscode';

export interface StatusBarInfo {
  modelLabel: string;
  modeName: string;
  accountCount: number;
  activeAccountCount: number;
  busy: boolean;
}

/**
 * Status bar item that mirrors the agent selection (mode · model) and the account pool.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private info: StatusBarInfo = { modelLabel: 'Best', modeName: 'Code', accountCount: 0, activeAccountCount: 0, busy: false };

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.render();
    this.item.show();
  }

  update(info: Partial<StatusBarInfo>): void {
    const next = { ...this.info, ...info };
    if (JSON.stringify(next) === JSON.stringify(this.info)) {
      return;
    }
    this.info = next;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const { modelLabel, modeName, accountCount, activeAccountCount, busy } = this.info;
    if (accountCount === 0) {
      this.item.text = '$(account) PerplexiCode: no account';
      this.item.tooltip = 'Click to sign in to Perplexity';
      this.item.command = 'perplexicode.addAccount';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    this.item.backgroundColor = undefined;
    this.item.text = `${busy ? '$(sync~spin)' : '$(sparkle)'} ${modeName} · ${modelLabel} | ${activeAccountCount}/${accountCount}`;
    this.item.tooltip = `PerplexiCode\nMode: ${modeName}\nModel: ${modelLabel}\nAccounts: ${activeAccountCount}/${accountCount} active\nClick to change the model`;
    this.item.command = 'perplexicode.selectModel';
  }
}
