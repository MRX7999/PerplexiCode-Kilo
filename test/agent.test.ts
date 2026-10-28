/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyDiff, detectCodeOmission, diffStats, lineDiff } from '../src/agent/diffEngine';
import { getModeBySlug, isToolAllowedForMode, MODES } from '../src/agent/modes';
import { buildFullPrompt, buildSystemPrompt } from '../src/agent/prompts';
import { AgentTask, CompletionProvider } from '../src/agent/task';
import { parseAssistantMessage, parseFollowUpSuggestions, parseTodos, stripWrappingFence } from '../src/agent/toolParser';
import {
  AgentHost,
  insertContent,
  isCommandAutoApproved,
  listFilesTool,
  readFileTool,
  searchFilesTool,
  splitCommandChain,
  truncateOutput,
} from '../src/agent/tools';
import { PerplexityTransport, type CompletionRequest, type CompletionResult, type StreamingClient } from '../src/agent/transport';
import { CapabilityFetcher } from '../src/api/capabilityFetcher';
import { RotationEngine } from '../src/api/rotationEngine';
import { AgentSettings, UiMessage } from '../src/agent/types';
import { getFallbackModelCatalog, getModelLabel, getResolvedModelId, setRuntimeModelCatalog } from '../src/api/modelCatalog';
import { ModelFetcher } from '../src/api/modelFetcher';
import { AccountSession } from '../src/api/types';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// -------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------

class NodeHost implements AgentHost {
  readonly writes: string[] = [];
  constructor(readonly cwd: string) {}
  async readFile(absPath: string): Promise<string> {
    return fs.promises.readFile(absPath, 'utf8');
  }
  async writeFile(absPath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, content, 'utf8');
    this.writes.push(absPath);
  }
  async deleteFile(absPath: string): Promise<void> {
    await fs.promises.rm(absPath, { force: true });
  }
  async runCommand(command: string, cwd: string, options: { signal: AbortSignal; timeoutMs: number; onOutput?: (chunk: string) => void }) {
    return new Promise<{ output: string; exitCode: number | null; timedOut?: boolean }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { cwd });
      let output = '';
      const onData = (data: Buffer) => {
        output += data.toString();
        options.onOutput?.(data.toString());
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', (code) => resolve({ output, exitCode: code }));
    });
  }
}

function settings(overrides: Partial<AgentSettings['autoApprove']> = {}): AgentSettings {
  return {
    autoApprove: { enabled: true, read: true, readOutsideWorkspace: false, write: false, execute: false, modeSwitch: true, subtasks: true, todo: true, retry: true, ...overrides },
    allowedCommands: ['echo', 'ls'],
    deniedCommands: ['rm -rf'],
    maxRequests: 20,
    maxReadLines: 500,
    commandTimeoutSec: 30,
    terminalOutputLines: 200,
    webSearch: 'auto',
    contextStrategy: 'full',
    maxPromptChars: 60000,
    language: 'en',
    customInstructions: '',
    modeInstructions: {},
    diffEnabled: true,
    includeFileListOnStart: true,
  };
}

class ScriptedProvider implements CompletionProvider {
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const text = this.replies.shift();
    if (text === undefined) {
      throw new Error('ScriptedProvider ran out of replies');
    }
    // Simulate streaming in a few chunks.
    let acc = '';
    for (const chunk of text.match(/[\s\S]{1,40}/g) || []) {
      acc += chunk;
      request.onText?.(acc, chunk);
    }
    return {
      text,
      meta: { requestedModel: request.baseModelId, resolvedModel: request.baseModelId, displayModel: request.baseModelId, searchMode: 'auto', mode: 'copilot' } as any,
      accountAlias: 'Test',
      modelLabel: 'Best',
      citations: [],
      usedFollowUp: false,
      promptChars: request.fullPrompt.length,
    };
  }
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-'));
  fs.writeFileSync(path.join(dir, 'math.ts'), 'export function add(a: number, b: number) {\n  return a - b;\n}\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), "import { add } from '../math';\nconsole.log(add(1, 2));\n");
  return dir;
}

function runTask(options: {
  cwd: string;
  replies: string[];
  mode?: string;
  auto?: Partial<AgentSettings['autoApprove']>;
  onAsk?: (task: AgentTask, kind: string, message: UiMessage | undefined) => { response: 'yes' | 'no' | 'message'; text?: string } | undefined;
  prompt: string;
}) {
  const host = new NodeHost(options.cwd);
  const provider = new ScriptedProvider(options.replies);
  const asks: string[] = [];
  const task: AgentTask = new AgentTask({
    host,
    provider,
    getSettings: () => settings(options.auto),
    getSelection: () => ({ baseModelId: 'turbo', thinking: false, webSearch: false }),
    getModelLabel: () => 'Best',
    mode: options.mode || 'code',
    callbacks: {
      onMessage: () => undefined,
      onState: (owner) => {
        const status = owner.status;
        if (status.state === 'waiting' && status.askId && status.askKind) {
          const askId = status.askId;
          const kind = status.askKind;
          if (asks[asks.length - 1] === `${kind}:${askId}`) {
            return;
          }
          asks.push(`${kind}:${askId}`);
          const message = owner.uiMessages.find((entry) => entry.id === askId);
          const reply = options.onAsk?.(owner, kind, message) || { response: 'yes' as const };
          setTimeout(() => owner.respond(askId, reply), 0);
        }
      },
    },
  });
  /** Resolves once the loop has stopped (completed, idle chat reply, error or abort). */
  const settle = () => new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!task.isBusy && task.status.state !== 'running' && task.status.state !== 'waiting' && task.status.requestCount > 0) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
  return { host, provider, asks, task, settle, start: () => task.start(options.prompt) };
}

// -------------------------------------------------------------------------------------------
// Tool parser
// -------------------------------------------------------------------------------------------

test('parser: extracts a tool call and prose', () => {
  const parsed = parseAssistantMessage('I will read the file.\n\n<read_file>\n<path>src/app.ts</path>\n<start_line>1</start_line>\n</read_file>');
  assert.equal(parsed.text.trim(), 'I will read the file.');
  assert.equal(parsed.tool?.name, 'read_file');
  assert.equal(parsed.tool?.params.path, 'src/app.ts');
  assert.equal(parsed.tool?.params.start_line, '1');
  assert.equal(parsed.tool?.partial, false);
});

test('parser: keeps markup inside body params', () => {
  const parsed = parseAssistantMessage('<write_to_file>\n<path>a.html</path>\n<content>\n<div><path>not a param</path></div>\n</content>\n<line_count>1</line_count>\n</write_to_file>');
  assert.equal(parsed.tool?.name, 'write_to_file');
  assert.equal(parsed.tool?.params.content.trim(), '<div><path>not a param</path></div>');
});

test('parser: tool inside a markdown fence is still detected, partial tool flagged', () => {
  const fenced = parseAssistantMessage('```xml\n<list_files>\n<path>.</path>\n</list_files>\n```');
  assert.equal(fenced.tool?.name, 'list_files');
  const partial = parseAssistantMessage('<apply_diff>\n<path>x.ts</path>\n<diff>\n<<<<<<< SEARCH', { partial: true });
  assert.equal(partial.tool?.name, 'apply_diff');
  assert.equal(partial.tool?.partial, true);
});

test('parser: HTML-escaped protocol is recovered', () => {
  const parsed = parseAssistantMessage('&lt;attempt_completion&gt;\n&lt;result&gt;Done&lt;/result&gt;\n&lt;/attempt_completion&gt;');
  assert.equal(parsed.tool?.name, 'attempt_completion');
  assert.equal(parsed.tool?.params.result, 'Done');
});

test('parser: thinking blocks become reasoning, todos and suggestions parse', () => {
  const parsed = parseAssistantMessage('<thinking>plan first</thinking>Let me look.\n<list_files>\n<path>.</path>\n</list_files>');
  assert.equal(parsed.reasoning.trim(), 'plan first');
  assert.equal(parsed.text.trim(), 'Let me look.');
  const todos = parseTodos('[x] one\n[-] two\n[ ] three');
  assert.deepEqual(todos.map((todo) => todo.status), ['completed', 'in_progress', 'pending']);
  const suggestions = parseFollowUpSuggestions('<suggest>Yes</suggest>\n<suggest mode="code">Implement it</suggest>');
  assert.equal(suggestions.length, 2);
  assert.equal(stripWrappingFence('```ts\nconst a = 1;\n```'), 'const a = 1;');
});

// -------------------------------------------------------------------------------------------
// Diff engine
// -------------------------------------------------------------------------------------------

const ORIGINAL = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';

test('diff: exact SEARCH/REPLACE with start_line', () => {
  const result = applyDiff(ORIGINAL, '<<<<<<< SEARCH\n:start_line:5\n-------\nfunction b() {\n  return 2;\n}\n=======\nfunction b() {\n  return 3;\n}\n>>>>>>> REPLACE');
  assert.equal(result.success, true, result.failures.join('\n'));
  assert.ok(result.content?.includes('return 3;'));
  assert.ok(result.content?.includes('return 1;'));
});

test('diff: whitespace-tolerant and fuzzy matching', () => {
  const loose = applyDiff(ORIGINAL, '<<<<<<< SEARCH\nfunction a() {\n    return 1;\n}\n=======\nfunction a() {\n  return 10;\n}\n>>>>>>> REPLACE');
  assert.equal(loose.success, true, loose.failures.join('\n'));
  assert.ok(loose.content?.includes('return 10;'));
  const fuzzy = applyDiff('const value = computeTotal(items, taxRate);\nconsole.log(value);\n', '<<<<<<< SEARCH\nconst value = computeTotal(items, taxrate);\n=======\nconst value = computeTotal(items, rate);\n>>>>>>> REPLACE');
  assert.equal(fuzzy.success, true, fuzzy.failures.join('\n'));
  assert.ok(fuzzy.content?.startsWith('const value = computeTotal(items, rate);'));
});

test('diff: CRLF files keep CRLF, missing blocks fail with a reason', () => {
  const crlf = ORIGINAL.replace(/\n/g, '\r\n');
  const result = applyDiff(crlf, '<<<<<<< SEARCH\n  return 1;\n=======\n  return 5;\n>>>>>>> REPLACE');
  assert.equal(result.success, true, result.failures.join('\n'));
  assert.ok(result.content?.includes('  return 5;\r\n'));
  const failed = applyDiff(ORIGINAL, '<<<<<<< SEARCH\nthis text does not exist anywhere\n=======\nx\n>>>>>>> REPLACE');
  assert.equal(failed.success, false);
  assert.ok(failed.failures.length > 0);
});

test('diff: lineDiff and stats', () => {
  const after = ORIGINAL.replace('return 2;', 'return 22;\n  // extra');
  const lines = lineDiff(ORIGINAL, after);
  assert.ok(lines.some((line) => line.type === '+' && line.text.includes('return 22;')));
  assert.ok(lines.some((line) => line.type === '-' && line.text.includes('return 2;')));
  assert.deepEqual(diffStats(ORIGINAL, after), { added: 2, removed: 1 });
  const changed = lineDiff('a\nb\nc', 'a\nB\nc').filter((line) => line.type !== '@').map((line) => `${line.type}${line.text}`);
  assert.deepEqual(changed, [' a', '-b', '+B', ' c'], 'removed lines come before added lines');
  assert.equal(lineDiff('a\nb\nc', 'a\nB\nc')[0].text, '@@ -1,3 +1,3 @@');
  assert.equal(detectCodeOmission(ORIGINAL, 'function a() {\n  // ... rest of code unchanged\n}\n'), true);
  assert.equal(detectCodeOmission(ORIGINAL, ORIGINAL.replace('1', '2')), false);
});

// -------------------------------------------------------------------------------------------
// Tools
// -------------------------------------------------------------------------------------------

test('tools: read/list/search/insert', async () => {
  const dir = makeWorkspace();
  const host = new NodeHost(dir);
  const read = await readFileTool(host, path.join(dir, 'math.ts'), { maxLines: 500 });
  assert.ok(read.text.includes('2 |   return a - b;'), read.text);
  const ranged = await readFileTool(host, path.join(dir, 'math.ts'), { maxLines: 500, startLine: 2, endLine: 2 });
  assert.ok(!ranged.text.includes('export function'), ranged.text);
  const listing = await listFilesTool(host, dir, true);
  assert.ok(listing.includes('math.ts') && listing.includes('src/index.ts'), listing);
  const found = await searchFilesTool(host, dir, 'add\\(', undefined, new AbortController().signal);
  assert.ok(found.includes('index.ts'), found);
  assert.equal(insertContent('a\nb\n', 2, 'X'), 'a\nX\nb\n');
  assert.equal(insertContent('a\nb\n', 0, 'Z'), 'a\nb\nZ\n');
  assert.ok(truncateOutput(Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n'), 100).includes('omitted'));
});

test('tools: command auto-approval respects allow/deny lists and chains', () => {
  assert.deepEqual(splitCommandChain('npm test && echo ok | cat; ls'), ['npm test', 'echo ok', 'cat', 'ls']);
  assert.equal(isCommandAutoApproved('echo hi', ['echo'], []), true);
  assert.equal(isCommandAutoApproved('echo hi && rm -rf /', ['echo', 'rm'], ['rm -rf']), false);
  assert.equal(isCommandAutoApproved('npm install', ['echo'], []), false);
  assert.equal(isCommandAutoApproved('anything', ['*'], []), true);
});

// -------------------------------------------------------------------------------------------
// Models
// -------------------------------------------------------------------------------------------

test('models: bundled Perplexity catalog has the current Max picker', () => {
  const catalog = getFallbackModelCatalog();
  assert.ok(catalog.length >= 80, `catalog has ${catalog.length} models`);
  const ids = new Set(catalog.map((model) => model.id));
  for (const id of ['turbo', 'gpt6_1_sol', 'gpt6_astra', 'gemini4argon', 'gemini38flash', 'claude55sonnet', 'claude55opus', 'claudefable51', 'grok47']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const surfaced = catalog.filter((model) => model.surfaced !== false).map((model) => model.label);
  assert.ok(surfaced.length >= 10 && surfaced.length <= 16, surfaced.join(', '));
  const opus = catalog.find((model) => model.id === 'claude55opus');
  assert.equal(opus?.requiredPlan, 'max');
  setRuntimeModelCatalog(catalog);
  assert.ok(getModelLabel('claude55sonnet').includes('Sonnet'));
  const thinkingCapable = catalog.find((model) => model.supportsThinking);
  if (thinkingCapable) {
    assert.notEqual(getResolvedModelId(thinkingCapable.id, true), '');
  }
});

test('models: Max models are locked for Pro and unlocked for Max', async () => {
  const fetcher = new ModelFetcher();
  const account = (plan: 'pro' | 'max'): AccountSession => ({
    id: plan, alias: plan, sessionToken: 'x', csrfToken: 'y', status: 'active', queriestoday: 0, queriesTotalLifetime: 0, addedAt: 0,
    capabilities: { plan, fetchedAt: Date.now() } as any,
  } as AccountSession);
  const pro = await fetcher.getModels(account('pro'));
  const max = await fetcher.getModels(account('max'));
  assert.equal(pro.find((model) => model.id === 'claude55opus')?.selectable, false);
  assert.equal(max.find((model) => model.id === 'claude55opus')?.selectable, true);
  assert.equal(pro.find((model) => model.id === 'claude55sonnet')?.selectable, true);
});

// -------------------------------------------------------------------------------------------
// Modes and prompts
// -------------------------------------------------------------------------------------------

test('modes: Kilo mode set and tool groups', () => {
  assert.deepEqual(MODES.map((mode) => mode.slug), ['code', 'architect', 'ask', 'debug', 'orchestrator', 'review']);
  assert.equal(isToolAllowedForMode('write_to_file', getModeBySlug('ask')), false);
  assert.equal(isToolAllowedForMode('read_file', getModeBySlug('ask')), true);
  assert.equal(isToolAllowedForMode('new_task', getModeBySlug('orchestrator')), true);
  const prompt = buildSystemPrompt({ mode: getModeBySlug('code'), cwd: '/tmp/x', settings: settings(), rules: '', osName: 'macOS', shell: '/bin/zsh' } as any);
  assert.ok(prompt.includes('apply_diff') && prompt.includes('attempt_completion'));
  const { prompt: full, droppedMessages } = buildFullPrompt('SYSTEM', Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(2000)}`, ts: i } as const)), 20000);
  assert.ok(full.length <= 26000, `prompt length ${full.length}`);
  assert.ok(droppedMessages > 0);
  assert.ok(full.includes('message 0'), 'first task message must be kept');
  assert.ok(full.includes('message 49'), 'latest message must be kept');
});

// -------------------------------------------------------------------------------------------
// Agent loop end to end (scripted model)
// -------------------------------------------------------------------------------------------

test('agent: read -> apply_diff (approved) -> attempt_completion', async () => {
  const cwd = makeWorkspace();
  const run = runTask({
    cwd,
    prompt: 'Fix the add function',
    replies: [
      'Let me read the file first.\n<read_file>\n<path>math.ts</path>\n</read_file>',
      'The function subtracts. Fixing it.\n<apply_diff>\n<path>math.ts</path>\n<diff>\n<<<<<<< SEARCH\n:start_line:2\n-------\n  return a - b;\n=======\n  return a + b;\n>>>>>>> REPLACE\n</diff>\n</apply_diff>',
      '<attempt_completion>\n<result>add() now returns the sum.</result>\n</attempt_completion>',
    ],
  });
  await run.start();
  await run.settle();
  const task = run.task;
  assert.equal(fs.readFileSync(path.join(cwd, 'math.ts'), 'utf8').includes('return a + b;'), true);
  assert.equal(task.status.state, 'completed', JSON.stringify(task.status));
  assert.equal(task.completionResult, 'add() now returns the sum.');
  assert.ok(run.asks.some((ask) => ask.startsWith('tool:')), `asks: ${run.asks.join(', ')}`);
  assert.ok(run.asks.some((ask) => ask.startsWith('completion_result:')));
  // The read was auto-approved: its result must reach the model in the second prompt.
  assert.ok(run.provider.requests[1].fullPrompt.includes('return a - b;'));
  const toolMessages = task.uiMessages.filter((message) => message.type === 'tool');
  const edit = toolMessages.find((message) => message.tool?.name === 'apply_diff');
  assert.equal(edit?.tool?.added, 1);
  assert.equal(edit?.tool?.removed, 1);
  assert.ok(task.uiMessages.some((message) => message.type === 'checkpoint'));
  assert.equal(task.checkpoints.length, 1);
  // Restoring the checkpoint reverts the edit.
  await task.restoreCheckpoint(task.checkpoints[0].seq);
  assert.equal(fs.readFileSync(path.join(cwd, 'math.ts'), 'utf8').includes('return a - b;'), true);
  // The task serialises cleanly for history.
  const json = JSON.parse(JSON.stringify(task.toJSON()));
  assert.equal(json.title, 'Fix the add function');
});

test('agent: denied edit is reported to the model and file is untouched', async () => {
  const cwd = makeWorkspace();
  const run = runTask({
    cwd,
    prompt: 'Rewrite math.ts',
    onAsk: (_task, kind) => (kind === 'tool' ? { response: 'no' } : { response: 'yes' }),
    replies: [
      '<write_to_file>\n<path>math.ts</path>\n<content>\nexport const broken = true;\n</content>\n<line_count>1</line_count>\n</write_to_file>',
      '<attempt_completion>\n<result>Stopped because the edit was denied.</result>\n</attempt_completion>',
    ],
  });
  await run.start();
  await run.settle();
  assert.ok(fs.readFileSync(path.join(cwd, 'math.ts'), 'utf8').includes('return a - b;'));
  assert.ok(/denied/i.test(run.provider.requests[1].fullPrompt), 'the denial must be sent back to the model');
  assert.equal(run.task.status.state, 'completed');
});

test('agent: plain answer waits for the user; mid-task no-tool answer gets a reminder', async () => {
  const cwd = makeWorkspace();
  const run = runTask({
    cwd,
    prompt: 'Create hello.txt and list files',
    auto: { write: true, execute: true },
    replies: [
      'Sure, I can do that. Shall I go ahead?',
      '<write_to_file>\n<path>notes/hello.txt</path>\n<content>\nhello\n</content>\n<line_count>1</line_count>\n</write_to_file>',
      '<execute_command>\n<command>ls notes</command>\n</execute_command>',
      'The file exists. Now I will finish the task.',
      '<attempt_completion>\n<result>Created notes/hello.txt</result>\n</attempt_completion>',
    ],
  });
  await run.start();
  await run.settle();
  assert.equal(run.task.status.state, 'idle', 'a plain chat answer stops the loop like a chat reply');
  assert.equal(run.provider.requests.length, 1);
  await run.task.submitUserMessage('Yes, go ahead');
  await run.settle();
  const task = run.task;
  assert.equal(task.status.state, 'completed', JSON.stringify(task.status));
  assert.equal(fs.readFileSync(path.join(cwd, 'notes', 'hello.txt'), 'utf8').trim(), 'hello');
  assert.ok(run.provider.requests[1].fullPrompt.includes('Yes, go ahead'));
  assert.ok(run.provider.requests[3].fullPrompt.includes('hello.txt'), 'command output must reach the model');
  assert.ok(run.provider.requests[4].fullPrompt.includes('You did not use a tool'), 'reminder after a mid-task no-tool answer');
  const command = task.uiMessages.find((message) => message.type === 'command');
  assert.equal(command?.command?.exitCode, 0);
  assert.ok(!run.asks.some((ask) => ask.startsWith('tool:') || ask.startsWith('command:')), `unexpected asks: ${run.asks.join(', ')}`);
});

test('agent: commands outside the allow list need approval; abort stops the task', async () => {
  const cwd = makeWorkspace();
  const run = runTask({
    cwd,
    prompt: 'Run a command',
    auto: { execute: true },
    onAsk: (owner, kind) => {
      if (kind === 'command') {
        setTimeout(() => owner.abort(), 0);
        return undefined;
      }
      return { response: 'yes' };
    },
    replies: ['<execute_command>\n<command>touch created-by-agent.txt</command>\n</execute_command>'],
  });
  await run.start();
  await run.settle();
  assert.ok(run.asks.some((ask) => ask.startsWith('command:')), `asks: ${run.asks.join(', ')}`);
  assert.equal(fs.existsSync(path.join(cwd, 'created-by-agent.txt')), false);
  assert.equal(run.task.status.state, 'aborted');
});

test('agent: ask mode cannot write files', async () => {
  const cwd = makeWorkspace();
  const run = runTask({
    cwd,
    mode: 'ask',
    prompt: 'Change math.ts',
    auto: { write: true },
    replies: [
      '<write_to_file>\n<path>math.ts</path>\n<content>\nx\n</content>\n<line_count>1</line_count>\n</write_to_file>',
      '<attempt_completion>\n<result>I can only explain in Ask mode.</result>\n</attempt_completion>',
    ],
  });
  await run.start();
  await run.settle();
  assert.ok(fs.readFileSync(path.join(cwd, 'math.ts'), 'utf8').includes('return a - b;'));
  assert.ok(/not allowed|mode/i.test(run.provider.requests[1].fullPrompt));
});

test('agent: followup question with suggestions', async () => {
  const cwd = makeWorkspace();
  const run = runTask({
    cwd,
    prompt: 'Add a feature',
    onAsk: (_task, kind) => (kind === 'followup' ? { response: 'message', text: 'Use TypeScript' } : { response: 'yes' }),
    replies: [
      '<ask_followup_question>\n<question>Which language?</question>\n<follow_up>\n<suggest>Use TypeScript</suggest>\n<suggest>Use JavaScript</suggest>\n</follow_up>\n</ask_followup_question>',
      '<attempt_completion>\n<result>Will use TypeScript.</result>\n</attempt_completion>',
    ],
  });
  await run.start();
  await run.settle();
  const followup = run.task.uiMessages.find((message) => message.type === 'followup');
  assert.equal(followup?.suggestions?.length, 2);
  assert.ok(run.provider.requests[1].fullPrompt.includes('Use TypeScript'));
});

// -------------------------------------------------------------------------------------------
// Transport (fake Perplexity client)
// -------------------------------------------------------------------------------------------

function fakeAccount(id: string, plan: 'pro' | 'max' = 'max'): AccountSession {
  return {
    id, alias: id, sessionToken: 's', csrfToken: 'c', status: 'active', queriestoday: 0, queriesTotalLifetime: 0, addedAt: 0,
    capabilities: { plan, fetchedAt: Date.now() } as any,
  } as AccountSession;
}

function makeTransport(accounts: AccountSession[], behaviour: (call: { prompt: string; model: string; options: any; account: string }) => { error?: Error; text?: string }) {
  const calls: Array<{ prompt: string; model: string; options: any; account: string }> = [];
  const manager = { getAccounts: () => accounts, saveMetas: async () => undefined, refreshSession: async () => false } as any;
  const transport = new PerplexityTransport(manager, new RotationEngine(), new CapabilityFetcher(), (account) => ({
    streamQuery(query, model, callbacks, options) {
      const call = { prompt: query, model, options, account: account.id };
      calls.push(call);
      const outcome = behaviour(call);
      setTimeout(() => {
        if (outcome.error) {
          callbacks.onError(outcome.error);
          return;
        }
        callbacks.onChunk?.(outcome.text || '');
        callbacks.onDone(outcome.text || '', { requestedModel: model, resolvedModel: model, displayModel: model, searchMode: 'search', mode: 'copilot', backendUuid: 'uuid-1', readWriteToken: 'rw' } as any);
      }, 0);
      return new AbortController();
    },
  } as StreamingClient));
  return { transport, calls };
}

test('transport: streams, returns a follow-up thread, uses no web sources by default', async () => {
  setRuntimeModelCatalog(getFallbackModelCatalog());
  const { transport, calls } = makeTransport([fakeAccount('a')], () => ({ text: 'hello' }));
  const result = await transport.complete({ fullPrompt: 'FULL', baseModelId: 'claude55sonnet', thinking: false, webSearch: false, signal: new AbortController().signal });
  assert.equal(result.text, 'hello');
  assert.equal(result.thread?.lastBackendUuid, 'uuid-1');
  assert.equal(calls[0].model, 'claude55sonnet');
  assert.deepEqual(calls[0].options.sources, []);
});

test('transport: rejected empty sources retry with web; broken follow-up resends full prompt', async () => {
  setRuntimeModelCatalog(getFallbackModelCatalog());
  const { transport, calls } = makeTransport([fakeAccount('a')], (call) => {
    if (call.options.followUp) {
      return { error: new Error('Thread not found (404)') };
    }
    if (call.options.sources.length === 0) {
      return { error: new Error('Request rejected by Perplexity (400)') };
    }
    return { text: 'ok' };
  });
  const thread = { accountId: 'a', modelId: 'claude55sonnet', lastBackendUuid: 'old' };
  const result = await transport.complete({ fullPrompt: 'FULL', followUpPrompt: 'SHORT', thread, baseModelId: 'claude55sonnet', thinking: false, webSearch: false, signal: new AbortController().signal });
  assert.equal(result.text, 'ok');
  assert.equal(calls[0].prompt, 'SHORT');
  assert.equal(calls[1].prompt, 'FULL');
  assert.deepEqual(calls[calls.length - 1].options.sources, ['web']);
  assert.equal(result.usedFollowUp, false);
});

test('transport: Max model on a Pro-only pool falls back to Best', async () => {
  setRuntimeModelCatalog(getFallbackModelCatalog());
  const infos: string[] = [];
  const { transport, calls } = makeTransport([fakeAccount('p', 'pro')], () => ({ text: 'fallback' }));
  const result = await transport.complete({ fullPrompt: 'FULL', baseModelId: 'claude55opus', thinking: false, webSearch: false, signal: new AbortController().signal, onInfo: (m) => infos.push(m) });
  assert.equal(result.text, 'fallback');
  assert.equal(calls[0].model, 'turbo');
  assert.ok(infos.some((m) => m.includes('Best')), infos.join('|'));
});

// -------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 15s')), 15000)),
      ]);
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL ${name}\n       ${(error as Error).stack?.split('\n').slice(0, 4).join('\n       ')}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
