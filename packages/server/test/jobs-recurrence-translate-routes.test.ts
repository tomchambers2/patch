// POST /api/jobs/recurrence/translate — the recurrence trigger's
// natural-language schedule input (spec/08 § Recurrence). Round-trips
// patch.recurrence.translate.request to the named host exactly as
// GET /api/models round-trips patch.models.request (see chat-routes.test.ts's
// coverage of that route, which this mirrors), then re-validates AND
// re-describes whatever the host claims before ever handing it back.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('POST /api/jobs/recurrence/translate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-recurrence-translate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(20));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-recurrence',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-recurrence',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    // `d1` must be a REGISTERED machine — every host-addressed route refuses
    // an id that is not (spec/04 § Spawn).
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    return { registry, jwt };
  }

  /** Wire `daemonLink.send` to answer every translate request with `rrule` (or `error` if given). */
  function stubDaemonAnswer(
    daemonLink: InProcessDaemonLink,
    answer: { rrule: string } | { error: string },
  ): void {
    const origSend = daemonLink.send.bind(daemonLink);
    daemonLink.send = (surfaceId, event) => {
      origSend(surfaceId, event);
      if (event.type !== 'patch.recurrence.translate.request') return;
      setImmediate(() => {
        daemonLink.emit(
          'rrule' in answer
            ? {
                type: 'patch.recurrence.translate.response',
                requestId: event.requestId,
                daemonId: 'd1',
                ok: true,
                rrule: answer.rrule,
              }
            : {
                type: 'patch.recurrence.translate.response',
                requestId: event.requestId,
                daemonId: 'd1',
                ok: false,
                error: answer.error,
              },
        );
      });
    };
  }

  it('translates a phrase into an rrule + English description on success', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    stubDaemonAnswer(daemonLink, {
      rrule: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
    });
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', phrase: 'every 3rd Sunday between May and August' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { rrule: string; description: string };
      expect(body.rrule).toBe(
        'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
      );
      expect(body.description).toBe('every 3rd Sunday, May through August at 9am');
    } finally {
      await built.app.close();
    }
  });

  it("maps the host's own ok:false (e.g. model said UNSURE) to 422", async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    stubDaemonAnswer(daemonLink, { error: 'could not confidently translate that phrase' });
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', phrase: 'sometime, whenever, you know' },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe('translation_failed');
      expect(body.message).toContain('could not confidently translate');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a syntactically invalid rrule from the host rather than saving it (422)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    stubDaemonAnswer(daemonLink, { rrule: 'FREQ=BOGUS' });
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', phrase: 'whenever' },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe('translation_failed');
      expect(body.message).toContain('invalid RRULE');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a syntactically valid rrule the describer cannot confirm (422, not a silent save)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    // Valid RRULE (BYMONTHDAY is real RFC 5545), but outside the narrow shape
    // describeRecurrence confidently phrases — exactly the case that must
    // fail loudly rather than confirm a rule Tom never actually saw in English.
    stubDaemonAnswer(daemonLink, { rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0' });
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', phrase: 'the 15th of every month' },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe('translation_failed');
      expect(body.message).toContain('plain English');
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unregistered daemonId (404), not a guess about which host', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'no-such-host', phrase: 'every Sunday at 9am' },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('unknown_host');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a request with no phrase (400)', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unauthenticated request (401)', async () => {
    const { registry } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        payload: { daemonId: 'd1', phrase: 'every Sunday at 9am' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('times out as 504 when the host never answers', async () => {
    const { registry, jwt } = await bootstrap();
    const daemonLink = new InProcessDaemonLink();
    // No stub — daemonLink.send is a no-op reply-wise, so the request hangs
    // until the route's own timeout fires. Shortened via the test-only
    // override so this doesn't cost the suite the real 25s production window.
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink,
      recurrenceTranslateTimeoutMs: 100,
    });
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/recurrence/translate',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', phrase: 'every Sunday at 9am' },
      });
      expect(res.statusCode).toBe(504);
    } finally {
      await built.app.close();
    }
  });
});
