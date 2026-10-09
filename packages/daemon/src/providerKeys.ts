// The provider keys this host uses (spec/02 § Provider keys).
//
// Each paid service the host itself calls — Gemini and OpenAI Realtime for
// hosted voice, Groq for Whisper — needs an API key on this host. A key has
// two possible sources:
//
//   ui  — set from Settings → Hosts → Keys, stored HERE, in
//         `<patchHome>/keys.json` (mode 0600). Never on the server.
//   env — the host's environment (`GEMINI_API_KEY`, `OPENAI_REALTIME_API_KEY`,
//         `GROQ_API_KEY`), read once at boot.
//
// A UI-set key wins over the environment. Everything that uses a key reads it
// through `get()` at the moment it opens a session or sends a request, so a
// set or a revoke takes effect for the next session without a restart.
//
// A value never leaves this module except to the provider it belongs to:
// `describe()` reports only where each key comes from and its last four
// characters. Crash-durable atomic write (temp + fsync + rename) as
// secrets.ts. NO FALLBACK: a malformed file throws on load rather than
// silently starting empty and running on a different key than the one chosen.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  PROVIDER_KEYS,
  PROVIDER_KEY_MIN_LENGTH,
  providerKeyInfo,
  type HostProviderKey,
  type ProviderKeyId,
} from '@patch/wire';

const KeysFile = z
  .object({
    version: z.literal(1),
    keys: z
      .object({
        gemini: z.string().min(1).optional(),
        openai: z.string().min(1).optional(),
        groq: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
type KeysFile = z.infer<typeof KeysFile>;

export type ProviderKeyErrorCode = 'invalid_value' | 'env_only' | 'not_set' | 'required';

export class ProviderKeyError extends Error {
  override readonly name = 'ProviderKeyError';
  constructor(
    readonly code: ProviderKeyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The environment's value for each key, read once at boot. */
export type EnvProviderKeys = Partial<Record<ProviderKeyId, string | undefined>>;

export function providerKeysPath(patchHome: string): string {
  return join(patchHome, 'keys.json');
}

/** Why a value is not one this host will store, or null when it is. */
export function invalidProviderKeyValue(value: string): string | null {
  if (value.length === 0) return 'A key is required.';
  if (/\s/.test(value)) return 'A key cannot contain spaces or line breaks.';
  if (value.length < PROVIDER_KEY_MIN_LENGTH) {
    return `That is too short to be an API key (at least ${PROVIDER_KEY_MIN_LENGTH} characters).`;
  }
  return null;
}

export class ProviderKeyStore {
  private readonly path: string;
  private readonly env: EnvProviderKeys;
  private stored: KeysFile['keys'];
  private readonly listeners = new Set<() => void>();

  private readonly requiredToStart: Partial<Record<ProviderKeyId, string>>;

  /**
   * `requiredToStart` names each key this host cannot boot without, with the
   * reason (the host aborts at startup when it is missing — Groq under
   * WHISPER_BACKEND=groq). Revoking the last value of such a key is refused:
   * the host would not come back up to be given a new one.
   */
  constructor(opts: {
    path: string;
    env: EnvProviderKeys;
    requiredToStart?: Partial<Record<ProviderKeyId, string>>;
  }) {
    this.path = opts.path;
    this.env = { ...opts.env };
    this.requiredToStart = opts.requiredToStart ?? {};
    this.stored = this.load();
  }

  private load(): KeysFile['keys'] {
    if (!existsSync(this.path)) return {};
    // A file someone widened is narrowed back before it is read: the values in
    // it are live credentials.
    if ((statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600);
    const raw = readFileSync(this.path, 'utf8');
    try {
      return KeysFile.parse(JSON.parse(raw)).keys;
    } catch (err) {
      throw new Error(
        `${this.path} is not a valid provider-key file (${(err as Error).message.split('\n')[0]}). ` +
          'Fix or remove it; the host will not guess which keys it held.',
      );
    }
  }

  /** The value in use for `id`: the UI-set one, else the environment's. */
  get(id: ProviderKeyId): string | undefined {
    return this.stored[id] ?? this.env[id];
  }

  has(id: ProviderKeyId): boolean {
    return this.get(id) !== undefined;
  }

  /** Every key's status, in Settings order. Never a value. */
  describe(): HostProviderKey[] {
    return PROVIDER_KEYS.map(({ id }) => {
      const ui = this.stored[id];
      const env = this.env[id];
      const value = ui ?? env;
      return {
        id,
        source: ui !== undefined ? 'ui' : env !== undefined ? 'env' : 'none',
        ...(value !== undefined ? { last4: value.slice(-4) } : {}),
        envSet: env !== undefined,
      } satisfies HostProviderKey;
    });
  }

  /** Store (or replace) the UI-set value for `id`. */
  set(id: ProviderKeyId, rawValue: string): void {
    const value = rawValue.trim();
    const problem = invalidProviderKeyValue(value);
    if (problem !== null) throw new ProviderKeyError('invalid_value', problem);
    this.persist({ ...this.stored, [id]: value });
  }

  /** Delete the UI-set value for `id`. The environment's, if any, applies again. */
  revoke(id: ProviderKeyId): void {
    if (this.stored[id] === undefined) {
      const { label, envVar } = providerKeyInfo(id);
      if (this.env[id] !== undefined) {
        throw new ProviderKeyError(
          'env_only',
          `${label} comes from this host's environment (${envVar}); it can't be revoked from here. Remove it from the host's environment and restart it.`,
        );
      }
      throw new ProviderKeyError('not_set', `${label} is not set on this host.`);
    }
    const reason = this.requiredToStart[id];
    if (reason !== undefined && this.env[id] === undefined) {
      const { label } = providerKeyInfo(id);
      throw new ProviderKeyError(
        'required',
        `${reason}, and this is its only ${label} key: without it the host would not start. Replace it instead.`,
      );
    }
    const next = { ...this.stored };
    delete next[id];
    this.persist(next);
  }

  /** Called after every change, so the host report and boot-time checks re-run. */
  /**
   * Replace every Settings-set key with the shared ones from a snapshot
   * (spec/01 § Settings). Refuses — and changes nothing — when the snapshot
   * drops the one key this host needs to start, with none in its environment:
   * the host would not come back up to be given another.
   */
  replaceAll(next: Partial<Record<ProviderKeyId, string>>): void {
    for (const [id, reason] of Object.entries(this.requiredToStart) as [ProviderKeyId, string][]) {
      if (next[id] === undefined && this.env[id] === undefined) {
        const { label } = providerKeyInfo(id);
        throw new ProviderKeyError(
          'required',
          `${reason}, and the shared settings have no ${label} key: without it the host would not start`,
        );
      }
    }
    const same =
      Object.keys(next).length === Object.keys(this.stored).length &&
      (Object.keys(next) as ProviderKeyId[]).every((id) => this.stored[id] === next[id]);
    if (!same) this.persist({ ...next });
  }

  /** The keys set from Settings, for this host's one import into the server. */
  settingsKeys(): Partial<Record<ProviderKeyId, string>> {
    return { ...this.stored };
  }

  /** The key in the host's own environment, for adopting it as the shared one. */
  envValue(id: ProviderKeyId): string | undefined {
    return this.env[id];
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist(next: KeysFile['keys']): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data = `${JSON.stringify({ version: 1, keys: next } satisfies KeysFile, null, 2)}\n`;
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // Only once the file holds it does the host use it: a write that failed
    // must not leave a key in use that the next boot would not have.
    this.stored = next;
    for (const fn of this.listeners) fn();
  }
}

/**
 * Answer one `patch.host_keys.request` (spec/03 § Provider keys). The answer
 * names every key's status after the change — never a value — and the fresh
 * `daemon.host` the store's change listener publishes is what every other
 * surface sees. Logs the key id and the op, never the value.
 */
