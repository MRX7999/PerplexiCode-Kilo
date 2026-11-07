import * as vscode from 'vscode';

export interface StatusBarInfo {
  modelLabel: string;
  /** 3.3: short compute-mode label ("Computer high"), empty for plain Search. */
  computeLabel?: string;
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
  private info: StatusBarInfo = { modelLabel: 'Best', computeLabel: '', modeName: 'Code', accountCount: 0, activeAccountCount: 0, busy: false };

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
    const { modelLabel, computeLabel, modeName, accountCount, activeAccountCount, busy } = this.info;
    if (accountCount === 0) {
      this.item.text = '$(account) PerplexiCode: no account';
      this.item.tooltip = 'Click to sign in to Perplexity';
      this.item.command = 'perplexicodeKilo.addAccount';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    this.item.backgroundColor = undefined;
    this.item.text = `${busy ? '$(sync~spin)' : '$(sparkle)'} ${modeName} · ${modelLabel}${computeLabel ? ` · ${computeLabel}` : ''} | ${activeAccountCount}/${accountCount}`;
    this.item.tooltip = `PerplexiCode\nMode: ${modeName}\nModel: ${modelLabel}\nCompute: ${computeLabel || 'Search'}\nAccounts: ${activeAccountCount}/${accountCount} active\nClick to change the model (PerplexiCode: Select Compute Mode for Computer/Research)`;
    this.item.command = 'perplexicodeKilo.selectModel';
  }
}
