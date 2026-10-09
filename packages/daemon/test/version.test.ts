// Version + git SHA surfaced by the host's /healthz (spec: NO FALLBACKS in
// production; dev affordance to derive from package.json + `git rev-parse`).
//
// `VERSION`/`GIT_SHA` are resolved ONCE at module-eval time from `process.env`,
// so each scenario here resets the module registry and re-imports fresh with a
// different env (and, where the dev fallback itself needs to fail, a mocked
// `node:fs`/`node:child_process`).

import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function importFresh(): Promise<typeof import('../src/version.js')> {
  vi.resetModules();
  return import('../src/version.js');
}

describe('version', () => {
  afterEach(() => {
    resetEnv();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('uses PATCH_VERSION / PATCH_GIT_SHA straight from env when set', async () => {
    delete process.env.NODE_ENV;
    process.env.PATCH_VERSION = '9.9.9';
    process.env.PATCH_GIT_SHA = 'abc1234';
    const mod = await importFresh();
    expect(mod.VERSION).toBe('9.9.9');
    expect(mod.GIT_SHA).toBe('abc1234');
  });

  it('throws in production when PATCH_VERSION is unset (NO FALLBACK)', async () => {
    delete process.env.PATCH_VERSION;
    process.env.PATCH_GIT_SHA = 'abc1234';
    process.env.NODE_ENV = 'production';
    await expect(importFresh()).rejects.toThrow(/PATCH_VERSION must be set in production/);
  });

  it('throws in production when PATCH_GIT_SHA is unset (NO FALLBACK)', async () => {
    process.env.PATCH_VERSION = '1.0.0';
    delete process.env.PATCH_GIT_SHA;
    process.env.NODE_ENV = 'production';
    await expect(importFresh()).rejects.toThrow(/PATCH_GIT_SHA must be set in production/);
  });

  it('falls back to reading package.json + `git rev-parse` in dev when env is unset', async () => {
    delete process.env.PATCH_VERSION;
    delete process.env.PATCH_GIT_SHA;
    delete process.env.NODE_ENV;
    const mod = await importFresh();
    // The real @patch/daemon package.json version (whatever it currently is).
    expect(typeof mod.VERSION).toBe('string');
    expect(mod.VERSION.length).toBeGreaterThan(0);
    // A real short git SHA from this checkout.
    expect(mod.GIT_SHA).toMatch(/^[0-9a-f]{4,40}$/);
  });

  // Dev now derives the version from the MONOREPO's single source of truth
  // (scripts/version.mjs), not packages/daemon/package.json — that file's version is
  // a permanent `0.0.0` placeholder, so reading it made the host report 0.0.0
  // alongside layers reporting a real version, leaving the update panel unable to
  // compare them (spec/11 § Version reporting).
  it('derives the version from scripts/version.mjs in dev', async () => {
    delete process.env.PATCH_VERSION;
    process.env.PATCH_GIT_SHA = 'abc1234';
    delete process.env.NODE_ENV;
    const mod = await importFresh();
    // major.minor.<commit count> — never the bare 0.0.0 placeholder.
    expect(mod.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mod.VERSION).not.toBe('0.0.0');
  });

  it('propagates a failure to resolve the workspace version rather than inventing one', async () => {
    delete process.env.PATCH_VERSION;
    process.env.PATCH_GIT_SHA = 'abc1234';
    delete process.env.NODE_ENV;
    vi.doMock('node:child_process', () => ({
      execSync: vi.fn((cmd: string) => {
        if (String(cmd).includes('version.mjs')) throw new Error('node: command not found');
        return 'abc1234';
      }),
    }));
    // NO FALLBACK: an unresolvable version fails loudly, never defaults.
    await expect(importFresh()).rejects.toThrow('node: command not found');
  });

  it('throws with a wrapped message when `git rev-parse` fails in dev', async () => {
    process.env.PATCH_VERSION = '1.0.0';
    delete process.env.PATCH_GIT_SHA;
    delete process.env.NODE_ENV;
    vi.doMock('node:child_process', () => ({
      execSync: vi.fn(() => {
        throw new Error('fatal: not a git repository');
      }),
    }));
    await expect(importFresh()).rejects.toThrow(
      /Cannot resolve git SHA for @patch\/daemon \(dev mode\): fatal: not a git repository/,
    );
  });

  it('trims trailing whitespace/newlines off the git rev-parse output', async () => {
    process.env.PATCH_VERSION = '1.0.0';
    delete process.env.PATCH_GIT_SHA;
    delete process.env.NODE_ENV;
    vi.doMock('node:child_process', () => ({
      execSync: vi.fn(() => 'deadbee\n'),
    }));
    const mod = await importFresh();
    expect(mod.GIT_SHA).toBe('deadbee');
  });
});
