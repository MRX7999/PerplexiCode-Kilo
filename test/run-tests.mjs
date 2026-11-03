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
  {
    // 3.0 headless core + CLI: real files, real sh hooks, mock OpenAI server, spawns out/cli.js.
    entry: 'core.test.ts',
    outfile: 'core.test.cjs',
    prebuild: true,
    options: { external: ['vscode', 'puppeteer-core', 'sql.js'] },
  },
];

const only = process.argv[2];
let failed = false;
for (const suite of suites) {
  if (only && !suite.entry.startsWith(only)) continue;
  if (suite.prebuild && !process.env.SKIP_PREBUILD) {
    // The CLI e2e tests spawn out/cli.js, so build it from the current sources first.
    const built = spawnSync(process.execPath, ['esbuild.js'], { stdio: 'inherit' });
    if (built.status !== 0) {
      console.error('esbuild.js failed');
      process.exit(1);
    }
  }
  const outfile = path.join(outDir, suite.outfile);
  await build({ ...common, ...suite.options, entryPoints: [path.join(process.cwd(), 'test', suite.entry)], outfile });
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`${suite.entry} failed with exit code ${result.status}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
