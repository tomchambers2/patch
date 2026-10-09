import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { build } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const der = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');

describe('Web Bot Auth public routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wba-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mk = (webBotAuthKey?: string) =>
    build({
      logger: false,
      registry: Registry.load(dir),
      daemonLink: new InProcessDaemonLink(),
      ...(webBotAuthKey ? { webBotAuthKey } : {}),
    });

  it('serves a directory, unauthenticated, signed over the request authority', async () => {
    const app = await mk(der);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/http-message-signatures-directory',
        headers: { host: 'patch.tomchambers.me' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(
        'application/http-message-signatures-directory+json',
      );
      const { keys } = res.json() as { keys: { kty: string; crv: string; x: string }[] };
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
      const params = String(res.headers['signature-input']).replace(/^sig1=/, '');
      expect(params).toContain('tag="http-message-signatures-directory"');
      expect(params).toContain('("@authority";req)');
      const base = `"@authority";req: patch.tomchambers.me\n"@signature-params": ${params}`;
      const sig = Buffer.from(
        /^sig1=:(.+):$/.exec(String(res.headers['signature']))![1]!,
        'base64',
      );
      const pub = createPublicKey({ key: keys[0]!, format: 'jwk' });
      expect(verify(null, Buffer.from(base), pub, sig)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('503s naming the missing variable when no key is configured — never an empty directory', async () => {
    const prev = process.env['PATCH_WEB_BOT_AUTH_KEY'];
    delete process.env['PATCH_WEB_BOT_AUTH_KEY'];
    const app = await mk();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/http-message-signatures-directory',
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('PATCH_WEB_BOT_AUTH_KEY');
    } finally {
      await app.close();
      if (prev !== undefined) process.env['PATCH_WEB_BOT_AUTH_KEY'] = prev;
    }
  });

  it('serves the public description page', async () => {
    const app = await mk(der);
    try {
      const res = await app.inject({ method: 'GET', url: '/agent' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      for (const needle of [
        'personal AI agent',
        'robots.txt',
        'low request rates',
        'tom.chambers@gmail.com',
        '/.well-known/http-message-signatures-directory',
      ]) {
        expect(res.body).toContain(needle);
      }
    } finally {
      await app.close();
    }
  });
});
