import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MODES } from '../agent/modes';
import { loadSkills, loadSubagents, SkillDefinition, SubagentDefinition } from './agents';

/**
 * 3.1 library: one-click presets for subagents, skills and tasks.
 *
 * Subagents and skills are installed as plain files in the Claude Code compatible layout, so the
 * IDE, `pcode` and Claude Code itself all see them:
 *   project: <cwd>/.perplexicode/agents/<name>.md    <cwd>/.perplexicode/skills/<name>/SKILL.md
 *   user:    ~/.perplexicode/agents/<name>.md        ~/.perplexicode/skills/<name>/SKILL.md
 *
 * Task presets are prompt templates bound to a mode and optionally a subagent. Built-in presets
 * ship with the extension; custom ones live in the user setting `perplexicodeKilo.taskPresets`
 * (IDE) and/or `<cwd>/.perplexicode/presets.json` / `~/.perplexicode/presets.json` (shared).
 */

export type LibraryScope = 'project' | 'user';

export interface AgentPreset {
  id: string;
  description: string;
  /** Claude Code tool list; undefined = all tools. */
  tools?: string[];
  mode: string;
  prompt: string;
  tags: string[];
}

export interface SkillPreset {
  id: string;
  description: string;
  body: string;
  tags: string[];
}

export interface TaskPreset {
  id: string;
  title: string;
  description: string;
  mode: string;
  /** Prompt template. `{{input}}` is replaced with the user's text (or removed when empty). */
  prompt: string;
  /** Optional subagent that runs the task as the primary agent. */
  agent?: string;
  /** The template is meaningless without user text (the UI asks for details before running). */
  inputRequired?: boolean;
  /** Subagents / skills the preset relies on; offered for installation when missing. */
  requires?: { agents?: string[]; skills?: string[] };
  icon?: string;
  source: 'builtin' | 'user' | 'project';
}

// ---------------------------------------------------------------------------------------------
// Built-in catalog
// ---------------------------------------------------------------------------------------------

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'code-reviewer',
    description: 'Reviews recent changes for bugs, security issues and missing tests. Use after edits or before a commit.',
    tools: ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)'],
    mode: 'review',
    tags: ['quality'],
    prompt: `You are a senior code reviewer. Review only what changed (start with \`git status\` and \`git diff\`; fall back to the files named in the brief).

Report findings ordered by severity:
1. Bugs and incorrect logic (with file:line and a concrete failing input).
2. Security: injection, secrets in code, unsafe deserialization, path traversal, missing authz.
3. Error handling, resource leaks, concurrency.
4. Missing or weak tests for the changed behaviour.
5. Readability issues only when they hide a real risk.

For every finding give: location, why it is wrong, and a minimal fix. Do not rewrite files. If nothing is wrong, say so plainly.`,
  },
  {
    id: 'test-writer',
    description: 'Writes and runs focused unit tests for a module or a recent change, using the project\'s existing test framework.',
    mode: 'code',
    tags: ['quality'],
    prompt: `You write tests. First detect the test framework and conventions already used in the project (package.json, go.mod, pyproject, existing *_test / *.test files). Never introduce a new framework when one exists.

Steps: read the code under test → list behaviours and edge cases (empty input, boundaries, errors) → write the smallest set of tests that pins them → run the test command → fix tests (not the code) until they pass, unless a test exposes a real bug: then report the bug instead of hiding it.

Finish with the exact command you ran and its result.`,
  },
  {
    id: 'debugger',
    description: 'Finds the root cause of an error, failing test or wrong output by reproducing it first. Use for bugs and stack traces.',
    mode: 'debug',
    tags: ['debug'],
    prompt: `You are a debugging specialist. Work hypothesis-driven:
1. Reproduce the problem with a command or minimal script and capture the exact error.
2. List 2–4 plausible causes, ranked; check the cheapest one first (read the code path, add a temporary log, run again).
3. Confirm the root cause with evidence before changing anything.
4. Apply the minimal fix, re-run the reproduction and the related tests.
5. Remove temporary logging.

Report: root cause, evidence, the fix, and how it was verified.`,
  },
  {
    id: 'security-auditor',
    description: 'Read-only security audit: secrets, injection, authz, dependency and configuration risks. Use before releases.',
    tools: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(npm audit:*)', 'Bash(pip-audit:*)', 'Bash(go list:*)'],
    mode: 'review',
    tags: ['security'],
    prompt: `You are an application security auditor working on the user's own code. Do not modify files.

Check, in this order: hard-coded secrets and tokens (report the file and line, never print the secret value) → injection (SQL, shell, template, path) → authentication and authorization gaps → unsafe crypto and TLS settings → SSRF and open redirects → dependency risks (lockfiles, audit tools if available) → insecure defaults in configs, Dockerfiles and CI.

For each finding: severity (critical/high/medium/low), location, exploit scenario in one sentence, and the fix. End with a short prioritised remediation list.`,
  },
  {
    id: 'docs-writer',
    description: 'Writes or updates README, usage docs and code comments from the actual code. Use after features land.',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    mode: 'code',
    tags: ['docs'],
    prompt: `You write documentation from the code, not from assumptions. Read the entry points, public API and configuration first.

Produce: what the project does (2–3 sentences), install, configure (every env var / setting with its default), run, test, and troubleshooting for errors you can see in the code. Keep examples copy-pasteable and verified against the code. Update existing docs in place instead of duplicating them. Do not invent features, versions or benchmarks.`,
  },
  {
    id: 'refactorer',
    description: 'Behaviour-preserving refactoring in small verified steps. Use for cleanup, splitting large files, removing duplication.',
    mode: 'code',
    tags: ['quality'],
    prompt: `You refactor without changing behaviour.
1. Find how behaviour is verified (tests, build, type check). If there is nothing, write characterisation tests first.
2. Make one small change at a time (rename, extract function, move module, remove duplication), then run the checks.
3. Never mix refactoring with feature changes or formatting churn across untouched files.
4. Keep public APIs stable unless the brief says otherwise.

Report each step and the check that passed after it.`,
  },
  {
    id: 'explorer',
    description: 'Fast read-only codebase research: where something is implemented, how data flows, which files to touch.',
    tools: ['Read', 'Grep', 'Glob'],
    mode: 'ask',
    tags: ['research'],
    prompt: `You explore a codebase and answer precisely. Use search and targeted reads; do not read whole large files when a range is enough. Do not edit anything.

Answer with: the relevant files and symbols (path:line), how they connect (call chain or data flow), and what would need to change for the brief. Keep it short and factual; mark guesses as guesses.`,
  },
  {
    id: 'planner',
    description: 'Turns a feature request into a step-by-step implementation plan with risks and acceptance checks. Does not write code.',
    tools: ['Read', 'Grep', 'Glob'],
    mode: 'architect',
    tags: ['planning'],
    prompt: `You plan, you do not implement. Read enough of the code to ground the plan.

Output: goal and non-goals → affected files/modules → ordered steps, each small enough for one commit → data/API changes → risks and how to de-risk them → acceptance checks (commands or observable behaviour). Ask one clarifying question only if a wrong assumption would waste the whole plan.`,
  },
];

export const SKILL_PRESETS: SkillPreset[] = [
  {
    id: 'commit-message',
    description: 'Writes Conventional Commits messages from the staged diff.',
    tags: ['git'],
    body: `# Commit message

1. Run \`git diff --staged\` (fall back to \`git diff\` when nothing is staged).
2. Pick the type: feat, fix, refactor, perf, test, docs, build, ci, chore. Add a scope when the change is confined to one area.
3. Subject: imperative, ≤ 72 characters, no trailing period.
4. Body (only when useful): why the change was needed and anything surprising. Wrap at 72.
5. Breaking changes: \`BREAKING CHANGE:\` footer.

Never invent changes that are not in the diff.`,
  },
  {
    id: 'code-review-checklist',
    description: 'Checklist for reviewing a diff or pull request.',
    tags: ['quality'],
    body: `# Code review checklist

- Correctness: edge cases (empty, null, max size, unicode), off-by-one, error paths.
- Security: input validation, injection, secrets, authz on every new endpoint.
- Concurrency and resources: locks, async errors, file/socket/handle leaks.
- Tests: new behaviour covered; tests fail without the change.
- API and compatibility: public signatures, config keys, migrations.
- Observability: errors logged with context, no secrets in logs.

Report findings with file:line, severity and a minimal fix.`,
  },
  {
    id: 'write-tests',
    description: 'How to add tests that match the project\'s existing framework and run them.',
    tags: ['quality'],
    body: `# Write tests

1. Detect the framework: package.json scripts (vitest/jest/mocha), go test, pytest, cargo test, XCTest.
2. Mirror the existing layout and naming for test files.
3. Cover: the happy path, boundaries, invalid input, and one regression test per fixed bug.
4. Prefer real objects over mocks; mock only I/O boundaries (network, clock, filesystem when slow).
5. Run the narrowest test command first, then the full suite.
6. Report the command and the pass/fail summary.`,
  },
  {
    id: 'security-audit',
    description: 'Step-by-step security audit procedure for a repository.',
    tags: ['security'],
    body: `# Security audit

1. Secrets: search for keys, tokens, private keys, .env files committed to git. Report locations only, never values.
2. Dependencies: run the ecosystem audit tool if present (npm audit, pip-audit, govulncheck, cargo audit).
3. Injection: shell (exec/spawn with string concatenation), SQL (string-built queries), templates, path joins with user input.
4. AuthN/AuthZ: every route/handler checks identity and ownership.
5. Transport and crypto: TLS verification disabled, weak hashes for passwords, homemade crypto.
6. Config: debug flags, permissive CORS, default credentials, containers running as root.

Output a table: severity · location · issue · fix.`,
  },
  {
    id: 'debug-playbook',
    description: 'Reproduce → hypothesise → verify → fix loop for bugs and failing tests.',
    tags: ['debug'],
    body: `# Debug playbook

1. Reproduce with one command; save the exact error output.
2. Read the stack trace from the first frame in project code.
3. Write down 2–4 hypotheses; test the cheapest first.
4. Add temporary logging or a minimal script to confirm; never guess-fix.
5. Fix minimally, rerun the reproduction and related tests, remove temporary logs.
6. Explain the root cause in one paragraph.`,
  },
  {
    id: 'api-design',
    description: 'Conventions for designing or reviewing HTTP/JSON APIs.',
    tags: ['design'],
    body: `# API design

- Resources as plural nouns, actions via HTTP methods; idempotent PUT/DELETE.
- Consistent error shape: \`{ "error": { "code", "message", "details" } }\` with correct status codes.
- Pagination (cursor preferred), filtering and sorting parameters documented.
- Versioning strategy decided up front (path or header).
- Validate input at the boundary; never trust client IDs for authorization.
- Document every endpoint with a request/response example.`,
  },
  {
    id: 'release-checklist',
    description: 'Checklist before tagging a release: version, changelog, build, tests, artifacts.',
    tags: ['release'],
    body: `# Release checklist

1. Version bumped in every manifest (package.json, Cargo.toml, go module tag, Info.plist…).
2. CHANGELOG entry: added / changed / fixed / breaking, with migration notes.
3. Clean build from a fresh clone; lint and full tests pass.
4. Artifacts built and smoke-tested (install the package, run --version / a basic command).
5. Secrets and debug flags absent from artifacts.
6. Tag and release notes prepared; do not push or publish without explicit approval.`,
  },
  {
    id: 'readme-writer',
    description: 'Structure and rules for writing a README from the actual code.',
    tags: ['docs'],
    body: `# README writer

Sections: one-line summary → features (verified in code) → requirements with versions → install → configuration table (name, default, description) → usage examples → development (build, test) → troubleshooting → license.

Rules: every command must exist in the repo (scripts, Makefile); no invented badges, versions or benchmarks; keep existing sections the maintainer wrote unless they are wrong.`,
  },
];

export const BUILTIN_TASK_PRESETS: TaskPreset[] = [
  {
    id: 'review-changes',
    title: 'Review my changes',
    description: 'Bugs, security and missing tests in the current git diff',
    mode: 'review',
    agent: 'code-reviewer',
    prompt: 'Review the uncommitted changes in this repository. {{input}}',
    requires: { agents: ['code-reviewer'] },
    icon: 'review',
    source: 'builtin',
  },
  {
    id: 'fix-bug',
    inputRequired: true,
    title: 'Fix a bug',
    description: 'Reproduce, find the root cause, fix and verify',
    mode: 'debug',
    agent: 'debugger',
    prompt: 'Find and fix this bug. Reproduce it first, then verify the fix with tests.\n\n{{input}}',
    requires: { agents: ['debugger'], skills: ['debug-playbook'] },
    icon: 'debug',
    source: 'builtin',
  },
  {
    id: 'write-tests',
    inputRequired: true,
    title: 'Write tests',
    description: 'Cover a module with tests in the existing framework',
    mode: 'code',
    agent: 'test-writer',
    prompt: 'Write unit tests for {{input}} using the project\'s existing test framework, then run them and report the result.',
    requires: { agents: ['test-writer'], skills: ['write-tests'] },
    icon: 'code',
    source: 'builtin',
  },
  {
    id: 'new-feature',
    inputRequired: true,
    title: 'Build a feature',
    description: 'Plan with the Orchestrator, delegate, verify',
    mode: 'orchestrator',
    prompt: 'Implement this feature. Break it into subtasks, delegate them, and finish only after the build and tests pass.\n\n{{input}}',
    requires: { agents: ['planner', 'test-writer', 'code-reviewer'] },
    icon: 'orchestrator',
    source: 'builtin',
  },
  {
    id: 'explain-project',
    title: 'Explain this project',
    description: 'Architecture, entry points and data flow',
    mode: 'ask',
    agent: 'explorer',
    prompt: 'Explain how this project is structured: entry points, main modules, data flow and how to build and test it. {{input}}',
    requires: { agents: ['explorer'] },
    icon: 'ask',
    source: 'builtin',
  },
  {
    id: 'security-audit',
    title: 'Security audit',
    description: 'Read-only audit with a prioritised fix list',
    mode: 'review',
    agent: 'security-auditor',
    prompt: 'Run a security audit of this repository and give a prioritised remediation list. {{input}}',
    requires: { agents: ['security-auditor'], skills: ['security-audit'] },
    icon: 'review',
    source: 'builtin',
  },
  {
    id: 'refactor',
    inputRequired: true,
    title: 'Refactor safely',
    description: 'Small behaviour-preserving steps with checks',
    mode: 'code',
    agent: 'refactorer',
    prompt: 'Refactor {{input}} without changing behaviour. Verify with tests after every step.',
    requires: { agents: ['refactorer'] },
    icon: 'code',
    source: 'builtin',
  },
  {
    id: 'write-docs',
    title: 'Update the README',
    description: 'Docs generated from the actual code',
    mode: 'code',
    agent: 'docs-writer',
    prompt: 'Update the README and usage docs from the current code. {{input}}',
    requires: { agents: ['docs-writer'], skills: ['readme-writer'] },
    icon: 'code',
    source: 'builtin',
  },
  {
    id: 'new-project',
    inputRequired: true,
    title: 'Scaffold a project',
    description: 'Project skeleton with build, tests and README',
    mode: 'code',
    prompt: 'Create a new project: {{input}}\n\nInclude a minimal working entry point, one module with logic, unit tests, a build/test command (Makefile or scripts), .gitignore and a README. Run the tests before finishing.',
    icon: 'code',
    source: 'builtin',
  },
  {
    id: 'commit-message',
    title: 'Commit message',
    description: 'Conventional Commits message from the diff',
    mode: 'ask',
    prompt: 'Write a Conventional Commits message for the staged changes (git diff --staged). {{input}}',
    requires: { skills: ['commit-message'] },
    icon: 'ask',
    source: 'builtin',
  },
];

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function yamlValue(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return /[:#\[\]{},&*!|>'"%@`]/.test(single) ? JSON.stringify(single) : single;
}

export function renderAgentMarkdown(def: { name: string; description: string; tools?: string[]; mode?: string; model?: string; prompt: string }): string {
  const lines = ['---', `name: ${def.name}`, `description: ${yamlValue(def.description)}`];
  if (def.tools && def.tools.length > 0) lines.push(`tools: ${def.tools.join(', ')}`);
  if (def.mode) lines.push(`mode: ${def.mode}`);
  if (def.model) lines.push(`model: ${def.model}`);
  lines.push('---', '', def.prompt.trim(), '');
  return lines.join('\n');
}

export function renderSkillMarkdown(def: { name: string; description: string; body: string }): string {
  return ['---', `name: ${def.name}`, `description: ${yamlValue(def.description)}`, '---', '', def.body.trim(), ''].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------------------------

export interface LibraryPaths {
  cwd?: string;
  home?: string;
}

function baseDir(scope: LibraryScope, paths: LibraryPaths): string {
  if (scope === 'project') {
    if (!paths.cwd) throw new Error('Open a folder to install into the project.');
    return path.join(paths.cwd, '.perplexicode');
  }
  return path.join(paths.home || os.homedir(), '.perplexicode');
}

export function agentFilePath(name: string, scope: LibraryScope, paths: LibraryPaths): string {
  return path.join(baseDir(scope, paths), 'agents', `${name}.md`);
}

export function skillFilePath(name: string, scope: LibraryScope, paths: LibraryPaths): string {
  return path.join(baseDir(scope, paths), 'skills', name, 'SKILL.md');
}

export interface WriteResult {
  file: string;
  created: boolean;
}

function writeFileSafe(file: string, content: string, overwrite: boolean): WriteResult {
  const exists = fs.existsSync(file);
  if (exists && !overwrite) {
    throw Object.assign(new Error(`${file} already exists`), { code: 'EEXIST', file });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { file, created: !exists };
}

export function installAgentPreset(id: string, scope: LibraryScope, paths: LibraryPaths, overwrite = false): WriteResult {
  const preset = AGENT_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown subagent preset "${id}". Known: ${AGENT_PRESETS.map((entry) => entry.id).join(', ')}`);
  return writeFileSafe(agentFilePath(preset.id, scope, paths), renderAgentMarkdown({ name: preset.id, ...preset }), overwrite);
}

export function installSkillPreset(id: string, scope: LibraryScope, paths: LibraryPaths, overwrite = false): WriteResult {
  const preset = SKILL_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown skill preset "${id}". Known: ${SKILL_PRESETS.map((entry) => entry.id).join(', ')}`);
  return writeFileSafe(skillFilePath(preset.id, scope, paths), renderSkillMarkdown({ name: preset.id, description: preset.description, body: preset.body }), overwrite);
}

export interface CustomAgentInput {
  name: string;
  description: string;
  tools?: string[];
  mode?: string;
  model?: string;
  prompt: string;
}

export function createCustomAgent(input: CustomAgentInput, scope: LibraryScope, paths: LibraryPaths, overwrite = false): WriteResult {
  const name = normalizeName(input.name);
  if (!NAME_RE.test(name)) throw new Error('Agent name must use a-z, 0-9, "-" or "_".');
  if (MODES.some((mode) => mode.slug === name)) throw new Error(`"${name}" is a built-in mode name; choose another.`);
  if (!input.description.trim()) throw new Error('Description is required: the orchestrator uses it to decide when to delegate.');
  if (!input.prompt.trim()) throw new Error('System prompt is required.');
  const mode = input.mode && MODES.some((entry) => entry.slug === input.mode) ? input.mode : undefined;
  const tools = (input.tools || []).map((entry) => entry.trim()).filter(Boolean);
  return writeFileSafe(agentFilePath(name, scope, paths), renderAgentMarkdown({ name, description: input.description, tools: tools.length ? tools : undefined, mode, model: input.model?.trim() || undefined, prompt: input.prompt }), overwrite);
}

export function createCustomSkill(input: { name: string; description: string; body: string }, scope: LibraryScope, paths: LibraryPaths, overwrite = false): WriteResult {
  const name = normalizeName(input.name);
  if (!NAME_RE.test(name)) throw new Error('Skill name must use a-z, 0-9, "-" or "_".');
  if (!input.description.trim()) throw new Error('Description is required: the agent uses it to decide when to load the skill.');
  if (!input.body.trim()) throw new Error('Skill instructions are required.');
  return writeFileSafe(skillFilePath(name, scope, paths), renderSkillMarkdown({ name, description: input.description, body: input.body }), overwrite);
}

/** Library folders a removable file may live in. */
function libraryRoots(paths: LibraryPaths): string[] {
  const home = paths.home || os.homedir();
  const roots = [path.join(home, '.perplexicode'), path.join(home, '.claude')];
  if (paths.cwd) roots.push(path.join(paths.cwd, '.perplexicode'), path.join(paths.cwd, '.claude'));
  return roots.flatMap((root) => [path.join(root, 'agents'), path.join(root, 'skills')]);
}

/**
 * Deletes an installed subagent file or a skill folder. Only files inside the agents/skills
 * folders of the project or home directory can be removed (no arbitrary paths from the UI).
 */
export function removeLibraryItem(kind: 'agent' | 'skill', file: string, paths: LibraryPaths): string {
  const resolved = path.resolve(file);
  const roots = libraryRoots(paths);
  const root = roots.find((entry) => resolved.startsWith(entry + path.sep));
  if (!root) throw new Error('Refusing to delete a file outside the agents/skills folders.');
  if (kind === 'agent') {
    if (!resolved.endsWith('.md') || !root.endsWith(`${path.sep}agents`)) throw new Error('Not a subagent file.');
    fs.rmSync(resolved, { force: true });
    return resolved;
  }
  if (path.basename(resolved) !== 'SKILL.md' || !root.endsWith(`${path.sep}skills`)) throw new Error('Not a SKILL.md file.');
  const folder = path.dirname(resolved);
  if (path.dirname(folder) !== root) throw new Error('Unexpected skill folder layout.');
  fs.rmSync(folder, { recursive: true, force: true });
  return folder;
}

// ---------------------------------------------------------------------------------------------
// Task presets
// ---------------------------------------------------------------------------------------------

function sanitizePreset(raw: unknown, source: TaskPreset['source']): TaskPreset | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entry = raw as Record<string, unknown>;
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
  if (!title || !prompt.trim()) return undefined;
  const mode = typeof entry.mode === 'string' && MODES.some((item) => item.slug === entry.mode) ? entry.mode : 'code';
  const id = typeof entry.id === 'string' && entry.id.trim() ? normalizeName(entry.id) : normalizeName(title);
  const agent = typeof entry.agent === 'string' && entry.agent.trim() ? normalizeName(entry.agent) : undefined;
  return {
    id: id || `preset-${Date.now()}`,
    title: title.slice(0, 80),
    description: typeof entry.description === 'string' ? entry.description.slice(0, 200) : '',
    mode,
    prompt,
    agent,
    inputRequired: entry.inputRequired === true,
    icon: MODES.find((item) => item.slug === mode)?.icon,
    source,
  };
}

export function presetsFilePath(scope: LibraryScope, paths: LibraryPaths): string {
  return path.join(baseDir(scope, paths), 'presets.json');
}

function readPresetFile(file: string, source: TaskPreset['source']): TaskPreset[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.presets) ? parsed.presets : [];
    return list.map((item: unknown) => sanitizePreset(item, source)).filter((item: TaskPreset | undefined): item is TaskPreset => Boolean(item));
  } catch {
    return [];
  }
}

/**
 * Built-in + file presets + presets from the IDE setting. Later sources override earlier ones
 * with the same id (project > user setting > user file > built-in).
 */
export function loadTaskPresets(paths: LibraryPaths, settingPresets: unknown[] = []): TaskPreset[] {
  const merged = new Map<string, TaskPreset>();
  for (const preset of BUILTIN_TASK_PRESETS) merged.set(preset.id, preset);
  for (const preset of readPresetFile(presetsFilePath('user', paths), 'user')) merged.set(preset.id, preset);
  for (const raw of settingPresets) {
    const preset = sanitizePreset(raw, 'user');
    if (preset) merged.set(preset.id, preset);
  }
  if (paths.cwd) {
    for (const preset of readPresetFile(presetsFilePath('project', paths), 'project')) merged.set(preset.id, preset);
  }
  return [...merged.values()];
}

/** Writes a custom preset to a presets.json file (used by `pcode presets add` and the IDE "project" scope). */
export function savePresetToFile(raw: Omit<TaskPreset, 'source' | 'id'> & { id?: string }, scope: LibraryScope, paths: LibraryPaths): TaskPreset {
  const preset = sanitizePreset(raw, scope);
  if (!preset) throw new Error('A preset needs a title and a prompt.');
  const file = presetsFilePath(scope, paths);
  const existing = readPresetFile(file, scope).filter((entry) => entry.id !== preset.id);
  const { source: _source, icon: _icon, ...stored } = preset;
  void _source; void _icon;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify([...existing.map(({ source: _s, icon: _i, ...rest }) => rest), stored], null, 2)}\n`, 'utf8');
  return preset;
}

export function deletePresetFromFile(id: string, scope: LibraryScope, paths: LibraryPaths): boolean {
  const file = presetsFilePath(scope, paths);
  const existing = readPresetFile(file, scope);
  const next = existing.filter((entry) => entry.id !== id);
  if (next.length === existing.length) return false;
  fs.writeFileSync(file, `${JSON.stringify(next.map(({ source: _s, icon: _i, ...rest }) => rest), null, 2)}\n`, 'utf8');
  return true;
}

/** Fills `{{input}}`; when there is no input the placeholder (and a dangling separator) disappears. */
export function applyPresetPrompt(preset: Pick<TaskPreset, 'prompt'>, input: string): string {
  const text = input.trim();
  if (preset.prompt.includes('{{input}}')) {
    return preset.prompt.replace(/\{\{input\}\}/g, text).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
  }
  return text ? `${preset.prompt.trim()}\n\n${text}` : preset.prompt.trim();
}

// ---------------------------------------------------------------------------------------------
// Snapshot for UIs
// ---------------------------------------------------------------------------------------------

export interface LibrarySnapshot {
  workspace: string | null;
  agents: Array<Pick<SubagentDefinition, 'name' | 'description' | 'mode' | 'file' | 'scope'> & { tools: string[] | null; preset: boolean }>;
  skills: Array<Pick<SkillDefinition, 'name' | 'description' | 'file' | 'scope'> & { preset: boolean }>;
  agentPresets: Array<{ id: string; description: string; mode: string; tools: string[] | null; tags: string[]; installed: LibraryScope | null }>;
  skillPresets: Array<{ id: string; description: string; tags: string[]; installed: LibraryScope | null }>;
  taskPresets: Array<TaskPreset & { missing: { agents: string[]; skills: string[] } }>;
}

export function librarySnapshot(paths: LibraryPaths, settingPresets: unknown[] = []): LibrarySnapshot {
  const home = paths.home || os.homedir();
  const cwd = paths.cwd;
  const agents = cwd ? loadSubagents(cwd, home) : loadSubagents(path.join(home, '.perplexicode-no-workspace'), home);
  const skills = cwd ? loadSkills(cwd, home) : loadSkills(path.join(home, '.perplexicode-no-workspace'), home);
  const agentNames = new Map(agents.map((agent) => [agent.name, agent.scope]));
  const skillNames = new Map(skills.map((skill) => [skill.name, skill.scope]));
  const agentPresetIds = new Set(AGENT_PRESETS.map((entry) => entry.id));
  const skillPresetIds = new Set(SKILL_PRESETS.map((entry) => entry.id));
  return {
    workspace: cwd || null,
    agents: agents.map((agent) => ({ name: agent.name, description: agent.description, mode: agent.mode, file: agent.file, scope: agent.scope, tools: agent.tools || null, preset: agentPresetIds.has(agent.name) })),
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description, file: skill.file, scope: skill.scope, preset: skillPresetIds.has(skill.name) })),
    agentPresets: AGENT_PRESETS.map((preset) => ({ id: preset.id, description: preset.description, mode: preset.mode, tools: preset.tools || null, tags: preset.tags, installed: agentNames.get(preset.id) || null })),
    skillPresets: SKILL_PRESETS.map((preset) => ({ id: preset.id, description: preset.description, tags: preset.tags, installed: skillNames.get(preset.id) || null })),
    taskPresets: loadTaskPresets(paths, settingPresets).map((preset) => ({
      ...preset,
      missing: {
        agents: [...new Set([...(preset.requires?.agents || []), ...(preset.agent ? [preset.agent] : [])])].filter((name) => !agentNames.has(name)),
        skills: (preset.requires?.skills || []).filter((name) => !skillNames.has(name)),
      },
    })),
  };
}
