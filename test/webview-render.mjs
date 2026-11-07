// Renders the agent webview in headless Chromium with fixture state and saves screenshots.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const outDir = path.join(root, 'out', 'test');
mkdirSync(outDir, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(root, 'test', 'webview-fixture.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: path.join(outDir, 'fixture.cjs'), logLevel: 'warning' }),
  build({ entryPoints: { 'agent-webview': path.join(root, 'webview-ui', 'agent', 'main.ts') }, bundle: true, outdir: path.join(root, 'out'), format: 'iife', platform: 'browser', target: 'es2020', minify: true, logLevel: 'warning' }),
]);
console.log(execFileSync('node', [path.join(outDir, 'fixture.cjs')], { encoding: 'utf8' }).trim());
const fixture = JSON.parse(readFileSync(path.join(outDir, 'fixture.json'), 'utf8'));

const themeVars = `:root{--vscode-font-family:-apple-system,Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;--vscode-editorWidget-background:#202020;--vscode-panel-border:#2b2b2b;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-textLink-foreground:#4daafc;--vscode-menu-background:#1f1f1f;--vscode-editor-font-family:Menlo,monospace}`;
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${themeVars}</style><link rel="stylesheet" href="file://${root}/out/agent-webview.css"></head><body><div id="root"></div>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>undefined,setState:()=>undefined});</script>
<script src="file://${root}/out/agent-webview.js"></script></body></html>`;
writeFileSync(path.join(outDir, 'harness.html'), html);

const pwDir = path.join(os.homedir(), '.cache', 'ms-playwright');
const chromiumDir = readdirSync(pwDir).find((name) => /^chromium-\d+$/.test(name));
const executablePath = path.join(pwDir, chromiumDir, 'chrome-linux64', 'chrome');
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
await page.goto(`file://${path.join(outDir, 'harness.html')}`);
const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent('message', { data: d })), data);
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); };

await send(fixture.empty);
await shot('01-welcome');
await page.click('#model-btn');
await shot('02-model-menu');
await page.click('#more-models').catch(() => errors.push('no #more-models'));
await page.evaluate(() => { const m = document.querySelector('#model-menu'); if (m) m.scrollTop = 400; });
await shot('03-more-models');
await page.click('#mode-btn').catch(() => undefined);
await shot('04-mode-menu');
await page.evaluate(() => document.body.click());
await send(fixture.withTask);
await page.evaluate(() => { const m = document.querySelector('#messages'); if (m) m.scrollTop = 0; });
await shot('05-task-top');
await page.evaluate(() => { const m = document.querySelector('#messages'); if (m) m.scrollTop = m.scrollHeight; });
await shot('06-task-bottom');
await send({ type: 'view', view: 'history' });
await shot('07-history');
await send({ type: 'view', view: 'settings' });
await shot('08-settings');
const tabs = await page.$$('.settings-tabs .tab');
for (let i = 1; i < tabs.length; i += 1) {
  const current = await page.$$('.settings-tabs .tab');
  await current[i].click();
  await shot(`09-settings-tab-${i}`);
}
await send({ type: 'view', view: 'chat' });
await page.type('#input', 'Hello @');
await send({ type: 'mentionResults', query: '', results: [{ label: 'problems', value: '@problems', kind: 'special' }, { label: 'math.ts', value: '@/math.ts', kind: 'file' }] });
await shot('10-mention-popup');
// Pending edit approval with the diff expanded.
const pending = JSON.parse(JSON.stringify(fixture.withTask));
const editIndex = pending.task.messages.findIndex((m) => m.type === 'tool' && m.tool?.name === 'apply_diff');
pending.task.messages = pending.task.messages.slice(0, editIndex + 1);
const edit = pending.task.messages[editIndex];
edit.status = 'pending';
edit.ask = { kind: 'tool', resolved: false };
pending.task.status = { state: 'waiting', askId: edit.id, askKind: 'tool', requestCount: 3 };
pending.task.busy = true;
await send({ type: 'view', view: 'chat' });
await page.evaluate(() => { const input = document.querySelector('#input'); input.value = ''; input.dispatchEvent(new Event('input')); });
await send(pending);
await page.evaluate(() => { const m = document.querySelector('#messages'); if (m) m.scrollTop = m.scrollHeight; });
await shot('11-pending-edit');
// 3.1: presets, subagents, skills.
await send({ type: 'view', view: 'chat' });
await send(fixture.empty);
await page.evaluate(() => { const w = document.querySelector('#welcome'); if (w) w.scrollTop = 0; });
await shot('12-welcome-presets');
await page.click('#mode-btn');
await page.evaluate(() => { const m = document.querySelector('#mode-menu'); if (m) m.scrollTop = m.scrollHeight; });
await shot('13-mode-menu-subagents');
await page.evaluate(() => document.body.click());
await page.click('[data-preset="fix-bug"]');
await page.type('#input', 'go test fails on macOS: undefined: syscall.Statfs_t');
await shot('14-preset-selected');
const beforeRun = await page.evaluate(() => window.__posted.length);
await page.keyboard.press('Enter');
const runMsg = await page.evaluate((n) => window.__posted.slice(n), beforeRun);
if (!runMsg.some((m) => m.type === 'runPreset' && m.id === 'fix-bug' && /Statfs_t/.test(m.text))) errors.push(`runPreset not posted: ${JSON.stringify(runMsg)}`);
await send({ type: 'view', view: 'library' });
await shot('15-library-presets');
await page.click('[data-lib-tab="agents"]');
await shot('16-library-agents');
await page.evaluate(() => { const b = document.querySelector('#view-library .view-body'); if (b) b.scrollTop = b.scrollHeight; });
await shot('17-library-agents-catalog');
await page.click('[data-lib-tab="skills"]');
await shot('18-library-skills');
await page.click('[data-lib-tab="agents"]');
await page.click('[data-lib-form="agent"]');
await page.type('[data-form-field="name"]', 'swift-expert');
await page.type('[data-form-field="description"]', 'SwiftUI and Xcode builds. Use for iOS/macOS code.');
await page.type('[data-form-field="tools"]', 'Read, Grep, Edit, Bash(xcodebuild:*)');
await page.type('[data-form-field="body"]', 'You are a senior Swift engineer. Build with xcodebuild and fix warnings.');
// A state push while typing must not wipe the form.
await send(fixture.empty);
await shot('19-library-create-agent');
const formKept = await page.evaluate(() => document.querySelector('[data-form-field="name"]').value);
if (formKept !== 'swift-expert') errors.push(`form lost on state update: ${formKept}`);
const beforeCreate = await page.evaluate(() => window.__posted.length);
await page.click('[data-action="lib-submit-agent"]');
const created = await page.evaluate((n) => window.__posted.slice(n), beforeCreate);
if (!created.some((m) => m.type === 'createLibraryItem' && m.kind === 'agent' && m.name === 'swift-expert' && /xcodebuild/.test(m.tools))) errors.push(`createLibraryItem not posted: ${JSON.stringify(created)}`);
await page.click('[data-action="lib-cancel"]').catch(() => undefined);
const beforeInstall = await page.evaluate(() => window.__posted.length);
await page.click('[data-install="agent"][data-id="test-writer"][data-scope="project"]');
const install = await page.evaluate((n) => window.__posted.slice(n), beforeInstall);
if (!install.some((m) => m.type === 'installPreset' && m.id === 'test-writer' && m.scope === 'project')) errors.push(`installPreset not posted: ${JSON.stringify(install)}`);
// Task started as a subagent, with the todo list the model produced (no duplicates after the parser fix).
const agentTask = JSON.parse(JSON.stringify(fixture.withTask));
agentTask.task.agent = 'debugger';
agentTask.task.mode = 'debug';
agentTask.mode = 'debug';
await send({ type: 'view', view: 'chat' });
await send(agentTask);
await page.evaluate(() => { const m = document.querySelector('#messages'); if (m) m.scrollTop = 0; });
await shot('20-task-with-agent');
// MCP catalog component harness: no extension host, native prompt or live server is involved.
let checks = 0;
const check = (condition, description) => { checks += 1; if (!condition) errors.push(`MCP: ${description}`); };
const copy = (value) => JSON.parse(JSON.stringify(value));
const cards = () => page.$$eval('.mcp-catalog-card', (elements) => elements.map((element) => ({ id: element.dataset.catalogId, category: element.dataset.category })));
const clickPosted = async (selector) => {
  const start = await page.evaluate(() => window.__posted.length);
  await page.click(selector);
  return page.evaluate((n) => window.__posted.slice(n), start);
};
const clearSearch = async () => {
  await page.click('#library-search');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
};
const catalog = fixture.empty.mcp.catalog;
const installable = catalog.find((entry) => entry.installable && !entry.installed);
const installed = catalog.find((entry) => entry.installed);
const setupOnly = catalog.find((entry) => !entry.installable);
check(Boolean(installable && installed && setupOnly), 'real catalog fixture covers installable, installed and setup-only states');
await send(fixture.empty);
await send({ type: 'view', view: 'library' });
await page.click('[data-lib-tab="mcp"]');
await shot('21-mcp-catalog-sidebar');
check((await cards()).length === catalog.length, 'All category shows every real catalog entry');
check(await page.$eval('.mcp-catalog-notice', (element) => element.textContent.includes('Adds configuration only. Packages and security tools are not installed or run. Approval rules stay unchanged.')), 'configuration-only disclaimer visible');
check(await page.$eval('.mcp-catalog-connection-note', (element) => element.textContent === 'Enabled servers may connect on your next task and download/run the declared npm or uv package. Review requirements and documentation before connecting.'), 'next-task connection and package download/run disclosure visible');
check((await page.$$('.mcp-category-filters button')).length === 6, 'six category filters present');
check(Boolean(await page.$('.mcp-saved-heading')) && Boolean(await page.$('.mcp-catalog')), 'saved servers and catalog are separate');
check(await page.$eval(`[data-catalog-id="${installed.id}"]`, (element) => /Installed/.test(element.textContent) && !element.querySelector('[data-mcp-catalog-install]')), 'installed card cannot be reinstalled');
check(await page.$eval(`[data-catalog-id="${setupOnly.id}"]`, (element) => /Setup guide/.test(element.textContent) && !element.querySelector('[data-mcp-catalog-install]')), 'setup-only card has no install button');
for (const entry of catalog) {
  const rendered = await page.$eval(`[data-catalog-id="${entry.id}"]`, (element) => ({
    text: element.textContent, docs: element.querySelector('[data-url]')?.dataset.url,
    installButtons: element.querySelectorAll('[data-mcp-catalog-install]').length,
  }));
  check(rendered.text.includes(entry.description) && rendered.text.includes(entry.requirements.join(' · ')) && rendered.text.includes(entry.notes)
    && rendered.text.includes(`Docs checked ${entry.checkedAt}`) && rendered.docs === entry.docsUrl
    && rendered.installButtons === (entry.installable && !entry.installed ? 2 : 0), `${entry.id} card preserves all source metadata and correct installability`);
}
for (const category of ['development', 'web', 'productivity', 'security', 'pentest']) {
  await page.click(`[data-mcp-category="${category}"]`);
  const visible = await cards();
  check(visible.length === catalog.filter((entry) => entry.category === category).length && visible.every((entry) => entry.category === category), `${category} category filters catalog`);
  check(await page.$eval(`[data-mcp-category="${category}"]`, (element) => element.getAttribute('aria-pressed') === 'true'), `${category} category exposes selected state`);
  check((await page.$$('.mcp-card')).length === 1, `${category} category does not filter saved servers`);
}
await page.focus('[data-mcp-category="web"]');
await page.keyboard.press('Enter');
check(await page.$eval('[data-mcp-category="web"]', (element) => element.getAttribute('aria-pressed') === 'true' && document.activeElement === element), 'category selection is keyboard accessible and retains focus');
await page.click('[data-mcp-category="security"]');
await send({ ...copy(fixture.empty), mcp: { ...copy(fixture.empty.mcp), trusted: false } });
check(await page.$eval('[data-mcp-category="security"]', (element) => element.getAttribute('aria-pressed') === 'true'), 'category survives MCP-only state push');
await shot('22-mcp-security-sidebar');
const guideMessages = await clickPosted('[data-testid="mcp-parrot-guide"]');
check(guideMessages.some((message) => message.type === 'mcpParrotGuide'), 'Parrot OS guide posts native guide action');
await page.click('[data-mcp-category="all"]');
const docMessages = await clickPosted(`[data-testid="mcp-docs-${installable.id}"]`);
check(docMessages.some((message) => message.type === 'openUrl' && message.url === installable.docsUrl), 'Docs posts exact catalog URL');
for (const scope of ['project', 'user']) {
  const messages = await clickPosted(`[data-mcp-catalog-install="${installable.id}"][data-scope="${scope}"]`);
  check(messages.length === 1 && messages[0].type === 'mcpCatalogInstall' && messages[0].id === installable.id && messages[0].scope === scope && Object.keys(messages[0]).sort().join(',') === 'id,scope,type', `${scope} install posts only ID/scope and never connects`);
}
check((await page.$$('.mcp-catalog input,.mcp-catalog textarea')).length === 0, 'catalog never collects credentials in webview');
await page.type('#library-search', installable.id);
check((await cards()).some((entry) => entry.id === installable.id) && (await cards()).every((entry) => {
  const item = catalog.find((candidate) => candidate.id === entry.id);
  return [item.id, item.title, item.description, item.category, ...item.requirements, item.notes].some((text) => text.toLowerCase().includes(installable.id.toLowerCase()));
}), 'search filters real catalog data');
await page.click(`[data-mcp-category="${installable.category}"]`);
const updated = copy(fixture.empty);
updated.mcp.catalog.find((entry) => entry.id === installable.id).installed = true;
await send(updated);
check(await page.$eval(`[data-catalog-id="${installable.id}"]`, (element) => /Installed/.test(element.textContent) && !element.querySelector('[data-mcp-catalog-install]')), 'MCP-only installed update refreshes catalog');
check(await page.$eval('#library-search', (element) => element.value) === installable.id, 'search survives state push');
check(await page.$eval(`[data-mcp-category="${installable.category}"]`, (element) => element.getAttribute('aria-pressed') === 'true'), 'category and search survive installed update together');
await clearSearch();
await page.type('#library-search', 'zz-no-such-server-zz');
check((await cards()).length === 0 && await page.$eval('.mcp-catalog', (element) => /No catalog entries match/.test(element.textContent)), 'unmatched query shows empty state');
await clearSearch();
await page.click('[data-mcp-category="all"]');
await send(fixture.empty);
for (const [field, query] of [['title', installable.title.slice(0, 32)], ['requirements', installable.requirements[0].slice(0, 32)], ['notes', installable.notes.slice(0, 32)]]) {
  await page.type('#library-search', query);
  check((await cards()).some((entry) => entry.id === installable.id), `search matches ${field}`);
  await clearSearch();
}
// Saved-server actions and manual add form remain separate from catalog installs.
check((await clickPosted('[data-mcp-connect="filesystem"]')).some((message) => message.type === 'mcpConnect' && message.name === 'filesystem'), 'saved server connect preserved');
check((await clickPosted('[data-mcp-file]')).some((message) => message.type === 'openMcpFile' && message.file === fixture.empty.mcp.servers[0].sourceFile), 'saved server config action preserved');
check((await clickPosted('[data-mcp-remove="filesystem"]')).some((message) => message.type === 'mcpRemove' && message.scope === 'project'), 'saved server remove action preserved');
check((await clickPosted('[data-mcp-connect=""]')).some((message) => message.type === 'mcpConnect' && !message.name), 'Connect all preserved');
await page.click('[data-lib-form="mcp"]');
await page.type('[data-form-field="name"]', 'manual-server');
await page.type('[data-form-field="target"]', 'https://mcp.example.com/mcp');
check((await clickPosted('[data-action="lib-submit-mcp"]')).some((message) => message.type === 'mcpAdd' && message.name === 'manual-server' && message.target === 'https://mcp.example.com/mcp'), 'manual Add server preserved');
const noWorkspace = copy(fixture.empty);
noWorkspace.workspace = null;
noWorkspace.library.workspace = null;
await send(noWorkspace);
check(await page.$eval(`[data-mcp-catalog-install="${installable.id}"][data-scope="project"]`, (element) => element.disabled), 'project install disabled without workspace');
check((await clickPosted(`[data-mcp-catalog-install="${installable.id}"][data-scope="project"]`)).length === 0, 'disabled project install sends nothing');
check((await clickPosted(`[data-mcp-catalog-install="${installable.id}"][data-scope="user"]`)).some((message) => message.type === 'mcpCatalogInstall' && message.scope === 'user'), 'Global install works without workspace');
await send({ ...copy(fixture.empty), mcp: { ...copy(fixture.empty.mcp), enabled: false } });
check((await page.$$('.mcp-catalog-card')).length === 0 && await page.$eval('#view-library', (element) => /MCP is disabled/.test(element.textContent)), 'disabled MCP stays non-actionable');
await send(fixture.empty);
await page.waitForFunction(() => [...document.querySelectorAll('.toast')].every((element) => getComputedStyle(element).opacity === '0'));
const fit = async (label) => {
  const overflow = await page.evaluate(() => {
    const body = document.querySelector('#view-library .view-body');
    const tabs = document.querySelector('.lib-tabs');
    const bad = [...document.querySelectorAll('.mcp-catalog-card,.mcp-category-filters,.mcp-catalog-actions')].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.className);
    return { document: document.documentElement.scrollWidth > innerWidth, body: body.scrollWidth > body.clientWidth + 1, tabs: tabs.scrollWidth > tabs.clientWidth + 1, bad };
  });
  check(!overflow.document && !overflow.body && !overflow.tabs && !overflow.bad.length, `${label} no horizontal overflow: ${JSON.stringify(overflow)}`);
};
await fit('420px sidebar');
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await fit('desktop');
await shot('23-mcp-catalog-desktop');
await page.setViewport({ width: 375, height: 900, deviceScaleFactor: 2 });
await fit('375px');
await shot('24-mcp-catalog-375');
await page.click('[data-mcp-category="pentest"]');
await fit('375px pentest');
await shot('25-mcp-pentest-375');
await page.click('[data-mcp-category="productivity"]');
await page.$eval('.mcp-catalog-heading', (element) => element.scrollIntoView({ block: 'start' }));
await shot('26-mcp-installable-375');
await page.click('[data-mcp-category="pentest"]');
const longText = copy(fixture.empty);
longText.mcp.catalog.find((entry) => entry.category === 'pentest').notes += ' ' + 'long-runtime-requirement-'.repeat(15);
await send(longText);
await fit('375px long note');
await page.setViewport({ width: 1280, height: 480, deviceScaleFactor: 1 });
await fit('short desktop window');
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await send(fixture.empty);
await page.click('[data-mcp-category="all"]');
await fit('desktop after mobile');
await send({ type: 'view', view: 'chat' });
check(Boolean(await page.$('#welcome:not(.hidden)')), 'return to chat works after catalog interaction');
const posted = await page.evaluate(() => window.__posted.map((m) => m.type));
console.log('posted:', [...new Set(posted)].join(','));
console.log('tabs:', tabs.length);
console.log('MCP catalog checks:', checks, 'real entries:', catalog.length);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
writeFileSync(path.join(outDir, 'webview-qa-results.json'), JSON.stringify({
  scope: 'Chromium VS Code webview component harness with real MCP catalog fixture; not a live IDE or extension host',
  checks, catalogEntries: catalog.length, settingsTabs: tabs.length, errors,
  screenshots: readdirSync(outDir).filter((file) => /^\d\d-.*\.png$/.test(file)).sort(),
}, null, 2));
await browser.close();
if (errors.length) process.exitCode = 1;
