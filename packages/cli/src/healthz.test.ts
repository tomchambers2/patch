// Smoke test for the CLI's healthz client. Stands up an HTTP server, asserts
// the parsed body, and tears it down. NO mocks of fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { healthz } from './healthz.js';

test('healthz parses /api/healthz JSON from a real server', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.0.0', gitSha: 'deadbee' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no addr');
  const url = `http://127.0.0.1:${addr.port}`;
  try {
    const out = await healthz(url);
    assert.equal(out.ok, true);
    assert.equal(out.version, '0.0.0');
    assert.equal(out.gitSha, 'deadbee');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
