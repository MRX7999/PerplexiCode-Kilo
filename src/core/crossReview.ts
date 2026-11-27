import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getModelById } from '../api/modelCatalog';
import type { CompletionRequest, CompletionResult } from '../agent/transport';

export interface CrossReviewProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type ModelFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'moonshot'
  | 'deepseek'
  | 'zhipu'
  | 'perplexity'
  | 'other';

/**
 * Resolves the underlying model family for both direct chat model IDs and ASI/Computer model IDs
 * (e.g. `pplx_asi_opus` → `anthropic`, `pplx_asi_astra` → `openai`, `gemini4argon` → `google`).
 */
export function inferModelFamily(modelId: string): ModelFamily {
  const id = (modelId || '').trim().toLowerCase();
  if (!id) return 'perplexity';

  if (id.includes('claude') || id.includes('sonnet') || id.includes('opus') || id.includes('haiku') || id.includes('fable')) {
    return 'anthropic';
  }
  if (id.includes('gpt') || id.includes('astra') || /(?:^|[_-])sol(?:$|[_-])/.test(id) || /^o[134](?:$|[-_])/.test(id)) {
    return 'openai';
  }
  if (id.includes('gemini') || id.includes('argon')) {
    return 'google';
  }
  if (id.includes('grok')) {
    return 'xai';
  }
  if (id.includes('kimi') || id.includes('moonshot')) {
    return 'moonshot';
  }
  if (id.includes('deepseek')) {
    return 'deepseek';
  }
  if (id.includes('glm')) {
    return 'zhipu';
  }

  const catalog = getModelById(modelId);
  const meta = `${catalog?.provider || ''} ${catalog?.category || ''}`.toLowerCase();
  if (meta.includes('anthropic')) return 'anthropic';
  if (meta.includes('openai')) return 'openai';
  if (meta.includes('google')) return 'google';
  if (meta.includes('xai')) return 'xai';
  if (meta.includes('moonshot')) return 'moonshot';
  if (meta.includes('deepseek')) return 'deepseek';
  if (meta.includes('zhipu')) return 'zhipu';

  if (id === 'turbo' || id === 'best' || id === 'default' || id.startsWith('sonar') || id.startsWith('pplx_')) {
    return 'perplexity';
  }
  return 'other';
}

const CROSS_FAMILY_CANDIDATES = [
  'claude55sonnet',
  'gpt6_1_sol',
  'gemini38flash',
  'grok47',
] as const;

/**
 * Picks a reviewer model guaranteed to belong to a different model family than `authorModelId`.
 */
export function selectCrossReviewModel(
  authorModelId: string,
  preferredReviewerModelId?: string
): {
  reviewerModelId: string;
  authorFamily: ModelFamily;
  reviewerFamily: ModelFamily;
} {
  const authorFamily = inferModelFamily(authorModelId);
  const preferred = preferredReviewerModelId?.trim();
  if (preferred) {
    const preferredFamily = inferModelFamily(preferred);
    if (preferredFamily !== authorFamily || authorFamily === 'other') {
      return {
        reviewerModelId: preferred,
        authorFamily,
        reviewerFamily: preferredFamily,
      };
    }
  }

  for (const candidate of CROSS_FAMILY_CANDIDATES) {
    const candidateFamily = inferModelFamily(candidate);
    if (candidateFamily !== authorFamily) {
      return {
        reviewerModelId: candidate,
        authorFamily,
        reviewerFamily: candidateFamily,
      };
    }
  }

  return {
    reviewerModelId: 'gpt6_1_sol',
    authorFamily,
    reviewerFamily: 'openai',
  };
}

function execGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    cp.execFile('git', ['--no-pager', ...args], { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      resolve({
        code: err ? (typeof (err as cp.ExecFileException).code === 'number' ? Number((err as cp.ExecFileException).code) : 1) : 0,
        stdout: String(stdout || ''),
      });
    });
  });
}

/**
 * Builds a bounded unified diff of edits in `cwd` (uses `git diff HEAD` when inside a git repo,
 * plus untracked/fallback edited file snapshots).
 */
export async function collectWorkspaceReviewDiff(
  cwd: string,
  editedPaths: Iterable<string>,
  maxChars = 24_000
): Promise<string> {
  const chunks: string[] = [];
  const headDiff = await execGit(cwd, ['diff', 'HEAD', '--no-color']);
  const workingDiff = headDiff.code === 0
    ? headDiff.stdout
    : (await execGit(cwd, ['diff', '--no-color'])).stdout;

  if (workingDiff.trim()) {
    chunks.push(workingDiff.trim());
  }

  for (const rawRel of editedPaths) {
    const abs = path.isAbsolute(rawRel) ? rawRel : path.resolve(cwd, rawRel);
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;
    // Include edited files that were untracked or when outside a git repo.
    if (workingDiff.includes(`b/${rel}`)) continue;
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const content = fs.readFileSync(abs, 'utf8').slice(0, 6000);
        const plusLines = content.split('\n').map((line) => `+${line}`).join('\n');
        chunks.push(`diff --git a/${rel} b/${rel}\nnew/modified file: ${rel}\n@@\n${plusLines}`);
      }
    } catch {
      // ignore unreadable binary/deleted file
    }
  }

  const joined = chunks.join('\n\n').trim();
  if (joined.length <= maxChars) {
    return joined;
  }
  return `${joined.slice(0, maxChars)}\n... [diff truncated at ${maxChars} chars]`;
}

export interface CrossReviewVerdict {
  approved: boolean;
  summary: string;
  findings: string[];
}

export function parseCrossReviewVerdict(rawText: string): CrossReviewVerdict {
  const text = (rawText || '').trim();
  if (!text) {
    return { approved: true, summary: 'Empty review response (non-blocking).', findings: [] };
  }

  // Support structured JSON verdicts (plain or fenced ```json ... ```) in addition to plain-text VERDICT: ...
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (unfenced.startsWith('{') && unfenced.endsWith('}')) {
    try {
      const parsed = JSON.parse(unfenced) as Record<string, unknown>;
      const rawVerdict = String(parsed.verdict || '').toUpperCase().trim();
      const rawIssues = Array.isArray(parsed.issues)
        ? parsed.issues
        : Array.isArray(parsed.findings)
          ? parsed.findings
          : [];
      const findings = rawIssues.map((x) => String(x).trim()).filter(Boolean);
      const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : findings[0] || 'Cross-model review completed.';
      if (rawVerdict === 'REQUEST_CHANGES' || rawVerdict === 'CHANGES_REQUESTED' || rawVerdict === 'REJECT' || rawVerdict === 'BLOCK') {
        return {
          approved: false,
          summary,
          findings: findings.length > 0 ? findings : [summary],
        };
      }
      if (rawVerdict === 'APPROVE' || rawVerdict === 'APPROVED' || rawVerdict === 'LGTM' || rawVerdict === 'PASS') {
        return { approved: true, summary, findings };
      }
    } catch {
      // fall through to line-based parser
    }
  }

  const requestChangesMatch = /VERDICT\s*:\s*(REQUEST_CHANGES|CHANGES_REQUESTED|REJECT|BLOCK)/i.test(text);
  const approveMatch = /VERDICT\s*:\s*(APPROVE|APPROVED|LGTM|PASS)/i.test(text);

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const findings = lines
    .filter((line) => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);

  if (requestChangesMatch && !approveMatch) {
    const summaryLine = lines.find((l) => !/^VERDICT\s*:/i.test(l)) || 'Reviewer requested fixes before completion.';
    return {
      approved: false,
      summary: summaryLine,
      findings: findings.length > 0 ? findings : [summaryLine],
    };
  }

  if (approveMatch) {
    const summaryLine = lines.find((l) => !/^VERDICT\s*:/i.test(l)) || 'Cross-model review approved the changes.';
    return {
      approved: true,
      summary: summaryLine,
      findings,
    };
  }

  return {
    approved: true,
    summary: lines[0] || 'Cross-model review completed with no blocking verdict.',
    findings,
  };
}

export interface RunCrossModelReviewOptions {
  provider: CrossReviewProvider;
  authorModelId: string;
  preferredReviewerModelId?: string;
  diff: string;
  verifySummary: string;
  completionSummary: string;
  signal: AbortSignal;
}

export interface CrossModelReviewResult extends CrossReviewVerdict {
  authorModelId: string;
  authorFamily: ModelFamily;
  reviewerModelId: string;
  reviewerFamily: ModelFamily;
  reviewerLabel?: string;
}

export async function runCrossModelReview(options: RunCrossModelReviewOptions): Promise<CrossModelReviewResult> {
  const { reviewerModelId, authorFamily, reviewerFamily } = selectCrossReviewModel(
    options.authorModelId,
    options.preferredReviewerModelId
  );

  const prompt = [
    'You are performing an independent pre-completion code review from a different model family than the author.',
    `Author model: ${options.authorModelId} (family: ${authorFamily})`,
    `Reviewer model: ${reviewerModelId} (family: ${reviewerFamily})`,
    '',
    'Inspect the diff and verification status below ONLY for concrete bugs, broken edge cases, security vulnerabilities, or unverified claims.',
    'Do NOT nitpick formatting, comments, or style.',
    '',
    'Reply in plain text starting on line 1 with EXACTLY one of:',
    'VERDICT: APPROVE',
    'VERDICT: REQUEST_CHANGES',
    '',
    'If REQUEST_CHANGES, list each concrete blocking defect as a `- file:line — issue and how to fix` bullet.',
    '',
    '=== Proposed completion summary ===',
    options.completionSummary.slice(0, 4000),
    '',
    '=== Verification status ===',
    options.verifySummary.slice(0, 4000) || 'No verification command output recorded.',
    '',
    '=== Diff ===',
    options.diff || '(no textual diff captured)',
  ].join('\n');

  const completion = await options.provider.complete({
    fullPrompt: prompt,
    baseModelId: reviewerModelId,
    thinking: false,
    webSearch: false,
    computeMode: 'search',
    signal: options.signal,
  });

  const verdict = parseCrossReviewVerdict(completion.text);
  return {
    ...verdict,
    authorModelId: options.authorModelId,
    authorFamily,
    reviewerModelId,
    reviewerFamily,
    reviewerLabel: completion.modelLabel,
  };
}
