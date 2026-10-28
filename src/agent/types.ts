import type { ThreadState } from './transport';
import type { TodoItem } from './toolParser';
import type { ApiMessage } from './prompts';

export type DiffLine = { type: ' ' | '+' | '-' | '@'; text: string };

export type AskKind =
  | 'tool'
  | 'command'
  | 'followup'
  | 'completion_result'
  | 'mode_switch'
  | 'new_task'
  | 'request_limit'
  | 'mistake_limit'
  | 'api_failed'
  | 'resume_task';

export interface ToolInfo {
  name: string;
  path?: string;
  /** Short human readable description, for example "Read src/app.ts (lines 1-200)". */
  title: string;
  content?: string;
  diff?: DiffLine[];
  added?: number;
  removed?: number;
  isNewFile?: boolean;
  regex?: string;
  mode?: string;
  reason?: string;
  outsideWorkspace?: boolean;
}

export interface UiMessage {
  id: string;
  ts: number;
  type:
    | 'user'
    | 'text'
    | 'reasoning'
    | 'tool'
    | 'command'
    | 'completion'
    | 'followup'
    | 'error'
    | 'info'
    | 'checkpoint'
    | 'subtask'
    | 'api_req';
  text?: string;
  partial?: boolean;
  tool?: ToolInfo;
  command?: { command: string; cwd?: string; output?: string; exitCode?: number | null; running?: boolean };
  suggestions?: Array<{ text: string; mode?: string }>;
  ask?: { kind: AskKind; resolved: boolean; response?: 'yes' | 'no' | 'message'; autoApproved?: boolean };
  status?: 'pending' | 'approved' | 'rejected' | 'done' | 'error' | 'running';
  meta?: { model?: string; account?: string; citations?: string[]; promptChars?: number; followUp?: boolean; durationMs?: number };
  checkpoint?: { seq: number; restored?: boolean };
  images?: string[];
}

export interface CheckpointRecord {
  seq: number;
  path: string;
  /** null means the file did not exist before the edit. */
  before: string | null;
  ts: number;
}

export interface AutoApproveSettings {
  enabled: boolean;
  read: boolean;
  readOutsideWorkspace: boolean;
  write: boolean;
  execute: boolean;
  modeSwitch: boolean;
  subtasks: boolean;
  todo: boolean;
  retry: boolean;
}

export interface AgentSettings {
  autoApprove: AutoApproveSettings;
  allowedCommands: string[];
  deniedCommands: string[];
  maxRequests: number;
  maxReadLines: number;
  commandTimeoutSec: number;
  terminalOutputLines: number;
  webSearch: 'auto' | 'always' | 'never';
  contextStrategy: 'auto' | 'full' | 'thread';
  maxPromptChars: number;
  language: string;
  customInstructions: string;
  modeInstructions: Record<string, string>;
  diffEnabled: boolean;
  includeFileListOnStart: boolean;
}

export interface ModelSelection {
  baseModelId: string;
  thinking: boolean;
  webSearch: boolean | undefined;
}

export interface TaskStatus {
  state: 'idle' | 'running' | 'waiting' | 'completed' | 'aborted' | 'error';
  askId?: string;
  askKind?: AskKind;
  requestCount: number;
}

export interface PersistedTask {
  version: 1;
  id: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  workspace: string;
  mode: string;
  modelId?: string;
  apiMessages: ApiMessage[];
  uiMessages: UiMessage[];
  todos: TodoItem[];
  thread?: ThreadState;
  checkpoints: CheckpointRecord[];
  status: TaskStatus['state'];
  requestCount: number;
  completionResult?: string;
}

export interface HistoryItem {
  id: string;
  ts: number;
  title: string;
  workspace: string;
  mode: string;
  status: TaskStatus['state'];
  parentId?: string;
  requestCount: number;
}
