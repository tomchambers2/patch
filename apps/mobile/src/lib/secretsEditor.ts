// Pure logic for the mobile Secrets editor (spec/15 § Settings tab — Secrets).
// Kept RN-free so the validation + optimistic list-shaping is unit-testable in
// plain Node (vitest), mirroring jobEditor.ts.
//
// Secrets are editable from any surface: add a key, set/replace a value, delete.
// The write field is write-only in the UI (you type a new value; existing ones
// are masked behind Reveal), but the value itself is a plain string carried to
// the host-owned store via the REST client.
//
// NO FALLBACK: validation returns a specific, field-naming message rather than
// letting a malformed body hit the server. Key rules match the host's
// SECRET_KEY_RE so the client rejects a bad key before the round-trip.

export interface SecretEntry {
  key: string;
  value: string;
}

/** Env-var-style identifier — must match packages/daemon/src/secrets.ts. */
export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretValidation {
  ok: boolean;
  /** Field-naming message when `ok` is false; empty otherwise. */
  message: string;
}

/**
 * Validate a proposed key + value for a set/add. `existingKeys` is used to flag
 * an add that would collide with a key already present (an add is expected to
 * be new; editing an existing key goes through the same PUT but the UI knows it
 * is an update). Pass `isNew: false` to allow an existing key (an edit).
 */
export function validateSecret(
  key: string,
  value: string,
  opts: { existingKeys?: readonly string[]; isNew?: boolean } = {},
): SecretValidation {
  const trimmedKey = key.trim();
  if (trimmedKey.length === 0) {
    return { ok: false, message: 'Key is required.' };
  }
  if (!SECRET_KEY_RE.test(trimmedKey)) {
    return {
      ok: false,
      message:
        'Key must start with a letter or underscore and contain only letters, digits or underscores.',
    };
  }
  if (value.length === 0) {
    return { ok: false, message: 'Value is required.' };
  }
  const isNew = opts.isNew ?? true;
  if (isNew && (opts.existingKeys ?? []).includes(trimmedKey)) {
    return { ok: false, message: `A secret named ${trimmedKey} already exists.` };
  }
  return { ok: true, message: '' };
}

/**
 * Optimistically apply an upsert to a list (append new / replace existing),
 * keeping the list sorted by key — the same order the host publishes — so the
 * UI reconciles cleanly when the authoritative `secrets.updated` lands.
 */
export function upsertSecret(
  list: readonly SecretEntry[],
  key: string,
  value: string,
): SecretEntry[] {
  const next = list.filter((s) => s.key !== key);
  next.push({ key, value });
  next.sort((a, b) => a.key.localeCompare(b.key));
  return next;
}

/** Optimistically remove a key from a list. */
export function removeSecret(list: readonly SecretEntry[], key: string): SecretEntry[] {
  return list.filter((s) => s.key !== key);
}
