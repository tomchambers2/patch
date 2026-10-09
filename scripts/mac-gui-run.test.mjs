import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'the GUI runner signs a real Mach-O without an SSH keychain password',
  {
    skip: process.platform !== 'darwin' || process.env.PATCH_REAL_SIGNING !== '1',
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-signing-test-'));
    const target = join(dir, 'probe');
    try {
      copyFileSync('/usr/bin/true', target);
      execFileSync(process.execPath, [
        fileURLToPath(new URL('./mac-gui-run.mjs', import.meta.url)),
        '/usr/bin/codesign',
        '--force',
        '--sign',
        'Patch Self-Signed Test',
        target,
      ]);
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', target]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  },
);
