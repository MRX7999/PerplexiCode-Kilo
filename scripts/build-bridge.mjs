// Packages the migration bridge (bridge/) into media/migration/perplexicode-migration-bridge.vsix.
// The main extension installs this VSIX to read accounts saved under the old ID perplexicode.perplexicode.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const bridgeDir = path.join(root, 'bridge');
const outDir = path.join(root, 'media', 'migration');
const outFile = path.join(outDir, 'perplexicode-migration-bridge.vsix');
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(root, 'media', 'icon.png'), path.join(bridgeDir, 'icon.png'));

const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const result = spawnSync(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--out', outFile], {
  cwd: bridgeDir,
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error('[bridge] vsce package failed');
  process.exit(result.status ?? 1);
}
console.log(`[bridge] ${path.relative(root, outFile)} (${statSync(outFile).size} bytes)`);
