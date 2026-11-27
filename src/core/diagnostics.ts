import * as os from 'os';
import type { TimedCoreEvent } from './types';

/**
 * Redacted diagnostics bundle for `pcode doctor --bundle` and the IDE
 * "Скопировать диагностику" action (F08).
 *
 * Security invariant:
 * - Strictly allowlisted fields only.
 * - Never includes cookies, session/CSRF tokens, HTTP headers, user prompts,
 *   assistant replies, file contents/diffs, source code, or terminal command
 *   strings / terminal output.
 */

export interface DiagnosticStageEntry {
  seq: number;
  ts: number;
  elapsedMs: number;
  stage: string;
  durationMs?: number;
  ok?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  decision?: string;
  reason?: string;
  rule?: string;
  route?: string;
}

export interface DiagnosticBundle {
  schemaVersion: 1;
  generatedAt: string;
  redacted: true;
  excludedData: string[];
  versions: {
    perplexicode: string;
    node: string;
    platform: string;
    release: string;
    arch: string;
    client: 'cli' | 'vscode';
    ideVersion?: string;
  };
  settings: {
    permissionMode: string;
    protectSecrets: boolean;
    stopOnFallback: boolean;
    computeMode: string;
    contextStrategy?: string;
    maxPromptChars?: number;
    hasVerifyCommand: boolean;
    ruleCounts: {
      allow: number;
      ask: number;
      deny: number;
    };
    hookEventCount: number;
    accountCount: number;
    activeAccountPlans: string[];
    mcpServers: Array<{
      type: string;
      scope: string;
      status: string;
    }>;
  };
  task?: {
    id: string;
    mode: string;
    state: string;
    requestCount: number;
    routeLine?: string;
    banner?: {
      phase: string;
      label: string;
      reason: string;
      rule: string;
    };
    verificationStatus?: string;
  };
  stages: DiagnosticStageEntry[];
}

export interface DiagnosticInput {
  version: string;
  client: 'cli' | 'vscode';
  ideVersion?: string;
  permissionMode: string;
  protectSecrets: boolean;
  stopOnFallback: boolean;
  computeMode: string;
  contextStrategy?: string;
  maxPromptChars?: number;
  hasVerifyCommand: boolean;
  ruleCounts: { allow: number; ask: number; deny: number };
  hookEventCount: number;
  accountPlans: string[];
  mcpServers?: Array<{ type: string; scope: string; status: string }>;
  task?: {
    id: string;
    mode: string;
    state: string;
    requestCount: number;
    routeLine?: string;
    banner?: {
      phase: string;
      label: string;
      reason: string;
      rule: string;
    };
    verificationStatus?: string;
  };
  events?: TimedCoreEvent[];
}

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /__Secure-next-auth\.session-token\s*=\s*[^\s;,"']+/gi,
  /next-auth\.csrf-token\s*=\s*[^\s;,"']+/gi,
  /next-auth\.session-token\s*=\s*[^\s;,"']+/gi,
  /pplx\.session-id\s*=\s*[^\s;,"']+/gi,
  /\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi,
  /\bAuthorization\s*:\s*[^\r\n]+/gi,
  /\b(?:X-CSRF-Token|X-API-Key|Proxy-Authorization)\s*:\s*[^\r\n]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:pplx-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+@)/gi,
];

/** Scrubs cookies, CSRF tokens, auth headers, bearer/API tokens and URL credentials from text. */
export function scrubSecretsFromText(input: string | undefined): string {
  if (!input) {
    return '';
  }
  let clean = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    clean = clean.replace(pattern, (_match, prefix) => (typeof prefix === 'string' && prefix.includes('://') ? `${prefix}[REDACTED]@` : '[REDACTED]'));
  }
  // Redact any absolute home path usernames to `~`.
  const home = os.homedir();
  if (home && home.length > 1) {
    clean = clean.split(home).join('~');
  }
  return clean;
}

/** Summarizes a short decision reason without preserving raw code, prompts, commands, or secrets. */
function sanitizeDiagnosticReason(reason: string | undefined, maxLen = 200): string | undefined {
  if (!reason) {
    return undefined;
  }
  // Strip inline backticked shell snippets or multi-line outputs from reasons.
  const singleLine = scrubSecretsFromText(reason)
    .split('\n')[0]
    .replace(/`[^`]{16,}`/g, '`[redacted]`')
    .trim();
  return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen)}…` : singleLine;
}

export function buildStagesFromEvents(events: TimedCoreEvent[]): DiagnosticStageEntry[] {
  if (events.length === 0) {
    return [];
  }
  const baseTs = events[0].ts || Date.now();
  const stages: DiagnosticStageEntry[] = [];
  let lastCommandStartTs: number | undefined;
  let lastToolStartTs: number | undefined;

  for (const event of events) {
    const elapsedMs = Math.max(0, (event.ts || baseTs) - baseTs);
    switch (event.type) {
      case 'session_start':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: event.resumed ? 'session_resume' : 'session_start',
          reason: `mode=${event.mode}`,
        });
        break;
      case 'request_start':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'request_start',
          route: sanitizeDiagnosticReason(event.model, 120),
        });
        break;
      case 'request_end':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'request_end',
          durationMs: event.durationMs,
          ok: event.ok,
          route: sanitizeDiagnosticReason(event.routeLine || event.model, 160),
          reason: event.error ? sanitizeDiagnosticReason(event.error, 160) : undefined,
        });
        break;
      case 'tool_start':
        lastToolStartTs = event.ts;
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: `tool_start:${event.tool}`,
        });
        break;
      case 'tool_end':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: `tool_end:${event.tool}`,
          durationMs: lastToolStartTs ? Math.max(0, event.ts - lastToolStartTs) : undefined,
          ok: event.ok,
        });
        lastToolStartTs = undefined;
        break;
      case 'denied':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: `denied:${event.tool}`,
          decision: 'deny',
          reason: sanitizeDiagnosticReason(event.reason, 160),
          rule: sanitizeDiagnosticReason(event.source, 120),
        });
        break;
      case 'command_start':
        lastCommandStartTs = event.ts;
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'command_start',
        });
        break;
      case 'command_end':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'command_end',
          durationMs: lastCommandStartTs ? Math.max(0, event.ts - lastCommandStartTs) : undefined,
          exitCode: event.exitCode,
          timedOut: event.timedOut,
          ok: event.exitCode === 0 && !event.timedOut,
        });
        lastCommandStartTs = undefined;
        break;
      case 'command_unconfirmed':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'command_unconfirmed',
          decision: 'unconfirmed',
          reason: 'результат не подтверждён',
          rule: 'journal.interrupted_command',
        });
        lastCommandStartTs = undefined;
        break;
      case 'banner':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: `banner:${event.phase}`,
          decision: event.label,
          reason: sanitizeDiagnosticReason(event.reason, 160),
          rule: sanitizeDiagnosticReason(event.rule, 120),
        });
        break;
      case 'state':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: `state:${event.state}`,
        });
        break;
      case 'verification':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'verification',
          decision: event.status,
          reason: sanitizeDiagnosticReason(event.detail, 160),
        });
        break;
      case 'compacted':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'compacted',
          reason: `${event.before}->${event.after}`,
        });
        break;
      case 'completion':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: 'completion',
          ok: true,
        });
        break;
      case 'mode':
        stages.push({
          seq: event.seq,
          ts: event.ts,
          elapsedMs,
          stage: `mode:${event.mode}`,
        });
        break;
      default:
        // Intentionally skip `user`, `assistant`, and `file_edit` paths/contents.
        break;
    }
  }
  return stages.slice(-200);
}

export function buildDiagnosticBundle(input: DiagnosticInput): DiagnosticBundle {
  const bundle: DiagnosticBundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    redacted: true,
    excludedData: [
      'cookies',
      'csrf_tokens',
      'http_headers',
      'prompts',
      'assistant_messages',
      'source_code_and_diffs',
      'terminal_commands_and_output',
    ],
    versions: {
      perplexicode: input.version,
      node: process.versions.node,
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      client: input.client,
      ideVersion: input.ideVersion,
    },
    settings: {
      permissionMode: input.permissionMode,
      protectSecrets: input.protectSecrets,
      stopOnFallback: input.stopOnFallback,
      computeMode: input.computeMode,
      contextStrategy: input.contextStrategy,
      maxPromptChars: input.maxPromptChars,
      hasVerifyCommand: input.hasVerifyCommand,
      ruleCounts: { ...input.ruleCounts },
      hookEventCount: input.hookEventCount,
      accountCount: input.accountPlans.length,
      activeAccountPlans: [...input.accountPlans],
      mcpServers: (input.mcpServers || []).map((server) => ({
        type: server.type,
        scope: server.scope,
        status: server.status,
      })),
    },
    task: input.task
      ? {
        id: input.task.id,
        mode: input.task.mode,
        state: input.task.state,
        requestCount: input.task.requestCount,
        routeLine: sanitizeDiagnosticReason(input.task.routeLine, 180),
        banner: input.task.banner
          ? {
            phase: input.task.banner.phase,
            label: input.task.banner.label,
            reason: sanitizeDiagnosticReason(input.task.banner.reason, 180) || '',
            rule: sanitizeDiagnosticReason(input.task.banner.rule, 120) || '',
          }
          : undefined,
        verificationStatus: input.task.verificationStatus,
      }
      : undefined,
    stages: buildStagesFromEvents(input.events || []),
  };

  const serialized = JSON.stringify(bundle);
  assertNoSecretsInDiagnosticJson(serialized);
  return bundle;
}

export function serializeDiagnosticBundle(bundle: DiagnosticBundle): string {
  const json = scrubSecretsFromText(JSON.stringify(bundle, null, 2));
  assertNoSecretsInDiagnosticJson(json);
  return json;
}

export function assertNoSecretsInDiagnosticJson(json: string): void {
  const forbidden = [
    /__Secure-next-auth\.session-token/i,
    /next-auth\.csrf-token/i,
    /\bSet-Cookie\s*:/i,
    /\bAuthorization\s*:\s*Bearer/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(json)) {
      throw new Error('Diagnostic bundle safety check failed: secret token pattern detected.');
    }
  }
}
