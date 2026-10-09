#!/usr/bin/env node
// Single-binary build for the patch CLI.
//
// Per spec/18 + group 15 task: chose `pkg`. Tries to invoke `pkg` against the
// already-built dist/index.js. If `pkg` is not installed the script fails
// loud (NO FALLBACK) so the operator knows to install it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const entry = resolve(pkgRoot, 'dist', 'index.js');
const outDir = resolve(pkgRoot, 'dist');
const out = resolve(outDir, 'patch');

if (!existsSync(entry)) {
  console.error(`[build-bin] missing ${entry} — run \`pnpm --filter @patch/cli build\` first`);
  process.exit(1);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const target = process.platform === 'darwin' ? 'node20-macos-arm64' : 'node20-linux-x64';
console.log(`[build-bin] target=${target} entry=${entry} out=${out}`);

try {
  execFileSync('npx', ['--yes', 'pkg', entry, '--target', target, '--output', out], {
    stdio: 'inherit',
  });
  console.log(`[build-bin] wrote ${out}`);
} catch (err) {
  console.error('[build-bin] failed:', err.message);
  process.exit(1);
}
