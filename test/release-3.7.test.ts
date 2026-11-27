import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import type { CompletionProvider } from '../src/agent/task';
import { parseAssistantMessage } from '../src/agent/toolParser';
import type { AgentSettings } from '../src/agent/types';
import {
  classifyCliErrorExitCode,
  classifyPrintExitCode,
  main as cliMain,
  parseArgs,
  PCODE_EXIT_CODES,
} from '../src/cli/index';
import { HookEngine } from '../src/core/hooks';
import { CoreSession, RunResult } from '../src/core/runner';
import { defaultSettings } from '../src/core/settings';
import {
  applyWorktreeChanges,
  buildWorktreeResultCard,
  createIsolatedWorktree,
  discardWorktreeChanges,
  enforceWorktreeCommandIsolation,
  enforceWorktreePathIsolation,
  enforceWorktreeToolCall,
  inspectMainCheckoutDirty,
  isReadOnlySubagentTarget,
  listManagedWorktrees,
  removeIsolatedWorktree,
  runWithConcurrencyLimit,
  WorktreeHookBlockedError,
} from '../src/core/worktree';

function initTempGitRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-37-git-'));
  const git = (args: string[]) => {
    const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
    return res.stdout.trim();
  };
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  git(['add', '-A']);
  git(['commit', '-m', 'Initial commit']);
  return fs.realpathSync(root);
}

function baseAgentSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    autoApprove: {
      enabled: true,
      read: true,
      readOutsideWorkspace: false,
      write: true,
      execute: true,
      modeSwitch: true,
      subtasks: true,
      todo: true,
      retry: true,
      mcp: false,
      web: false,
    },
    allowedCommands: ['*'],
    deniedCommands: [],
    maxRequests: 20,
    maxReadLines: 500,
    commandTimeoutSec: 30,
    terminalOutputLines: 200,
    webSearch: 'never',
    contextStrategy: 'full',
    maxPromptChars: 60_000,
    language: 'ru',
    customInstructions: '',
    modeInstructions: {},
    diffEnabled: true,
    includeFileListOnStart: true,
    ...overrides,
  };
}

function mockReply(text: string) {
  return {
    text,
    citations: [] as Array<{ title?: string; url: string }>,
    modelLabel: 'mock-model',
    accountAlias: 'mock-account',
    promptChars: text.length,
    usedFollowUp: false,
  };
}

// -----------------------------------------------------------------------------------------------
// F16: Isolated git worktree from HEAD, dirty main checkout warning, symlink & git -C confinement
// -----------------------------------------------------------------------------------------------

test('F16: inspectMainCheckoutDirty detects uncommitted edits and untracked files before worktree start', async () => {
  const repo = initTempGitRepo({
    'src/app.ts': 'export const VERSION = 1;\n',
  });
  try {
    const clean = inspectMainCheckoutDirty(repo);
    assert.equal(clean.isGitRepo, true);
    assert.equal(clean.dirty, false);
    assert.equal(clean.warningMessage, undefined);

    // Modify tracked file and add an untracked file in main checkout
    fs.writeFileSync(path.join(repo, 'src/app.ts'), 'export const VERSION = 999;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src/uncommitted.ts'), 'export const DRAFT = true;\n', 'utf8');

    const dirty = inspectMainCheckoutDirty(repo);
    assert.equal(dirty.dirty, true);
    assert.ok(dirty.dirtyFiles.includes('src/app.ts'));
    assert.ok(dirty.dirtyFiles.includes('src/uncommitted.ts'));
    assert.match(dirty.warningMessage || '', /незакоммиченные изменения/);

    // Worktree is created from HEAD (VERSION = 1, without uncommitted draft) and carries warning
    const handle = await createIsolatedWorktree({ cwd: repo, name: 'feat-iso' });
    assert.equal(handle.dirtyMainCheckout, true);
    assert.match(handle.warningMessage || '', /HEAD/);
    assert.equal(
      fs.readFileSync(path.join(handle.worktreePath, 'src/app.ts'), 'utf8'),
      'export const VERSION = 1;\n'
    );
    assert.equal(fs.existsSync(path.join(handle.worktreePath, 'src/uncommitted.ts')), false);

    await removeIsolatedWorktree(handle);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('F16: enforceWorktreePathIsolation and enforceWorktreeCommandIsolation block .., symlinks, git -C, --git-dir, and git push', async () => {
  const repo = initTempGitRepo({
    'src/index.ts': 'export const ok = true;\n',
    'secret.txt': 'MAIN_CHECKOUT_ONLY\n',
  });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-37-outside-'));
  const outsideFile = path.join(outsideDir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'OUTSIDE_DATA\n', 'utf8');

  try {
    const handle = await createIsolatedWorktree({ cwd: repo, name: 'confine-test' });
    const wt = handle.worktreePath;

    // Create symlinks inside the worktree pointing outside (file symlink, dir symlink, broken symlink, internal symlink)
    fs.symlinkSync(outsideFile, path.join(wt, 'escape-file-link.txt'));
    fs.symlinkSync(outsideDir, path.join(wt, 'escape-dir-link'));
    fs.symlinkSync(path.join(outsideDir, 'non-existent-target.txt'), path.join(wt, 'broken-escape-link.txt'));
    fs.symlinkSync(path.join(wt, 'src/index.ts'), path.join(wt, 'safe-internal-link.ts'));

    // 1. Safe paths inside worktree pass
    assert.equal(enforceWorktreePathIsolation(wt, 'src/index.ts').ok, true);
    assert.equal(enforceWorktreePathIsolation(wt, 'src/new-dir/new-file.ts').ok, true);
    assert.equal(enforceWorktreePathIsolation(wt, 'safe-internal-link.ts').ok, true);

    // 2. Parent traversal, absolute path to main checkout, and all external symlinks are blocked
    assert.equal(enforceWorktreePathIsolation(wt, '../secret.txt').ok, false);
    assert.equal(enforceWorktreePathIsolation(wt, path.join(repo, 'secret.txt')).ok, false);
    assert.equal(enforceWorktreePathIsolation(wt, 'escape-file-link.txt').ok, false);
    assert.equal(enforceWorktreePathIsolation(wt, 'escape-dir-link/outside.txt').ok, false);
    assert.equal(enforceWorktreePathIsolation(wt, 'escape-dir-link/brand-new.txt').ok, false);
    assert.equal(enforceWorktreePathIsolation(wt, 'broken-escape-link.txt').ok, false);

    // 3. Shell command confinement table
    const allowedCommands = [
      'npm test',
      'git status',
      'git diff HEAD',
      `git -C ${wt} status`,
      'cd src && ls -la',
      'ln -s index.ts src/alias.ts',
    ];
    for (const cmd of allowedCommands) {
      const res = enforceWorktreeCommandIsolation({ command: cmd, worktreeRoot: wt, mainRepoRoot: repo });
      assert.equal(res.ok, true, `Expected safe worktree command to pass: ${cmd} (got: ${res.reason})`);
    }

    const blockedCommands = [
      `git -C ${repo} status`,
      `git -C .. status`,
      `git -C${repo} checkout -- .`,
      `git --git-dir=${path.join(repo, '.git')} status`,
      `git --work-tree=${repo} checkout -- .`,
      `GIT_WORK_TREE=${repo} git status`,
      'git push origin master',
      'git worktree list',
      'cd .. && cat secret.txt',
      `cd ${repo} && rm -rf src`,
      'cd ~ && ls',
      `ln -s ${outsideFile} pwn.txt`,
      'cat ../secret.txt',
      `cat ${path.join(repo, 'secret.txt')}`,
      'cat escape-file-link.txt',
      'eval "git -C /tmp status"',
    ];
    for (const cmd of blockedCommands) {
      const res = enforceWorktreeCommandIsolation({ command: cmd, worktreeRoot: wt, mainRepoRoot: repo });
      assert.equal(res.ok, false, `Expected escaping command to be blocked: ${cmd}`);
    }

    // 4. Tool-level enforcement covers both file tools and execute_command
    assert.equal(
      enforceWorktreeToolCall(
        { name: 'write_to_file', params: { path: 'escape-dir-link/pwn.ts', content: 'x' } },
        { worktreeRoot: wt, mainRepoRoot: repo }
      ).ok,
      false
    );
    assert.equal(
      enforceWorktreeToolCall(
        { name: 'execute_command', params: { command: `git -C ${repo} reset --hard` } },
        { worktreeRoot: wt, mainRepoRoot: repo }
      ).ok,
      false
    );

    await removeIsolatedWorktree(handle);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('F16 & F17: CoreSession with worktree runs isolated from main checkout, warns on dirty tree, and enforces gate confinement', async () => {
  const repo = initTempGitRepo({
    'src/math.ts': 'export function double(n: number): number {\n  return n + n;\n}\n',
  });
  try {
    // Make an uncommitted note in main checkout to verify pre-start dirty warning
    fs.writeFileSync(path.join(repo, 'LOCAL_DRAFT.md'), 'uncommitted main note\n', 'utf8');

    const warnings: string[] = [];
    let turn = 0;
    const toolObservations: string[] = [];
    const provider: CompletionProvider = {
      async complete(req) {
        turn += 1;
        toolObservations.push(req.followUpPrompt || req.fullPrompt || '');
        if (turn === 1) {
          // Try escaping via git -C first — gate must deny it even with bypassPermissions!
          return mockReply(`<execute_command>\n<command>git -C ${repo} status</command>\n</execute_command>`);
        }
        if (turn === 2) {
          // Legitimate edit inside the isolated worktree
          return mockReply(
            `<write_to_file>\n<path>src/math.ts</path>\n<content>export function double(n: number): number {\n  return n * 2;\n}\n</content>\n</write_to_file>`
          );
        }
        if (turn === 3) {
          // Run verification check inside the isolated worktree
          return mockReply(`<execute_command>\n<command>node -e "process.exit(0)"</command>\n</execute_command>`);
        }
        return mockReply(
          '<attempt_completion>\n<result>Refactored double() inside isolated worktree.</result>\n</attempt_completion>'
        );
      },
    };

    const settings = defaultSettings();
    settings.verify.command = 'node -e "process.exit(0)"';

    const session = new CoreSession({
      cwd: repo,
      provider,
      agentSettings: baseAgentSettings({ maxRequests: 8 }),
      selection: { baseModelId: 'sonar', thinking: false },
      permissionMode: 'bypassPermissions',
      settings,
      worktree: 'math-refactor',
      journal: false,
      onWorktreeWarning: (msg) => warnings.push(msg),
      onAsk: async (_task, msg) => (msg.ask?.kind === 'request_limit' ? { response: 'no' } : { response: 'yes' }),
    });

    const result = await session.run('Refactor double(n) to use n * 2');
    assert.equal(result.status, 'completed');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /LOCAL_DRAFT\.md/);

    // Verify turn 1's escaping `git -C <mainRepo>` was rejected by worktree isolation
    assert.match(toolObservations[1] || '', /worktree/i);

    // Main checkout MUST remain untouched before Apply!
    assert.equal(
      fs.readFileSync(path.join(repo, 'src/math.ts'), 'utf8'),
      'export function double(n: number): number {\n  return n + n;\n}\n'
    );

    // F17: WorktreeResultCard has diff, verify=verified, state=pending
    const card = result.worktreeCard;
    assert.ok(card, 'Expected worktreeCard on RunResult');
    assert.equal(card.worktreeName, 'math-refactor');
    assert.equal(card.state, 'pending');
    assert.equal(card.verify.status, 'verified');
    assert.equal(card.changedFiles.length, 1);
    assert.equal(card.changedFiles[0].path, 'src/math.ts');
    assert.match(card.unifiedDiff, /\+  return n \* 2;/);

    // Apply via CoreSession: updates working copy WITHOUT creating a merge commit or pushing
    const headBeforeApply = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const appliedCard = await session.applyWorktree();
    assert.equal(appliedCard.state, 'applied');
    assert.equal(
      fs.readFileSync(path.join(repo, 'src/math.ts'), 'utf8'),
      'export function double(n: number): number {\n  return n * 2;\n}\n'
    );
    const headAfterApply = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    assert.equal(headAfterApply, headBeforeApply, 'Apply must not create automatic git commits/merges');
    assert.equal(fs.existsSync(card.worktreePath), false, 'Worktree cleaned up after Apply');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------------
// F17: Result card Conflict stops cleanly with file list; Discard removes worktree without touching main
// -----------------------------------------------------------------------------------------------

test('F17: applyWorktreeChanges stops on conflict with conflictFiles list without mutating main checkout, and discardWorktreeChanges cleans up', async () => {
  const repo = initTempGitRepo({
    'src/config.ts': 'export const PORT = 3000;\n',
    'src/keep.ts': 'export const KEEP = true;\n',
  });
  try {
    const handle = await createIsolatedWorktree({ cwd: repo, name: 'conflict-demo' });

    // Edit src/config.ts and add src/newFile.ts inside the worktree
    fs.writeFileSync(path.join(handle.worktreePath, 'src/config.ts'), 'export const PORT = 8080;\n', 'utf8');
    fs.writeFileSync(path.join(handle.worktreePath, 'src/newFile.ts'), 'export const FROM_WT = 1;\n', 'utf8');

    const card = buildWorktreeResultCard(handle, {
      status: 'verified',
      detail: 'npm test (exit 0)',
      editedFiles: ['src/config.ts', 'src/newFile.ts'],
      checks: [],
    });
    assert.equal(card.changedFiles.length, 2);
    assert.equal(card.verify.status, 'verified');

    // Introduce conflicting edits in the main checkout after the worktree branched from HEAD
    fs.writeFileSync(path.join(repo, 'src/config.ts'), 'export const PORT = 9090;\n', 'utf8');

    const conflictRes = await applyWorktreeChanges(handle);
    assert.equal(conflictRes.ok, false);
    assert.equal(conflictRes.state, 'conflict');
    assert.ok(conflictRes.conflictFiles.includes('src/config.ts'));

    // Main checkout was NOT partially mutated (newFile.ts was not written, config.ts stays 9090)
    assert.equal(fs.readFileSync(path.join(repo, 'src/config.ts'), 'utf8'), 'export const PORT = 9090;\n');
    assert.equal(fs.existsSync(path.join(repo, 'src/newFile.ts')), false);
    // Worktree is preserved on conflict so user can inspect or discard
    assert.equal(fs.existsSync(handle.worktreePath), true);

    // Discard removes the isolated worktree cleanly
    const discardRes = await discardWorktreeChanges(handle);
    assert.equal(discardRes.ok, true);
    assert.equal(discardRes.state, 'discarded');
    assert.equal(fs.existsSync(handle.worktreePath), false);
    assert.equal(listManagedWorktrees(repo).length, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------------
// F18: Orchestrator parallel subagents (readers in main tree, writers each in own worktree, concurrency cap)
// -----------------------------------------------------------------------------------------------

test('F18: parseAssistantMessage batches consecutive <new_task> calls and isReadOnlySubagentTarget separates readers from writers', () => {
  const multiXml = [
    '<thinking>Run reader and two writers concurrently.</thinking>',
    '<new_task><mode>ask</mode><message>Inspect architecture</message></new_task>',
    '<new_task><mode>code</mode><message>Implement module A</message></new_task>',
    '<new_task><mode>code</mode><message>Implement module B</message></new_task>',
  ].join('\n');

  const parsed = parseAssistantMessage(multiXml);
  assert.ok(parsed.tool);
  assert.ok(parsed.subtaskBatch);
  assert.equal(parsed.subtaskBatch.length, 2);
  assert.deepEqual(
    [parsed.tool, ...parsed.subtaskBatch].map((item) => item.params.mode),
    ['ask', 'code', 'code']
  );

  // Built-in modes: ask is strictly read-only; architect (.md edits), code & debug are write-capable
  assert.equal(isReadOnlySubagentTarget('ask'), true);
  assert.equal(isReadOnlySubagentTarget('architect'), false);
  assert.equal(isReadOnlySubagentTarget('code'), false);
  assert.equal(isReadOnlySubagentTarget('debug'), false);

  // Custom subagents: Read/Grep/git diff only -> read-only; Write/Edit -> writer
  assert.equal(
    isReadOnlySubagentTarget('reviewer', {
      name: 'reviewer',
      description: 'Read-only reviewer',
      prompt: '',
      mode: 'code',
      tools: ['Read', 'Grep', 'Glob', 'Bash(git diff:*)'],
      source: 'test',
      scope: 'project',
    }),
    true
  );
  assert.equal(
    isReadOnlySubagentTarget('implementer', {
      name: 'implementer',
      description: 'Writer agent',
      prompt: '',
      mode: 'code',
      tools: ['Read', 'Edit', 'Write'],
      source: 'test',
      scope: 'project',
    }),
    false
  );
});

test('F18: runWithConcurrencyLimit caps active workers at maxParallel and preserves result ordering', async () => {
  let active = 0;
  let peak = 0;
  const inputs = [10, 20, 30, 40, 50];
  const out = await runWithConcurrencyLimit(inputs, 2, async (val) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 25));
    active -= 1;
    return val * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out, [20, 40, 60, 80, 100]);
});

test('F18: Orchestrator runs reader subagent in main tree and writing subagents in separate isolated worktrees', async () => {
  const repo = initTempGitRepo({
    'README.md': '# Main Tree Readme\n',
    'src/a.ts': 'export const A = 1;\n',
    'src/b.ts': 'export const B = 1;\n',
  });
  try {
    // Put an uncommitted marker ONLY in the main tree so we can prove the reader ran in the main tree
    // while writing subagents branched cleanly from HEAD in separate worktrees!
    fs.writeFileSync(path.join(repo, 'MAIN_TREE_MARKER.txt'), 'VISIBLE_IN_MAIN_TREE_ONLY\n', 'utf8');

    let activeChildren = 0;
    let maxConcurrentChildren = 0;
    const writerCwds = new Set<string>();
    let orchestratorTurn = 0;
    const childTurnBySystem = new Map<string, number>();

    const provider: CompletionProvider = {
      async complete(req) {
        const full = req.fullPrompt || '';
        const promptText = req.followUpPrompt || full;
        const cwdMatch = full.match(/Current Workspace Directory:\s*(.+)/);
        const taskCwd = cwdMatch ? cwdMatch[1].trim() : '';

        // Root orchestrator turns: fullPrompt starts with Orchestrator roleDefinition
        if (full.startsWith('You are PerplexiCode, a strategic workflow orchestrator')) {
          orchestratorTurn += 1;
          if (orchestratorTurn === 1) {
            return mockReply(
              [
                '<new_task><mode>ask</mode><message>[SubtaskAsk] Read MAIN_TREE_MARKER.txt</message></new_task>',
                '<new_task><mode>code</mode><message>[SubtaskWriterA] Update src/a.ts</message></new_task>',
                '<new_task><mode>code</mode><message>[SubtaskWriterB] Update src/b.ts</message></new_task>',
              ].join('\n')
            );
          }
          return mockReply('<attempt_completion><result>All parallel subtasks finished.</result></attempt_completion>');
        }

        // Subagent turns: track concurrency across parallel children
        activeChildren += 1;
        maxConcurrentChildren = Math.max(maxConcurrentChildren, activeChildren);
        await new Promise((r) => setTimeout(r, 30));
        activeChildren -= 1;

        // Distinguish reader (runs in main repo in Ask mode) vs isolated writers (sub-2-code, sub-3-code)
        const key = taskCwd.includes('sub-2-code')
          ? 'writerA'
          : taskCwd.includes('sub-3-code')
            ? 'writerB'
            : 'ask';
        const subTurn = (childTurnBySystem.get(key) || 0) + 1;
        childTurnBySystem.set(key, subTurn);

        if (key === 'ask') {
          if (subTurn === 1) {
            return mockReply('<read_file><path>MAIN_TREE_MARKER.txt</path></read_file>');
          }
          const sawMainMarker = promptText.includes('VISIBLE_IN_MAIN_TREE_ONLY');
          return mockReply(
            `<attempt_completion><result>Reader saw main marker: ${sawMainMarker}</result></attempt_completion>`
          );
        }

        if (taskCwd) writerCwds.add(taskCwd);
        if (key === 'writerA') {
          if (subTurn === 1) {
            return mockReply(
              '<write_to_file><path>src/a.ts</path><content>export const A = 200;\n</content></write_to_file>'
            );
          }
          return mockReply('<attempt_completion><result>Updated A in isolated worktree</result></attempt_completion>');
        }

        if (subTurn === 1) {
          return mockReply(
            '<write_to_file><path>src/b.ts</path><content>export const B = 300;\n</content></write_to_file>'
          );
        }
        return mockReply('<attempt_completion><result>Updated B in isolated worktree</result></attempt_completion>');
      },
    };

    const settings = defaultSettings();
    settings.maxParallelSubtasks = 2; // Cap concurrency at 2 even though 3 subtasks were dispatched

    const session = new CoreSession({
      cwd: repo,
      provider,
      agentSettings: baseAgentSettings({ maxParallelSubtasks: 2 }),
      selection: { baseModelId: 'sonar', thinking: false },
      mode: 'orchestrator',
      permissionMode: 'bypassPermissions',
      settings,
      journal: false,
      onAsk: async () => ({ response: 'yes' }),
    });

    const result = await session.run('Coordinate reader + two writers');
    assert.equal(result.status, 'completed');
    assert.ok(maxConcurrentChildren <= 2, `Expected concurrency <= 2, got ${maxConcurrentChildren}`);

    // Each writer ran in its own distinct isolated worktree, neither equal to main repo!
    assert.equal(writerCwds.size, 2);
    for (const wtCwd of writerCwds) {
      assert.notEqual(fs.realpathSync(wtCwd), repo);
    }

    // Main tree src/a.ts and src/b.ts were NOT overwritten by parallel writers
    assert.equal(fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8'), 'export const A = 1;\n');
    assert.equal(fs.readFileSync(path.join(repo, 'src/b.ts'), 'utf8'), 'export const B = 1;\n');

    // Subtask worktree cards were recorded on RunResult
    assert.equal(result.subtaskWorktreeCards?.length, 2);

    // Clean up subtask worktrees
    for (const wt of listManagedWorktrees(repo)) {
      await removeIsolatedWorktree(wt);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------------
// F19: WorktreeCreate and WorktreeRemove hooks
// -----------------------------------------------------------------------------------------------

test('F19: WorktreeCreate and WorktreeRemove hooks receive JSON payload, can block with exit 2, or supply a custom worktreePath', async () => {
  const repo = initTempGitRepo({
    'index.ts': 'export const hello = "world";\n',
  });
  const customHookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-37-custom-wt-'));
  fs.writeFileSync(path.join(customHookDir, 'index.ts'), 'export const hello = "from-custom-hook";\n', 'utf8');

  try {
    // 1. Blocking WorktreeCreate hook (exit 2) aborts worktree creation and cleans up
    const blockingHooks = new HookEngine(
      {
        WorktreeCreate: [{ hooks: [{ type: 'command', command: 'echo "Policy: worktrees disabled" >&2; exit 2' }] }],
      },
      repo
    );
    await assert.rejects(
      () => createIsolatedWorktree({ cwd: repo, name: 'blocked-wt', hooks: blockingHooks }),
      (err: unknown) => err instanceof WorktreeHookBlockedError && /Policy: worktrees disabled/.test(err.message)
    );
    assert.equal(listManagedWorktrees(repo).length, 0);

    // 2. Custom path WorktreeCreate + WorktreeRemove lifecycle tracking
    const hookLogFile = path.join(os.tmpdir(), `pcode-37-hooklog-${Date.now()}.jsonl`);
    const lifecycleHooks = new HookEngine(
      {
        WorktreeCreate: [
          {
            hooks: [
              {
                type: 'command',
                command: `cat >> "${hookLogFile}"; echo "" >> "${hookLogFile}"; printf '%s\\n' '{"worktreePath": ${JSON.stringify(customHookDir)}}'`,
              },
            ],
          },
        ],
        WorktreeRemove: [
          {
            hooks: [
              {
                type: 'command',
                command: `cat >> "${hookLogFile}"; echo "" >> "${hookLogFile}"`,
              },
            ],
          },
        ],
      },
      repo
    );

    const handle = await createIsolatedWorktree({
      cwd: repo,
      name: 'hook-managed',
      hooks: lifecycleHooks,
    });
    assert.equal(handle.createdByHook, true);
    assert.equal(handle.worktreePath, fs.realpathSync(customHookDir));

    await removeIsolatedWorktree(handle, { hooks: lifecycleHooks, reason: 'discarded' });

    const lines = fs
      .readFileSync(hookLogFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].hook_event_name, 'WorktreeCreate');
    assert.equal(lines[0].worktree_name, 'hook-managed');
    assert.equal(lines[1].hook_event_name, 'WorktreeRemove');
    assert.equal(lines[1].reason, 'discarded');

    fs.unlinkSync(hookLogFile);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    if (fs.existsSync(customHookDir)) {
      fs.rmSync(customHookDir, { recursive: true, force: true });
    }
  }
});

// -----------------------------------------------------------------------------------------------
// F20: Documented pcode -p exit codes for CI (0, 1, 2, 3, 4, 5, 6, 64, 130)
// -----------------------------------------------------------------------------------------------

test('F20: parseArgs parses --worktree [name] and --max-parallel-subtasks cleanly without swallowing positional prompt', () => {
  const autoNamed = parseArgs(['-p', '--worktree', 'Fix the bug']);
  assert.equal(autoNamed.worktree, true);
  assert.equal(autoNamed.prompt, 'Fix the bug');

  const explicitEq = parseArgs(['-p', '--worktree=feat-auth', 'Fix auth']);
  assert.equal(explicitEq.worktree, 'feat-auth');
  assert.equal(explicitEq.prompt, 'Fix auth');

  const explicitPositional = parseArgs(['-p', '-w', 'feat-login', '--max-parallel-subtasks', '4', 'Build login']);
  assert.equal(explicitPositional.worktree, 'feat-login');
  assert.equal(explicitPositional.maxParallelSubtasks, 4);
  assert.equal(explicitPositional.prompt, 'Build login');
});

test('F20: classifyPrintExitCode, classifyCliErrorExitCode, and cliMain cover all documented CI exit codes (0, 1, 2, 3, 4, 5, 6, 64, 130)', async () => {
  const baseRun = (overrides: Partial<RunResult> = {}): RunResult => ({
    taskId: 't-1',
    status: 'idle',
    result: 'Done',
    lastText: 'Done',
    requests: 1,
    verification: { status: 'verified', detail: 'ok', editedFiles: ['a.ts'], checks: [] },
    ...overrides,
  });

  // 0: OK
  assert.equal(classifyPrintExitCode(baseRun()), PCODE_EXIT_CODES.OK);
  assert.equal(await cliMain(['--version']), PCODE_EXIT_CODES.OK);

  // 1: RUNTIME_ERROR
  assert.equal(
    classifyPrintExitCode(baseRun({ status: 'error', result: undefined, lastText: 'Unexpected socket reset' })),
    PCODE_EXIT_CODES.RUNTIME_ERROR
  );

  // 2: VERIFY_FAILED
  assert.equal(
    classifyPrintExitCode(
      baseRun({
        verification: { status: 'failed', detail: 'npm test exited with 1', editedFiles: ['a.ts'], checks: [] },
      })
    ),
    PCODE_EXIT_CODES.VERIFY_FAILED
  );

  // 3: POLICY_BLOCKED (verification blocked, stopOnFallback, permission/hook/worktree block)
  assert.equal(
    classifyPrintExitCode(
      baseRun({
        result: undefined,
        stopRule: 'stopOnFallback',
        stopReason: 'Fallback disallowed',
      })
    ),
    PCODE_EXIT_CODES.POLICY_BLOCKED
  );
  assert.equal(
    classifyCliErrorExitCode(new WorktreeHookBlockedError('Blocked by WorktreeCreate')),
    PCODE_EXIT_CODES.POLICY_BLOCKED
  );

  // 4: MAX_TURNS_EXCEEDED
  assert.equal(
    classifyPrintExitCode(
      baseRun({
        result: undefined,
        stopRule: 'maxRequests=5',
        stopReason: 'Turn limit reached',
      })
    ),
    PCODE_EXIT_CODES.MAX_TURNS_EXCEEDED
  );

  // 5: AUTH_REQUIRED
  assert.equal(
    classifyPrintExitCode(
      baseRun({
        status: 'error',
        result: undefined,
        stopRule: 'accounts.none',
        lastText: 'No Perplexity account configured',
      })
    ),
    PCODE_EXIT_CODES.AUTH_REQUIRED
  );
  assert.equal(
    classifyCliErrorExitCode(new Error('No Perplexity account configured. Run pcode login.')),
    PCODE_EXIT_CODES.AUTH_REQUIRED
  );

  // 6: WORKTREE_CONFLICT (both classifier and real `pcode worktree apply <name>` CLI invocation)
  assert.equal(
    classifyPrintExitCode(
      baseRun({
        worktreeCard: {
          worktreeName: 'wt-1',
          worktreePath: '/tmp/wt-1',
          mainRepoRoot: '/tmp/repo',
          baseCommit: 'abc1234',
          changedFiles: [],
          totalAdditions: 1,
          totalDeletions: 1,
          unifiedDiff: '',
          verify: { status: 'verified', detail: '', editedFiles: [] },
          state: 'conflict',
          conflictFiles: ['src/app.ts'],
        },
      })
    ),
    PCODE_EXIT_CODES.WORKTREE_CONFLICT
  );

  const repo = initTempGitRepo({ 'conflict.txt': 'line 1\n' });
  try {
    const wt = await createIsolatedWorktree({ cwd: repo, name: 'cli-conflict' });
    fs.writeFileSync(path.join(wt.worktreePath, 'conflict.txt'), 'from worktree\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'from main\n', 'utf8');

    const conflictExit = await cliMain(['worktree', 'apply', 'cli-conflict', '--cwd', repo]);
    assert.equal(conflictExit, PCODE_EXIT_CODES.WORKTREE_CONFLICT);

    const discardExit = await cliMain(['worktree', 'discard', 'cli-conflict', '--cwd', repo]);
    assert.equal(discardExit, PCODE_EXIT_CODES.OK);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // 64: USAGE_ERROR (invalid flag or missing cwd)
  assert.equal(await cliMain(['--definitely-unknown-flag']), PCODE_EXIT_CODES.USAGE_ERROR);
  assert.equal(await cliMain(['--cwd', '/nonexistent/pcode/path/37']), PCODE_EXIT_CODES.USAGE_ERROR);

  // 130: INTERRUPTED (SIGINT / aborted)
  assert.equal(
    classifyPrintExitCode(baseRun({ status: 'aborted', result: undefined }), { aborted: true }),
    PCODE_EXIT_CODES.INTERRUPTED
  );
});
