import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentHost, CommandResult, spawnShellCommand } from '../agent/tools';

/** AgentHost for plain Node (CLI, CI, SSH sessions on a VPS). No editor required. */
export class NodeAgentHost implements AgentHost {
  private rg?: string | null;

  constructor(readonly cwd: string, private readonly env: Record<string, string> = {}) {}

  async readFile(absPath: string): Promise<string> {
    return fs.promises.readFile(absPath, 'utf8');
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    // Write to a temp file and rename, so a crash never leaves a half-written source file.
    const tmp = `${absPath}.pcode-${process.pid}.tmp`;
    let mode: number | undefined;
    try {
      mode = (await fs.promises.stat(absPath)).mode;
    } catch {
      mode = undefined;
    }
    await fs.promises.writeFile(tmp, content, 'utf8');
    if (mode !== undefined) {
      await fs.promises.chmod(tmp, mode & 0o7777).catch(() => undefined);
    }
    await fs.promises.rename(tmp, absPath);
  }

  async deleteFile(absPath: string): Promise<void> {
    await fs.promises.rm(absPath, { force: true });
  }

  runCommand(command: string, cwd: string, options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void }): Promise<CommandResult> {
    return spawnShellCommand(command, cwd, { ...options, env: { ...process.env, ...this.env, PERPLEXICODE: '1', CI: process.env.CI || '' } });
  }

  ripgrepPath(): string | undefined {
    if (this.rg === undefined) {
      try {
        const which = process.platform === 'win32' ? 'where rg' : 'command -v rg';
        this.rg = cp.execSync(which, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' ? undefined : '/bin/sh' }).split('\n')[0].trim() || null;
      } catch {
        this.rg = null;
      }
    }
    return this.rg || undefined;
  }
}
