import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PersistedTask } from '../agent/types';
import { CoreEvent, TimedCoreEvent } from './types';

/**
 * Durable sessions shared by the extension and the CLI.
 *
 *   ~/.perplexicode/sessions/<taskId>.jsonl   append-only event log (audit trail, crash evidence)
 *   ~/.perplexicode/sessions/<taskId>.json    latest task snapshot, replaced atomically
 *
 * Resume = load the snapshot, then inspect the log for work that started but never finished.
 * A command with a command_start and no command_end has an UNKNOWN outcome: it may have run
 * (migrations, deploys, rm -rf). It is never replayed automatically; the model is told to check
 * the real state first.
 */

export function perplexicodeHome(): string {
  return process.env.PERPLEXICODE_HOME || path.join(os.homedir(), '.perplexicode');
}

export function sessionsDir(home = perplexicodeHome()): string {
  return path.join(home, 'sessions');
}

export class SessionJournal {
  private seq = 0;
  private readonly logFile: string;
  private readonly snapshotFile: string;

  constructor(readonly taskId: string, readonly dir = sessionsDir()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.logFile = path.join(dir, `${safeId(taskId)}.jsonl`);
    this.snapshotFile = path.join(dir, `${safeId(taskId)}.json`);
    this.seq = countLines(this.logFile);
  }

  get logPath(): string {
    return this.logFile;
  }

  append(event: CoreEvent): TimedCoreEvent {
    this.seq += 1;
    const timed = { ...event, ts: Date.now(), seq: this.seq, taskId: this.taskId } as TimedCoreEvent;
    fs.appendFileSync(this.logFile, `${JSON.stringify(redactEvent(timed))}\n`, { mode: 0o600 });
    return timed;
  }

  /** Atomic snapshot: write to a temp file, fsync, rename. */
  snapshot(task: PersistedTask): void {
    const tmp = `${this.snapshotFile}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(task));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.snapshotFile);
  }

  static events(taskId: string, dir = sessionsDir()): TimedCoreEvent[] {
    const file = path.join(dir, `${safeId(taskId)}.jsonl`);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: TimedCoreEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line after a crash; ignore it.
      }
    }
    return out;
  }

  static loadSnapshot(taskId: string, dir = sessionsDir()): PersistedTask | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${safeId(taskId)}.json`), 'utf8')) as PersistedTask;
      return parsed && parsed.version === 1 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  mode: string;
  status: string;
  updatedAt: number;
  requestCount: number;
  parentId?: string;
}

export function listSessions(options: { dir?: string; workspace?: string; includeSubtasks?: boolean } = {}): SessionSummary[] {
  const dir = options.dir || sessionsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of files) {
    const snapshot = SessionJournal.loadSnapshot(name.slice(0, -5), dir);
    if (!snapshot) continue;
    if (options.workspace && path.resolve(snapshot.workspace) !== path.resolve(options.workspace)) continue;
    if (!options.includeSubtasks && snapshot.parentId) continue;
    out.push({
      id: snapshot.id,
      title: snapshot.title,
      workspace: snapshot.workspace,
      mode: snapshot.mode,
      status: snapshot.status,
      updatedAt: snapshot.updatedAt,
      requestCount: snapshot.requestCount,
      parentId: snapshot.parentId,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Resolves a full id, a unique prefix or "latest" (for the given workspace). */
export function findSession(ref: string, options: { dir?: string; workspace?: string } = {}): SessionSummary | undefined {
  const all = listSessions({ dir: options.dir, includeSubtasks: true });
  if (ref === 'latest' || ref === '') {
    return listSessions({ dir: options.dir, workspace: options.workspace })[0];
  }
  const exact = all.find((entry) => entry.id === ref);
  if (exact) return exact;
  const prefixed = all.filter((entry) => entry.id.startsWith(ref));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

export interface InterruptedWork {
  /** Commands that were started and never reported an exit code. */
  unknownCommands: string[];
  /** A model request was in flight (safe to resend). */
  requestInFlight: boolean;
  /** Tool calls that started without a tool_end. */
  unfinishedTools: string[];
  lastState?: string;
}

export function detectInterruptedWork(events: TimedCoreEvent[]): InterruptedWork {
  const openCommands: string[] = [];
  const openTools: string[] = [];
  let requestInFlight = false;
  let lastState: string | undefined;
  for (const event of events) {
    switch (event.type) {
      case 'command_start':
        openCommands.push(event.command);
        break;
      case 'command_end': {
        const index = openCommands.lastIndexOf(event.command);
        if (index >= 0) openCommands.splice(index, 1);
        break;
      }
      case 'tool_start':
        openTools.push(event.tool);
        break;
      case 'tool_end':
      case 'denied': {
        const index = openTools.lastIndexOf(event.tool);
        if (index >= 0) openTools.splice(index, 1);
        break;
      }
      case 'request_start':
        requestInFlight = true;
        break;
      case 'request_end':
        requestInFlight = false;
        break;
      case 'state':
        lastState = event.state;
        break;
      case 'session_start':
        // A clean resume closes everything that was open before it.
        openCommands.length = 0;
        openTools.length = 0;
        requestInFlight = false;
        break;
      default:
        break;
    }
  }
  return { unknownCommands: openCommands, requestInFlight, unfinishedTools: openTools, lastState };
}

/** The note added to the transcript when a session is resumed after an interruption. */
export function resumeNote(work: InterruptedWork): string {
  const lines = ['[Session resumed after an interruption (crash, closed terminal or lost connection).'];
  if (work.unknownCommands.length > 0) {
    lines.push(`These commands were started but their outcome is UNKNOWN: ${work.unknownCommands.map((command) => `\`${command}\``).join(', ')}. They may have partially or fully run. Do NOT re-run them blindly; first inspect the real state (files, git status, service status, database) and only then decide.`);
  }
  if (work.unfinishedTools.length > 0) {
    lines.push(`Tool calls without a recorded result: ${work.unfinishedTools.join(', ')}. Re-read affected files before editing them.`);
  }
  lines.push('Continue the task from where it stopped.]');
  return lines.join(' ');
}

const SECRET_KEYS = /session[-_]?token|csrf|cookie|authorization|api[-_]?key|password|secret/i;

function redactEvent(event: TimedCoreEvent): TimedCoreEvent {
  if (event.type !== 'tool_start') return event;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.params)) {
    params[key] = SECRET_KEYS.test(key) ? '[redacted]' : value.length > 4000 ? `${value.slice(0, 4000)}… [${value.length} chars]` : value;
  }
  return { ...event, params };
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function countLines(file: string): number {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}
