// `patch chats *` — primitives over the host's chats resource.
//
// Routes:
//   list      → GET /chats (uds) | GET /api/chats (rest)
//   get <id>  → GET /chats/:id (uds) | GET /api/chats/:id (rest)
//   spawn     → POST /internal/spawn (uds) | POST /api/chats (rest)
//   send-to   → POST /internal/send-to (uds) | POST /api/chats/:id/send-to (rest)
//   stop      → POST /chats/:id/stop (uds) | POST /api/chats/:id/stop (rest)
//   archive   → POST /chats/:id/archive (uds) | POST /api/chats/:id/archive (rest)
//   pin       → POST /api/chats/:id/pin (rest)
//   rename    → POST /api/chats/:id/rename (rest)
//   move      → POST /api/chats/:id/move (rest — the server drives both machines)
//
// All commands accept `--json`. Without `--json`, output is a small table.

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, errorMessage, getTransport, pickPath, run } from './_common.js';
import { resolveHost } from './hosts.js';
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

export function registerChatsCommands(program: Command): void {
  const chats = program.command('chats').description('Chat resource ops');

  chats
    .command('list')
    .description('List chats')
    .option('--json', 'JSON output')
    .option('--archived <mode>', "'only' | 'include'")
    .action(async (opts: CommonOpts & { archived?: string }) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const path = pickPath(t, '/chats', '/api/chats');
        const qs =
          opts.archived !== undefined ? `?archived=${encodeURIComponent(opts.archived)}` : '';
        const res = await t.get<{ chats: ChatSummary[] }>(path + qs);
        if (opts.json) {
          emitJson(res);
          return;
        }
        if (res.chats.length === 0) {
          emitText('(no chats)');
          return;
        }
        for (const c of res.chats) {
          // H1-d4: print the FULL chatId (a truncated id is ambiguous and
          // rejected downstream as 'chat not found').
          emitText(
            `${c.chatId}  ${c.status ?? '?'}  ${c.activity ?? '?'}  ${c.folder ?? ''}  ${c.name ?? ''}`,
          );
        }
      });
    });

  chats
    .command('get <id>')
    .description('Show one chat')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        const path = pickPath(t, `/chats/${id}`, `/api/chats/${id}`);
        const res = await t.get<unknown>(path);
        if (opts.json) emitJson(res);
        else emitText(JSON.stringify(res, null, 2));
      });
    });

  chats
    .command('spawn [folder]')
    .description('Spawn a fresh chat in a folder')
    .option('--folder <folder>', 'Folder (alternative to positional arg)')
    .option('--prompt <prompt>', 'Initial user prompt')
    .option('--name <name>', 'Optional chat name')
    .option('--model <model>', 'SDK model override (pass-through to host spawn)')
    .option(
      '--dangerously-skip-permissions',
      'Run with permissionMode=bypassPermissions (pass-through to host spawn)',
    )
    .option('--json', 'JSON output')
    .action(
      async (
        folderArg: string | undefined,
        opts: CommonOpts & {
          folder?: string;
          prompt?: string;
          name?: string;
          model?: string;
          dangerouslySkipPermissions?: boolean;
        },
        cmd: Command,
      ) => {
        await run(opts, async () => {
          const rootOpts = cmd.parent?.parent?.opts() as { folder?: string } | undefined;
          const folder = folderArg ?? opts.folder ?? rootOpts?.folder;
          if (!folder)
            throw new Error('chats spawn: <folder> (positional or --folder) is required');
          // `--model` / `--dangerously-skip-permissions` are ALSO defined on the
          // root `patch` program (for the bare-`patch` TUI launch). Commander
          // binds a flag shared with an ancestor at the ANCESTOR level, so the
          // subcommand's own `opts.model` can be undefined even when the user
          // passed `--model` here. Resolve via optsWithGlobals() so we read the
          // value regardless of which command commander attached it to.
          const merged = cmd.optsWithGlobals() as {
            model?: string;
            dangerouslySkipPermissions?: boolean;
          };
          const t = getTransport(opts);
          const body: Record<string, unknown> = { folder };
          if (opts.prompt !== undefined) body['prompt'] = opts.prompt;
          if (opts.name !== undefined) body['name'] = opts.name;
          // Flag pass-through (spec/13): translate into the host spawn RPC's
          // SDK query() options.
          if (merged.model !== undefined) body['model'] = merged.model;
          if (merged.dangerouslySkipPermissions) body['permissionMode'] = 'bypassPermissions';
          if (t.kind === 'uds') {
            const res = await t.post<{ chatId: string }>('/internal/spawn', body);
            if (opts.json) emitJson(res);
            else emitText(`spawned ${res.chatId}`);
          } else {
            const res = await t.post<{ chatId: string; status: string }>('/api/chats', body);
            if (opts.json) emitJson(res);
            else emitText(`spawned ${res.chatId} (${res.status})`);
          }
        });
      },
    );

  chats
    .command('send-to <id> [message]')
    .description('Deliver a user-turn into a chat')
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
          if (!message) throw new Error('chats send-to: <message> or --message is required');
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

  chats
    .command('stop <id>')
    .description('Stop a chat')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        if (t.kind === 'uds') {
          const res = await t.post<{ ok: true }>(`/chats/${id}/stop`);
          if (opts.json) emitJson(res);
          else emitText('stopped');
        } else {
          const res = await t.post<{ ok: true }>(`/api/chats/${id}/stop`);
          if (opts.json) emitJson(res);
          else emitText('stopped');
        }
      });
    });

  chats
    .command('archive <id>')
    .description('Archive a chat (or unarchive with --archived false)')
    .option('--archived <bool>', 'true|false', 'true')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts & { archived: string }) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        const archived = opts.archived !== 'false';
        // One backend (spec/17): archive is a host resource op. Local CLI
        // hits the host UDS route; remote goes through the server REST API.
        const path = pickPath(t, `/chats/${id}/archive`, `/api/chats/${id}/archive`);
        const res = await t.post<{ ok: true }>(path, { archived });
        if (opts.json) emitJson(res);
        else emitText(archived ? 'archived' : 'unarchived');
      });
    });

  chats
    .command('disable <id>')
    .description(
      'Turn a special thread off (or on with --disabled false). Manager/Speakers only — this is the "off" switch archive is refused for on those (spec/06 § Disabled).',
    )
    .option('--disabled <bool>', 'true|false', 'true')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts & { disabled: string }) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        const disabled = opts.disabled !== 'false';
        const path = pickPath(t, `/chats/${id}/disable`, `/api/chats/${id}/disable`);
        const res = await t.post<{ ok: true }>(path, { disabled });
        if (opts.json) emitJson(res);
        else emitText(disabled ? 'disabled' : 'enabled');
      });
    });

  chats
    .command('rename <id> [name]')
    .description('Rename a chat; omit the name to clear it back to the derived label')
    .option('--json', 'JSON output')
    .action(async (rawId: string, name: string | undefined, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        if (t.kind === 'uds') {
          throw new Error('chats rename over UDS not supported; use REST (--remote or non-UDS)');
        }
        const next = name === undefined || name.trim() === '' ? null : name;
        const res = await t.post<{ ok: true }>(`/api/chats/${id}/rename`, { name: next });
        if (opts.json) emitJson(res);
        else emitText(next === null ? 'name cleared' : `renamed to ${next}`);
      });
    });

  chats
    .command('move <id>')
    .description(
      'Move a chat to another machine, to run in --folder there (spec/04 § Moving a chat to another host)',
    )
    .requiredOption('--host <host>', 'The machine to move it to: a host name or daemonId prefix')
    .requiredOption('--folder <folder>', 'Absolute folder on that machine')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts & { host: string; folder: string }) => {
      await run(opts, async () => {
        // Only the server can reach both machines, so this is REST even from
        // the machine the chat is on.
        const daemonId = await resolveHost(opts);
        const t = getTransport({ ...opts, remote: true });
        const id = await resolveChatId(t, rawId);
        const res = await t.post<{ ok: true; chatId: string; daemonId: string; folder: string }>(
          `/api/chats/${id}/move`,
          { daemonId, folder: opts.folder },
        );
        if (opts.json) emitJson(res);
        else emitText(`moved ${res.chatId} to ${opts.host}:${res.folder}`);
      });
    });

  chats
    .command('pin <id>')
    .description('Pin (or unpin with --pinned false) a chat')
    .option('--pinned <bool>', 'true|false', 'true')
    .option('--json', 'JSON output')
    .action(async (rawId: string, opts: CommonOpts & { pinned: string }) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const id = await resolveChatId(t, rawId);
        const pinned = opts.pinned !== 'false';
        if (t.kind === 'uds') {
          throw new Error('chats pin over UDS not supported; use REST (--remote or non-UDS)');
        }
        const res = await t.post<{ ok: true }>(`/api/chats/${id}/pin`, { pinned });
        if (opts.json) emitJson(res);
        else emitText(pinned ? 'pinned' : 'unpinned');
      });
    });
}

// Re-export for tests that drive command bodies directly (without commander).
export const _internals = { errorMessage };
