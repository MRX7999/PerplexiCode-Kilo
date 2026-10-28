import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const outDir = path.join(process.cwd(), 'out', 'test');
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  logLevel: 'warning',
};

const suites = [
  {
    entry: 'agent.test.ts',
    outfile: 'agent.test.cjs',
    options: { external: ['vscode', 'puppeteer-core', 'sql.js'] },
  },
  {
    // settingsStore runs against a small `vscode` mock that rejects unregistered keys like the editor does.
    entry: 'settings.test.ts',
    outfile: 'settings.test.cjs',
    options: { alias: { vscode: path.join(process.cwd(), 'test', 'mocks', 'vscode-settings.ts') } },
  },
];

let failed = false;
for (const suite of suites) {
  const outfile = path.join(outDir, suite.outfile);
  await build({ ...common, ...suite.options, entryPoints: [path.join(process.cwd(), 'test', suite.entry)], outfile });
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`${suite.entry} failed with exit code ${result.status}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
