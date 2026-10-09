// The first-run machinery, as one bundle the Electron main process loads
// (scripts/bundle-first-run.mjs → dist/first-run.cjs). It is bundled rather than
// compiled with the rest of the shell because it uses packages that are ES
// modules (the relay, the wire), which the shell's CommonJS main process cannot
// `require`.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readSaved, writeSaved, type SavedConnection } from './connection.js';
import { launchPatch, type Launch, type SetupUi } from './launch.js';
import { freePort, startLocalServer } from './local-server.js';
import { bringUpLocal } from './setup-local.js';

export type { Launch, SetupUi };

export interface FirstRunEnv {
  /** Electron's `userData` directory. */
  userData: string;
  /** The user's home, for the host installer. */
  home: string;
  /** The app's `resources` directory, where the server release and host builds ride. */
  resources: string;
  /** The app's own Node: the executable that runs the server with `ELECTRON_RUN_AS_NODE`. */
  execPath: string;
  /** The relay a phone reaches this Mac's server through. */
  relayUrl: string;
  /** What servers call this app in their device lists. */
  label: string;
  ui: SetupUi;
  /** The shell's own host installer (`local-daemon.ts`). */
  installHost(
    origin: string,
    code: string,
  ): Promise<{ ok: boolean; exitCode: number | null; output: string }>;
  hostInstalled(): boolean;
}

const connectionFile = (userData: string): string => join(userData, 'connection.json');
const localHome = (userData: string): string => join(userData, 'server');
const localCredentialFile = (userData: string): string =>
  join(localHome(userData), 'desktop.credential');

async function post(
  origin: string,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; json: { credential?: string; nonce?: string; error?: string } }> {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as { credential?: string; nonce?: string; error?: string },
  };
}

export function launch(env: FirstRunEnv): Promise<Launch> {
  return launchPatch({
    file: connectionFile(env.userData),
    ui: env.ui,
    label: env.label,
    startLocal: (existing, progress) =>
      bringUpLocal(existing, {
        freePort,
        startServer: ({ port }) =>
          startLocalServer({
            releaseDir: join(env.resources, 'server'),
            home: localHome(env.userData),
            port,
            relayUrl: env.relayUrl,
            daemonArtifacts: join(env.resources, 'daemon'),
            node: { execPath: env.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
          }),
        call: post,
        hostInstalled: env.hostInstalled,
        installHost: env.installHost,
        save: (saved) => {
          mkdirSync(localHome(env.userData), { recursive: true });
          writeSaved(localCredentialFile(env.userData), saved);
          writeSaved(connectionFile(env.userData), saved);
        },
        recover: () =>
          existsSync(localCredentialFile(env.userData))
            ? readSaved(localCredentialFile(env.userData))
            : null,
        progress,
        label: env.label,
      }),
  });
}

/** Forget which server this app uses; the next launch asks again. Nothing on any server is touched. */
export function forgetConnection(userData: string): void {
  rmSync(connectionFile(userData), { force: true });
}

/** What is remembered, for the shell to know which feed and which services apply. */
export function remembered(userData: string): SavedConnection | null {
  return readSaved(connectionFile(userData));
}
