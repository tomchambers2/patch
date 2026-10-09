// Provider keys a host holds (spec/02 § Provider keys).
//
// The paid services the HOST itself calls — hosted voice (Gemini Live, OpenAI
// Realtime) and Groq's Whisper — each need an API key on the host. They used to
// come only from the host's environment, so adding one meant editing a file
// and restarting the machine. Now each host also keeps its own store of them,
// shared by every host: Settings → Keys is one page for the whole account, and
// a set/revoke there reaches every host that is online right now, and a key
// set that way wins over the environment's.
//
// A key's VALUE never leaves a host except to another host over the same
// authenticated link, never to a surface. A surface sends one in a single
// write-only request (REST, stored on the server and sent to hosts in the settings snapshot),
// and everything that comes back — a host's `daemon.host.providerKeys` report
// and the request's response — carries only where each key comes from and its
// last four characters.

import { z } from 'zod';

/** The keys a host can use, by id. */
export const ProviderKeyId = z.enum(['gemini', 'openai', 'groq']);
export type ProviderKeyId = z.infer<typeof ProviderKeyId>;

export interface ProviderKeyInfo {
  id: ProviderKeyId;
  /** How the key is named on every screen. */
  label: string;
  /** The environment variable the host also reads it from. */
  envVar: string;
  /** What this host uses it for, in a few words. */
  usedFor: string;
}

/** Every provider key, in the order Settings lists them. */
export const PROVIDER_KEYS: readonly ProviderKeyInfo[] = [
  {
    id: 'gemini',
    label: 'Gemini',
    envVar: 'GEMINI_API_KEY',
    usedFor: 'Voice on the gemini backend',
  },
  {
    id: 'openai',
    label: 'OpenAI Realtime',
    envVar: 'OPENAI_REALTIME_API_KEY',
    usedFor: 'Voice on the openai backend',
  },
  {
    id: 'groq',
    label: 'Groq',
    envVar: 'GROQ_API_KEY',
    usedFor: 'Whisper transcription when WHISPER_BACKEND=groq',
  },
];

export function providerKeyInfo(id: ProviderKeyId): ProviderKeyInfo {
  const info = PROVIDER_KEYS.find((k) => k.id === id);
  /* v8 ignore next -- the enum and the table are the same three ids. */
  if (!info) throw new Error(`unknown provider key: ${id}`);
  return info;
}

/**
 * The shortest value a host will store. Real provider keys are dozens of
 * characters; the floor exists so that showing the last four can never show
 * most of a key.
 */
export const PROVIDER_KEY_MIN_LENGTH = 16;

/**
 * One key's state on one host. `source` is where the value the host USES
 * comes from: `ui` (set from Settings, stored on the host — wins over the
 * environment), `env` (the host's environment) or `none`. `last4` is the
 * last four characters of that value, absent when `none`. `envSet` says
 * whether the environment also carries one, so a surface can say what
 * revoking a UI-set key falls back to, and why an env-only key cannot be
 * revoked from here.
 */
export const HostProviderKey = z
  .object({
    id: ProviderKeyId,
    source: z.enum(['ui', 'env', 'none']),
    last4: z.string().min(1).max(4).optional(),
    envSet: z.boolean(),
  })
  .strict();
export type HostProviderKey = z.infer<typeof HostProviderKey>;

/** The status line Settings shows for one key row. One copy for web and mobile. */
export function providerKeyStatusText(key: HostProviderKey): string {
  const tail = key.last4 !== undefined ? ` · ends ${key.last4}` : '';
  if (key.source === 'ui') {
    return key.envSet ? `Set from UI${tail} (overrides environment)` : `Set from UI${tail}`;
  }
  if (key.source === 'env') return `Set from environment${tail}`;
  return 'Not set';
}

/**
 * Why a row has no Revoke: the only value is the environment's, which the
 * host did not store and cannot remove.
 */
export function providerKeyEnvOnlyNote(key: HostProviderKey): string | null {
  if (key.source !== 'env') return null;
  return `From ${providerKeyInfo(key.id).envVar} in this host's environment; can't be revoked here.`;
}
