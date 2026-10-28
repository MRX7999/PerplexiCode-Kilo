/* Builds realistic webview state messages from a scripted agent run (used by webview-render.mjs). */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { MODES, getModeBySlug } from '../src/agent/modes';
import { AgentTask } from '../src/agent/task';
import type { AgentHost } from '../src/agent/tools';
import type { AgentSettings } from '../src/agent/types';
import { getBundledSnapshotDate, getFallbackModelCatalog, getModelLabel, setRuntimeModelCatalog } from '../src/api/modelCatalog';
import { ModelFetcher } from '../src/api/modelFetcher';

const settings: AgentSettings = {
  autoApprove: { enabled: true, read: true, readOutsideWorkspace: false, write: false, execute: true, modeSwitch: true, subtasks: true, todo: true, retry: true },
  allowedCommands: ['npm test', 'ls', 'git status'], deniedCommands: [], maxRequests: 40, maxReadLines: 500, commandTimeoutSec: 120,
  terminalOutputLines: 300, webSearch: 'auto', contextStrategy: 'auto', maxPromptChars: 60000, language: 'auto', customInstructions: '',
  modeInstructions: {}, diffEnabled: true, includeFileListOnStart: true,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-ui-'));
fs.writeFileSync(path.join(dir, 'math.ts'), 'export function add(a: number, b: number) {\n  return a - b;\n}\n');
const host: AgentHost = {
  cwd: dir,
  readFile: (p) => fs.promises.readFile(p, 'utf8'),
  writeFile: (p, c) => fs.promises.writeFile(p, c),
  runCommand: (command, cwd, options) => new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd });
    let output = '';
    child.stdout.on('data', (d) => { output += d; options.onOutput?.(String(d)); });
    child.on('close', (code) => resolve({ output, exitCode: code }));
  }),
};
const replies = [
  '<thinking>I should look at the file first.</thinking>I will start by reading **math.ts**.\n<update_todo_list>\n<todos>\n[-] Read math.ts\n[ ] Fix add()\n[ ] Run tests\n</todos>\n</update_todo_list>',
  '<read_file>\n<path>math.ts</path>\n</read_file>',
  'Found the bug: `add` subtracts.\n\n```ts\nreturn a - b; // wrong\n```\n<apply_diff>\n<path>math.ts</path>\n<diff>\n<<<<<<< SEARCH\n:start_line:2\n-------\n  return a - b;\n=======\n  return a + b;\n>>>>>>> REPLACE\n</diff>\n</apply_diff>',
  '<execute_command>\n<command>ls</command>\n</execute_command>',
  '<ask_followup_question>\n<question>Should I also add unit tests?</question>\n<follow_up>\n<suggest>Yes, add tests with vitest</suggest>\n<suggest mode="architect">Plan the test strategy first</suggest>\n</follow_up>\n</ask_followup_question>',
];
let stopAtFollowup: (() => void) | undefined;
const followupReached = new Promise<void>((resolve) => { stopAtFollowup = resolve; });
const task = new AgentTask({
  host,
  provider: {
    async complete(request) {
      const text = replies.shift() || '<attempt_completion>\n<result>Done</result>\n</attempt_completion>';
      request.onText?.(text, text);
      return { text, meta: { displayModel: 'claude55sonnet' } as any, accountAlias: 'Personal', modelLabel: 'Claude Sonnet 5.5', citations: ['https://www.typescriptlang.org/docs/'], usedFollowUp: false, promptChars: request.fullPrompt.length };
    },
  },
  getSettings: () => settings,
  getSelection: () => ({ baseModelId: 'claude55sonnet', thinking: false, webSearch: undefined }),
  getModelLabel: (id, thinking) => getModelLabel(id, thinking),
  mode: 'code',
  callbacks: {
    onMessage: () => undefined,
    onState: (owner) => {
      if (owner.status.state === 'waiting' && owner.status.askKind === 'tool' && owner.status.askId) {
        const id = owner.status.askId;
        setTimeout(() => owner.respond(id, { response: 'yes' }), 0);
      }
      if (owner.status.state === 'waiting' && owner.status.askKind === 'followup') {
        stopAtFollowup?.();
      }
    },
  },
});

async function main() {
  const catalog = getFallbackModelCatalog();
  setRuntimeModelCatalog(catalog);
  const models = await new ModelFetcher().getModels({ id: 'a', alias: 'Personal', sessionToken: '', csrfToken: '', status: 'active', queriestoday: 3, queriesTotalLifetime: 120, addedAt: 0, capabilities: { plan: 'max', fetchedAt: Date.now() } } as any);
  void task.start('Fix the add function in math.ts and make sure tests pass');
  await followupReached;
  const base = {
    type: 'state', version: '2.1.0', includeMessages: true,
    mode: 'code',
    modes: MODES.map((mode) => ({ slug: mode.slug, name: mode.name, description: mode.description, icon: mode.icon })),
    models: models.map((model) => ({ id: model.id, label: model.label, description: model.description, category: model.category, supportsThinking: model.supportsThinking, requiredPlan: model.requiredPlan, isNew: model.isNew === true, surfaced: model.surfaced !== false, selectable: model.selectable !== false, provider: model.provider || null })),
    selection: { modelId: 'claude55sonnet', thinking: false, webSearch: null, modelLabel: getModelLabel('claude55sonnet'), modeWebSearchDefault: getModeBySlug('code').webSearchDefault },
    settings,
    general: { subscriptionPlan: 'auto', rotationStrategy: 'round-robin', revealEditedFiles: true, modelsSnapshot: getBundledSnapshotDate() },
    accounts: [{ id: 'a', alias: 'Personal', status: 'active', plan: 'max', email: 'user@example.com', queriesToday: 3, queriesTotal: 120, lastUsedAt: Date.now(), quotas: { pro: 'unlimited', research: '200 left', labs: '50 left', free: '' } }],
    history: [{ id: 'h1', ts: Date.now() - 3600_000, title: 'Refactor the auth middleware to use async/await', workspace: dir, mode: 'code', status: 'completed', requestCount: 7 }],
    workspace: dir,
  };
  const withTask = { ...base, task: { id: task.id, title: task.title, mode: task.mode, status: task.status, todos: task.todos, busy: task.isBusy, messages: task.uiMessages, depth: 0 } };
  const empty = { ...base, task: null };
  fs.writeFileSync(path.join(process.cwd(), 'out', 'test', 'fixture.json'), JSON.stringify({ withTask, empty }, null, 2));
  console.log(`fixture: ${task.uiMessages.length} messages, types=${[...new Set(task.uiMessages.map((m) => m.type))].join(',')}, models=${models.length}`);
  task.abort();
  process.exit(0);
}
void main();
