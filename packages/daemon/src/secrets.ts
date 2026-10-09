// Host-owned secret store (spec/15 § Settings tab — Secrets).
//
// Secrets are a key-value store of tokens/credentials the host injects into
// chats, so the host — which owns the chat runtime — owns the store, exactly
// as it owns the folder registry. It is the single source of truth: the host
// publishes the set to the server (`secrets.list` on connect, `secrets.updated`
// on change), the server mirrors it (SecretsRegistry) and relays it to every
// surface. Writes arrive as surface-originated RPCs the server round-trips here
// (`patch.secrets.set_request` / `patch.secrets.delete_request`).
//
// Persisted to `<patchHome>/secrets.json` as a flat `{ key: value }` object,
// mode 0600, via a crash-durable atomic write (temp + fsync + rename), the same
// discipline as meta.ts. NO FALLBACK: a malformed file throws on load rather
// than silently starting from an empty store and dropping real credentials.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export interface SecretEntry {
  key: string;
  value: string;
}

/**
 * Secret keys are injected into chats as environment variables, so they must be
 * valid env-var identifiers: a letter/underscore followed by letters, digits or
 * underscores. This rejects whitespace, path separators and other characters
 * that could not round-trip through an env injection.
 */
export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

const SecretsFile = z.record(z.string().min(1), z.string());
type SecretsFile = z.infer<typeof SecretsFile>;

export class InvalidSecretKeyError extends Error {
  override readonly name = 'InvalidSecretKeyError';
  constructor(key: string) {
    super(`invalid secret key: ${JSON.stringify(key)}`);
  }
}

export class SecretsStore {
  private readonly path: string;
  private secrets: SecretsFile;

  constructor(path: string) {
    this.path = path;
    this.secrets = this.load();
  }

  private load(): SecretsFile {
    if (!existsSync(this.path)) return {};
    const raw = readFileSync(this.path, 'utf8');
    if (raw.trim().length === 0) return {};
    // NO FALLBACK — a corrupt/malformed secrets file is a hard error, not an
    // excuse to silently forget every credential.
    const parsed: unknown = JSON.parse(raw);
    return SecretsFile.parse(parsed);
  }

  /** Current secrets, sorted by key for a stable published order. */
  list(): SecretEntry[] {
    return Object.keys(this.secrets)
      .sort()
      .map((key) => ({ key, value: this.secrets[key]! }));
  }

  /** Upsert a key's value. Throws {@link InvalidSecretKeyError} for a bad key. */
  set(key: string, value: string): void {
    if (!isValidSecretKey(key)) throw new InvalidSecretKeyError(key);
    this.secrets[key] = value;
    this.persist();
  }

  /** Remove a key. Returns false if the key was not present. */
  delete(key: string): boolean {
    if (!(key in this.secrets)) return false;
    delete this.secrets[key];
    this.persist();
    return true;
  }

  /**
   * Crash-durable atomic write: temp file → fsync → rename, mode 0600. Mirrors
   * meta.ts / registry.ts. NO FALLBACK — any fs error propagates.
   */
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data = `${JSON.stringify(this.secrets, null, 2)}\n`;
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

export function secretsPath(patchHome: string): string {
  return join(patchHome, 'secrets.json');
}

export function createSecretsStore(patchHome: string): SecretsStore {
  return new SecretsStore(secretsPath(patchHome));
}
