// `patch-server pair` — print a pairing code (a QR and its text) for a new
// device, and say when it stops working. The first run on a fresh server also
// makes the account (spec/11 § Pairing the first device).
//
//   patch-server pair [--url https://patch.example.com] [--json]
//
// Run through the launcher (`<home>/current/patch-server pair`), which loads
// server.env first, so PORT, PATCH_PUBLIC_URL and the data directory are the
// running server's own.

import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { defaultServerHome } from '../config.js';
import { pairNewSurface } from '../pair-admin.js';

function fail(message: string): never {
  process.stderr.write(`patch-server pair: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const urlFlag = args.indexOf('--url');
  const publicUrl =
    (urlFlag === -1 ? undefined : args[urlFlag + 1]) ??
    process.env['PATCH_PUBLIC_URL'] ??
    process.env['PATCH_SERVER_URL'];
  const port = process.env['PORT'] ?? '3000';
  const dataDir = process.env['PATCH_DATA_DIR'] ?? join(defaultServerHome(), 'data');

  const out = await pairNewSurface({
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    ...(publicUrl ? { publicUrl } : {}),
  }).catch((err: Error) => fail(err.message));

  if (json) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (out.createdAccount) process.stdout.write('Made this server’s account.\n\n');
  process.stdout.write('Scan this with Patch on the device you want to add:\n\n');
  await new Promise<void>((resolve) =>
    qrcode.generate(out.uri, { small: true }, (qr: string) => {
      process.stdout.write(`${qr}\n`);
      resolve();
    }),
  );
  const minutes = Math.max(1, Math.round((out.expiresAt - Date.now()) / 60_000));
  process.stdout.write(
    `${out.uri}\n\nGood for ${minutes} minutes, once. Run this again for another.\n`,
  );
}

void main();
