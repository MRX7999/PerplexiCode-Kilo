const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode', 'puppeteer-core', 'sql.js'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
};

/** @type {import('esbuild').BuildOptions} */
const cliConfig = {
  entryPoints: ['src/cli/main.ts'],
  bundle: true,
  outfile: 'out/cli.js',
  external: ['vscode', 'puppeteer-core', 'sql.js'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: { 'agent-webview': 'webview-ui/agent/main.ts' },
  bundle: true,
  outdir: 'out',
  loader: { '.svg': 'text' },
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: !isWatch,
};

async function build() {
  try {
    if (isWatch) {
      const extensionCtx = await esbuild.context(extensionConfig);
      const webviewCtx = await esbuild.context(webviewConfig);
      const cliCtx = await esbuild.context(cliConfig);
      await Promise.all([extensionCtx.watch(), webviewCtx.watch(), cliCtx.watch()]);
      console.log('[watch] Build started — watching for changes...');
    } else {
      await Promise.all([
        esbuild.build(extensionConfig),
        esbuild.build(webviewConfig),
        esbuild.build(cliConfig),
      ]);
      require('fs').chmodSync(path.join(__dirname, 'out', 'cli.js'), 0o755);
      console.log('[build] Extension, webview and CLI built successfully.');
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

build();
