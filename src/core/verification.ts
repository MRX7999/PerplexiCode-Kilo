import { CoreEvent, VerificationStatus } from './types';

/**
 * Turns "the model says it is done" into evidence.
 *
 *   verified      files changed and a check (test/lint/build/typecheck) passed after the last edit
 *   failed        the last check after the last edit failed
 *   needs_review  files changed but nothing checked them afterwards
 *   blocked       the task ended on a denial, a limit or an error without completion
 *   no_changes    the task completed without editing files (answers, plans, reviews)
 */

export const CHECK_COMMAND = /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|build|check|typecheck|type-check|verify)\b|npx\s+(tsc|vitest|jest|eslint|mocha|playwright)\b|tsc\b|vitest\b|jest\b|mocha\b|pytest\b|python3?\s+-m\s+(pytest|unittest|mypy|ruff)\b|ruff\b|mypy\b|flake8\b|go\s+(test|vet|build)\b|cargo\s+(test|check|clippy|build)\b|make\s+(test|check|lint)\b|ctest\b|swift\s+(test|build)\b|xcodebuild\b.*\btest\b|gradle\w*\s+(test|check|build)\b|mvn\s+(test|verify)\b|dotnet\s+(test|build)\b|phpunit\b|rspec\b|shellcheck\b|node\s+--test\b|terraform\s+validate\b|xray\s+(run\s+)?-test\b|nginx\s+-t\b|sshd\s+-t\b|caddy\s+validate\b)/;

export function isCheckCommand(command: string): boolean {
  return CHECK_COMMAND.test(command.trim());
}

export interface VerificationReport {
  status: VerificationStatus;
  detail: string;
  editedFiles: string[];
  checks: Array<{ command: string; exitCode: number | null; afterLastEdit: boolean }>;
}

export class VerificationTracker {
  /** @param extraChecks commands that always count as checks (the configured `verify.command`). */
  constructor(private readonly extraChecks: string[] = []) {}

  private order = 0;
  private lastEditOrder = -1;
  private readonly edited = new Set<string>();
  private readonly checks: Array<{ command: string; exitCode: number | null; order: number }> = [];
  private denials = 0;
  private completed = false;
  private lastState = '';

  observe(event: CoreEvent): void {
    this.order += 1;
    switch (event.type) {
      case 'file_edit':
        this.lastEditOrder = this.order;
        this.edited.add(event.path);
        break;
      case 'command_end':
        if (isCheckCommand(event.command) || this.extraChecks.includes(event.command.trim())) {
          this.checks.push({ command: event.command, exitCode: event.timedOut ? null : event.exitCode, order: this.order });
        }
        break;
      case 'denied':
        this.denials += 1;
        break;
      case 'completion':
        this.completed = true;
        break;
      case 'state':
        this.lastState = event.state;
        break;
      default:
        break;
    }
  }

  report(): VerificationReport {
    const editedFiles = [...this.edited];
    const checks = this.checks.map((check) => ({ command: check.command, exitCode: check.exitCode, afterLastEdit: check.order > this.lastEditOrder }));
    const after = checks.filter((check) => check.afterLastEdit);
    if (!this.completed && (this.lastState === 'error' || this.lastState === 'aborted' || this.denials > 0)) {
      return { status: 'blocked', detail: this.lastState === 'aborted' ? 'Stopped before completion.' : this.denials > 0 ? `Ended without completion after ${this.denials} denied operation(s).` : 'Ended with an error before completion.', editedFiles, checks };
    }
    if (editedFiles.length === 0) {
      return { status: 'no_changes', detail: 'No files were changed.', editedFiles, checks };
    }
    if (after.length === 0) {
      return { status: 'needs_review', detail: `${editedFiles.length} file(s) changed; no test, lint or build ran after the last edit.`, editedFiles, checks };
    }
    const last = after[after.length - 1];
    if (last.exitCode === 0) {
      return { status: 'verified', detail: `${editedFiles.length} file(s) changed; \`${last.command}\` passed after the last edit.`, editedFiles, checks };
    }
    return { status: 'failed', detail: `\`${last.command}\` ${last.exitCode === null ? 'timed out' : `exited with ${last.exitCode}`} after the last edit.`, editedFiles, checks };
  }
}

export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  verified: 'Verified',
  needs_review: 'Needs review',
  failed: 'Failed',
  blocked: 'Blocked',
  no_changes: 'No changes',
};
