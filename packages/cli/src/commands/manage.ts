// Flat top-level management verbs (spec/17 § Management subcommands).
//
// These are the human/agent shortcuts the spec lists as bare verbs, distinct
// from the resource-grouped `patch chats *` forms:
//   patch list [--active]        list all chats (--active → running/awaiting)
//   patch send <id> "msg"        fire-and-forget user turn, exit 0
//   patch history <id> [--limit] print a chat's event history to stdout
//   patch stop <id>              terminate a chat
//
// They share the same transport seam as the resource commands (UDS-preferred
// when daemon-local, REST when remote). NO FALLBACK: errors surface via run().

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, parseLimit, pickPath, run } from './_common.js';
import { resolveChatId } from './chatId.js';

interface ChatSummary {
  chatId: string;
  name?: string;
  folder?: string;
  status?: string;
  activity?: string;
  pinned?: boolean;
  lastUpdated?: number;
}

const ACTIVE_ACTIVITIES = new Set(['running', 'awaiting-permission']);

export function registerManageCommands(program: Command): void {
  // patch list [--active]
  program
    .command('list')
    .description('List all chats (--active filters to running/awaiting-permission)')
    .option('--active', 'Only chats that are running or awaiting permission')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { active?: boolean }) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const res = await t.get<{ chats: ChatSummary[] }>(pickPath(t, '/chats', '/api/chats'));
        const chats = opts.active
          ? res.chats.filter((c) => c.activity !== undefined && ACTIVE_ACTIVITIES.has(c.activity))
          : res.chats;
        if (opts.json) {
          emitJson({ chats });
          return;
        }
        if (chats.length === 0) {
          emitText('(no chats)');
          return;
        }
        for (const c of chats) {
          // H1-d4: print the FULL chatId, not chatId.slice(0,8). The truncated
          // form ('thread_s', 'thread_t') is both ambiguous and rejected
          // downstream as 'chat not found' when fed to history/stop/send. The
          // id a user reads here must be the usable one.
          emitText(
            `${c.chatId}  ${c.status ?? '?'}  ${c.activity ?? '?'}  ${c.folder ?? ''}  ${c.name ?? ''}`,
          );
        }
      });
    });

  // patch send <id> <message>
  program
    .command('send <id> [message]')
    .description('Fire-and-forget user turn into a chat (exit 0)')
    .option('--message <message>', 'Message body (alternative to positional)')
    .option('--json', 'JSON output')
    .action(
      async (
        rawId: string,
        positional: string | undefined,
        opts: CommonOpts & { message?: string },
      ) => {
        await run(opts, async () => {
          const message = positional ?? opts.message;
          if (!message) throw new Error('send: <message> or --message is required');
          const t = getTransport(opts);
          const id = await resolveChatId(t, rawId);
          if (t.kind === 'uds') {
            const res = await t.post<{ ok: true; queued: boolean }>('/internal/send-to', {
              chatId: id,
              message,
            });
            if (opts.json) emitJson(res);
            else emitText('queued');
          } else {
            const res = await t.post<{ ok: true; queued: boolean; localId: string }>(
              `/api/chats/${id}/send-to`,
              { message },
            );
            if (opts.json) emitJson(res);
            else emitText('queued');
          }
        });
      },
    );

  // patch history <id> [--limit N]
  program
    .command('history <id>')
    .description("Print a chat's event history to stdout")
    .option('--limit <n>', 'Max number of most-recent events to print')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts & { limit?: string }) => {
      await run(opts, async () => {
        const limit: number | undefined =
          opts.limit !== undefined ? parseLimit(opts.limit) : undefined;
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        const qs = limit !== undefined ? `?limit=${limit}` : '';
        const path = pickPath(
          t,
          `/internal/history/${encodeURIComponent(id)}${qs}`,
          `/api/chats/${encodeURIComponent(id)}/history${qs}`,
        );
        const res = await t.get<{ events: unknown[]; nextFromSeq?: number }>(path);
        if (opts.json) {
          emitJson(res);
          return;
        }
        if (res.events.length === 0) {
          emitText('(no history)');
          return;
        }
        for (const ev of res.events) emitText(JSON.stringify(ev));
      });
    });

  // patch stop <id>
  program
    .command('stop <id>')
    .description('Terminate a chat')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        const path = pickPath(t, `/chats/${id}/stop`, `/api/chats/${id}/stop`);
        const res = await t.post<{ ok: true }>(path);
        if (opts.json) emitJson(res);
        else emitText('stopped');
      });
    });

  // patch __complete-folder [partial]
  //
  // Host-mediated `--folder` tab-completion (spec/13). The candidate list is
  // sourced from the HOST box's filesystem via GET /chats/folders — NOT the
  // CLI's local cwd — so completion is correct regardless of which host the CLI
  // runs on. Shell completion scripts call this; it is also the seam G1-13
  // exercises. With no partial it prints the host's recent folders.
  program
    .command('__complete-folder [partial]')
    .description('Host-mediated folder completion candidates for --folder')
    .option('--json', 'JSON output')
    .action(async (partial: string | undefined, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        if (t.kind !== 'uds') {
          // Folder completion reads the HOST box's filesystem. The local UDS
          // path talks to the host directly; a remote CLI would need the
          // server to round-trip to the host, which is not wired. Fail loud
          // rather than silently completing against the wrong (local) box.
          throw new Error(
            'folder completion is host-mediated and requires the local host socket ' +
              '(PATCH_DAEMON_SOCKET + PATCH_DAEMON_LOCAL_KEY); not available in remote/REST mode',
          );
        }
        const qs = partial ? `?path=${encodeURIComponent(partial)}` : '';
        const res = await t.get<{ recents: string[]; completions: string[] }>(
          `/chats/folders${qs}`,
        );
        emitFolders(opts, partial, res);
      });
    });
}

function emitFolders(
  opts: CommonOpts,
  partial: string | undefined,
  res: { recents: string[]; completions: string[] },
): void {
  if (opts.json) {
    emitJson(res);
    return;
  }
  const lines = partial && partial.length > 0 ? res.completions : res.recents;
  for (const l of lines) emitText(l);
}
