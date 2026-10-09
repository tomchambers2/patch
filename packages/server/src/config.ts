// Server config (spec/01 § Starting with no settings). A server starts with
// NOTHING set: the port, the data directory and the voice-token secret all have
// a home of their own, and a secret the server needs it makes itself — into the
// data directory, next to `secrets.key`, the first time it starts. Anything that
// IS set is taken at its word: an explicit value that cannot be used (a data
// directory that does not exist, a token that is too short) stops the boot
// rather than being quietly replaced by a default.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  /**
   * HMAC secret for voice session tokens (spec/13). Surfaces present a minted
   * token to a host's audio WSS, which verifies it with the same secret — so
   * the server hands it to each host when the host is registered
   * (spec/10 § Host registration) and no one types it anywhere.
   */
  internalToken: string;
  /** Directory for the persistent registry.json. */
  dataDir: string;
  /**
   * A relay to be reachable through (`PATCH_RELAY_URL`, spec/10 § Relay). Unset
   * for a server with a public address of its own.
   */
  relayUrl?: string;
}

export interface LoadConfigOptions {
  /**
   * If `true`, an unset `PATCH_DATA_DIR` becomes a throwaway temporary directory
   * instead of the install home's `data/`. Strictly for tests.
   */
  allowEphemeralDataDir?: boolean;
}

/** Where the server keeps its state when nothing says otherwise. */
export function defaultServerHome(env: NodeJS.ProcessEnv = process.env): string {
  // `HOME` first: `os.homedir()` reads the process's own environment block,
  // which a change to `process.env` inside a worker thread does not reach.
  return env['PATCH_SERVER_HOME'] || join(env['HOME'] || homedir(), '.patch-server');
}

const TOKEN_FILE = 'internal.token';
const MIN_TOKEN_LENGTH = 16;

/**
 * The voice-token secret: `PATCH_INTERNAL_TOKEN` when set, else the one in the
 * data directory, made on the first start. `wx` so two servers starting on one
 * data directory cannot each write a different one.
 */
function internalTokenFor(dataDir: string): string {
  const fromEnv = process.env.PATCH_INTERNAL_TOKEN;
  if (fromEnv !== undefined) {
    if (fromEnv.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `PATCH_INTERNAL_TOKEN is set but only ${fromEnv.length} chars (need >=${MIN_TOKEN_LENGTH}). Refusing to start.`,
      );
    }
    return fromEnv;
  }
  const path = join(dataDir, TOKEN_FILE);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(24).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `${path} is not a token (${token.length} chars, need >=${MIN_TOKEN_LENGTH}). Delete it to have the server make a new one — every host must then be given it again.`,
    );
  }
  return token;
}

export function loadConfig(opts: LoadConfigOptions = {}): ServerConfig {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  const host = process.env.HOST ?? '0.0.0.0';

  const dataDirEnv = process.env.PATCH_DATA_DIR;
  let dataDir: string;
  if (dataDirEnv) {
    if (!existsSync(dataDirEnv)) {
      throw new Error(
        `PATCH_DATA_DIR=${dataDirEnv} does not exist (refusing to silently create a directory you named).`,
      );
    }
    if (!statSync(dataDirEnv).isDirectory()) {
      throw new Error(`PATCH_DATA_DIR=${dataDirEnv} is not a directory.`);
    }
    dataDir = dataDirEnv;
  } else if (opts.allowEphemeralDataDir) {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-server-data-'));
  } else {
    dataDir = join(defaultServerHome(), 'data');
    mkdirSync(dataDir, { recursive: true });
  }

  const relayUrl = process.env.PATCH_RELAY_URL;
  if (relayUrl !== undefined && !/^wss?:\/\//.test(relayUrl)) {
    throw new Error(`PATCH_RELAY_URL must be a ws:// or wss:// address, got ${relayUrl}`);
  }
  return {
    port,
    host,
    internalToken: internalTokenFor(dataDir),
    dataDir,
    ...(relayUrl ? { relayUrl } : {}),
  };
}
