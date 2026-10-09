// One-time: bring the standalone Pad service's designs into Patch's Pads.
//
//   pnpm --filter @patch/server exec tsx src/scripts/import-standalone-pads.ts \
//     --from ~/.pad --pads-dir ~/.patch-server/data/pads
//
// Safe to re-run: a design already in Patch is skipped. Exits non-zero if any
// design could not be imported, naming why.

import { importStandalone } from '../pads/import-standalone.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    process.stderr.write(`import-standalone-pads: --${name} <path> is required\n`);
    process.exit(1);
  }
  return v;
}

const result = importStandalone({ from: arg('from'), padsDir: arg('pads-dir') });
for (const slug of result.imported) process.stdout.write(`imported ${slug}\n`);
for (const s of result.skipped) process.stdout.write(`skipped  ${s.slug}: ${s.reason}\n`);
for (const f of result.failed) process.stderr.write(`FAILED   ${f.slug}: ${f.reason}\n`);
process.exit(result.failed.length ? 1 : 0);
