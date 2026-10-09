// `patch threads *` — primitives for the two special threads
// (manager / speakers).
//
// Filters the chats list to those whose chatId matches `thread_*` per
// spec/06. send-to is identical to `chats send-to`, but resolved by name.

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';

interface ChatSummary {
  chatId: string;
  name?: string;
}

const NAME_TO_ID: Record<string, string> = {
  manager: 'thread_manager',
  speakers: 'thread_speakers',
};

export function registerThreadsCommands(program: Command): void {
  const threads = program.command('threads').description('Special-thread ops');

  threads
    .command('list')
    .description('List the two special threads')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const path = t.kind === 'uds' ? '/chats' : '/api/chats';
        const res = await t.get<{ chats: ChatSummary[] }>(path);
        const threads = res.chats.filter((c) => c.chatId.startsWith('thread_'));
        if (opts.json) emitJson({ threads });
        else for (const c of threads) emitText(`${c.chatId}  ${c.name ?? ''}`);
      });
    });

  threads
    .command('send-to <name> <message>')
    .description('Send a message to a named thread')
    .option('--json', 'JSON output')
    .action(async (name: string, message: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const id = NAME_TO_ID[name];
        if (!id) throw new Error(`unknown thread name: ${name} (try manager/speakers)`);
        const t = getTransport(opts);
        if (t.kind === 'uds') {
          const res = await t.post<{ ok: true; queued: boolean }>('/internal/send-to', {
            chatId: id,
            message,
          });
          if (opts.json) emitJson(res);
          else emitText(`queued → ${id}`);
        } else {
          const res = await t.post<{ ok: true; queued: boolean; chatId: string }>(
            `/api/threads/${name}/send-to`,
            { message },
          );
          if (opts.json) emitJson(res);
          else emitText(`queued → ${res.chatId}`);
        }
      });
    });

  // Manager sweep (spec/06 § Sweep) — account-wide, server-owned state with
  // no local UDS equivalent: unlike send-to, there is nothing a host can
  // answer for this on its own, so these always go straight to the server
  // (`remote: true` forces REST — `getTransport` never returns a UDS
  // transport once that's set).
  threads
    .command('sweep-now')
    .description("Force the Manager sweep's gate to check right now (spec/06 § Sweep)")
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<{ fired: boolean }>('/api/manager/sweep/check-now', {});
        if (opts.json) emitJson(res);
        else emitText(res.fired ? 'sweep fired' : 'nothing changed — no sweep run');
      });
    });

  threads
    .command('sweeps')
    .description('List recent Manager sweep runs (spec/06 § Sweep)')
    .option('--limit <n>', 'Max runs to list (default 50, max 200)')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { limit?: string }) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const limit = opts.limit ? Math.min(200, Math.max(1, Number(opts.limit) || 50)) : undefined;
        const res = await t.get<{ runs: unknown[] }>(
          `/api/manager/sweeps${limit ? `?limit=${limit}` : ''}`,
        );
        if (opts.json) emitJson(res);
        else for (const run of res.runs) emitText(JSON.stringify(run));
      });
    });
}
