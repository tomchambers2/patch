// Where this desktop app's Patch lives, and the credential it holds there
// (spec/05 § Desktop first run). Written once the first run has worked and read
// at every launch after; its absence IS the first run.
//
//   local   this Mac runs the server (and a host) itself, on a loopback port
//   remote  a server of the user's own, reached at its address
//   relay   a server reached only through a relay, via a loopback bridge
//
// NO FALLBACK: a file that is there and wrong is an error that names it, not a
// quiet return to the first run — which would strand whatever the file pointed at.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { PairingRelay } from '@patch/wire';

export type Connection =
  | { mode: 'local'; port: number }
  | { mode: 'remote'; server: string }
  | { mode: 'relay'; relay: PairingRelay; port: number };

export interface SavedConnection {
  connection: Connection;
  /** The desktop surface's credential on that server; handed to the page in the URL fragment. */
  credential: string;
}

const validPort = (p: unknown): p is number =>
  Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536;
const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

function valid(c: unknown): c is Connection {
  const o = c as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null) return false;
  if (o['mode'] === 'local') return validPort(o['port']);
  if (o['mode'] === 'remote')
    return typeof o['server'] === 'string' && /^https?:\/\//.test(o['server']);
  if (o['mode'] === 'relay') {
    const r = o['relay'] as Record<string, unknown> | null;
    return (
      validPort(o['port']) &&
      typeof r === 'object' &&
      r !== null &&
      nonEmpty(r['url']) &&
      nonEmpty(r['channel']) &&
      nonEmpty(r['serverKey'])
    );
  }
  return false;
}

export function readSaved(file: string): SavedConnection | null {
  if (!existsSync(file)) return null;
  let parsed: { connection?: unknown; credential?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
  } catch (e) {
    throw new Error(
      `${file} is not readable (${(e as Error).message}). Delete it to set Patch up again.`,
    );
  }
  if (!valid(parsed.connection) || !nonEmpty(parsed.credential)) {
    throw new Error(`${file} does not describe a connection. Delete it to set Patch up again.`);
  }
  return { connection: parsed.connection, credential: parsed.credential };
}

export function writeSaved(file: string, saved: SavedConnection): void {
  writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** What the window talks to: this machine for a local or bridged server, else the server itself. */
export function originOf(c: Connection): string {
  return c.mode === 'remote' ? c.server.replace(/\/+$/, '') : `http://127.0.0.1:${c.port}`;
}

/** The page to load. The credential rides in the fragment: it never leaves the machine. */
export function appUrl(origin: string, credential: string): string {
  return `${origin}/app/#credential=${credential}`;
}
