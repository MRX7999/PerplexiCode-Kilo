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
await build({ entryPoints: [path.join(root, 'test', 'webview-fixture.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: path.join(outDir, 'fixture.cjs'), logLevel: 'warning' });
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
const shot = async (name) => { await new Promise((r) => setTimeout(r, 150)); await page.screenshot({ path: path.join(outDir, `${name}.png`) }); };

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
const posted = await page.evaluate(() => window.__posted.map((m) => m.type));
console.log('posted:', [...new Set(posted)].join(','));
console.log('tabs:', tabs.length);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
