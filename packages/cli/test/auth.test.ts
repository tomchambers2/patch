// Identity / credential persistence tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureConfigDir,
  loadOrCreateIdentity,
  readIdentity,
  writeCredential,
  readCredential,
  MissingIdentityError,
  MissingCredentialError,
} from '../src/auth.js';
import { identityFilePath, credentialFilePath } from '../src/config.js';

function withTempPatchHome<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'patch-cli-auth-'));
  const prev = process.env.PATCH_HOME;
  process.env.PATCH_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PATCH_HOME;
    else process.env.PATCH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readIdentity: throws MissingIdentityError when absent', () => {
  withTempPatchHome(() => {
    ensureConfigDir();
    assert.throws(() => readIdentity(), MissingIdentityError);
  });
});

test('loadOrCreateIdentity: writes a fresh keypair and re-derives the same on next read', () => {
  withTempPatchHome(() => {
    const kp = loadOrCreateIdentity();
    assert.ok(kp.publicKey.length > 0);
    assert.ok(kp.privateKey.length > 0);
    assert.ok(existsSync(identityFilePath()));
    const kp2 = readIdentity();
    assert.equal(kp.publicKey, kp2.publicKey);
  });
});

test('readCredential: throws MissingCredentialError when absent', () => {
  withTempPatchHome(() => {
    ensureConfigDir();
    assert.throws(() => readCredential(), MissingCredentialError);
  });
});

test('writeCredential: persists and round-trips', () => {
  withTempPatchHome(() => {
    writeCredential('eyJ.fake.jwt');
    assert.ok(existsSync(credentialFilePath()));
    assert.equal(readCredential(), 'eyJ.fake.jwt');
  });
});
