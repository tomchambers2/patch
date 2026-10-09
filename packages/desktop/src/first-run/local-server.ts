// The server this Mac runs for itself (spec/05 § Desktop first run, "On this
// Mac"). The release the app carries is started exactly as the box's installer
// starts one — through its own launcher, against a home of its own — with the
// app's bundled Node, listening on loopback only. The page the window loads and
// the host on this Mac both talk to it there; a phone reaches it through the
// relay (`PATCH_RELAY_URL`).

import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface LocalServerOptions {
  /** The server release the app carries (`patch-server`, `server/`, `web/`, `build-info.json`). */
  releaseDir: string;
  /** Where this server keeps everything: `data/`, `downloads/`, `logs/`. */
  home: string;
  port: number;
  /** Lets a phone reach this server (`ws(s)://` address of a relay). */
  relayUrl?: string;
  /** Host builds to serve from `downloads/`, for the host on this Mac to install from. */
  daemonArtifacts?: string;
  /** The Node that runs it: in Electron, the app's own with `ELECTRON_RUN_AS_NODE`. */
  node: { execPath: string; env: Record<string, string> };
  startTimeoutMs?: number;
}

export interface LocalServer {
  origin: string;
  /** Stops the server this call started; one that was already running is left alone. */
  stop(): Promise<void>;
}

/** A port nothing is listening on, to keep for good once chosen. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function healthz(origin: string): Promise<{ gitSha?: string } | null> {
  try {
    const res = await fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as { gitSha?: string }) : null;
  } catch {
    return null;
  }
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/** Copy each file in `from` into `to` unless an identical-size copy is already there. */
function seed(from: string, to: string): void {
  if (!existsSync(from)) {
    throw new Error(
      `This build of Patch carries no host builds (${from} is missing), so it cannot set up a host on this Mac.`,
    );
  }
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true });
    else if (!existsSync(dest) || statSync(dest).size !== statSync(src).size)
      copyFileSync(src, dest);
  }
}

export async function startLocalServer(opts: LocalServerOptions): Promise<LocalServer> {
  const launcher = join(opts.releaseDir, 'patch-server');
  if (!existsSync(launcher))
    throw new Error(`There is no server release at ${opts.releaseDir} (no patch-server launcher).`);
  const origin = `http://127.0.0.1:${opts.port}`;
  const ourSha = (
    JSON.parse(readFileSync(join(opts.releaseDir, 'build-info.json'), 'utf8')) as { gitSha: string }
  ).gitSha;

  for (const d of ['data', 'downloads', 'logs']) mkdirSync(join(opts.home, d), { recursive: true });
  if (opts.daemonArtifacts) seed(opts.daemonArtifacts, join(opts.home, 'downloads'));

  const running = await healthz(origin);
  if (running !== null) {
    if (running.gitSha !== ourSha) {
      throw new Error(
        `Port ${opts.port} is already answering as a different Patch server (build ${running.gitSha}, this app carries ${ourSha}). Quit that one first.`,
      );
    }
    return { origin, stop: async () => undefined };
  }

  const logFile = join(opts.home, 'logs', 'server.log');
  const log = openSync(logFile, 'a');
  const child: ChildProcess = spawn('/bin/sh', [launcher], {
    stdio: ['ignore', log, log],
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? opts.home,
      ...opts.node.env,
      PATCH_SERVER_HOME: opts.home,
      PATCH_NODE: opts.node.execPath,
      PORT: String(opts.port),
      HOST: '127.0.0.1',
      ...(opts.relayUrl ? { PATCH_RELAY_URL: opts.relayUrl } : {}),
    },
  });
  let exited: number | null | undefined;
  child.once('exit', (code) => {
    exited = code;
  });
  child.once('error', (e) => {
    exited = -1;
    process.stderr.write(`[patch] could not start the server: ${e.message}\n`);
  });

  const stop = async (): Promise<void> => {
    if (exited !== undefined) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  };

  const deadline = Date.now() + (opts.startTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      throw new Error(
        `The server exited (${exited}) while starting. The end of ${logFile}:\n${tail(logFile)}`,
      );
    }
    if ((await healthz(origin)) !== null) return { origin, stop };
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop();
  throw new Error(
    `The server did not answer on ${origin} within ${(opts.startTimeoutMs ?? 30_000) / 1000}s. The end of ${logFile}:\n${tail(logFile)}`,
  );
}
