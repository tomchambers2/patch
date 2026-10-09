#!/usr/bin/env node
// `patch-relay` — run a relay (spec/10 § Relay). Nothing to configure: it listens
// on PORT (default 8787) and keeps no state. Put TLS in front of it (Caddy:
// `reverse_proxy 127.0.0.1:8787`) and give people the `wss://` address.

import { createRelayServer } from './server.js';

const port = Number(process.env['PORT'] ?? '8787');
if (!Number.isInteger(port) || port <= 0) {
  console.error(`patch-relay: invalid PORT ${process.env['PORT']}`);
  process.exit(1);
}

const relay = await createRelayServer({
  port,
  host: process.env['HOST'] ?? '0.0.0.0',
  ...(process.env['MAX_CLIENTS_PER_CHANNEL']
    ? { maxClientsPerChannel: Number(process.env['MAX_CLIENTS_PER_CHANNEL']) }
    : {}),
});
console.log(`patch-relay listening on :${relay.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void relay.close().then(() => process.exit(0)));
}
