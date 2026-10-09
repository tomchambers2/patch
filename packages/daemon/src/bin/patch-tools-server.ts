#!/usr/bin/env node
// Entry point — launched as a child process by the Claude Code SDK for
// every `query()` the host kicks off. See `mcp.ts` for the server build.
//
// `--probe` lists the tools registered with the server, used by the smoke
// test. The probe doesn't talk to the host — it builds the
// server in-memory and inspects the registered handlers.

import { buildPatchToolsServer, runPatchToolsServerStdio } from '../mcp.js';

if (process.argv.includes('--probe')) {
  // Probe: list tools and exit. No env vars required.
  const server = buildPatchToolsServer({
    daemonSocketPath: '/dev/null',
    chatId: 'probe',
    // The probe never opens the socket, so the key is inert here.
    localKey: 'probe',
  });
  // McpServer exposes a private `_registeredTools` map; we walk via the
  // public `server.server` notification handlers? Simplest: emit the list
  // we know we register (kept in sync with mcp.ts) by introspecting the
  // McpServer's internal tool set if available.
  const internal = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  const names = internal ? Object.keys(internal) : [];
  console.log(JSON.stringify({ tools: names.sort() }, null, 2));
  process.exit(0);
}

runPatchToolsServerStdio().catch((err: unknown) => {
  console.error('[patch-tools-server] fatal:', err);
  process.exit(1);
});
