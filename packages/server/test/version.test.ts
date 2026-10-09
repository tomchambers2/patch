// src/version.ts computes VERSION + GIT_SHA at MODULE LOAD TIME (top-level
// `export const`), so every scenario below needs vi.resetModules() + a fresh
// dynamic import to re-run resolveVersion()/resolveGitSha() under different
// env vars and mocked node:fs / node:child_process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('version.ts — resolveVersion / resolveGitSha', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PATCH_VERSION;
    delete process.env.PATCH_GIT_SHA;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('uses PATCH_VERSION and PATCH_GIT_SHA from env when set', async () => {
    process.env.PATCH_VERSION = '9.9.9';
    process.env.PATCH_GIT_SHA = 'deadbee';
    const mod = await import('../src/version.js');
    expect(mod.VERSION).toBe('9.9.9');
    expect(mod.GIT_SHA).toBe('deadbee');
  });

  it('throws in production when PATCH_VERSION is unset', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PATCH_GIT_SHA = 'deadbee';
    delete process.env.PATCH_VERSION;
    await expect(import('../src/version.js')).rejects.toThrow(
      /PATCH_VERSION must be set in production/,
    );
  });

  it('throws in production when PATCH_GIT_SHA is unset', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PATCH_VERSION = '1.0.0';
    delete process.env.PATCH_GIT_SHA;
    await expect(import('../src/version.js')).rejects.toThrow(
      /PATCH_GIT_SHA must be set in production/,
    );
  });

  // Dev now derives the version from the MONOREPO's single source of truth
  // (scripts/version.mjs), not packages/server/package.json — that file's version
  // is a permanent `0.0.0` placeholder, so reading it made the server report 0.0.0
  // alongside layers reporting a real version, and the update panel could not
  // meaningfully compare them (spec/11 § Version reporting).
  it('derives the version from scripts/version.mjs (dev) when PATCH_VERSION unset', async () => {
    process.env.PATCH_GIT_SHA = 'deadbee'; // pin sha so we isolate the version path
    delete process.env.PATCH_VERSION;
    const mod = await import('../src/version.js');
    // major.minor.<commit count> — never the bare 0.0.0 placeholder.
    expect(mod.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mod.VERSION).not.toBe('0.0.0');
    expect(mod.GIT_SHA).toBe('deadbee');
  });

  it('propagates a failure to resolve the workspace version rather than inventing one', async () => {
    process.env.PATCH_GIT_SHA = 'deadbee';
    delete process.env.PATCH_VERSION;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return {
        ...actual,
        execSync: (cmd: string) => {
          if (String(cmd).includes('version.mjs')) throw new Error('node: command not found');
          return 'deadbee';
        },
      };
    });
    // NO FALLBACK: a version we cannot resolve must fail loudly, never default.
    await expect(import('../src/version.js')).rejects.toThrow(/node: command not found/);
  });

  it('reads git SHA via `git rev-parse --short HEAD` (dev) when PATCH_GIT_SHA unset', async () => {
    process.env.PATCH_VERSION = '1.2.3';
    delete process.env.PATCH_GIT_SHA;
    const mod = await import('../src/version.js');
    expect(mod.VERSION).toBe('1.2.3');
    expect(mod.GIT_SHA.length).toBeGreaterThan(0);
  });

  it('throws a wrapped error when git rev-parse fails (dev, no PATCH_GIT_SHA)', async () => {
    process.env.PATCH_VERSION = '1.2.3';
    delete process.env.PATCH_GIT_SHA;
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return {
        ...actual,
        execSync: () => {
          throw new Error('git: command not found');
        },
      };
    });
    await expect(import('../src/version.js')).rejects.toThrow(
      /Cannot resolve git SHA for @patch\/server \(dev mode\)/,
    );
  });
});
