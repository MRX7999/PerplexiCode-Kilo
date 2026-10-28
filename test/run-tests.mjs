import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = path.join(process.cwd(), 'out', 'test');
const outfile = path.join(outDir, 'agent.test.cjs');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(process.cwd(), 'test', 'agent.test.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile,
  external: ['vscode', 'puppeteer-core', 'sql.js'],
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
