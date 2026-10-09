// Regression tests for the UDS transport (src/transport/uds.ts).
//
// Bug fixed here: a no-body POST used to send `content-type: application/json`
// with an empty body, which Fastify rejects (FST_ERR_CTP_EMPTY_JSON_BODY →
// 400). That broke every no-body CLI POST: `jobs enable/disable`, `chats stop`.
// A no-body POST must send NO content-type (and no body) at all; a POST with a
// body still advertises application/json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UdsClient } from '../src/transport/uds.js';

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startUdsServer(): Promise<{
  socketPath: string;
  captured: Captured[];
  close: () => Promise<void>;
}> {
  const captured: Captured[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'patch-uds-'));
  const socketPath = join(dir, 'daemon.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('no-body POST sends NO content-type header and an empty body', async () => {
  const srv = await startUdsServer();
  try {
    const client = new UdsClient({ socketPath: srv.socketPath, localKey: 'k' });
    const res = await client.post<{ ok: boolean }>('/internal/jobs/j1/disable');
    assert.deepEqual(res, { ok: true });
    assert.equal(srv.captured.length, 1);
    const req = srv.captured[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.body, '');
    // The regression: must not advertise a JSON content-type with no body.
    assert.equal(req.headers['content-type'], undefined);
    // Auth still flows.
    assert.equal(req.headers['authorization'], 'Bearer k');
  } finally {
    await srv.close();
  }
});

test('POST with a body sends content-type: application/json and the JSON body', async () => {
  const srv = await startUdsServer();
  try {
    const client = new UdsClient({ socketPath: srv.socketPath, localKey: 'k' });
    await client.post('/chats/c1/archive', { archived: true });
    const req = srv.captured[0]!;
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(req.body), { archived: true });
  } finally {
    await srv.close();
  }
});
