// A provider key as a voice engine receives it: either a fixed value (tests,
// in-process smoke runs) or a function that returns the host's CURRENT key
// (the host — providerKeys.ts). Engines resolve it at the moment they open a
// session or send a request, never at construction, so a key set or revoked
// from Settings → Hosts → Keys applies to the next session without a restart.

export type KeySource = string | (() => string | undefined) | undefined;

/** The key in force right now, or undefined when there is none. Empty = none. */
export function readKey(source: KeySource): string | undefined {
  const v = typeof source === 'function' ? source() : source;
  return v === undefined || v.length === 0 ? undefined : v;
}
