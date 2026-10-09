// `patch host *` — host management (only meaningful on the Hetzner box).
//
// start/stop are aliases to systemd / docker-compose commands; we expose
// them as primitives so an agent can invoke them. status checks reachability.
// `list` is an alias for `chats list`.

import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, pickPath, run } from './_common.js';

export function registerHostCommands(program: Command): void {
  const host = program.command('host').description('Host management');

  host
    .command('status')
    .description('Check host reachability')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        // GET /healthz over UDS, /api/daemon/healthz over REST.
        const path = t.kind === 'uds' ? '/healthz' : '/api/daemon/healthz';
        const res = await t.get<unknown>(path);
        if (opts.json) emitJson({ transport: t.kind, healthz: res });
        else emitText(`transport=${t.kind} ${JSON.stringify(res)}`);
      });
    });

  host
    .command('start')
    .description('Start the host (docker compose / systemd)')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const cmd = process.env.PATCH_DAEMON_START_CMD ?? 'docker compose up -d daemon';
        if (opts.json) {
          // Don't leak shell stderr through stdout in --json mode.
          const out = spawnSync(cmd, { shell: true });
          if (out.status !== 0) {
            throw new Error(
              `host start exited ${out.status}: ${(out.stderr ?? Buffer.from('')).toString('utf8').trim()}`,
            );
          }
          emitJson({
            ok: true,
            cmd,
            _stderr: (out.stderr ?? Buffer.from('')).toString('utf8'),
          });
          return;
        }
        const out = spawnSync(cmd, { shell: true, stdio: 'inherit' });
        if (out.status !== 0) throw new Error(`host start exited ${out.status}`);
        emitText('started');
      });
    });

  host
    .command('stop')
    .description('Stop the host')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const cmd = process.env.PATCH_DAEMON_STOP_CMD ?? 'docker compose stop daemon';
        if (opts.json) {
          const out = spawnSync(cmd, { shell: true });
          if (out.status !== 0) {
            throw new Error(
              `host stop exited ${out.status}: ${(out.stderr ?? Buffer.from('')).toString('utf8').trim()}`,
            );
          }
          emitJson({
            ok: true,
            cmd,
            _stderr: (out.stderr ?? Buffer.from('')).toString('utf8'),
          });
          return;
        }
        const out = spawnSync(cmd, { shell: true, stdio: 'inherit' });
        if (out.status !== 0) throw new Error(`host stop exited ${out.status}`);
        emitText('stopped');
      });
    });

  host
    .command('clean')
    .description('Remove meta.json entries for chats Claude Code has lost')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        // `clean` operates on the host box's on-disk meta — local UDS only.
        if (t.kind !== 'uds') {
          throw new Error(
            'host clean operates on the host box and requires the local host socket ' +
              '(PATCH_DAEMON_SOCKET + PATCH_DAEMON_LOCAL_KEY); not available in remote/REST mode',
          );
        }
        const res = await t.post<{ removed: string[] }>('/clean');
        if (opts.json) emitJson(res);
        else if (res.removed.length === 0) emitText('(nothing to clean)');
        else emitText(`removed ${res.removed.length}: ${res.removed.join(', ')}`);
      });
    });

  host
    .command('list')
    .description('List chats (alias for `chats list`)')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const res = await t.get<{ chats: unknown[] }>(pickPath(t, '/chats', '/api/chats'));
        if (opts.json) emitJson(res);
        else emitText(JSON.stringify(res, null, 2));
      });
    });
}
