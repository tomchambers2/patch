// A `host.json` written by a DIFFERENT version of this host (spec/02 § Host identity).
//
// This file is read in the HostStateStore constructor, before anything is
// listening and before the service is up. It used to be parsed `.strict()`, so
// retiring a field was enough to take a whole machine offline: every host on a
// host whose `host.json` still carried `lastUsedModel` threw
// `Unrecognized key(s) in object: 'lastUsedModel'` out of `main()` and
// crash-looped under systemd. A host that will not boot cannot be reached to
// be fixed, which is what makes this worse than ignoring the key.
//
// The strictness was there for a real reason — silently resetting the user's
// designated project roots is worse than failing loudly — and that case still
// throws. An unknown KEY and an invalid VALUE are different failures.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStateStore } from '../src/hostState.js';

let home: string;
const warnings: { keys?: unknown }[] = [];
const logger = {
  warn: (obj: { keys?: unknown }) => {
    warnings.push(obj);
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-hoststate-'));
  warnings.length = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const write = (obj: unknown): void => {
  writeFileSync(join(home, 'host.json'), JSON.stringify(obj), 'utf8');
};

describe('HostStateStore — a file from another version of the host', () => {
  it('boots past a RETIRED key instead of crash-looping on it', () => {
    // The exact file that took ubuntu-4gb-hel1-1 offline.
    write({ permissionModeDefault: 'bypassPermissions', lastUsedModel: 'claude-haiku-4-5' });
    const store = new HostStateStore(home, logger);
    expect(store.get().permissionModeDefault).toBe('bypassPermissions');
  });

  it('keeps every key it DOES know from that same file', () => {
    write({
      hostName: 'box',
      permissionModeDefault: 'auto',
      folderRoots: ['/srv/work'],
      lastUsedModel: 'claude-haiku-4-5',
    });
    const s = new HostStateStore(home, logger).get();
    expect(s.hostName).toBe('box');
    expect(s.permissionModeDefault).toBe('auto');
    expect(s.folderRoots).toEqual(['/srv/work']);
  });

  it('names the ignored key, so a setting that stopped applying leaves a trace', () => {
    write({ lastUsedModel: 'claude-haiku-4-5', somethingFromTheFuture: 1 });
    new HostStateStore(home, logger);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.keys).toEqual(['lastUsedModel', 'somethingFromTheFuture']);
  });

  it('does not carry an unknown key back into what it writes', () => {
    // Carried forward, it would be written back on the next update and outlive
    // every host that ever understood it.
    write({ permissionModeDefault: 'auto', lastUsedModel: 'claude-haiku-4-5' });
    const store = new HostStateStore(home, logger);
    store.update({ hostName: 'renamed' });
    const onDisk = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8'));
    expect(onDisk).not.toHaveProperty('lastUsedModel');
    expect(onDisk.hostName).toBe('renamed');
  });

  it('STILL throws on a key that is present with an invalid value', () => {
    // The case strictness actually existed for: this is a corrupt file, not an
    // old one, and quietly resetting it loses the user's project roots.
    write({ folderRoots: 'not-an-array' });
    expect(() => new HostStateStore(home, logger)).toThrow();
  });

  it('reads a file with no unknown keys without warning about anything', () => {
    write({ permissionModeDefault: 'auto', defaultModel: 'claude-opus-5' });
    const s = new HostStateStore(home, logger).get();
    expect(s.defaultModel).toBe('claude-opus-5');
    expect(warnings).toHaveLength(0);
  });
});
