import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MODES } from '../agent/modes';
import { analyzeShellCommand } from '../agent/shellParser';
import { isInsideWorkspace, resolveWorkspacePath } from '../agent/tools';
import type { WorktreeChangedFile, WorktreeResultCard } from '../agent/types';
import type { SubagentDefinition } from './agents';
import type { HookEngine } from './hooks';
import { parseRule, ruleCoversTool } from './permissions';
import type { PermissionMode } from './types';
import type { VerificationReport } from './verification';

export type { WorktreeChangedFile, WorktreeResultCard };

/**
 * Release 3.7 (F16–F19): Git worktree task isolation, strict symlink & `git -C` confinement,
 * result card with unified diff + verify summary + non-merging Apply / Discard,
 * Orchestrator parallel subagents (readers in main tree, writers in isolated worktrees),
 * and Claude Code compatible `WorktreeCreate` / `WorktreeRemove` hooks.
 */

export interface DirtyCheckoutInspection {
  isGitRepo: boolean;
  repoRoot: string;
  gitCommonDir: string;
  headCommit: string;
  dirty: boolean;
  dirtyFiles: string[];
  warningMessage?: string;
}

export interface IsolatedWorktreeHandle {
  name: string;
  worktreePath: string;
  mainRepoRoot: string;
  gitCommonDir: string;
  baseCommit: string;
  createdByHook: boolean;
  dirtyMainCheckout?: boolean;
  dirtyMainWarning?: string;
  warningMessage?: string;
  dirtyMainFiles: string[];
  removed?: boolean;
}

export interface ApplyWorktreeResult {
  ok: boolean;
  state: 'applied' | 'conflict';
  appliedFiles: string[];
  conflictFiles: string[];
  message: string;
}

export class WorktreeHookBlockedError extends Error {
  readonly code = 'WORKTREE_HOOK_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeHookBlockedError';
  }
}

function runGit(cwd: string, args: string[], envExtra?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const res = cp.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: envExtra ? { ...process.env, ...envExtra } : process.env,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || (res.error ? res.error.message : ''),
  };
}

export function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function sanitizeWorktreeName(raw?: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === 'true' || trimmed === '1') {
    const stamp = Date.now().toString(36).slice(-5);
    const rand = crypto.randomBytes(2).toString('hex');
    return `wt-${stamp}-${rand}`;
  }
  const cleaned = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid worktree name: '${raw}'.`);
  }
  return cleaned;
}

/**
 * F16: Inspects the main git checkout before starting an isolated worktree task.
 * Emits an explicit Russian warning when uncommitted changes exist in the main tree.
 */
export function inspectMainCheckoutDirty(cwd: string): DirtyCheckoutInspection {
  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout.trim()) {
    return {
      isGitRepo: false,
      repoRoot: path.resolve(cwd),
      gitCommonDir: '',
      headCommit: '',
      dirty: false,
      dirtyFiles: [],
    };
  }
  const repoRoot = safeRealpath(top.stdout.trim());
  const commonRaw = runGit(repoRoot, ['rev-parse', '--git-common-dir']);
  const gitCommonDir = commonRaw.status === 0 && commonRaw.stdout.trim()
    ? safeRealpath(path.resolve(repoRoot, commonRaw.stdout.trim()))
    : path.join(repoRoot, '.git');
  const headRes = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  const headCommit = headRes.status === 0 ? headRes.stdout.trim() : '';

  const statusRes = runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const dirtyFiles: string[] = [];
  if (statusRes.status === 0 && statusRes.stdout) {
    for (const line of statusRes.stdout.split(/\r?\n/)) {
      if (!line || line.length < 4) continue;
      const rawFile = line.slice(3).trim();
      const arrowIdx = rawFile.indexOf(' -> ');
      const rel = (arrowIdx >= 0 ? rawFile.slice(arrowIdx + 4) : rawFile).replace(/^"|"$/g, '');
      if (rel) {
        dirtyFiles.push(rel);
      }
    }
  }

  const dirty = dirtyFiles.length > 0;
  let warningMessage: string | undefined;
  if (dirty) {
    const sample = dirtyFiles.slice(0, 5).join(', ') + (dirtyFiles.length > 5 ? ` and ${dirtyFiles.length - 5} more` : '');
    const shortSha = headCommit ? headCommit.slice(0, 7) : 'HEAD';
    warningMessage = `Warning: the main working tree has uncommitted changes (${dirtyFiles.length}: ${sample}). The isolated git worktree is created from HEAD (${shortSha}) and does not include uncommitted edits from the main checkout.`;
  }

  return {
    isGitRepo: true,
    repoRoot,
    gitCommonDir,
    headCommit,
    dirty,
    dirtyFiles,
    warningMessage,
  };
}

export interface CreateWorktreeOptions {
  cwd: string;
  name?: string;
  sessionId?: string;
  taskId?: string;
  hooks?: HookEngine;
  permissionMode?: PermissionMode;
}

/**
 * F16 & F19: Creates a detached git worktree from `HEAD` under `<gitCommonDir>/perplexicode-worktrees/<name>`
 * and invokes `WorktreeCreate` hooks when configured.
 */
export async function createIsolatedWorktree(options: CreateWorktreeOptions): Promise<IsolatedWorktreeHandle> {
  const inspection = inspectMainCheckoutDirty(options.cwd);
  if (!inspection.isGitRepo || !inspection.headCommit) {
    throw new Error('--worktree needs a git repository with at least one commit (HEAD).');
  }

  const name = sanitizeWorktreeName(options.name);
  const baseDir = path.join(inspection.gitCommonDir, 'perplexicode-worktrees');
  fs.mkdirSync(baseDir, { recursive: true });
  let worktreePath = path.join(baseDir, name);

  // Clean up any stale registration or leftover folder with the same worktree name
  runGit(inspection.repoRoot, ['worktree', 'prune']);
  if (fs.existsSync(worktreePath)) {
    runGit(inspection.repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  const addRes = runGit(inspection.repoRoot, ['worktree', 'add', '--detach', worktreePath, inspection.headCommit]);
  if (addRes.status !== 0) {
    throw new Error(`Could not create git worktree '${name}': ${addRes.stderr.trim() || addRes.stdout.trim()}`);
  }
  worktreePath = safeRealpath(worktreePath);
  let createdByHook = false;

  if (options.hooks?.has('WorktreeCreate')) {
    const decision = await options.hooks.run('WorktreeCreate', {
      session_id: options.sessionId || options.taskId || `wt-${name}`,
      cwd: inspection.repoRoot,
      permission_mode: options.permissionMode || 'default',
      hook_event_name: 'WorktreeCreate',
      name,
      worktree_name: name,
      worktree_path: worktreePath,
      base_commit: inspection.headCommit,
    });
    if (decision.block || decision.permission === 'deny' || decision.stopTask) {
      runGit(inspection.repoRoot, ['worktree', 'remove', '--force', worktreePath]);
      fs.rmSync(worktreePath, { recursive: true, force: true });
      throw new WorktreeHookBlockedError(
        decision.reason || decision.stopReason || 'Worktree creation was blocked by the WorktreeCreate hook.'
      );
    }
    if (decision.worktreePath) {
      const candidateCustom = path.resolve(inspection.repoRoot, decision.worktreePath);
      if (fs.existsSync(candidateCustom) && fs.statSync(candidateCustom).isDirectory()) {
        const customReal = safeRealpath(candidateCustom);
        if (customReal !== worktreePath) {
          runGit(inspection.repoRoot, ['worktree', 'remove', '--force', worktreePath]);
          fs.rmSync(worktreePath, { recursive: true, force: true });
          worktreePath = customReal;
          createdByHook = true;
        }
      }
    }
  }

  const handle: IsolatedWorktreeHandle = {
    name,
    worktreePath,
    mainRepoRoot: inspection.repoRoot,
    gitCommonDir: inspection.gitCommonDir,
    baseCommit: inspection.headCommit,
    createdByHook,
    dirtyMainCheckout: inspection.dirty,
    dirtyMainWarning: inspection.warningMessage,
    warningMessage: inspection.warningMessage,
    dirtyMainFiles: inspection.dirtyFiles,
  };
  try {
    fs.writeFileSync(
      path.join(baseDir, `${name}.meta.json`),
      JSON.stringify({
        name: handle.name,
        worktreePath: handle.worktreePath,
        mainRepoRoot: handle.mainRepoRoot,
        gitCommonDir: handle.gitCommonDir,
        baseCommit: handle.baseCommit,
        createdByHook: handle.createdByHook,
      }, null, 2),
      'utf8'
    );
  } catch {
    // ignore metadata sidecar errors
  }
  return handle;
}

export function listManagedWorktrees(cwd: string): IsolatedWorktreeHandle[] {
  const inspection = inspectMainCheckoutDirty(cwd);
  if (!inspection.isGitRepo || !inspection.gitCommonDir) {
    return [];
  }
  const baseDir = path.join(inspection.gitCommonDir, 'perplexicode-worktrees');
  if (!fs.existsSync(baseDir)) {
    return [];
  }
  const out: IsolatedWorktreeHandle[] = [];
  for (const entry of fs.readdirSync(baseDir)) {
    if (!entry.endsWith('.meta.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(baseDir, entry), 'utf8'));
      if (parsed && parsed.name && parsed.worktreePath && fs.existsSync(parsed.worktreePath)) {
        out.push({
          name: String(parsed.name),
          worktreePath: String(parsed.worktreePath),
          mainRepoRoot: String(parsed.mainRepoRoot || inspection.repoRoot),
          gitCommonDir: String(parsed.gitCommonDir || inspection.gitCommonDir),
          baseCommit: String(parsed.baseCommit || inspection.headCommit),
          createdByHook: Boolean(parsed.createdByHook),
          dirtyMainFiles: [],
        });
      }
    } catch {
      // ignore malformed sidecar
    }
  }
  return out;
}

export function loadManagedWorktree(cwd: string, name: string): IsolatedWorktreeHandle | undefined {
  return listManagedWorktrees(cwd).find((item) => item.name === name);
}

/**
 * F19: Removes an isolated worktree and runs `WorktreeRemove` hooks.
 */
export async function removeIsolatedWorktree(
  handle: IsolatedWorktreeHandle,
  options: {
    hooks?: HookEngine;
    sessionId?: string;
    taskId?: string;
    permissionMode?: PermissionMode;
    reason?: 'applied' | 'discarded' | 'cleanup';
  } = {}
): Promise<void> {
  if (handle.removed) {
    return;
  }
  handle.removed = true;
  const reason = options.reason || 'cleanup';

  if (options.hooks?.has('WorktreeRemove')) {
    await options.hooks.run('WorktreeRemove', {
      session_id: options.sessionId || options.taskId || `wt-${handle.name}`,
      cwd: handle.mainRepoRoot,
      permission_mode: options.permissionMode || 'default',
      hook_event_name: 'WorktreeRemove',
      name: handle.name,
      worktree_name: handle.name,
      worktree_path: handle.worktreePath,
      base_commit: handle.baseCommit,
      reason,
    });
  }

  if (!handle.createdByHook) {
    runGit(handle.mainRepoRoot, ['worktree', 'remove', '--force', handle.worktreePath]);
    runGit(handle.mainRepoRoot, ['worktree', 'prune']);
  }
  if (fs.existsSync(handle.worktreePath)) {
    fs.rmSync(handle.worktreePath, { recursive: true, force: true });
  }
  if (handle.gitCommonDir) {
    const metaPath = path.join(handle.gitCommonDir, 'perplexicode-worktrees', `${handle.name}.meta.json`);
    if (fs.existsSync(metaPath)) {
      try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
    }
  }
}

/**
 * F16: Enforces strict confinement of file paths inside `worktreeRoot`, including symlink traversal
 * (both existing symlinks and intermediate symlinked directories, as well as dangling symlinks
 * whose link target points outside `worktreeRoot`).
 */
export function enforceWorktreePathIsolation(
  worktreeRoot: string,
  candidatePath: string
): { ok: boolean; resolvedPath: string; reason?: string } {
  const wtReal = safeRealpath(worktreeRoot);
  const wtLex = path.resolve(worktreeRoot);
  const lexResolved = resolveWorkspacePath(wtReal, candidatePath || '.');

  if (!isInsideWorkspace(wtReal, lexResolved) && !isInsideWorkspace(wtLex, resolveWorkspacePath(wtLex, candidatePath || '.'))) {
    return {
      ok: false,
      resolvedPath: lexResolved,
      reason: `Path '${candidatePath}' is outside the isolated worktree (${wtReal}).`,
    };
  }

  // Walk every prefix component under wtReal to detect symlinks escaping the worktree (even broken symlinks!)
  const relFromWt = path.relative(wtReal, lexResolved);
  const parts = relFromWt ? relFromWt.split(path.sep).filter(Boolean) : [];
  let cursor = wtReal;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch {
      // Non-existent tail (e.g. creating a new file inside an existing safe parent directory)
      break;
    }
    if (stat.isSymbolicLink()) {
      let linkTargetAbs: string;
      try {
        linkTargetAbs = fs.realpathSync(cursor);
      } catch {
        // Broken symlink: inspect raw readlink target resolved against parent directory
        const rawLink = fs.readlinkSync(cursor);
        linkTargetAbs = path.resolve(path.dirname(cursor), rawLink);
      }
      if (!isInsideWorkspace(wtReal, linkTargetAbs)) {
        return {
          ok: false,
          resolvedPath: linkTargetAbs,
          reason: `Symlink '${candidatePath}' points outside the isolated worktree (${linkTargetAbs}).`,
        };
      }
      cursor = linkTargetAbs;
    }
  }

  // Also check deepest existing ancestor's realpath
  let probe = lexResolved;
  while (probe && probe !== path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      const realProbe = safeRealpath(probe);
      if (!isInsideWorkspace(wtReal, realProbe)) {
        return {
          ok: false,
          resolvedPath: realProbe,
          reason: `Real path '${realProbe}' is outside the isolated worktree (${wtReal}).`,
        };
      }
      break;
    }
    probe = path.dirname(probe);
  }

  return { ok: true, resolvedPath: lexResolved };
}

function tokenizeSimpleWords(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      current += segment[i + 1];
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * F16: Enforces strict shell command confinement inside `worktreeRoot`:
 * - Blocks `cwd` escaping `worktreeRoot` (including via symlinks)
 * - Blocks unparseable/dynamic shell obfuscation (`eval`, `$cmd`, unclosed quotes)
 * - Blocks `git -C <outside>`, `git --git-dir=<outside>`, `git --work-tree=<outside>`, and `git push`
 * - Blocks `cd` / `pushd` outside `worktreeRoot`
 * - Blocks `ln -s <outside>` creating escape symlinks
 * - Blocks path tokens referencing `mainRepoRoot` (outside `worktreeRoot`) or `..` escaping `worktreeRoot`
 */
export function enforceWorktreeCommandIsolation(params: {
  command: string;
  worktreeRoot: string;
  mainRepoRoot?: string;
  cwd?: string;
}): { ok: boolean; reason?: string } {
  const wtReal = safeRealpath(params.worktreeRoot);
  const mainReal = params.mainRepoRoot ? safeRealpath(params.mainRepoRoot) : undefined;

  const baseCwdCheck = enforceWorktreePathIsolation(wtReal, params.cwd || '.');
  if (!baseCwdCheck.ok) {
    return { ok: false, reason: baseCwdCheck.reason };
  }

  const analysis = analyzeShellCommand(params.command);
  if (!analysis.valid) {
    return {
      ok: false,
      reason: `Command rejected in worktree isolation (unparseable or dynamic syntax): ${analysis.reason || 'unparseable shell'}`,
    };
  }

  let effectiveCwd = baseCwdCheck.resolvedPath;

  // Pre-scan raw command tokens for GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE
  // before analyzeShellCommand normalizes away leading VAR=val prefixes.
  for (const rawTok of tokenizeSimpleWords(params.command)) {
    const cleanTok = rawTok.replace(/^[;|&()]+|[;|&()]+$/g, '');
    const m = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)=(.*)$/.exec(cleanTok);
    if (m) {
      const envKey = m[1];
      const envVal = m[2] || '';
      const envPathCheck = enforceWorktreePathIsolation(wtReal, path.resolve(effectiveCwd, envVal));
      if (!envPathCheck.ok) {
        return {
          ok: false,
          reason: `Variable ${envKey} points outside the isolated worktree: ${envVal}`,
        };
      }
    }
  }

  for (const segment of analysis.segments) {
    const rawTokens = tokenizeSimpleWords(segment);
    if (rawTokens.length === 0) continue;

    // Strip leading VAR=val assignments and transparent wrappers
    let idx = 0;
    while (idx < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[idx])) {
      const eqPos = rawTokens[idx].indexOf('=');
      const envKey = rawTokens[idx].slice(0, eqPos);
      const envVal = rawTokens[idx].slice(eqPos + 1);
      if (envKey === 'GIT_DIR' || envKey === 'GIT_WORK_TREE' || envKey === 'GIT_COMMON_DIR') {
        const envPathCheck = enforceWorktreePathIsolation(wtReal, path.resolve(effectiveCwd, envVal));
        if (!envPathCheck.ok) {
          return {
            ok: false,
            reason: `Variable ${envKey} points outside the isolated worktree: ${envVal}`,
          };
        }
      }
      idx += 1;
    }
    while (idx < rawTokens.length && (rawTokens[idx] === 'env' || rawTokens[idx] === 'command' || rawTokens[idx] === 'nohup' || rawTokens[idx] === 'time')) {
      idx += 1;
      while (idx < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[idx])) {
        idx += 1;
      }
    }
    if (idx >= rawTokens.length) continue;

    const bin = path.basename(rawTokens[idx]);
    const args = rawTokens.slice(idx + 1);

    // 1. cd / pushd confinement
    if (bin === 'cd' || bin === 'pushd') {
      const target = args[0] || '~';
      if (target === '~' || target.startsWith('~/') || target === '-') {
        return {
          ok: false,
          reason: `'${bin} ${target}' leaves the isolated worktree and is not allowed.`,
        };
      }
      const nextAbs = path.resolve(effectiveCwd, target);
      const check = enforceWorktreePathIsolation(wtReal, nextAbs);
      if (!check.ok) {
        return { ok: false, reason: check.reason };
      }
      effectiveCwd = check.resolvedPath;
      continue;
    }

    // 2. git -C / --git-dir / --work-tree / push / worktree confinement
    if (bin === 'git') {
      let gitSubcmd: string | undefined;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-C') {
          const dirArg = args[i + 1] || '';
          const check = enforceWorktreePathIsolation(wtReal, path.resolve(effectiveCwd, dirArg));
          if (!check.ok) {
            return {
              ok: false,
              reason: `'git -C ${dirArg}' reaches outside the isolated worktree.`,
            };
          }
          i += 1;
          continue;
        }
        if (arg.startsWith('-C') && arg.length > 2) {
          const dirArg = arg.slice(2);
          const check = enforceWorktreePathIsolation(wtReal, path.resolve(effectiveCwd, dirArg));
          if (!check.ok) {
            return {
              ok: false,
              reason: `'git ${arg}' reaches outside the isolated worktree.`,
            };
          }
          continue;
        }
        if (arg === '--git-dir' || arg === '--work-tree') {
          const dirArg = args[i + 1] || '';
          const check = enforceWorktreePathIsolation(wtReal, path.resolve(effectiveCwd, dirArg));
          if (!check.ok) {
            return {
              ok: false,
              reason: `'git ${arg} ${dirArg}' reaches outside the isolated worktree.`,
            };
          }
          i += 1;
          continue;
        }
        if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
          const dirArg = arg.slice(arg.indexOf('=') + 1);
          const check = enforceWorktreePathIsolation(wtReal, path.resolve(effectiveCwd, dirArg));
          if (!check.ok) {
            return {
              ok: false,
              reason: `'git ${arg}' reaches outside the isolated worktree.`,
            };
          }
          continue;
        }
        if (!arg.startsWith('-') && !gitSubcmd) {
          gitSubcmd = arg;
        }
      }
      if (gitSubcmd === 'push') {
        return {
          ok: false,
          reason: 'git push from an isolated worktree is not allowed (use the result card).',
        };
      }
      if (gitSubcmd === 'worktree') {
        return {
          ok: false,
          reason: 'Managing git worktrees from inside an isolated task is not allowed.',
        };
      }
    }

    // 3. ln -s <target> <link> confinement
    if (bin === 'ln') {
      const positional = args.filter((a) => !a.startsWith('-'));
      if (positional.length >= 1) {
        const rawTarget = positional[0];
        const linkLocation = positional.length >= 2
          ? path.resolve(effectiveCwd, positional[positional.length - 1])
          : effectiveCwd;
        const resolvedTarget = path.isAbsolute(rawTarget)
          ? rawTarget
          : path.resolve(path.dirname(linkLocation), rawTarget);
        const check = enforceWorktreePathIsolation(wtReal, resolvedTarget);
        if (!check.ok) {
          return {
            ok: false,
            reason: `Creating a symlink to the outside path '${rawTarget}' in an isolated worktree is not allowed.`,
          };
        }
      }
    }

    // 4. Generic path-argument check against parent traversal (`..`), `~`, mainRepoRoot, and symlink traversal
    for (const rawArg of args) {
      if (!rawArg || rawArg.startsWith('-') || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawArg)) {
        continue;
      }
      // Strip redirection operators like `>../out` or `2>/tmp/x`
      const cleanedArg = rawArg.replace(/^[0-9]*>>?|^<+/, '');
      if (!cleanedArg) continue;

      if (cleanedArg === '~' || cleanedArg.startsWith('~/')) {
        return {
          ok: false,
          reason: `Accessing the home directory '${cleanedArg}' from an isolated worktree is not allowed.`,
        };
      }

      const looksLikePath =
        cleanedArg === '..'
        || cleanedArg.startsWith('../')
        || cleanedArg.includes('/..')
        || cleanedArg.startsWith('./')
        || path.isAbsolute(cleanedArg);

      if (looksLikePath) {
        // Allow /dev/null and Node/system binaries only if not referencing mainRepoRoot or escaping via ..
        if (cleanedArg === '/dev/null') continue;
        if (
          cleanedArg === '..'
          || cleanedArg.startsWith('../')
          || cleanedArg.includes('/..')
          || (mainReal && isInsideWorkspace(mainReal, path.resolve(effectiveCwd, cleanedArg)) && !isInsideWorkspace(wtReal, path.resolve(effectiveCwd, cleanedArg)))
        ) {
          const check = enforceWorktreePathIsolation(wtReal, path.resolve(effectiveCwd, cleanedArg));
          if (!check.ok) {
            return { ok: false, reason: check.reason };
          }
        }
      }

      // If cleanedArg matches an existing symlink inside effectiveCwd that points outside wtReal, block it!
      const candidateLocal = path.resolve(effectiveCwd, cleanedArg);
      if (isInsideWorkspace(wtReal, candidateLocal) && fs.existsSync(candidateLocal)) {
        const symCheck = enforceWorktreePathIsolation(wtReal, candidateLocal);
        if (!symCheck.ok) {
          return { ok: false, reason: symCheck.reason };
        }
      }
    }
  }

  return { ok: true };
}

const WORKTREE_PATH_TOOLS = new Set([
  'read_file',
  'write_to_file',
  'apply_diff',
  'insert_content',
  'search_and_replace',
  'list_files',
  'search_files',
  'list_code_definition_names',
  'glob_files',
]);

export interface WorktreeIsolationCheck {
  ok: boolean;
  reason?: string;
}

/**
 * F16: Unified pre-execution check for file tools and `execute_command` inside an isolated worktree.
 */
export function enforceWorktreeToolCall(
  tool: { name: string; params: Record<string, string | undefined> },
  isolation: { worktreeRoot: string; mainRepoRoot?: string }
): WorktreeIsolationCheck {
  if (tool.name === 'execute_command') {
    return enforceWorktreeCommandIsolation({
      command: tool.params.command || '',
      cwd: tool.params.cwd,
      worktreeRoot: isolation.worktreeRoot,
      mainRepoRoot: isolation.mainRepoRoot,
    });
  }
  if (WORKTREE_PATH_TOOLS.has(tool.name)) {
    const rawPath = (tool.params.path ?? '.').trim() || '.';
    const check = enforceWorktreePathIsolation(isolation.worktreeRoot, rawPath);
    return { ok: check.ok, reason: check.reason };
  }
  return { ok: true };
}

/**
 * Captures the complete diff (modified, added/untracked, deleted, renamed) between `handle.baseCommit`
 * and the current working tree inside `handle.worktreePath`, using an ephemeral git index so the
 * worktree's own git state is never mutated.
 */
export function captureWorktreeSnapshot(handle: IsolatedWorktreeHandle): {
  changedFiles: WorktreeChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  unifiedDiff: string;
  binaryPatch: string;
} {
  if (!fs.existsSync(handle.worktreePath)) {
    return { changedFiles: [], totalAdditions: 0, totalDeletions: 0, unifiedDiff: '', binaryPatch: '' };
  }

  const tmpIndex = path.join(
    os.tmpdir(),
    `pcode-wt-idx-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  );
  const env = { GIT_INDEX_FILE: tmpIndex };

  try {
    runGit(handle.worktreePath, ['read-tree', handle.baseCommit], env);
    runGit(handle.worktreePath, ['add', '-A'], env);

    const statusRes = runGit(handle.worktreePath, ['diff', '--cached', '--name-status', '-M', handle.baseCommit], env);
    const numstatRes = runGit(handle.worktreePath, ['diff', '--cached', '--numstat', '-M', handle.baseCommit], env);
    const diffRes = runGit(handle.worktreePath, ['diff', '--cached', '-M', handle.baseCommit], env);
    const patchRes = runGit(handle.worktreePath, ['diff', '--cached', '--binary', '-M', handle.baseCommit], env);

    const statusMap = new Map<string, WorktreeChangedFile['status']>();
    for (const line of statusRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const code = (parts[0] || '').trim();
      const filePath = (parts.length >= 3 ? parts[2] : parts[1] || '').trim();
      if (!filePath) continue;
      const status: WorktreeChangedFile['status'] = code.startsWith('A')
        ? 'added'
        : code.startsWith('D')
          ? 'deleted'
          : code.startsWith('R')
            ? 'renamed'
            : 'modified';
      statusMap.set(filePath, status);
    }

    const changedFiles: WorktreeChangedFile[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of numstatRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const add = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
      const del = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
      let filePath = parts.slice(2).join('\t').trim();
      // Normalize rename syntax `src/{old => new}.ts` or `old => new`
      const braceRename = filePath.match(/^(.*)\{[^}]* => ([^}]*)\}(.*)$/);
      if (braceRename) {
        filePath = `${braceRename[1]}${braceRename[2]}${braceRename[3]}`.replace(/\/+/g, '/');
      } else if (filePath.includes(' => ')) {
        filePath = filePath.split(' => ').pop()!.trim();
      }
      totalAdditions += add;
      totalDeletions += del;
      changedFiles.push({
        path: filePath,
        status: statusMap.get(filePath) || 'modified',
        additions: add,
        deletions: del,
      });
    }

    return {
      changedFiles,
      totalAdditions,
      totalDeletions,
      unifiedDiff: diffRes.stdout,
      binaryPatch: patchRes.stdout,
    };
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * F17: Builds the Worktree Result Card (diff, verify summary, Apply / Discard state).
 * Never auto-merges or pushes.
 */
export function buildWorktreeResultCard(
  handle: IsolatedWorktreeHandle,
  verification: VerificationReport,
  state: WorktreeResultCard['state'] = 'pending',
  conflictFiles: string[] = [],
  statusMessage?: string
): WorktreeResultCard {
  const snap = captureWorktreeSnapshot(handle);
  return {
    worktreeName: handle.name,
    worktreePath: handle.worktreePath,
    mainRepoRoot: handle.mainRepoRoot,
    baseCommit: handle.baseCommit,
    changedFiles: snap.changedFiles,
    totalAdditions: snap.totalAdditions,
    totalDeletions: snap.totalDeletions,
    unifiedDiff: snap.unifiedDiff,
    verify: {
      status: verification.status,
      detail: verification.detail,
      editedFiles: [...verification.editedFiles],
    },
    state,
    conflictFiles: [...conflictFiles],
    statusMessage,
  };
}

function parseGitApplyConflictFiles(stderr: string, fallbackCandidates: string[]): string[] {
  const found = new Set<string>();
  const patterns = [
    /error:\s+patch failed:\s+([^\s:]+):\d+/g,
    /error:\s+([^:\n]+):\s+(?:patch does not apply|already exists in working directory|does not exist in working tree|cannot read)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) {
      if (m[1]) found.add(m[1].trim());
    }
  }
  if (found.size === 0) {
    for (const candidate of fallbackCandidates) {
      if (stderr.includes(candidate)) {
        found.add(candidate);
      }
    }
  }
  return [...found].sort();
}

/**
 * F17: Applies the isolated worktree's changes to `mainRepoRoot` WITHOUT automatic `git merge`,
 * `git commit`, or `git push`. Performs an atomic dry-run check first; if any conflict exists,
 * halts immediately without modifying `mainRepoRoot` and returns the exact list of conflicting files.
 */
export async function applyWorktreeChanges(
  handle: IsolatedWorktreeHandle,
  options: {
    hooks?: HookEngine;
    sessionId?: string;
    taskId?: string;
    permissionMode?: PermissionMode;
    keepWorktreeOnApply?: boolean;
    removeAfterApply?: boolean;
  } = {}
): Promise<ApplyWorktreeResult> {
  const keepWorktree = options.keepWorktreeOnApply ?? (options.removeAfterApply === false);
  const effectiveSessionId = options.sessionId || options.taskId;
  const snap = captureWorktreeSnapshot(handle);
  if (snap.changedFiles.length === 0 || !snap.binaryPatch.trim()) {
    if (!keepWorktree) {
      await removeIsolatedWorktree(handle, {
        hooks: options.hooks,
        sessionId: effectiveSessionId,
        permissionMode: options.permissionMode,
        reason: 'applied',
      });
    }
    return {
      ok: true,
      state: 'applied',
      appliedFiles: [],
      conflictFiles: [],
      message: 'The worktree has no changes to apply.',
    };
  }

  // Pre-check untracked/modified collisions for newly added files in mainRepoRoot
  const preConflicts = new Set<string>();
  for (const file of snap.changedFiles) {
    if (file.status === 'added') {
      const targetInMain = path.join(handle.mainRepoRoot, file.path);
      const sourceInWt = path.join(handle.worktreePath, file.path);
      if (fs.existsSync(targetInMain) && fs.existsSync(sourceInWt)) {
        const mainBytes = fs.readFileSync(targetInMain);
        const wtBytes = fs.readFileSync(sourceInWt);
        if (!mainBytes.equals(wtBytes)) {
          preConflicts.add(file.path);
        }
      }
    }
  }

  const tmpPatch = path.join(
    os.tmpdir(),
    `pcode-wt-apply-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.patch`
  );
  fs.writeFileSync(tmpPatch, snap.binaryPatch, 'utf8');

  try {
    const checkRes = runGit(handle.mainRepoRoot, ['apply', '--check', '--whitespace=nowarn', tmpPatch]);
    if (checkRes.status !== 0 || preConflicts.size > 0) {
      const parsed = parseGitApplyConflictFiles(
        checkRes.stderr,
        snap.changedFiles.map((f) => f.path)
      );
      for (const p of parsed) preConflicts.add(p);
      if (preConflicts.size === 0) {
        // Fallback: find which touched files diverged from baseCommit in mainRepoRoot
        for (const f of snap.changedFiles) {
          const diffMain = runGit(handle.mainRepoRoot, ['diff', '--name-only', handle.baseCommit, '--', f.path]);
          if (diffMain.stdout.trim() || fs.existsSync(path.join(handle.mainRepoRoot, f.path))) {
            preConflicts.add(f.path);
          }
        }
      }
      const conflictFiles = [...preConflicts].sort();
      return {
        ok: false,
        state: 'conflict',
        appliedFiles: [],
        conflictFiles,
        message: `Conflict while applying worktree '${handle.name}'. The main tree was not changed. Conflicting files: ${conflictFiles.join(', ')}`,
      };
    }

    const applyRes = runGit(handle.mainRepoRoot, ['apply', '--whitespace=nowarn', tmpPatch]);
    if (applyRes.status !== 0) {
      const conflictFiles = parseGitApplyConflictFiles(
        applyRes.stderr,
        snap.changedFiles.map((f) => f.path)
      );
      return {
        ok: false,
        state: 'conflict',
        appliedFiles: [],
        conflictFiles,
        message: `Failed to apply the patch from worktree '${handle.name}': ${applyRes.stderr.trim()}`,
      };
    }

    if (!keepWorktree) {
      await removeIsolatedWorktree(handle, {
        hooks: options.hooks,
        sessionId: effectiveSessionId,
        permissionMode: options.permissionMode,
        reason: 'applied',
      });
    }

    const appliedFiles = snap.changedFiles.map((f) => f.path);
    return {
      ok: true,
      state: 'applied',
      appliedFiles,
      conflictFiles: [],
      message: `Changes from worktree '${handle.name}' applied to the working copy (${appliedFiles.length} file(s), no auto merge or push).`,
    };
  } finally {
    try {
      if (fs.existsSync(tmpPatch)) fs.unlinkSync(tmpPatch);
    } catch {
      // ignore
    }
  }
}

/**
 * F17: Discards an isolated worktree without touching `mainRepoRoot` and fires `WorktreeRemove`.
 */
export async function discardWorktreeChanges(
  handle: IsolatedWorktreeHandle,
  options: {
    hooks?: HookEngine;
    sessionId?: string;
    taskId?: string;
    permissionMode?: PermissionMode;
  } = {}
): Promise<{ ok: true; worktreeName: string; state: 'discarded'; message: string }> {
  await removeIsolatedWorktree(handle, {
    hooks: options.hooks,
    sessionId: options.sessionId || options.taskId,
    permissionMode: options.permissionMode,
    reason: 'discarded',
  });
  return {
    ok: true,
    worktreeName: handle.name,
    state: 'discarded',
    message: `Changes in worktree '${handle.name}' discarded, isolated tree removed.`,
  };
}

/**
 * F18: Determines whether a subtask target (built-in mode or `.claude/agents` subagent) is
 * strictly read-only (runs in the main workspace tree) or write-capable (must run in its own
 * isolated git worktree when orchestrated in parallel).
 */
export function isReadOnlySubagentTarget(slug: string, agent?: SubagentDefinition): boolean {
  if (agent) {
    if (agent.tools && agent.tools.length > 0) {
      const writeProbeTools = ['write_to_file', 'apply_diff', 'insert_content', 'search_and_replace'];
      for (const rawRule of agent.tools) {
        const parsed = parseRule(rawRule);
        if (!parsed) continue;
        if (writeProbeTools.some((t) => ruleCoversTool(parsed.tool, t))) {
          return false;
        }
        if (ruleCoversTool(parsed.tool, 'execute_command')) {
          const spec = (parsed.specifier || '').trim().toLowerCase();
          // Only strictly read-only git inspection specifiers count as read-only Bash
          const safeGitRead = /^git\s+(diff|status|log|show|rev-parse|branch)\b/.test(spec);
          if (!safeGitRead) {
            return false;
          }
        }
      }
      return true;
    }
    return isReadOnlySubagentTarget(agent.mode);
  }

  const builtIn = MODES.find((m) => m.slug === slug);
  if (!builtIn) {
    return false;
  }
  const hasWriteOrCmdGroup = builtIn.groups.some((entry) => {
    const groupName = Array.isArray(entry) ? entry[0] : entry;
    return groupName === 'edit' || groupName === 'command';
  });
  return !hasWriteOrCmdGroup;
}

/**
 * F18: Bounded concurrency runner for parallel Orchestrator subagents.
 * Preserves input ordering in returned results and enforces `maxParallel` >= 1.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  maxParallel: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(16, Math.floor(maxParallel || 3)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function lane(): Promise<void> {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= items.length) {
        return;
      }
      results[idx] = await worker(items[idx], idx);
    }
  }

  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => lane());
  await Promise.all(lanes);
  return results;
}
