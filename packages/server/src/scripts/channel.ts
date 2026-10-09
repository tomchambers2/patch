// `patch-server channel [stable|dev|off]` — show or set which release channel this
// server follows. Takes effect at the next hourly check; no restart.
//
// Run through the launcher (`<home>/current/patch-server channel`), which sets
// the data directory.

import { join } from 'node:path';
import { defaultServerHome } from '../config.js';
import { readChannel, writeChannel, RELEASE_REPO } from '../release-channel.js';

const dataDir = process.env['PATCH_DATA_DIR'] ?? join(defaultServerHome(), 'data');
const wanted = process.argv[2];
try {
  if (wanted === undefined) {
    process.stdout.write(`${readChannel(dataDir)}  (releases from ${RELEASE_REPO})\n`);
  } else {
    process.stdout.write(`following ${writeChannel(dataDir, wanted)}\n`);
  }
} catch (err) {
  process.stderr.write(`patch-server channel: ${(err as Error).message}\n`);
  process.exit(1);
}
