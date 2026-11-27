import type { ThreadState } from './transport';
import type { TodoItem } from './toolParser';
import type { ApiMessage } from './prompts';
import type { ComputeMode } from '../api/types';

export type { ApiMessage, TodoItem };

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
  /** MCP server name (use_mcp_tool / access_mcp_resource). */
  server?: string;
  /** Target URL (web_fetch) or resource URI. */
  url?: string;
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
  command?: { command: string; cwd?: string; output?: string; exitCode?: number | null; running?: boolean; unconfirmed?: boolean };
  suggestions?: Array<{ text: string; mode?: string }>;
  ask?: { kind: AskKind; resolved: boolean; response?: 'yes' | 'no' | 'message'; autoApproved?: boolean };
  status?: 'pending' | 'approved' | 'rejected' | 'done' | 'error' | 'running';
  meta?: { model?: string; account?: string; citations?: string[]; promptChars?: number; followUp?: boolean; durationMs?: number; routeLine?: string };
  checkpoint?: { seq: number; restored?: boolean };
  images?: string[];
}

export interface CheckpointRecord {
  seq: number;
  path: string;
  /** null means the file did not exist before the edit. */
  before: string | null;
  ts: number;
  /** F28: Session `apiMessages` length prior to this checkpoint for `/rewind` session rollback. */
  apiMessageCount?: number;
  /** F28: Session `uiMessages` length prior to this checkpoint for `/rewind` session rollback. */
  uiMessageCount?: number;
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
  /** 3.3: MCP tool calls and resource reads. */
  mcp: boolean;
  /** 3.3: web_fetch. */
  web: boolean;
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
  /** F04: Stop task instead of falling back to another model/compute mode. */
  stopOnFallback?: boolean;
  /** F11/F14: Automatically attach @repo symbol/import/test map to task system context. */
  repoMapEnabled?: boolean;
  /** F11: Hard character budget for @repo repository map. Default 6000. */
  repoMapMaxChars?: number;
  /** F13: Ratio of maxPromptChars (0.3..0.98) triggering structured auto-compaction; 0 disables. Default 0.8. */
  autoCompactThreshold?: number;
  /** F13: Number of latest dialogue steps kept untouched during auto-compaction. Default 4. */
  autoCompactKeepSteps?: number;
  /** F16: Run new tasks inside an isolated git worktree created from HEAD. Default false. */
  worktreeEnabled?: boolean;
  /** F18: Maximum concurrent subtasks executed in parallel by Orchestrator. Default 3. */
  maxParallelSubtasks?: number;
  /** F24: Run cross-family model review on diff + verify before attempt_completion. Default false. */
  crossModelReview?: boolean;
  /** F24: Optional preferred reviewer model ID (must belong to another family, else auto-selected). */
  crossModelReviewModel?: string;
}

export interface WorktreeChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface WorktreeResultCard {
  worktreeName: string;
  worktreePath: string;
  mainRepoRoot: string;
  baseCommit: string;
  changedFiles: WorktreeChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  unifiedDiff: string;
  verify: {
    status: 'no_changes' | 'verified' | 'needs_review' | 'failed' | 'blocked';
    detail: string;
    editedFiles: string[];
  };
  state: 'pending' | 'applied' | 'discarded' | 'conflict';
  conflictFiles: string[];
  statusMessage?: string;
}

export interface ModelSelection {
  baseModelId: string;
  thinking: boolean;
  webSearch: boolean | undefined;
  /** 3.3: Perplexity compute mode (search / computer light-standard-high-ultra / research / labs). */
  computeMode?: ComputeMode;
}

export type TaskBannerPhase = 'waiting_approval' | 'retrying' | 'verifying' | 'needs_attention';
export type TaskBannerLabel = 'waiting for approval' | 'retrying request' | 'verifying result' | 'needs attention';

export interface TaskStateBanner {
  phase: TaskBannerPhase;
  label: TaskBannerLabel;
  reason: string;
  rule: string;
}

export interface TaskStatus {
  state: 'idle' | 'running' | 'waiting' | 'completed' | 'aborted' | 'error';
  askId?: string;
  askKind?: AskKind;
  requestCount: number;
  /** F03: Transparent task state banner with concrete reason and rule. */
  banner?: TaskStateBanner;
  /** F04: Last request route line: "<requested mode> → <actual>, <reason>". */
  routeLine?: string;
  /** F16/F17: Active isolated worktree name when task runs inside a git worktree. */
  worktreeName?: string;
  /** F16: Pre-start warning when uncommitted changes existed in the main checkout. */
  worktreeWarning?: string;
  /** F17: Result card with diff, verify outcome, and Apply / Discard controls. */
  worktreeCard?: WorktreeResultCard;
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
  routeLine?: string;
  /** F12: Context item IDs manually excluded by user via Context Inspector. */
  excludedContextIds?: string[];
  /** F16/F17: Persisted worktree metadata and result card. */
  worktreeName?: string;
  worktreePath?: string;
  mainRepoRoot?: string;
  worktreeBaseCommit?: string;
  worktreeWarning?: string;
  worktreeCard?: WorktreeResultCard;
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
