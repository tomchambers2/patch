// `patch surfaces *` — connected-device introspection.
//
// list   → REST: GET /api/presence (server registry).
// ping   → emits a heartbeat probe; we just return the current presence row.
// revoke → POST /api/auth/revoke

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';

interface PresenceRow {
  surfaceId: string;
  surfaceKind?: string;
  online?: boolean;
  lastSeen?: number;
  label?: string;
}

export function registerSurfacesCommands(program: Command): void {
  const surfaces = program.command('surfaces').description('Connected-device ops');

  surfaces
    .command('list')
    .description('List connected surfaces')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        // Surface registry lives on the server; force REST.
        const t = getTransport({ ...opts, remote: true });
        const res = await t.get<{ presence: PresenceRow[] }>('/api/presence');
        // Normalise response key to `surfaces` for consistency with other groups.
        if (opts.json) {
          emitJson({ surfaces: res.presence });
          return;
        }
        if (res.presence.length === 0) {
          emitText('(no connected surfaces)');
          return;
        }
        for (const p of res.presence)
          emitText(
            `${p.surfaceId}  kind=${p.surfaceKind ?? '?'}  online=${p.online ?? false}  ${p.label ?? ''}`,
          );
      });
    });

  surfaces
    .command('ping <id>')
    .description('Heartbeat probe (returns current presence row for id)')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.get<{ presence: PresenceRow[] }>('/api/presence');
        const row = res.presence.find((p) => p.surfaceId === id);
        if (!row) throw new Error(`surface not found: ${id}`);
        if (opts.json) emitJson(row);
        else emitText(JSON.stringify(row, null, 2));
      });
    });

  surfaces
    .command('revoke <id>')
    .description('Revoke a surface credential')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<{ ok: true }>('/api/auth/revoke', { id });
        if (opts.json) emitJson(res);
        else emitText('revoked');
      });
    });
}
