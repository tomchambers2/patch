// `patch activity` — the user's own messages (spec/17 § CLI, spec/06 §
// Cross-chat toolset).
//
// Always REST, never UDS: unlike `chats list` (which has a meaningful
// local-only view — this machine's own chats), the answer spans every host's
// chat logs and only the server gathers them (mirrors `chats move`/`rename`/
// `pin`, which force REST for the same "only the server has this" reason).

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';

interface ActivityMessage {
  chatId: string;
  chatName: string | null;
  daemonId: string;
  folder: string;
  text: string;
  ts: number;
}

interface ActivityResult {
  messages: ActivityMessage[];
  messagesTruncated: boolean;
  nextMessagesCursor?: number;
}

/** Accepts an ISO-8601 date/time, or a bare ms-epoch integer. */
function parseTimestamp(raw: string, flag: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} must be an ISO-8601 timestamp or ms-epoch integer (got ${raw})`);
  }
  return parsed;
}

export function registerActivityCommands(program: Command): void {
  program
    .command('activity')
    .description("Read the user's own timeline: messages you sent")
    .option('--since <when>', 'ISO-8601 or ms-epoch; default 24h before --until')
    .option('--until <when>', 'ISO-8601 or ms-epoch; default now')
    .option('--messages-cursor <ms>', 'resume a truncated messages page')
    .option('--limit <n>', 'max rows per list (server-capped)')
    .option('--json', 'JSON output')
    .action(
      async (
        opts: CommonOpts & {
          since?: string;
          until?: string;
          messagesCursor?: string;
          limit?: string;
        },
      ) => {
        await run(opts, async () => {
          const until =
            opts.until !== undefined ? parseTimestamp(opts.until, '--until') : Date.now();
          const since =
            opts.since !== undefined
              ? parseTimestamp(opts.since, '--since')
              : until - 24 * 60 * 60 * 1000;
          const t = getTransport({ ...opts, remote: true });
          const params = new URLSearchParams();
          params.set('since', String(since));
          params.set('until', String(until));
          if (opts.messagesCursor !== undefined) params.set('messagesCursor', opts.messagesCursor);
          if (opts.limit !== undefined) params.set('limit', opts.limit);
          const res = await t.get<ActivityResult>(`/api/activity?${params.toString()}`);
          if (opts.json) {
            emitJson(res);
            return;
          }
          if (res.messages.length === 0) {
            emitText('(no activity in this window)');
            return;
          }
          for (const m of res.messages) {
            emitText(`[sent]    ${new Date(m.ts).toISOString()}  ${m.folder}  ${m.text}`);
          }
          if (res.messagesTruncated)
            emitText(
              `(messages truncated — resume with --messages-cursor ${res.nextMessagesCursor})`,
            );
        });
      },
    );
}
