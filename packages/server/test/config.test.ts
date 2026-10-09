import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const original = { ...process.env };
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'patch-config-'));
  });

  afterEach(() => {
    process.env = { ...original };
    rmSync(scratch, { recursive: true, force: true });
  });

  it('crashes if PATCH_DATA_DIR is set but missing', () => {
    process.env.PATCH_INTERNAL_TOKEN = 'a'.repeat(32);
    process.env.PATCH_DATA_DIR = '/nonexistent/path/that/does/not/exist-zzz';
    expect(() => loadConfig()).toThrowError(/does not exist/);
  });

  it('crashes if PORT is invalid', () => {
    process.env.PORT = 'not-a-number';
    expect(() => loadConfig()).toThrowError(/Invalid PORT/);
  });

  it('uses PATCH_DATA_DIR when set', () => {
    process.env.PATCH_DATA_DIR = scratch;
    process.env.PATCH_INTERNAL_TOKEN = 'a'.repeat(32);
    const config = loadConfig();
    expect(config.dataDir).toBe(scratch);
    expect(config.internalToken).toBe('a'.repeat(32));
  });

  it('crashes if PATCH_INTERNAL_TOKEN is too short', () => {
    process.env.PATCH_DATA_DIR = scratch;
    process.env.PATCH_INTERNAL_TOKEN = 'short';
    expect(() => loadConfig()).toThrowError(/need >=16/);
  });

  it('crashes if PATCH_DATA_DIR is set but is not a directory (a file)', () => {
    const filePath = join(scratch, 'not-a-dir.txt');
    writeFileSync(filePath, 'x');
    process.env.PATCH_DATA_DIR = filePath;
    process.env.PATCH_INTERNAL_TOKEN = 'a'.repeat(32);
    expect(() => loadConfig()).toThrowError(/is not a directory/);
  });

  it('creates an ephemeral dataDir when allowEphemeralDataDir is true and PATCH_DATA_DIR is unset', () => {
    delete process.env.PATCH_DATA_DIR;
    process.env.PATCH_INTERNAL_TOKEN = 'a'.repeat(32);
    delete process.env.NODE_ENV;
    const config = loadConfig({ allowEphemeralDataDir: true });
    expect(config.dataDir.length).toBeGreaterThan(0);
    rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('defaults host to 0.0.0.0 when HOST is unset', () => {
    process.env.PATCH_DATA_DIR = scratch;
    process.env.PATCH_INTERNAL_TOKEN = 'a'.repeat(32);
    delete process.env.HOST;
    const config = loadConfig();
    expect(config.host).toBe('0.0.0.0');
  });

  // spec/01 § Starting with no settings — a server starts with nothing set.
  describe('with nothing set', () => {
    let home: string;
    beforeEach(() => {
      home = join(scratch, 'home');
      process.env.HOME = home;
      delete process.env.PATCH_DATA_DIR;
      delete process.env.PATCH_INTERNAL_TOKEN;
      delete process.env.PATCH_SERVER_HOME;
      delete process.env.PORT;
      delete process.env.HOST;
    });

    it('keeps its data in ~/.patch-server/data, made on the spot', () => {
      const config = loadConfig();
      expect(config.dataDir).toBe(join(home, '.patch-server', 'data'));
      expect(statSync(config.dataDir).isDirectory()).toBe(true);
    });

    it('keeps its data in PATCH_SERVER_HOME/data when that is set', () => {
      process.env.PATCH_SERVER_HOME = join(scratch, 'elsewhere');
      expect(loadConfig().dataDir).toBe(join(scratch, 'elsewhere', 'data'));
    });

    it('makes the internal token into the data dir, mode 600, the way secrets.key is made', () => {
      const config = loadConfig();
      const path = join(config.dataDir, 'internal.token');
      expect(config.internalToken).toMatch(/^[0-9a-f]{48}$/);
      expect(readFileSync(path, 'utf8').trim()).toBe(config.internalToken);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('reads the same token back on the next start', () => {
      const first = loadConfig();
      expect(loadConfig().internalToken).toBe(first.internalToken);
    });

    it('lets PATCH_INTERNAL_TOKEN win, and writes no file for it', () => {
      process.env.PATCH_INTERNAL_TOKEN = 'b'.repeat(32);
      const config = loadConfig();
      expect(config.internalToken).toBe('b'.repeat(32));
      expect(existsSync(join(config.dataDir, 'internal.token'))).toBe(false);
    });

    it('refuses a token file that is not a token, rather than minting over it', () => {
      const dir = join(home, '.patch-server', 'data');
      loadConfig();
      writeFileSync(join(dir, 'internal.token'), 'short');
      expect(() => loadConfig()).toThrowError(/internal\.token/);
    });

    it('still refuses an explicit PATCH_DATA_DIR that does not exist', () => {
      process.env.PATCH_DATA_DIR = join(scratch, 'nope');
      expect(() => loadConfig()).toThrowError(/does not exist/);
    });

    it('needs no env at all in production', () => {
      process.env.NODE_ENV = 'production';
      const config = loadConfig();
      expect(config.port).toBe(3000);
      expect(config.dataDir).toBe(join(home, '.patch-server', 'data'));
    });
  });
});
