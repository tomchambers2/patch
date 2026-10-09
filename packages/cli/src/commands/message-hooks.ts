// `patch message-hooks *` — user-message hooks (spec/20-hooks.md).
//
// Server-owned, REST only — there is no host-side UDS mirror for hooks
// (unlike jobs), so every subcommand forces the REST transport, same as
// `patch surfaces` (surfaces.ts).

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

interface HookRow {
  id: string;
  name: string;
  enabled: boolean;
  kind: string;
  when: string;
}

export function registerMessageHooksCommands(program: Command): void {
  const hooks = program
    .command('message-hooks')
    .description('User-message hook CRUD (spec/20-hooks.md)');

  hooks
    .command('list')
    .description('List all message hooks')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.get<{ hooks: HookRow[] }>('/api/hooks');
        if (opts.json) {
          emitJson(res);
          return;
        }
        if (res.hooks.length === 0) {
          emitText('(no message hooks)');
          return;
        }
        for (const h of res.hooks) {
          emitText(
            `${h.id}  ${h.name}  [${h.enabled ? 'enabled' : 'disabled'}]  ${h.when}/${h.kind}`,
          );
        }
      });
    });

  hooks
    .command('get <id>')
    .description('Show a single message hook')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.get<unknown>(`/api/hooks/${id}`);
        if (opts.json) emitJson(res);
        else emitText(JSON.stringify(res, null, 2));
      });
    });

  hooks
    .command('create <file>')
    .description('Create a message hook from a JSON file')
    .option('--json', 'JSON output')
    .action(async (file: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const body = readJsonFile(file);
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<unknown>('/api/hooks', body);
        if (opts.json) emitJson(res);
        else emitText(JSON.stringify(res, null, 2));
      });
    });

  hooks
    .command('update <id> <file>')
    .description('Update a message hook from a JSON file (PATCH)')
    .option('--json', 'JSON output')
    .action(async (id: string, file: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const body = readJsonFile(file);
        const t = getTransport({ ...opts, remote: true });
        const res = await t.patch<unknown>(`/api/hooks/${id}`, body);
        if (opts.json) emitJson(res);
        else emitText(JSON.stringify(res, null, 2));
      });
    });

  hooks
    .command('delete <id>')
    .description('Delete a message hook')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        await t.delete<void>(`/api/hooks/${id}`);
        if (opts.json) emitJson({ ok: true });
        else emitText('deleted');
      });
    });

  hooks
    .command('enable <id>')
    .description('Enable a message hook')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<unknown>(`/api/hooks/${id}/enable`);
        if (opts.json) emitJson(res);
        else emitText('enabled');
      });
    });

  hooks
    .command('disable <id>')
    .description('Disable a message hook')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<unknown>(`/api/hooks/${id}/disable`);
        if (opts.json) emitJson(res);
        else emitText('disabled');
      });
    });
}
