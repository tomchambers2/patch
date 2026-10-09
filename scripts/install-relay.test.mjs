import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relayUnit } from './install-relay.mjs';

test('the relay unit binds loopback on 8787 and restarts on failure', () => {
  const u = relayUnit({ home: '/h/.patch-relay', node: '/usr/bin/node' });
  assert.match(u, /Environment=PORT=8787 HOST=127\.0\.0\.1/);
  assert.match(u, /ExecStart=\/usr\/bin\/node \/h\/\.patch-relay\/current\/dist\/cli\.js/);
  assert.match(u, /Restart=on-failure/);
});

test('the installer defaults to the latest release the project publishes on GitHub', () => {
  const sh = readFileSync(
    new URL('../packages/server/release/install-server.sh', import.meta.url),
    'utf8',
  );
  assert.match(
    sh,
    /DEFAULT_RELEASE_URL="https:\/\/github\.com\/tomchambers2\/patch\/releases\/latest\/download\/patch-server\.tar\.gz"/,
  );
});
