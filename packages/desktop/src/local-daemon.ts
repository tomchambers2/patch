// The host on this Mac (spec/02 § Desktop app and the local host).
//
// The desktop app is a surface, but it is the one surface sitting on a machine
// that can also be a host, so it offers to make it one: it runs the same
// installer anyone runs from a shell, with the pairing code the SPA mints, and
// the host it leaves behind is an ordinary launchd service with its own
// lifetime. Nothing here talks to the host afterwards; once it is running it
// is a host like any other, and Settings → Hosts shows it from the server.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The launchd label the installer registers (`installer/service.ts`). */
export const DAEMON_SERVICE_LABEL = 'me.tomchambers.patch-daemon';

export interface LocalDaemonStatus {
  /** Whether a host service is installed for this user on this Mac. */
  installed: boolean;
  /** This Mac's host identity, once it has one — how the SPA finds its row. */
  daemonId: string | null;
}

export interface LocalDaemonInstallResult {
  ok: boolean;
  exitCode: number | null;
  /** What the installer printed, stdout and stderr interleaved as they came. */
  output: string;
}

export function localDaemonStatus(home: string): LocalDaemonStatus {
  const plist = join(home, 'Library', 'LaunchAgents', `${DAEMON_SERVICE_LABEL}.plist`);
  const identityFile = join(home, '.patch', 'daemon-identity.json');
  let daemonId: string | null = null;
  if (existsSync(identityFile)) {
    const parsed = JSON.parse(readFileSync(identityFile, 'utf8')) as { daemonId?: unknown };
    if (typeof parsed.daemonId === 'string') daemonId = parsed.daemonId;
  }
  return { installed: existsSync(plist), daemonId };
}

/** A pairing code is a base64url nonce; anything else never reaches a shell. */
export function isPairingCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(code);
}

/**
 * The server origin the installer should report to, from the URL the shell
 * loads its SPA from (`https://host/app/` → `https://host`).
 */
export function serverOrigin(spaUrl: string): string {
  return new URL(spaUrl).origin;
}

/**
 * Run the published installer for this Mac. The server URL and code travel as
 * environment, never spliced into the command, and the install script reads
 * both from there.
 */
export function installLocalDaemon(opts: {
  serverUrl: string;
  code: string;
  home: string;
  spawnImpl?: typeof spawn;
}): Promise<LocalDaemonInstallResult> {
  if (!isPairingCode(opts.code)) {
    return Promise.resolve({ ok: false, exitCode: null, output: 'not a pairing code' });
  }
  const run = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const child = run(
      '/bin/sh',
      ['-c', 'curl -fsSL "$PATCH_SERVER_URL/api/daemon/install.sh" | sh -s -- --non-interactive'],
      {
        env: {
          HOME: opts.home,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          PATCH_SERVER_URL: opts.serverUrl,
          PATCH_PAIRING_CODE: opts.code,
          // The installer reads the service's PATH from the user's own login
          // shell; without this it would have to assume which one that is.
          ...(process.env['SHELL'] ? { SHELL: process.env['SHELL'] } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => resolve({ ok: false, exitCode: null, output: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, exitCode: code, output }));
  });
}
