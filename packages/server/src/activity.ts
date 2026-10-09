// The user's own messages (spec/06 § Cross-chat toolset — `patch_activity`).
//
// There is no activity store: a user message is a `chat.message` event with
// role 'user' in the chat's own history log, and those logs live on the host
// that owns each chat. So `patch_activity` is a read-through — the server asks
// every online machine for the user messages in its own logs for the window,
// merges the answers, and joins them against the chat mirror for name/host/
// folder. NO FALLBACK: a machine that is offline or does not answer fails the
// call, because an answer missing one host's messages would look complete.

import { randomUUID } from 'node:crypto';
import type { ActivityMessage, PatchActivityReadResponseEvent } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';
import type { DaemonLink } from './daemon-link.js';

/** How far back a single `patch_activity` call may reach. Declared in code per spec/06. */
export const ACTIVITY_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTIVITY_DEFAULT_PAGE_SIZE = 200;
export const ACTIVITY_MAX_PAGE_SIZE = 500;
/** How long one machine has to scan its logs before the whole call fails. */
export const ACTIVITY_READ_TIMEOUT_MS = 30_000;

const READ_SURFACE_ID = 'activity-read';

export interface ActivityQuery {
  since: number;
  until: number;
  /** Resume point from a previously truncated page. */
  messagesCursor?: number;
  limit?: number;
}

export interface ActivityResult {
  messages: ActivityMessage[];
  messagesTruncated: boolean;
  nextMessagesCursor?: number;
}

export interface ActivityReader {
  query(q: ActivityQuery): Promise<ActivityResult>;
  /** Stop listening and fail anything still waiting. */
  close(): void;
}

export function createActivityReader(deps: {
  daemonLink: DaemonLink;
  chatRegistry: ChatRegistry;
  now?: () => number;
}): ActivityReader {
  const { daemonLink, chatRegistry } = deps;
  const now = deps.now ?? Date.now;
  const waiting = new Map<
    string,
    { resolve: (e: PatchActivityReadResponseEvent) => void; reject: (err: Error) => void }
  >();

  const unsubscribe = daemonLink.onEvent((event) => {
    if (event.type !== 'patch.activity.read.response') return;
    const w = waiting.get(event.requestId);
    if (w) w.resolve(event);
  });

  const readHost = (
    daemonId: string,
    since: number,
    until: number,
    limit: number,
  ): Promise<PatchActivityReadResponseEvent> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(
          new Error(
            `patch_activity: machine ${daemonId} did not answer within ${ACTIVITY_READ_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, ACTIVITY_READ_TIMEOUT_MS);
      timer.unref();
      waiting.set(requestId, {
        resolve: (e) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          resolve(e);
        },
        reject: (err) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          reject(err);
        },
      });
      daemonLink.sendTo(daemonId, READ_SURFACE_ID, {
        type: 'patch.activity.read.request',
        requestId,
        since,
        until,
        limit,
      });
    });

  return {
    async query(q) {
      const until = Math.min(q.until, now());
      let since = Math.min(q.since, until);
      if (until - since > ACTIVITY_MAX_WINDOW_MS) since = until - ACTIVITY_MAX_WINDOW_MS;
      const limit = Math.min(
        Math.max(Math.trunc(q.limit ?? ACTIVITY_DEFAULT_PAGE_SIZE), 1),
        ACTIVITY_MAX_PAGE_SIZE,
      );
      const from = q.messagesCursor !== undefined ? Math.max(q.messagesCursor, since) : since;

      const hosts = daemonLink.onlineDaemonIds();
      // Each machine returns its oldest `limit + 1` — enough to tell whether
      // the merged page is truncated without any machine sending its whole log.
      const answers = await Promise.all(hosts.map((h) => readHost(h, from, until, limit + 1)));
      const all = answers.flatMap((a) => a.messages).sort((a, b) => a.ts - b.ts);
      const truncated = all.length > limit;
      const page = all.slice(0, limit);

      const messages: ActivityMessage[] = [];
      for (const m of page) {
        const chat = chatRegistry.get(m.chatId);
        // A chat the mirror no longer knows has no host to attribute it to.
        if (!chat) continue;
        messages.push({
          chatId: m.chatId,
          chatName: chat.name,
          daemonId: chat.daemonId,
          folder: chat.folder,
          text: m.text,
          ts: m.ts,
        });
      }
      // `+1`: the next page must not re-include the last message returned.
      const nextMessagesCursor = truncated ? (page[page.length - 1]?.ts ?? from) + 1 : undefined;
      return {
        messages,
        messagesTruncated: truncated,
        ...(nextMessagesCursor !== undefined ? { nextMessagesCursor } : {}),
      };
    },
    close() {
      unsubscribe();
      for (const w of [...waiting.values()]) w.reject(new Error('patch_activity: server closing'));
    },
  };
}
