// CLI configuration loader.
//
// Reads ~/.patch/config.json (server URL, default folder, voice prefs) and
// allows env overrides via PATCH_SERVER_URL / PATCH_DAEMON_SOCKET /
// PATCH_DAEMON_LOCAL_KEY. NO FALLBACKS: a malformed config crashes loud.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PatchConfig {
  serverUrl: string;
  defaultFlags?: string[];
  defaultFolder?: string;
  voice?: { enabled?: boolean };
}

export interface ResolvedConfig {
  serverUrl: string;
  daemonSocket: string | null;
  daemonLocalKey: string | null;
  defaultFlags: string[];
  defaultFolder: string | null;
  configHome: string;
}

const DEFAULT_SERVER = 'http://localhost:3000';

export function configHomeDir(): string {
  const home = process.env.PATCH_HOME;
  const cfg = process.env.PATCH_CONFIG_DIR;
  if (home && home.length > 0 && cfg && cfg.length > 0 && home !== cfg) {
    throw new Error(
      'set only one of PATCH_HOME / PATCH_CONFIG_DIR (they are aliases; got different values)',
    );
  }
  const override = home ?? cfg;
  if (override && override.length > 0) return override;
  return join(homedir(), '.patch');
}

export function configFilePath(): string {
  return join(configHomeDir(), 'config.json');
}

export function identityFilePath(): string {
  return join(configHomeDir(), 'identity.key');
}

export function credentialFilePath(): string {
  return join(configHomeDir(), 'credential.jwt');
}

export function defaultDaemonSocketPath(): string {
  return join(configHomeDir(), 'daemon.sock');
}

/**
 * Where the running host keeps this run's local key — beside the socket,
 * under the host user's own `~/.patch` (spec/02 § Control IPC). The fixed
 * path is what makes it findable without a discovery step.
 */
export function defaultLocalKeyPath(): string {
  return join(configHomeDir(), 'local.key');
}

/** Load and resolve config, applying env overrides. */
export function loadConfig(): ResolvedConfig {
  let fileConfig: Partial<PatchConfig> = {};
  const path = configFilePath();
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    fileConfig = JSON.parse(raw) as Partial<PatchConfig>;
    if (typeof fileConfig !== 'object' || fileConfig === null) {
      throw new Error(`config: ${path} is not an object`);
    }
  }

  const serverUrl = process.env.PATCH_SERVER_URL ?? fileConfig.serverUrl ?? DEFAULT_SERVER;

  // Host socket auto-detection: env override > default path if it exists
  // and is reachable as a socket.
  const envSocket = process.env.PATCH_DAEMON_SOCKET;
  let daemonSocket: string | null = null;
  if (envSocket && envSocket.length > 0) {
    daemonSocket = envSocket;
  } else {
    const defaultPath = defaultDaemonSocketPath();
    if (existsSync(defaultPath)) {
      const st = statSync(defaultPath);
      if (st.isSocket()) daemonSocket = defaultPath;
    }
  }

  // The host mints the key and writes it beside the socket; a person running
  // the CLI on that machine READS IT FROM THAT FILE. The env var is honoured
  // first only because the host puts it in the environment of the children it
  // starts, which is the same value — it is not a way to configure the key,
  // and nothing but the host may set it (spec/02 § Control IPC).
  const envLocalKey = process.env.PATCH_DAEMON_LOCAL_KEY;
  let daemonLocalKey: string | null =
    envLocalKey !== undefined && envLocalKey.length > 0 ? envLocalKey : null;
  if (daemonLocalKey === null) {
    const keyPath = defaultLocalKeyPath();
    if (existsSync(keyPath)) {
      const value = readFileSync(keyPath, 'utf8').trim();
      // An empty file means a rotation is mid-flight or the host is gone.
      // Leaving it null makes the socket call fail with a clear 401 rather
      // than sending an empty bearer that reads as a bug elsewhere.
      daemonLocalKey = value.length > 0 ? value : null;
    }
  }

  return {
    serverUrl,
    daemonSocket,
    daemonLocalKey,
    defaultFlags: fileConfig.defaultFlags ?? [],
    defaultFolder: fileConfig.defaultFolder ?? null,
    configHome: configHomeDir(),
  };
}
