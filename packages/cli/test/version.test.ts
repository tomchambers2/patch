// What `patch --version` reports, from the place the program is actually
// running.
//
// The artifact ships the CLI as one bundled `bin/patch.js` with no package.json
// anywhere near it, and `readVersion` looked for nothing else — so on a freshly
// installed machine EVERY `patch` command died at startup with "@patch/cli:
// package.json version not found", before parsing a single argument. The
// patch-cli skill tells every chat on that machine to run `patch chats list`,
// so its very first instruction failed.
//
// The artifact does stamp itself: `build-info.json` sits at its root, beside the
// program directory, and is what the host reads for exactly this reason
// (spec/11 § Version reporting).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCliVersion } from '../src/version.js';

function withTmp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'patch-cli-version-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reads the artifact stamp when running from an installed artifact', () => {
  withTmp((root) => {
    // Artifact layout: build-info.json at the root, the program in bin/.
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(root, 'build-info.json'),
      JSON.stringify({ version: '0.1.404', gitSha: 'abc1234', builtAt: 'x', target: 'linux-x64' }),
    );
    assert.equal(resolveCliVersion(bin), '0.1.404');
  });
});

test('reads the workspace package.json when running from a checkout', () => {
  withTmp((root) => {
    const src = join(root, 'packages', 'cli', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(root, 'packages', 'cli', 'package.json'),
      JSON.stringify({ version: '9.9.9' }),
    );
    assert.equal(resolveCliVersion(src), '9.9.9');
  });
});

test('says what it looked for rather than dying with a bare message', () => {
  withTmp((root) => {
    // It still fails loudly — a CLI that invents a version is worse — but the
    // message has to name the places it looked.
    const nowhere = join(root, 'nowhere');
    mkdirSync(nowhere, { recursive: true });
    assert.throws(() => resolveCliVersion(nowhere), /build-info\.json/);
  });
});
