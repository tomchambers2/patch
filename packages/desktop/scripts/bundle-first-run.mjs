// Bundle src/first-run into dist/first-run.cjs. The first-run code uses ES-module
// packages (@patch/relay, @patch/wire, @patch/auth) the CommonJS main process
// cannot require; esbuild folds them, and their dependencies, into one file.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src/first-run/index.ts')],
  outfile: join(root, 'dist/first-run.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // `ws` has optional native speed-ups it falls back from on its own.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
