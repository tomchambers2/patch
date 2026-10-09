// playwright-core in the host bundle (scripts/build-daemon.mjs).
//
// playwright-core finds its own package.json at `path.join(__dirname, '..')`,
// assuming it sits one folder inside its package. Flattened into daemon.mjs, that
// resolved to `.patch/versions/` and every browser tool died with
// MODULE_NOT_FOUND. This bundles a one-line entry that loads `playwright` the way
// the host does and runs it from a `versions/<v>/` layout.
//
// Run: node --test scripts/build-daemon-playwright.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, copyPlaywrightCore, esbuild } from './build-daemon.mjs';

const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'daemon');

test('a bundled host loads playwright from a versions/<v>/ install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-bundle-'));
  const entry = join(DAEMON, 'src', `.pw-bundle-probe-${process.pid}.ts`);
  try {
    const outDir = join(root, 'versions', '1.0.0');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      entry,
      "import { chromium } from 'playwright';\nprocess.stdout.write(`ok ${typeof chromium.launch}`);\n",
    );
    await bundle(await esbuild(), entry, join(outDir, 'daemon.mjs'));
    copyPlaywrightCore(outDir);
    const out = execFileSync(process.execPath, [join(outDir, 'daemon.mjs')], { encoding: 'utf8' });
    assert.equal(out, 'ok function');
  } finally {
    rmSync(entry, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
