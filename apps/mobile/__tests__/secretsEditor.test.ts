// spec/15 § Settings tab — Secrets. Pure editor logic: key/value validation
// (matching the host's SECRET_KEY_RE) and optimistic list shaping.

import { describe, it, expect } from 'vitest';
import {
  validateSecret,
  upsertSecret,
  removeSecret,
  SECRET_KEY_RE,
  type SecretEntry,
} from '../src/lib/secretsEditor';

describe('validateSecret', () => {
  it('accepts an env-var-style key with a value', () => {
    expect(validateSecret('OPENAI_API_KEY', 'sk-1')).toEqual({ ok: true, message: '' });
  });

  it('requires a key', () => {
    const r = validateSecret('   ', 'v');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/key is required/i);
  });

  it('requires a value', () => {
    const r = validateSecret('TOKEN', '');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/value is required/i);
  });

  it('rejects a malformed key', () => {
    expect(validateSecret('bad key', 'v').ok).toBe(false);
    expect(validateSecret('2leading', 'v').ok).toBe(false);
    expect(validateSecret('a/b', 'v').ok).toBe(false);
  });

  it('rejects an add that collides with an existing key', () => {
    const r = validateSecret('TOKEN', 'v', { existingKeys: ['TOKEN'], isNew: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already exists/i);
  });

  it('allows an edit of an existing key (isNew: false)', () => {
    const r = validateSecret('TOKEN', 'v2', { existingKeys: ['TOKEN'], isNew: false });
    expect(r.ok).toBe(true);
  });

  it('SECRET_KEY_RE matches the host rule', () => {
    expect(SECRET_KEY_RE.test('OPENAI_API_KEY')).toBe(true);
    expect(SECRET_KEY_RE.test('has space')).toBe(false);
  });
});

describe('upsertSecret', () => {
  const base: SecretEntry[] = [
    { key: 'ALPHA', value: 'a' },
    { key: 'ZED', value: 'z' },
  ];

  it('appends a new key, keeping sorted order', () => {
    expect(upsertSecret(base, 'MID', 'm')).toEqual([
      { key: 'ALPHA', value: 'a' },
      { key: 'MID', value: 'm' },
      { key: 'ZED', value: 'z' },
    ]);
  });

  it('replaces an existing key in place', () => {
    expect(upsertSecret(base, 'ALPHA', 'a2')).toEqual([
      { key: 'ALPHA', value: 'a2' },
      { key: 'ZED', value: 'z' },
    ]);
  });

  it('does not mutate the input', () => {
    upsertSecret(base, 'MID', 'm');
    expect(base).toHaveLength(2);
  });
});

describe('removeSecret', () => {
  it('drops the matching key', () => {
    const list: SecretEntry[] = [
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ];
    expect(removeSecret(list, 'A')).toEqual([{ key: 'B', value: '2' }]);
  });

  it('is a no-op for an absent key', () => {
    const list: SecretEntry[] = [{ key: 'A', value: '1' }];
    expect(removeSecret(list, 'X')).toEqual([{ key: 'A', value: '1' }]);
  });
});
