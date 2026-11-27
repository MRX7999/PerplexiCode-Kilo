import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { buildRepoMap, extractSymbolsAndImports } from '../src/agent/repoMap';
import type { CompletionProvider } from '../src/agent/task';
import { diffPostEditDiagnostics, IdeDiagnosticEntry } from '../src/agent/tools';
import type { AgentSettings } from '../src/agent/types';
import {
  computeBackoffWithJitterMs,
  DEFAULT_MAX_REQUESTS_PER_MINUTE_PER_ACCOUNT,
  RotationEngine,
} from '../src/api/rotationEngine';
import type { Account } from '../src/api/types';
import { checkAutoCompactThreshold, structuredAutoCompact } from '../src/core/compaction';
import { assembleAndInspectPrompt, formatContextReportForCli } from '../src/core/contextInspector';
import { NodeAgentHost } from '../src/core/nodeHost';
import { buildRepoMapBenchmarkSuite, runRepoMapBenchmark } from '../src/core/repoMapBench';
import { CoreSession } from '../src/core/runner';
import { defaultSettings } from '../src/core/settings';

function makeTempWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-36-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
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

function makeAccount(id: string, alias = id): Account {
  return {
    id,
    alias,
    cookie: `fake-session-${id}`,
    status: 'active',
    queriestoday: 0,
    queriesTotalLifetime: 0,
    createdAt: new Date(0).toISOString(),
  };
}

// -----------------------------------------------------------------------------------------------
// F10: Post-edit IDE diagnostics (Errors + Warnings, multiset diff)
// -----------------------------------------------------------------------------------------------

test('F10: diffPostEditDiagnostics keeps only newly introduced Error and Warning entries', () => {
  const before: IdeDiagnosticEntry[] = [
    { severity: 'warning', line: 3, column: 5, message: 'Unused import foo', source: 'ts' },
    { severity: 'error', line: 10, column: 1, message: 'Cannot find name x', source: 'ts' },
  ];
  const after: IdeDiagnosticEntry[] = [
    // Pre-existing entries remain:
    { severity: 'warning', line: 3, column: 5, message: 'Unused import foo', source: 'ts' },
    { severity: 'error', line: 10, column: 1, message: 'Cannot find name x', source: 'ts' },
    // Newly introduced Error and Warning:
    { severity: 'error', line: 14, column: 9, message: "Type 'string' is not assignable to type 'number'", source: 'ts' },
    { severity: 'warning', line: 18, column: 3, message: 'Variable shadow detected', source: 'eslint' },
  ];

  const formatted = diffPostEditDiagnostics('src/calc.ts', before, after);
  assert.match(formatted, /src\/calc\.ts/);
  assert.match(formatted, /\[Error\/ts\] Line 14: Type 'string' is not assignable to type 'number'/);
  assert.match(formatted, /\[Warning\/eslint\] Line 18: Variable shadow detected/);
  assert.doesNotMatch(formatted, /Unused import foo/);
  assert.doesNotMatch(formatted, /Cannot find name x/);
});

test('F10: write_to_file, apply_diff, and search_and_replace append new IDE errors and warnings to tool results', async () => {
  const ws = makeTempWorkspace({
    'src/calc.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  });
  try {
    const promptsSeen: string[] = [];
    let turn = 0;
    const provider: CompletionProvider = {
      async complete(req) {
        promptsSeen.push(req.fullPrompt || req.followUpPrompt || '');
        turn += 1;
        let text = '';
        if (turn === 1) {
          text = `<apply_diff>\n<path>src/calc.ts</path>\n<diff>\n<<<<<<< SEARCH\n  return a + b;\n=======\n  const unused = 1;\n  return a + b;\n>>>>>>> REPLACE\n</diff>\n</apply_diff>`;
        } else if (turn === 2) {
          text = `<search_and_replace>\n<path>src/calc.ts</path>\n<search>const unused = 1;</search>\n<replace>const broken: number = "bad" as any;</replace>\n</search_and_replace>`;
        } else if (turn === 3) {
          text = `<write_to_file>\n<path>src/extra.ts</path>\n<content>export const v: number = 42;\n</content>\n</write_to_file>`;
        } else {
          text = `<attempt_completion>\n<result>Checked post-edit diagnostics across all edit tools.</result>\n</attempt_completion>`;
        }
        req.onProgress?.(text);
        return {
          text,
          citations: [],
          modelUsed: 'mock',
          accountAlias: 'mock',
          routeSummary: { requestedMode: 'search', requestedModel: 'turbo', actualMode: 'search', actualModel: 'turbo' },
        };
      },
    };

    class MockIdeHost extends NodeAgentHost {
      override async getDiagnostics(absPath: string): Promise<string> {
        const rel = path.relative(ws, absPath).replace(/\\/g, '/');
        if (rel === 'src/calc.ts') {
          return diffPostEditDiagnostics(rel, [], [
            { severity: 'warning', line: 2, column: 9, message: "'unused' is declared but never read.", source: 'ts' },
            { severity: 'error', line: 3, column: 3, message: 'Type mismatch in calc.ts', source: 'ts' },
          ]);
        }
        return diffPostEditDiagnostics(rel, [], [
          { severity: 'warning', line: 1, column: 14, message: 'Missing explicit JSDoc', source: 'eslint' },
        ]);
      }
    }

    const session = new CoreSession({
      cwd: ws,
      host: new MockIdeHost(ws),
      provider,
      agentSettings: baseAgentSettings({ repoMapEnabled: false }),
      selection: { baseModelId: 'turbo', thinking: false },
      mode: 'code',
      settings: defaultSettings(),
      permissionMode: 'bypassPermissions',
      journal: false,
      onAsk: async () => ({ response: 'yes' }),
    });

    const res = await session.run('Edit files and observe diagnostics');
    assert.equal(res.status, 'completed');
    assert.match(promptsSeen[1], /New problems detected after saving the file:/);
    assert.match(promptsSeen[1], /\[Warning\/ts\] Line 2: 'unused' is declared but never read\./);
    assert.match(promptsSeen[1], /\[Error\/ts\] Line 3: Type mismatch in calc\.ts/);
    assert.match(promptsSeen[2], /\[search_and_replace for 'src\/calc\.ts'\] Result:[\s\S]*New problems detected after saving the file:/);
    assert.match(promptsSeen[3], /\[write_to_file for 'src\/extra\.ts'\] Result:[\s\S]*\[Warning\/eslint\] Line 1: Missing explicit JSDoc/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------------
// F11: Structural Repository Map (@repo) without vector DB
// -----------------------------------------------------------------------------------------------

test('F11: buildRepoMap extracts symbols, signatures, imports, related tests, prioritizes active/diff files, and enforces char budget', async () => {
  const ws = makeTempWorkspace({
    'src/billing.ts': [
      "import { formatMoney } from './currency';",
      'export interface InvoiceInput { cents: number; taxBps: number }',
      'export function computeInvoiceTotal(input: InvoiceInput): string {',
      '  return formatMoney(input.cents);',
      '}',
    ].join('\n'),
    'src/currency.ts': [
      'export function formatMoney(cents: number): string {',
      '  return `$${(cents / 100).toFixed(2)}`;',
      '}',
    ].join('\n'),
    'src/unrelatedAlpha.ts': 'export function alphaNoise(): number { return 1; }\n'.repeat(20),
    'src/unrelatedBeta.ts': 'export function betaNoise(): number { return 2; }\n'.repeat(20),
    'test/billing.test.ts': [
      "import { computeInvoiceTotal } from '../src/billing';",
      'export function testBilling() { return computeInvoiceTotal({ cents: 100, taxBps: 500 }); }',
    ].join('\n'),
  });

  try {
    const parsed = extractSymbolsAndImports(
      'src/billing.ts',
      fs.readFileSync(path.join(ws, 'src/billing.ts'), 'utf8')
    );
    assert.ok(parsed.symbols.some((s) => s.name === 'InvoiceInput' && s.kind === 'interface'));
    assert.ok(parsed.symbols.some((s) => s.name === 'computeInvoiceTotal' && s.exported));
    assert.deepEqual(parsed.rawImports, ['./currency']);

    const fullMap = await buildRepoMap({
      cwd: ws,
      activeFile: 'src/billing.ts',
      changedFiles: ['src/currency.ts'],
      maxChars: 4000,
    });
    assert.ok(fullMap.usedChars <= 4000 && fullMap.text.length <= 4000);
    assert.equal(fullMap.files[0].relPath, 'src/billing.ts');
    assert.ok(fullMap.files.slice(0, 3).some((f) => f.relPath === 'src/currency.ts'));
    assert.match(fullMap.text, /src\/billing\.ts \[active file\]/);
    assert.match(fullMap.text, /imports: src\/currency\.ts/);
    assert.match(fullMap.text, /tests: test\/billing\.test\.ts/);
    assert.match(fullMap.text, /computeInvoiceTotal\(input: InvoiceInput\): string/);

    // Hard budget enforcement on tight limit:
    const tightMap = await buildRepoMap({
      cwd: ws,
      activeFile: 'src/billing.ts',
      changedFiles: ['src/currency.ts'],
      maxChars: 520,
    });
    assert.ok(tightMap.usedChars <= 520 && tightMap.text.length <= 520, `Expected <= 520 chars, got ${tightMap.usedChars}`);
    assert.match(tightMap.text, /src\/billing\.ts/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('F11: @repo mention injects <repo_map> on demand even when repoMapEnabled is false', async () => {
  const ws = makeTempWorkspace({
    'src/router.ts': 'export function dispatchRoute(pathname: string): boolean { return pathname.startsWith("/"); }\n',
  });
  try {
    let capturedPrompt = '';
    const provider: CompletionProvider = {
      async complete(req) {
        capturedPrompt = req.fullPrompt || '';
        const text = '<attempt_completion>\n<result>Explained router via @repo.</result>\n</attempt_completion>';
        req.onProgress?.(text);
        return { text, citations: [], modelUsed: 'mock', accountAlias: 'mock' };
      },
    };
    const session = new CoreSession({
      cwd: ws,
      provider,
      agentSettings: baseAgentSettings({ repoMapEnabled: false, repoMapMaxChars: 2000 }),
      selection: { baseModelId: 'turbo', thinking: false },
      mode: 'ask',
      settings: defaultSettings(),
      permissionMode: 'bypassPermissions',
      journal: false,
      onAsk: async () => ({ response: 'yes' }),
    });
    await session.run('Объясни маршрутизацию через @repo');
    assert.match(capturedPrompt, /<repo_map>/);
    assert.match(capturedPrompt, /dispatchRoute\(pathname: string\): boolean/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------------
// F12: Context Inspector (what goes into next request, why, compacted status, exclusions)
// -----------------------------------------------------------------------------------------------

test('F12: assembleAndInspectPrompt reports reasons, compacted state, and applies item exclusions', () => {
  const excluded = new Set<string>();
  const messages = [
    { role: 'user' as const, content: 'Fix auth token refresh in src/auth.ts' },
    {
      role: 'user' as const,
      content: '<compacted_context mode="auto" compacted_messages="4" kept_steps="2">\n## Изменённые файлы\n- src/auth.ts\n</compacted_context>',
    },
    { role: 'assistant' as const, content: 'Checking src/auth.ts' },
    { role: 'user' as const, content: "[read_file for 'src/auth.ts'] Result:\nexport function refresh() {}" },
    { role: 'assistant' as const, content: 'Preparing edit to src/auth.ts' },
    { role: 'user' as const, content: 'Apply the fix cleanly.' },
  ];

  const initial = assembleAndInspectPrompt({
    baseSystemPrompt: 'SYSTEM INSTRUCTIONS',
    repoMapBlock: '<repo_map>\n# Repository map\n- src/auth.ts\n</repo_map>',
    repoMapReason: 'Включено по упоминанию @repo в запросе пользователя',
    messages,
    maxPromptChars: 30_000,
    autoCompactThresholdRatio: 0.8,
    excludedIds: excluded,
  });

  assert.match(initial.fullPrompt, /<repo_map>/);
  const repoItem = initial.report.items.find((i) => i.id === 'repo_map');
  assert.ok(repoItem && repoItem.status === 'included' && repoItem.canExclude);
  assert.match(repoItem.reason, /@repo/);

  const compactedItem = initial.report.items.find((i) => i.status === 'compacted');
  assert.ok(compactedItem && compactedItem.canExclude);

  const sysItem = initial.report.items.find((i) => i.id === 'system_base');
  assert.ok(sysItem && !sysItem.canExclude);

  // Exclude repo_map and the read_file tool result, then verify prompt shrinks and omits them:
  const readMsgItem = initial.report.items.find((i) => i.label.includes('read_file'));
  assert.ok(readMsgItem && readMsgItem.canExclude);
  excluded.add('repo_map');
  excluded.add(readMsgItem.id);

  const afterExclude = assembleAndInspectPrompt({
    baseSystemPrompt: 'SYSTEM INSTRUCTIONS',
    repoMapBlock: '<repo_map>\n# Repository map\n- src/auth.ts\n</repo_map>',
    repoMapReason: 'Включено по упоминанию @repo в запросе пользователя',
    messages,
    maxPromptChars: 30_000,
    autoCompactThresholdRatio: 0.8,
    excludedIds: excluded,
  });

  assert.doesNotMatch(afterExclude.fullPrompt, /<repo_map>/);
  assert.doesNotMatch(afterExclude.fullPrompt, /export function refresh/);
  assert.ok(afterExclude.report.totalChars < initial.report.totalChars);
  assert.equal(afterExclude.report.excludedCount, 2);

  const cliText = formatContextReportForCli(afterExclude.report);
  assert.match(cliText, /Инспектор контекста:/);
  assert.match(cliText, /исключено/i);
});

// -----------------------------------------------------------------------------------------------
// F13: Threshold-based Structured Auto-Compaction
// -----------------------------------------------------------------------------------------------

test('F13: structuredAutoCompact triggers at threshold of maxPromptChars, emits all 4 sections, and keeps system prompt + last N steps untouched', () => {
  const originalSystemPrompt = 'IMMUTABLE SYSTEM PROMPT — DO NOT ALTER';
  const messages = [
    { role: 'user' as const, content: 'Task: fix rate calculation in src/pricing.ts. Не ломать публичный API и без новых зависимостей.' },
    { role: 'assistant' as const, content: '<read_file><path>src/pricing.ts</path></read_file>' },
    { role: 'user' as const, content: "[read_file for 'src/pricing.ts'] Result:\n" + '// padding\n'.repeat(220) },
    { role: 'assistant' as const, content: '<apply_diff><path>src/pricing.ts</path><diff>...</diff></apply_diff>' },
    { role: 'user' as const, content: "[apply_diff for 'src/pricing.ts'] Result:\nThe changes were applied to src/pricing.ts." },
    { role: 'assistant' as const, content: '<execute_command><command>npm test</command></execute_command>' },
    { role: 'user' as const, content: "[execute_command for 'npm test'] Result:\nCommand exited with code 0.\n" + 'ok line\n'.repeat(220) },
    // Last 2 steps (4 messages) that MUST remain untouched:
    { role: 'assistant' as const, content: 'KEEP_STEP_A_ASSISTANT' },
    { role: 'user' as const, content: 'KEEP_STEP_A_USER_RESULT' },
    { role: 'assistant' as const, content: 'KEEP_STEP_B_ASSISTANT' },
    { role: 'user' as const, content: 'KEEP_STEP_B_USER_RESULT' },
  ];

  const preAssemble = assembleAndInspectPrompt({
    baseSystemPrompt: originalSystemPrompt,
    messages,
    maxPromptChars: 4000,
    autoCompactThresholdRatio: 0.75,
  });
  const check = checkAutoCompactThreshold({
    systemChars: originalSystemPrompt.length,
    messages,
    maxPromptChars: 4000,
    thresholdRatio: 0.75,
  });
  assert.equal(check.shouldCompact, true);

  const compacted = structuredAutoCompact({
    messages,
    keepSteps: 2,
    todos: [
      { text: 'Fix src/pricing.ts', status: 'completed' },
      { text: 'Verify edge cases', status: 'in_progress' },
    ],
    maxSummaryChars: 2000,
  });

  assert.ok(compacted.compactedMessages > 0);
  // Required 4 sections in Russian:
  assert.match(compacted.summary, /## Изменённые файлы/);
  assert.match(compacted.summary, /src\/pricing\.ts/);
  assert.match(compacted.summary, /## Проверенные гипотезы/);
  assert.match(compacted.summary, /npm test/);
  assert.match(compacted.summary, /## Ограничения/);
  assert.match(compacted.summary, /## Статус todo/);
  assert.match(compacted.summary, /Fix src\/pricing\.ts/);
  assert.match(compacted.summary, /Verify edge cases/);

  // Last 2 steps (4 messages) are preserved verbatim at the tail:
  const tail = compacted.messages.slice(-4);
  assert.deepEqual(
    tail.map((m) => m.content),
    ['KEEP_STEP_A_ASSISTANT', 'KEEP_STEP_A_USER_RESULT', 'KEEP_STEP_B_ASSISTANT', 'KEEP_STEP_B_USER_RESULT']
  );

  // System prompt remains completely untouched after assembling compacted history:
  const postAssemble = assembleAndInspectPrompt({
    baseSystemPrompt: originalSystemPrompt,
    messages: compacted.messages,
    maxPromptChars: 10_000,
    autoCompactThresholdRatio: 0.75,
  });
  assert.ok(postAssemble.fullPrompt.startsWith(originalSystemPrompt));
});

// -----------------------------------------------------------------------------------------------
// F14: 24-task Reproducible Benchmark (3.4 baseline vs 3.6 @repo map)
// -----------------------------------------------------------------------------------------------

test('F14: 24-task reproducible benchmark compares read_file count, prompt chars, and verify.command pass rate vs 3.4', async () => {
  const suite = buildRepoMapBenchmarkSuite();
  assert.equal(suite.length, 24);

  const summary = await runRepoMapBenchmark({ tasks: suite });
  assert.equal(summary.tasksCount, 24);
  assert.equal(summary.baseline34.verifyPassRate, 1);
  assert.equal(summary.repoMap36.verifyPassRate, 1);
  assert.ok(
    summary.repoMap36.avgReadsBeforeFirstEdit < summary.baseline34.avgReadsBeforeFirstEdit,
    `Expected fewer reads with @repo (${summary.repoMap36.avgReadsBeforeFirstEdit} vs ${summary.baseline34.avgReadsBeforeFirstEdit})`
  );
  assert.ok(
    summary.repoMap36.avgPromptCharsSent < summary.baseline34.avgPromptCharsSent,
    `Expected fewer total prompt chars with @repo (${summary.repoMap36.avgPromptCharsSent} vs ${summary.baseline34.avgPromptCharsSent})`
  );
  assert.equal(summary.repoMapRecommendedDefault, true);

  // Verify package.json default matches the benchmark's empirical recommendation:
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(
    pkg.contributes.configuration.properties['perplexicodeKilo.agent.repoMapEnabled'].default,
    summary.repoMapRecommendedDefault
  );
});

// -----------------------------------------------------------------------------------------------
// F15: Exponential Backoff with Jitter & Per-Account RPM Rate Limiting
// -----------------------------------------------------------------------------------------------

test('F15: computeBackoffWithJitterMs applies bounded exponential backoff with equal jitter', () => {
  assert.equal(computeBackoffWithJitterMs(0, { baseMs: 1500, maxMs: 30_000, rng: () => 0 }), 750);
  assert.equal(computeBackoffWithJitterMs(0, { baseMs: 1500, maxMs: 30_000, rng: () => 1 }), 1500);
  assert.equal(computeBackoffWithJitterMs(2, { baseMs: 1500, maxMs: 30_000, rng: () => 1 }), 6000);
  assert.equal(computeBackoffWithJitterMs(10, { baseMs: 1500, maxMs: 30_000, rng: () => 1 }), 30_000);
  assert.equal(computeBackoffWithJitterMs(10, { baseMs: 1500, maxMs: 30_000, rng: () => 0 }), 15_000);
});

test('F15: RotationEngine enforces conservative per-account RPM window, rotates accounts, and applies jittered rate-limit cooldown', () => {
  assert.equal(DEFAULT_MAX_REQUESTS_PER_MINUTE_PER_ACCOUNT, 12);

  let nowMs = 1_000_000;
  const engine = new RotationEngine({
    strategy: 'failover-only',
    maxRequestsPerMinute: 3,
    now: () => nowMs,
    rng: () => 0.5,
  });

  const accA = makeAccount('a', 'Account A');
  const accB = makeAccount('b', 'Account B');
  const pool = [accA, accB];

  // Send 3 requests on Account A within the same minute:
  for (let i = 0; i < 3; i += 1) {
    const picked = engine.selectAccount(pool);
    assert.equal(picked?.id, 'a');
    engine.recordRequest('a');
    nowMs += 1_000;
  }

  // 4th request within 60s: Account A is at 3/3 RPM -> failover selects Account B!
  assert.equal(engine.canSendRequest('a'), false);
  assert.ok(engine.getMsUntilAccountSlot('a') > 50_000);
  assert.equal(engine.selectAccount(pool)?.id, 'b');

  // Exhaust Account B's 3 RPM slots as well:
  for (let i = 0; i < 3; i += 1) {
    engine.recordRequest('b');
    nowMs += 500;
  }
  assert.equal(engine.selectAccount(pool), null);
  const waitMs = engine.getMsUntilPoolSlot(pool);
  assert.ok(waitMs > 0 && waitMs <= 60_000);

  // Advance clock past the 60s sliding window -> Account A becomes eligible again:
  nowMs += 60_000;
  assert.equal(engine.canSendRequest('a'), true);
  assert.equal(engine.selectAccount(pool)?.id, 'a');

  // Rate-limit failure sets jittered cooldown on Account A:
  engine.markFailed(accA, true);
  assert.equal(accA.status, 'rate_limited');
  assert.ok(accA.cooldownUntil && new Date(accA.cooldownUntil).getTime() > nowMs);
});

test('CLI 3.6: --version matches package.json and --help documents @repo and --max-rpm flags', () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version as string;
  const cliPath = path.join(process.cwd(), 'out', 'cli.js');
  const ver = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), pkgVersion);

  const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--repo-map \/ --no-repo-map/);
  assert.match(help.stdout, /--max-rpm/);
});
