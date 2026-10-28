import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentHost, CommandResult, spawnShellCommand, toPosixRelative } from './tools';

/** AgentHost backed by the VS Code / Antigravity editor APIs. */
export class VsCodeAgentHost implements AgentHost {
  private readonly errorsBefore = new Map<string, Set<string>>();

  constructor(readonly cwd: string, private readonly revealEdits: () => boolean) {}

  async readFile(absPath: string): Promise<string> {
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === absPath);
    if (open) {
      return open.getText();
    }
    return fs.promises.readFile(absPath, 'utf8');
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    this.errorsBefore.set(absPath, new Set(errorKeys(uri)));
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === absPath);
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), content);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error('The editor rejected the edit.');
      }
      await open.save();
    } else {
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
    if (this.revealEdits()) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One });
      } catch {
        // Binary or too large to open; ignore.
      }
    }
  }

  async deleteFile(absPath: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await fs.promises.rm(absPath, { force: true });
    }
  }

  async getDiagnostics(absPath: string): Promise<string> {
    const uri = vscode.Uri.file(absPath);
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch {
      return '';
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const before = this.errorsBefore.get(absPath) || new Set<string>();
    const fresh = vscode.languages.getDiagnostics(uri)
      .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
      .filter((diagnostic) => !before.has(diagnosticKey(diagnostic)));
    if (fresh.length === 0) {
      return '';
    }
    const rel = toPosixRelative(this.cwd, absPath);
    return [`${rel}`, ...fresh.slice(0, 30).map((diagnostic) => `- [${diagnostic.source || 'error'}] Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`)].join('\n');
  }

  async getWorkspaceProblems(): Promise<string> {
    const lines: string[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      const relevant = diagnostics.filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning);
      if (relevant.length === 0 || uri.scheme !== 'file') {
        continue;
      }
      lines.push(toPosixRelative(this.cwd, uri.fsPath));
      relevant.slice(0, 30).forEach((diagnostic) => {
        lines.push(`- [${diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}] Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
      });
      if (lines.length > 300) {
        break;
      }
    }
    return lines.length > 0 ? lines.join('\n') : 'No errors or warnings detected.';
  }

  runCommand(command: string, cwd: string, options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void }): Promise<CommandResult> {
    return spawnShellCommand(command, cwd, options);
  }

  ripgrepPath(): string | undefined {
    const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', binary),
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', binary),
      path.join(vscode.env.appRoot, 'node_modules', 'vscode-ripgrep', 'bin', binary),
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', 'vscode-ripgrep', 'bin', binary),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  openTabs(): string[] {
    const tabs: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri && input.uri.scheme === 'file') {
          tabs.push(toPosixRelative(this.cwd, input.uri.fsPath));
        }
      }
    }
    return [...new Set(tabs)].slice(0, 30);
  }

  visibleFiles(): string[] {
    return vscode.window.visibleTextEditors
      .filter((editor) => editor.document.uri.scheme === 'file')
      .map((editor) => toPosixRelative(this.cwd, editor.document.uri.fsPath));
  }

  activeFile(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document.uri.scheme === 'file' ? toPosixRelative(this.cwd, editor.document.uri.fsPath) : undefined;
  }
}

function diagnosticKey(diagnostic: vscode.Diagnostic): string {
  return `${diagnostic.message}|${diagnostic.source || ''}|${diagnostic.code ?? ''}`;
}

function errorKeys(uri: vscode.Uri): string[] {
  return vscode.languages.getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
    .map(diagnosticKey);
}
