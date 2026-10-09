// Host-owned secret store (spec/15 § Settings tab — Secrets).
//
// The host owns the store; these tests exercise SecretsStore directly:
// list ordering, upsert semantics, delete, key validation, on-disk persistence
// (a fresh instance reading the same file sees prior writes) and the NO-FALLBACK
// malformed-file behaviour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretsStore,
  createSecretsStore,
  secretsPath,
  isValidSecretKey,
  InvalidSecretKeyError,
} from '../src/secrets.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-secrets-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('isValidSecretKey', () => {
  it('accepts env-var-style identifiers', () => {
    expect(isValidSecretKey('OPENAI_API_KEY')).toBe(true);
    expect(isValidSecretKey('_x')).toBe(true);
    expect(isValidSecretKey('token2')).toBe(true);
  });
  it('rejects empty, whitespace and path-like keys', () => {
    expect(isValidSecretKey('')).toBe(false);
    expect(isValidSecretKey('has space')).toBe(false);
    expect(isValidSecretKey('a/b')).toBe(false);
    expect(isValidSecretKey('2leading')).toBe(false);
  });
});

describe('SecretsStore', () => {
  it('starts empty when no file exists', () => {
    const store = createSecretsStore(home);
    expect(store.list()).toEqual([]);
  });

  it('sets, lists (sorted by key), and reads back values', () => {
    const store = createSecretsStore(home);
    store.set('ZED', 'z');
    store.set('ALPHA', 'a');
    expect(store.list()).toEqual([
      { key: 'ALPHA', value: 'a' },
      { key: 'ZED', value: 'z' },
    ]);
  });

  it('upserts an existing key in place', () => {
    const store = createSecretsStore(home);
    store.set('TOKEN', 'first');
    store.set('TOKEN', 'second');
    expect(store.list()).toEqual([{ key: 'TOKEN', value: 'second' }]);
  });

  it('rejects an invalid key on set', () => {
    const store = createSecretsStore(home);
    expect(() => store.set('bad key', 'x')).toThrow(InvalidSecretKeyError);
    expect(store.list()).toEqual([]);
  });

  it('deletes a key and reports whether it existed', () => {
    const store = createSecretsStore(home);
    store.set('TOKEN', 'v');
    expect(store.delete('TOKEN')).toBe(true);
    expect(store.delete('TOKEN')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('persists across instances (a write is durable on disk)', () => {
    const a = createSecretsStore(home);
    a.set('TOKEN', 'v');
    const b = createSecretsStore(home);
    expect(b.list()).toEqual([{ key: 'TOKEN', value: 'v' }]);
  });

  it('writes the file with 0600 permissions', () => {
    const store = createSecretsStore(home);
    store.set('TOKEN', 'v');
    const path = secretsPath(home);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('throws on a malformed secrets file (NO FALLBACK)', () => {
    writeFileSync(secretsPath(home), 'not json', 'utf8');
    expect(() => new SecretsStore(secretsPath(home))).toThrow();
  });

  it('treats a whitespace-only secrets file as empty (not a parse error)', () => {
    writeFileSync(secretsPath(home), '   \n\t  ', 'utf8');
    const store = new SecretsStore(secretsPath(home));
    expect(store.list()).toEqual([]);
  });
});
