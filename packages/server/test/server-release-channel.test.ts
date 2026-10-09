// The install channel (spec/11 § Server installation): install.sh, the release
// tarball and its checksum, served unauthenticated so one curl can fetch them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('GET /api/server-release/:name', () => {
  let dir: string;
  let downloads: string;
  const prev = process.env['PATCH_DOWNLOADS_DIR'];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-srvrel-'));
    downloads = join(dir, 'downloads');
    mkdirSync(join(downloads, 'server-release'), { recursive: true });
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(downloads, 'server-release', 'install.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(downloads, 'server-release', 'patch-server.tar.gz'), 'tarbytes');
    writeFileSync(
      join(downloads, 'server-release', 'patch-server.tar.gz.sha256'),
      'abc  patch-server.tar.gz\n',
    );
    writeFileSync(join(downloads, 'secret.txt'), 'nope');
    process.env['PATCH_DOWNLOADS_DIR'] = downloads;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['PATCH_DOWNLOADS_DIR'];
    else process.env['PATCH_DOWNLOADS_DIR'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const registry = Registry.load(join(dir, 'data'));
    registry.bootstrapAccount({ keypair: generateUserKeypair(() => new Uint8Array(32).fill(7)) });
    return buildAll({ logger: false, registry, daemonLink: new InProcessDaemonLink() });
  }

  it('serves the installer, tarball and checksum with no credential', async () => {
    const built = await makeApp();
    try {
      const sh = await built.app.inject({ method: 'GET', url: '/api/server-release/install.sh' });
      expect(sh.statusCode).toBe(200);
      expect(sh.headers['content-type']).toContain('text/x-shellscript');
      expect(sh.body).toBe('#!/bin/sh\necho hi\n');
      const tar = await built.app.inject({
        method: 'GET',
        url: '/api/server-release/patch-server.tar.gz',
      });
      expect(tar.statusCode).toBe(200);
      expect(tar.body).toBe('tarbytes');
      const sum = await built.app.inject({
        method: 'GET',
        url: '/api/server-release/patch-server.tar.gz.sha256',
      });
      expect(sum.statusCode).toBe(200);
      expect(sum.body).toBe('abc  patch-server.tar.gz\n');
    } finally {
      await built.app.close();
    }
  });

  it('404s anything else, and a published name that is missing', async () => {
    const built = await makeApp();
    try {
      for (const name of ['secret.txt', '..%2Fsecret.txt', 'other.tar.gz']) {
        const res = await built.app.inject({ method: 'GET', url: `/api/server-release/${name}` });
        expect(res.statusCode).toBe(404);
      }
      rmSync(join(downloads, 'server-release', 'install.sh'));
      const gone = await built.app.inject({ method: 'GET', url: '/api/server-release/install.sh' });
      expect(gone.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });
});
