import * as fs from 'fs';
import * as path from 'path';
import type { Memento } from 'vscode';
import { HistoryItem, PersistedTask } from './types';

const HISTORY_KEY = 'perplexicode.agent.history';
const MAX_HISTORY = 300;

/** Task history persisted under the extension's global storage folder. */
export class TaskStore {
  private readonly dir: string;
  private writeTimers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, PersistedTask>();

  constructor(storageDir: string, private readonly state: Memento) {
    this.dir = path.join(storageDir, 'tasks');
  }

  list(): HistoryItem[] {
    return (this.state.get<HistoryItem[]>(HISTORY_KEY) || []).slice().sort((a, b) => b.ts - a.ts);
  }

  async load(id: string): Promise<PersistedTask | undefined> {
    const pending = this.pending.get(id);
    if (pending) {
      return pending;
    }
    try {
      const raw = await fs.promises.readFile(this.file(id), 'utf8');
      const parsed = JSON.parse(raw) as PersistedTask;
      return parsed.version === 1 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Debounced save; call flush() before shutdown. */
  save(task: PersistedTask): void {
    this.pending.set(task.id, task);
    const existing = this.writeTimers.get(task.id);
    if (existing) {
      clearTimeout(existing);
    }
    this.writeTimers.set(task.id, setTimeout(() => {
      void this.write(task.id);
    }, 600));
  }

  async flush(): Promise<void> {
    const ids = [...this.pending.keys()];
    await Promise.all(ids.map((id) => this.write(id)));
  }

  async delete(id: string): Promise<void> {
    const timer = this.writeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    this.pending.delete(id);
    await fs.promises.rm(this.file(id), { force: true });
    const children = this.list().filter((item) => item.parentId === id).map((item) => item.id);
    await this.state.update(HISTORY_KEY, this.list().filter((item) => item.id !== id && !children.includes(item.id)));
    await Promise.all(children.map((child) => fs.promises.rm(this.file(child), { force: true })));
  }

  async clear(): Promise<void> {
    for (const item of this.list()) {
      await fs.promises.rm(this.file(item.id), { force: true });
    }
    await this.state.update(HISTORY_KEY, []);
  }

  private async write(id: string): Promise<void> {
    const task = this.pending.get(id);
    if (!task) {
      return;
    }
    this.pending.delete(id);
    this.writeTimers.delete(id);
    if (task.uiMessages.length === 0) {
      return;
    }
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(id)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(task), 'utf8');
    await fs.promises.rename(tmp, this.file(id));

    const item: HistoryItem = {
      id: task.id,
      ts: task.updatedAt,
      title: task.title || 'Untitled task',
      workspace: task.workspace,
      mode: task.mode,
      status: task.status,
      parentId: task.parentId,
      requestCount: task.requestCount,
    };
    const items = this.list().filter((entry) => entry.id !== id);
    items.unshift(item);
    const kept = items.slice(0, MAX_HISTORY);
    const dropped = items.slice(MAX_HISTORY);
    await this.state.update(HISTORY_KEY, kept);
    await Promise.all(dropped.map((entry) => fs.promises.rm(this.file(entry.id), { force: true })));
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }
}
