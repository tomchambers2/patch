// esbuild entry for the artifact's `install.mjs`. Nothing but the process
// boundary lives here: exit code out, everything else in main.ts.

import { installerMain } from './main.js';

installerMain().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`patch install: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 70;
  },
);
