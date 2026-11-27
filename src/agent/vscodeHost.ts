import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AgentHost,
  CommandResult,
  diffPostEditDiagnostics,
  IdeDiagnosticEntry,
  LspQueryRequest,
  resolveWorkspacePath,
  spawnShellCommand,
  toPosixRelative,
} from './tools';

/** AgentHost backed by the VS Code / Antigravity editor APIs. */
export class VsCodeAgentHost implements AgentHost {
  private readonly diagnosticsBefore = new Map<string, IdeDiagnosticEntry[]>();

  constructor(
    readonly cwd: string,
    private readonly revealEdits: () => boolean,
    private readonly diagnosticsSettleMs = 1200
  ) {}

  async readFile(absPath: string): Promise<string> {
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === absPath);
    if (open) {
      return open.getText();
    }
    return fs.promises.readFile(absPath, 'utf8');
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    this.diagnosticsBefore.set(absPath, toIdeDiagnostics(vscode.languages.getDiagnostics(uri)));
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
    if (this.diagnosticsSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.diagnosticsSettleMs));
    }
    const before = this.diagnosticsBefore.get(absPath) || [];
    const after = toIdeDiagnostics(vscode.languages.getDiagnostics(uri));
    const rel = toPosixRelative(this.cwd, absPath);
    return diffPostEditDiagnostics(rel, before, after, 30);
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

  async lspQuery(request: LspQueryRequest): Promise<string> {
    if (request.operation === 'diagnostics') {
      if (!request.path || request.path.trim() === '' || request.path.trim() === '.') {
        return this.getWorkspaceProblems();
      }
      const absPath = resolveWorkspacePath(this.cwd, request.path);
      const uri = vscode.Uri.file(absPath);
      try {
        await vscode.workspace.openTextDocument(uri);
      } catch {
        // ignore if virtual/missing
      }
      const rel = toPosixRelative(this.cwd, absPath);
      const diagnostics = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
      if (diagnostics.length === 0) {
        return `No errors or warnings detected in ${rel}.`;
      }
      return [
        rel,
        ...diagnostics.slice(0, 50).map(
          (d) =>
            `- [${d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}] Line ${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.message}`
        ),
      ].join('\n');
    }

    if (!request.path || !request.path.trim()) {
      throw new Error(`LSP '${request.operation}' requires a file path.`);
    }
    const absPath = resolveWorkspacePath(this.cwd, request.path);
    const uri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const line0 = Math.max(0, (request.line || 1) - 1);
    const char0 = Math.max(0, (request.character || 1) - 1);
    const pos = new vscode.Position(line0, char0);

    if (request.operation === 'definition') {
      const results = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        pos
      );
      return formatVsCodeLocations(this.cwd, 'Definition', results || []);
    }

    if (request.operation === 'references') {
      const results = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        doc.uri,
        pos
      );
      return formatVsCodeLocations(this.cwd, 'References', results || []);
    }

    if (request.operation === 'hover') {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        doc.uri,
        pos
      );
      if (!hovers || hovers.length === 0) {
        return 'No hover information available at this position.';
      }
      const chunks: string[] = [];
      for (const h of hovers) {
        for (const item of h.contents) {
          if (typeof item === 'string') {
            if (item.trim()) chunks.push(item.trim());
          } else if ('value' in item && typeof item.value === 'string' && item.value.trim()) {
            chunks.push(
              'language' in item && item.language
                ? `\`\`\`${item.language}\n${item.value.trim()}\n\`\`\``
                : item.value.trim()
            );
          }
        }
      }
      return chunks.length > 0 ? chunks.join('\n\n') : 'No hover information available at this position.';
    }

    throw new Error(`Unsupported LSP operation '${String(request.operation)}'.`);
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

function toIdeDiagnostics(diagnostics: readonly vscode.Diagnostic[]): IdeDiagnosticEntry[] {
  return diagnostics.map((diagnostic) => {
    const severity: IdeDiagnosticEntry['severity'] =
      diagnostic.severity === vscode.DiagnosticSeverity.Error
        ? 'error'
        : diagnostic.severity === vscode.DiagnosticSeverity.Warning
          ? 'warning'
          : diagnostic.severity === vscode.DiagnosticSeverity.Information
            ? 'info'
            : 'hint';
    const rawCode = typeof diagnostic.code === 'object' && diagnostic.code !== null
      ? diagnostic.code.value
      : diagnostic.code;
    return {
      severity,
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      message: diagnostic.message,
      source: diagnostic.source,
      code: rawCode,
    };
  });
}

function formatVsCodeLocations(
  cwd: string,
  heading: string,
  items: ReadonlyArray<vscode.Location | vscode.LocationLink>
): string {
  if (items.length === 0) {
    return `${heading}: no locations found.`;
  }
  const lines = items.slice(0, 100).map((item) => {
    if ('targetUri' in item) {
      const rel = toPosixRelative(cwd, item.targetUri.fsPath);
      const r = item.targetSelectionRange || item.targetRange;
      return `${rel}:${r.start.line + 1}:${r.start.character + 1}`;
    }
    const rel = toPosixRelative(cwd, item.uri.fsPath);
    return `${rel}:${item.range.start.line + 1}:${item.range.start.character + 1}`;
  });
  return `${heading} (${items.length}):\n${lines.join('\n')}`;
}

