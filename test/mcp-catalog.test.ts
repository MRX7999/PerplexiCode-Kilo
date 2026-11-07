import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMcpCatalogConfig, findMcpCatalogEntry, installMcpCatalogEntry, MCP_CATALOG } from '../src/core/mcpCatalog';
import { loadMcpServers } from '../src/core/mcp';

type TestCase = { name: string; run: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run });
const temporary: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcode-mcp-catalog-'));
  temporary.push(dir);
  return dir;
};
const workspace = () => ({ cwd: tmp(), home: tmp() });
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
const CLI = path.resolve(process.cwd(), 'out', 'cli.js');
const runCli = (args: string[], options: { cwd: string; home: string }, env: NodeJS.ProcessEnv = {}) => {
  assert.ok(fs.existsSync(CLI), 'out/cli.js missing; build the CLI first');
  const result = cp.spawnSync(process.execPath, [CLI, 'mcp', ...args], {
    cwd: options.cwd,
    env: { ...process.env, HOME: options.home, USERPROFILE: options.home, PERPLEXICODE_HOME: path.join(options.home, '.perplexicode'), NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
};

test('catalog: unique IDs, primary documentation, metadata and conservative security guides', () => {
  assert.strictEqual(MCP_CATALOG.length, 21);
  assert.strictEqual(new Set(MCP_CATALOG.map((entry) => entry.id)).size, MCP_CATALOG.length);
  for (const entry of MCP_CATALOG) {
    assert.match(entry.id, /^[a-z0-9_.-]+$/);
    assert.match(entry.docsUrl, /^https:\/\//);
    assert.match(entry.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.title && entry.description && entry.notes && entry.requirements.length);
    assert.strictEqual(new Set(entry.inputs.map((input) => input.key)).size, entry.inputs.length);
    if (entry.category === 'security' || entry.category === 'pentest') {
      assert.strictEqual(entry.config, undefined, 'native/security integrations remain setup-only');
    }
    if (entry.risk === 'active') assert.strictEqual(entry.category, 'pentest');
  }
});

test('catalog: find entries and reject unknown IDs without executing anything', () => {
  assert.strictEqual(findMcpCatalogEntry('filesystem')?.title, 'Filesystem');
  assert.strictEqual(findMcpCatalogEntry('not-a-server'), undefined);
  assert.throws(() => buildMcpCatalogConfig('not-a-server', {}, '/tmp'), /Unknown MCP catalog entry/);
});

test('catalog: reference server package names and uvx commands are exact', () => {
  assert.deepStrictEqual(buildMcpCatalogConfig('filesystem', {}, '/tmp/project').args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/project']);
  assert.deepStrictEqual(buildMcpCatalogConfig('memory', {}, '/tmp/project').args, ['-y', '@modelcontextprotocol/server-memory']);
  assert.deepStrictEqual(buildMcpCatalogConfig('sequential-thinking', {}, '/tmp/project').args, ['-y', '@modelcontextprotocol/server-sequential-thinking']);
  for (const id of ['fetch', 'git', 'time']) assert.strictEqual(buildMcpCatalogConfig(id, {}, '/tmp/project').command, 'uvx');
  assert.deepStrictEqual(buildMcpCatalogConfig('fetch', {}, '/tmp/project').args, ['mcp-server-fetch']);
  assert.deepStrictEqual(buildMcpCatalogConfig('git', {}, '/tmp/project').args, ['mcp-server-git', '--repository', '/tmp/project']);
  assert.deepStrictEqual(buildMcpCatalogConfig('time', {}, '/tmp/project').args, ['mcp-server-time']);
});

test('catalog: workspace defaults are absolute and explicit directory arguments stay single arguments', () => {
  const cwd = path.resolve('project with spaces');
  assert.deepStrictEqual(buildMcpCatalogConfig('filesystem', {}, 'project with spaces').args?.slice(-1), [cwd]);
  const supplied = '/tmp/allowed directory; not a shell command';
  assert.deepStrictEqual(buildMcpCatalogConfig('filesystem', { DIRECTORY: supplied }, cwd).args?.slice(-1), [supplied]);
  assert.strictEqual(buildMcpCatalogConfig('memory', {}, cwd).env?.MEMORY_FILE_PATH, `${cwd}/.perplexicode-memory.jsonl`);
  assert.strictEqual(buildMcpCatalogConfig('git', { REPOSITORY: supplied }, cwd).args?.[2], supplied);
});

test('catalog: required nonsecret values and invalid workspace arguments are rejected', () => {
  assert.throws(() => buildMcpCatalogConfig('filesystem', { DIRECTORY: '' }, '/tmp'), /Required MCP catalog input/);
  assert.throws(() => buildMcpCatalogConfig('memory', { MEMORY_FILE_PATH: '   ' }, '/tmp'), /Required MCP catalog input/);
  assert.throws(() => buildMcpCatalogConfig('time', {}, ''), /valid workspace directory/);
  assert.throws(() => buildMcpCatalogConfig('time', {}, '/tmp\0evil'), /valid workspace directory/);
});

test('catalog: unknown, nonstring, and template-injecting values are rejected', () => {
  assert.throws(() => buildMcpCatalogConfig('filesystem', { UNKNOWN: 'x' }, '/tmp'), /Unknown input/);
  assert.throws(() => buildMcpCatalogConfig('filesystem', { DIRECTORY: 123 as unknown as string }, '/tmp'), /must be a string/);
  assert.throws(() => buildMcpCatalogConfig('filesystem', { DIRECTORY: '${HOME}' }, '/tmp'), /literal text/);
  assert.throws(() => buildMcpCatalogConfig('filesystem', { DIRECTORY: '{input:REPOSITORY}' }, '/tmp'), /literal text/);
  assert.throws(() => buildMcpCatalogConfig('filesystem', { DIRECTORY: 'x\0y' }, '/tmp'), /literal text/);
  assert.throws(() => buildMcpCatalogConfig('time', null as unknown as Record<string, string>, '/tmp'), /key\/value object/);
});

test('catalog: prototype keys and inherited parameter maps are rejected', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const values = JSON.parse(`{"${key}":"not-allowed"}`) as Record<string, string>;
    assert.throws(() => buildMcpCatalogConfig('time', values, '/tmp'), /Unsafe MCP catalog input key/);
  }
  assert.throws(() => buildMcpCatalogConfig('filesystem', Object.create({ DIRECTORY: '/not-owned' }), '/tmp'), /plain key\/value object/);
  assert.deepStrictEqual(buildMcpCatalogConfig('time', Object.create(null), '/tmp').args, ['mcp-server-time']);
});

test('catalog: secret fields always emit named placeholders and never read process secrets', () => {
  const original = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'do-not-copy-process-secret';
  try {
    for (const entry of MCP_CATALOG.filter((candidate) => candidate.config)) {
      const config = buildMcpCatalogConfig(entry.id, {}, '/tmp');
      for (const input of entry.inputs.filter((candidate) => candidate.secret)) {
        assert.ok(JSON.stringify(config).includes('${' + input.key + '}'));
      }
      assert.ok(!JSON.stringify(config).includes('do-not-copy-process-secret'));
    }
  } finally {
    if (original === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = original;
  }
});

test('catalog: reject raw secrets without echoing them, accept only the exact placeholder', () => {
  for (const entry of MCP_CATALOG.filter((candidate) => candidate.config)) {
    for (const input of entry.inputs.filter((candidate) => candidate.secret)) {
      const raw = 'super-private-test-token';
      assert.throws(() => buildMcpCatalogConfig(entry.id, { [input.key]: raw }, '/tmp'), (error: Error) =>
        error.message.includes('Do not pass a raw secret') && !error.message.includes(raw));
      const values = { [input.key]: '${' + input.key + '}' };
      assert.deepStrictEqual(buildMcpCatalogConfig(entry.id, values, '/tmp'), buildMcpCatalogConfig(entry.id, {}, '/tmp'));
      assert.throws(() => buildMcpCatalogConfig(entry.id, { [input.key]: '${DIFFERENT_KEY}' }, '/tmp'), /Do not pass a raw secret/);
    }
  }
});

test('catalog: vendor endpoints use explicit supported bearer tokens, not archived packages', () => {
  const expected: Record<string, [string, string]> = {
    context7: ['https://mcp.context7.com/mcp', 'CONTEXT7_API_KEY'],
    github: ['https://api.githubcopilot.com/mcp/', 'GITHUB_PERSONAL_ACCESS_TOKEN'],
    notion: ['https://mcp.notion.com/mcp', 'NOTION_MCP_TOKEN'],
    linear: ['https://mcp.linear.app/mcp', 'LINEAR_API_KEY'],
  };
  for (const [id, [url, key]] of Object.entries(expected)) {
    assert.deepStrictEqual(buildMcpCatalogConfig(id, {}, '/tmp'), { type: 'http', url, headers: { Authorization: 'Bearer ${' + key + '}' } });
  }
  assert.match(findMcpCatalogEntry('notion')!.requirements.join(' '), /Business or Enterprise/);
  assert.strictEqual(buildMcpCatalogConfig('sentry', {}, '/tmp').env?.SENTRY_AUTH_TOKEN, '${SENTRY_AUTH_TOKEN}');
});

test('catalog: browser templates keep isolation and privacy safeguards without sandbox bypass', () => {
  const playwright = buildMcpCatalogConfig('playwright', {}, '/tmp');
  assert.deepStrictEqual(playwright.args, ['-y', '@playwright/mcp@latest', '--headless', '--isolated']);
  const chrome = buildMcpCatalogConfig('chrome-devtools', {}, '/tmp');
  assert.ok(chrome.args?.includes('--no-usage-statistics'));
  assert.ok(chrome.args?.includes('--no-performance-crux'));
  for (const entry of MCP_CATALOG.filter((candidate) => candidate.config)) {
    assert.ok(!JSON.stringify(entry.config).includes('--no-sandbox'));
    assert.ok(!JSON.stringify(entry.config).includes('sudo'));
  }
});

test('catalog: build results do not alias mutable catalog arrays, env, or headers', () => {
  const config = buildMcpCatalogConfig('filesystem', {}, '/tmp');
  config.args!.push('unexpected');
  assert.ok(!buildMcpCatalogConfig('filesystem', {}, '/tmp').args!.includes('unexpected'));
  const memory = buildMcpCatalogConfig('memory', {}, '/tmp');
  memory.env!.MEMORY_FILE_PATH = 'changed';
  assert.notStrictEqual(buildMcpCatalogConfig('memory', {}, '/tmp').env!.MEMORY_FILE_PATH, 'changed');
  const github = buildMcpCatalogConfig('github', {}, '/tmp');
  github.headers!.Authorization = 'changed';
  assert.notStrictEqual(buildMcpCatalogConfig('github', {}, '/tmp').headers!.Authorization, 'changed');
});

test('catalog: every setup-only entry fails with actionable primary documentation', () => {
  const options = workspace();
  for (const entry of MCP_CATALOG.filter((candidate) => !candidate.config)) {
    assert.throws(() => buildMcpCatalogConfig(entry.id, {}, options.cwd), (error: Error) =>
      error.message.includes('manual setup') && error.message.includes(entry.docsUrl));
    assert.throws(() => installMcpCatalogEntry(entry.id, 'project', options), /manual setup/);
  }
  assert.deepStrictEqual(fs.readdirSync(options.cwd), []);
  assert.deepStrictEqual(fs.readdirSync(options.home), []);
});

test('catalog install: project/user/local paths preserve settings and named servers', () => {
  for (const scope of ['project', 'user', 'local'] as const) {
    const options = workspace();
    const expected = scope === 'user' ? path.join(options.home, '.perplexicode', 'mcp.json')
      : scope === 'local' ? path.join(options.cwd, '.perplexicode', 'settings.local.json')
        : path.join(options.cwd, '.mcp.json');
    write(expected, { permissions: { allow: ['Read'] }, mcpServers: { untouched: { command: 'existing' } } });
    const file = installMcpCatalogEntry('filesystem', scope, options);
    assert.strictEqual(file, expected);
    const data = read(file);
    assert.deepStrictEqual(data.permissions, { allow: ['Read'] });
    assert.deepStrictEqual(data.mcpServers.untouched, { command: 'existing' });
    assert.strictEqual(data.mcpServers.filesystem.args[2], options.cwd);
  }
});

test('catalog install: round trip preserves placeholders at rest and loader resolves at runtime', () => {
  const options = workspace();
  const file = installMcpCatalogEntry('github', 'local', options);
  assert.strictEqual(read(file).mcpServers.github.headers.Authorization, 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}');
  const loaded = loadMcpServers(options.cwd, { home: options.home, env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'runtime-only' } });
  assert.strictEqual(loaded.find((server) => server.name === 'github')?.headers?.Authorization, 'Bearer runtime-only');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('runtime-only'));
});

test('catalog install: local settings command blocks are preserved, not treated as bare servers', () => {
  const options = workspace();
  const file = path.join(options.cwd, '.perplexicode', 'settings.local.json');
  const settings = { verify: { command: 'npm test' }, permissions: { allow: ['Read'] } };
  write(file, settings);
  assert.strictEqual(installMcpCatalogEntry('time', 'local', options), file);
  assert.deepStrictEqual(read(file).verify, settings.verify);
  assert.deepStrictEqual(read(file).permissions, settings.permissions);
  assert.deepStrictEqual(read(file).mcpServers.time, { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] });
});

test('catalog install: refuses duplicates in every configuration layer, including disabled ones', () => {
  const layers = [
    ['home', '.claude.json'], ['home', '.claude/.mcp.json'], ['home', '.claude/mcp.json'],
    ['home', '.perplexicode/mcp.json'], ['home', '.claude/settings.json'], ['home', '.perplexicode/settings.json'],
    ['cwd', '.mcp.json'], ['cwd', '.claude/.mcp.json'], ['cwd', '.claude/mcp.json'],
    ['cwd', '.perplexicode/mcp.json'], ['cwd', '.claude/settings.json'], ['cwd', '.perplexicode/settings.json'],
    ['cwd', '.mcp.local.json'], ['cwd', '.claude/settings.local.json'], ['cwd', '.perplexicode/settings.local.json'],
  ] as const;
  for (const [base, relative] of layers) {
    const options = workspace();
    const file = path.join(options[base], relative);
    write(file, { mcpServers: { time: { command: 'do-not-replace', disabled: true } } });
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => installMcpCatalogEntry('time', 'project', options), /already exists/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  }
});

test('catalog install: refuses project-scoped ~/.claude.json duplicate definitions', () => {
  const options = workspace();
  write(path.join(options.home, '.claude.json'), { projects: { [options.cwd]: { mcpServers: { time: { command: 'old' } } } } });
  assert.throws(() => installMcpCatalogEntry('time', 'user', options), /already exists/);
});

test('catalog install: malformed names/definitions and bare server maps cannot be overwritten', () => {
  const options = workspace();
  write(path.join(options.cwd, '.claude', 'settings.json'), { mcpServers: { ' time ': { description: 'invalid but user-owned' } } });
  assert.throws(() => installMcpCatalogEntry('time', 'user', options), /already exists/);
  const bare = workspace();
  write(path.join(bare.cwd, '.mcp.json'), { time: { command: '${UNSET_COMMAND}' } });
  assert.throws(() => installMcpCatalogEntry('time', 'local', bare), /already exists/);
});

test('catalog install: refuses invalid JSON or nonobject targets instead of destroying them', () => {
  for (const content of ['{invalid', '[]', 'null', '{"mcpServers":[]}']) {
    const options = workspace();
    const file = path.join(options.cwd, '.mcp.json');
    fs.writeFileSync(file, content);
    assert.throws(() => installMcpCatalogEntry('time', 'project', options), /Repair it first/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
  }
});

test('catalog install: refuses unrelated bare-map conversion that would hide existing servers', () => {
  const options = workspace();
  const file = path.join(options.cwd, '.mcp.json');
  write(file, { other: { command: 'keep-visible' } });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => installMcpCatalogEntry('time', 'project', options), /bare server map/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('catalog install: rejects invalid scope, unknown input and raw token before writing', () => {
  const options = workspace();
  assert.throws(() => installMcpCatalogEntry('time', 'cli' as 'project', options), /scope must be/);
  assert.throws(() => installMcpCatalogEntry('filesystem', 'project', { ...options, values: { TYPO: 'x' } }), /Unknown input/);
  assert.throws(() => installMcpCatalogEntry('github', 'project', { ...options, values: { GITHUB_PERSONAL_ACCESS_TOKEN: 'raw-token' } }), /raw secret/);
  assert.deepStrictEqual(fs.readdirSync(options.cwd), []);
  assert.deepStrictEqual(fs.readdirSync(options.home), []);
});

test('catalog install: config-only operation does not spawn commands or change trust/permissions', () => {
  const options = workspace();
  const childProcess = require('child_process') as typeof cp;
  const originalSpawn = childProcess.spawn;
  const originalExec = childProcess.exec;
  (childProcess as any).spawn = () => { throw new Error('catalog must not spawn'); };
  (childProcess as any).exec = () => { throw new Error('catalog must not execute'); };
  try {
    const file = installMcpCatalogEntry('playwright', 'project', options);
    assert.deepStrictEqual(Object.keys(read(file)), ['mcpServers']);
    assert.deepStrictEqual(fs.readdirSync(options.cwd), ['.mcp.json']);
    assert.deepStrictEqual(fs.readdirSync(options.home), []);
  } finally {
    (childProcess as any).spawn = originalSpawn;
    (childProcess as any).exec = originalExec;
  }
});

test('catalog CLI: category/query filtering shows setup guides without generating config', () => {
  const options = workspace();
  const pentest = runCli(['catalog', 'pentest'], options);
  assert.strictEqual(pentest.code, 0, pentest.output);
  for (const id of ['burp-suite-mcp', 'zap-mcp', 'nmap-mcp']) assert.ok(pentest.output.includes(`${id}\tpentest\tsetup-guide`));
  assert.ok(!pentest.output.includes('filesystem\tdevelopment'));
  const security = runCli(['catalog', 'security'], options);
  assert.strictEqual(security.code, 0, security.output);
  for (const id of ['semgrep-security', 'snyk-security', 'ghidra-mcp', 'virustotal-mcp', 'shodan-mcp']) {
    assert.ok(security.output.includes(`${id}\tsecurity\tsetup-guide`));
  }
  assert.ok(!security.output.includes('filesystem\tdevelopment'), 'security category must not match general security-warning prose');
  assert.ok(!security.output.includes('burp-suite-mcp\tpentest'), 'security and pentest are distinct exact categories');
  const query = runCli(['catalog', 'Ghidra'], options);
  assert.strictEqual(query.code, 0, query.output);
  assert.ok(query.output.includes('ghidra-mcp\tsecurity\tsetup-guide'));
  assert.ok(!query.output.includes('time\tproductivity'));
  assert.deepStrictEqual(fs.readdirSync(options.cwd), []);
});

test('catalog CLI: nonsecret --set writes one argument and duplicate install is nondestructive', () => {
  const options = workspace();
  const directory = path.join(options.cwd, 'allowed folder');
  const first = runCli(['install', 'filesystem', '--set', `DIRECTORY=${directory}`], options);
  assert.strictEqual(first.code, 0, first.output);
  assert.match(first.output, /No server started and permissions unchanged/);
  const file = path.join(options.cwd, '.mcp.json');
  assert.strictEqual(read(file).mcpServers.filesystem.args[2], directory);
  const before = fs.readFileSync(file, 'utf8');
  const second = runCli(['install', 'filesystem'], options);
  assert.strictEqual(second.code, 1, second.output);
  assert.match(second.output, /already exists/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(options.cwd), ['.mcp.json']);
});

test('catalog CLI: user and local installs honor isolated HOME without permission changes', () => {
  for (const scope of ['user', 'local']) {
    const options = workspace();
    const result = runCli(['install', 'time', '-s', scope], options);
    assert.strictEqual(result.code, 0, result.output);
    const target = scope === 'user' ? path.join(options.home, '.perplexicode', 'mcp.json')
      : path.join(options.cwd, '.perplexicode', 'settings.local.json');
    assert.deepStrictEqual(Object.keys(read(target)), ['mcpServers']);
    assert.deepStrictEqual(Object.keys(read(target).mcpServers), ['time']);
    assert.ok(!fs.existsSync(path.join(options.cwd, '.mcp.json')));
  }
});

test('catalog CLI: setup-only native security integration errors with docs and writes nothing', () => {
  const options = workspace();
  const result = runCli(['install', 'burp-suite-mcp'], options);
  assert.strictEqual(result.code, 1, result.output);
  assert.match(result.output, /manual setup/);
  assert.ok(result.output.includes(findMcpCatalogEntry('burp-suite-mcp')!.docsUrl));
  assert.deepStrictEqual(fs.readdirSync(options.cwd), []);
  assert.deepStrictEqual(fs.readdirSync(options.home), []);
});

test('catalog CLI: secret --set and --env values are rejected without being echoed or saved', () => {
  for (const flag of ['--set', '--env']) {
    const options = workspace();
    const raw = 'private-cli-test-token-do-not-echo';
    const result = runCli(['install', 'github', flag, `GITHUB_PERSONAL_ACCESS_TOKEN=${raw}`], options);
    assert.notStrictEqual(result.code, 0, result.output);
    assert.ok(!result.output.includes(raw));
    assert.deepStrictEqual(fs.readdirSync(options.cwd), []);
    assert.deepStrictEqual(fs.readdirSync(options.home), []);
  }
});

test('catalog CLI: environment secrets stay placeholders in saved HTTP configuration', () => {
  const options = workspace();
  const raw = 'runtime-token-must-not-persist';
  const result = runCli(['install', 'github'], options, { GITHUB_PERSONAL_ACCESS_TOKEN: raw });
  assert.strictEqual(result.code, 0, result.output);
  assert.ok(!result.output.includes(raw));
  const content = fs.readFileSync(path.join(options.cwd, '.mcp.json'), 'utf8');
  assert.ok(!content.includes(raw));
  assert.strictEqual(JSON.parse(content).mcpServers.github.headers.Authorization, 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}');
});

async function main(): Promise<void> {
  let failed = 0;
  try {
    for (const entry of tests) {
      try {
        await entry.run();
        console.log(`  ✓ ${entry.name}`);
      } catch (error) {
        failed++;
        console.error(`  ✗ ${entry.name}\n    ${(error as Error).stack}`);
      }
    }
  } finally {
    for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nmcp-catalog: ${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
