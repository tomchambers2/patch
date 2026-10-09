// Chat search REST (spec/01 § Endpoints, spec/03 § Chat search).
//
//   GET /api/chats/search?q=<query>&limit=<n>&offset=<n>&fullText=<true|false>
//
// Searches every chat on every host — names and the full text of what was
// said. The transcripts live on the hosts (the server holds none), so this
// fans one `patch.chat_search.request` out to each ONLINE host, merges what
// comes back under the one shared ranking (`compareChatSearchHits`), and pages
// the merged list.
//
// NO SILENT OMISSION: every registered host is named in `hosts[]` with what
// happened to it — searched, offline (not asked), timed out, or failed — so a
// result list missing a machine's chats always says so. Auth is exactly the
// other chat routes': a live surface credential.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  CHAT_SEARCH_DEFAULT_LIMIT,
  CHAT_SEARCH_MAX_DEPTH,
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_MIN_QUERY,
  compareChatSearchHits,
  highlightRanges,
  parseSearchQuery,
  SPECIAL_THREAD_IDS,
  type ChatSearchSection,
  type ChatSearchHit,
  type ChatSearchHostResult,
  type ChatSearchResponse,
  type WireEvent,
} from '@patch/wire';
import type { Registry } from './registry.js';
import type { DaemonLink } from './daemon-link.js';
import type { ChatRegistry } from './chat-registry.js';
import type { ChatMirror } from './chat-mirror.js';
import { requireAuth } from './folder-routes.js';

export interface ChatSearchRoutesDeps {
  logger: Logger;
  registry: Registry;
  daemonLink: DaemonLink;
  chatRegistry: ChatRegistry;
  /** The server's copy of message text, used for chats whose host is offline. */
  mirror?: ChatMirror;
  idGenerator: () => string;
}

/**
 * How long one host has to answer. Generous because the first search after a
 * host restart waits for that host's index to finish building (seconds on a
 * host with gigabytes of transcript); a host that misses it is named as timed
 * out, and the others' results still come back.
 */
export const CHAT_SEARCH_TIMEOUT_MS = 15_000;

type Response = Extract<WireEvent, { type: 'patch.chat_search.response' }>;

interface HostOutcome {
  status: ChatSearchHostResult;
  hits: ChatSearchHit[];
  total: number;
}

/** A query parameter as a bounded integer, or a message saying why not. */
function intParam(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number | string {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return `${name} must be an integer ${min}..${max}`;
  }
  return n;
}

function sectionOf(
  chat: {
    chatId: string;
    status: string;
    hidden: boolean;
    pinned: boolean;
    snoozedUntil: number | null;
  },
  now: number,
): ChatSearchSection {
  if (chat.chatId === SPECIAL_THREAD_IDS.manager) return 'manager';
  if (chat.chatId === SPECIAL_THREAD_IDS.speakers) return 'channels';
  if (chat.status === 'archived') return 'archived';
  if (chat.hidden) return 'hidden';
  if (chat.status === 'active' && chat.snoozedUntil !== null && chat.snoozedUntil > now) {
    return 'snoozed';
  }
  return chat.pinned ? 'pinned' : 'folders';
}

export function registerChatSearchRoutes(app: FastifyInstance, deps: ChatSearchRoutesDeps): void {
  const pending = new Map<
    string,
    { resolve: (ev: Response) => void; timeout: NodeJS.Timeout; daemonId: string }
  >();
  deps.daemonLink.onEvent((event: WireEvent, from) => {
    if (event.type !== 'patch.chat_search.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    // Only the machine that was asked may answer for itself.
    if (event.daemonId !== w.daemonId || (from !== null && from !== w.daemonId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.daemonId, answered: event.daemonId, from },
        'chat search: response from a machine that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  /** Every machine this account knows: registered ones, plus any attached link. */
  function hostIds(): string[] {
    const ids = deps.registry.registeredDaemonIds();
    for (const linked of deps.daemonLink.onlineDaemonIds()) {
      if (!ids.includes(linked)) ids.push(linked);
    }
    return ids;
  }

  /**
   * An offline host cannot answer, so answer for it from what the server holds:
   * the chat registry's names and the mirrored message text. Hits are flagged
   * `mirrored` so a surface can say the host is not reachable right now.
   */
  function searchMirror(daemonId: string, query: string, fullText: boolean): HostOutcome {
    const hostName = deps.registry.hostName(daemonId) ?? null;
    const offline = { daemonId, hostName, state: 'offline' as const };
    if (!deps.mirror) return { status: offline, hits: [], total: 0 };
    const terms = parseSearchQuery(query);
    const now = Date.now();
    const hits: ChatSearchHit[] = [];
    let mirroredChats = 0;
    const mirrored = new Set(deps.mirror.chatIds());
    for (const chat of deps.chatRegistry.list({ includeArchived: true, includeSnoozed: true })) {
      if (chat.daemonId !== daemonId || chat.status === 'deleted') continue;
      if (!mirrored.has(chat.chatId) && chat.name === null) continue;
      mirroredChats++;
      const name = chat.name ?? '';
      const lowerName = name.toLowerCase();
      const nameMatch = terms.length > 0 && terms.every((t) => lowerName.includes(t));
      const found = fullText ? deps.mirror.search(query, chat.chatId) : null;
      if (!nameMatch && !found) continue;
      hits.push({
        chatId: chat.chatId,
        daemonId,
        name: chat.name,
        preview: chat.preview,
        folder: chat.folder,
        status: chat.status,
        section: sectionOf(chat, now),
        pinned: chat.pinned,
        snoozedUntil: chat.snoozedUntil,
        lastUpdated: chat.lastUpdated,
        jobId: null,
        nameMatch,
        nameHighlights: nameMatch ? highlightRanges(name, terms) : [],
        messageMatches: found?.messageMatches ?? 0,
        snippet: found?.snippet ?? null,
        mirrored: true,
      });
    }
    hits.sort(compareChatSearchHits);
    return {
      status: mirroredChats > 0 ? { ...offline, mirroredChats } : offline,
      hits,
      total: hits.length,
    };
  }

  async function askHost(
    daemonId: string,
    surfaceId: string,
    query: string,
    depth: number,
    fullText: boolean,
  ): Promise<HostOutcome> {
    const hostName = deps.registry.hostName(daemonId) ?? null;
    if (!deps.daemonLink.isOnline(daemonId)) {
      return searchMirror(daemonId, query, fullText);
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<Response | 'timeout'>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolve('timeout');
      }, CHAT_SEARCH_TIMEOUT_MS);
      pending.set(requestId, { resolve, timeout, daemonId });
      deps.daemonLink.sendTo(daemonId, surfaceId, {
        type: 'patch.chat_search.request',
        requestId,
        daemonId,
        query,
        limit: depth,
        fullText,
      });
    });
    if (result === 'timeout') {
      deps.logger.warn({ daemonId }, 'chat search: host did not answer in time');
      return { status: { daemonId, hostName, state: 'timeout' }, hits: [], total: 0 };
    }
    if (!result.ok) {
      const message = result.error?.message ?? 'search failed';
      deps.logger.warn({ daemonId, err: message }, 'chat search: host answered with a failure');
      return { status: { daemonId, hostName, state: 'error', message }, hits: [], total: 0 };
    }
    return {
      status: {
        daemonId,
        hostName,
        state: 'searched',
        ...(result.searchedChats !== undefined ? { searchedChats: result.searchedChats } : {}),
        ...(result.transcriptsMissing !== undefined
          ? { transcriptsMissing: result.transcriptsMissing }
          : {}),
      },
      hits: result.hits ?? [],
      total: result.total ?? 0,
    };
  }

  app.get<{ Querystring: { q?: string; limit?: string; offset?: string; fullText?: string } }>(
    '/api/chats/search',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const query = (req.query?.q ?? '').toString().trim();
      if (query.length < CHAT_SEARCH_MIN_QUERY) {
        return reply.code(400).send({
          error: 'query_too_short',
          message: `q must be at least ${CHAT_SEARCH_MIN_QUERY} characters`,
        });
      }
      const limit = intParam(
        req.query?.limit,
        'limit',
        CHAT_SEARCH_DEFAULT_LIMIT,
        1,
        CHAT_SEARCH_MAX_LIMIT,
      );
      const offset = intParam(req.query?.offset, 'offset', 0, 0, CHAT_SEARCH_MAX_DEPTH - 1);
      if (typeof limit === 'string' || typeof offset === 'string') {
        return reply
          .code(400)
          .send({ error: 'invalid_query', message: typeof limit === 'string' ? limit : offset });
      }
      const fullTextRaw = req.query?.fullText;
      if (
        fullTextRaw !== undefined &&
        fullTextRaw !== '' &&
        !['true', 'false', '1', '0'].includes(fullTextRaw)
      ) {
        return reply
          .code(400)
          .send({ error: 'invalid_query', message: 'fullText must be true or false' });
      }
      const fullText = fullTextRaw !== 'false' && fullTextRaw !== '0';
      // Each host sends its own top `depth`; the merged top `depth` is always
      // inside their union, so this page is exact.
      const depth = Math.min(offset + limit, CHAT_SEARCH_MAX_DEPTH);
      const outcomes = await Promise.all(
        hostIds().map((daemonId) => askHost(daemonId, auth.surfaceId, query, depth, fullText)),
      );
      const merged = outcomes
        .flatMap((o) => o.hits)
        .map((hit) => ({ ...hit, jobId: deps.chatRegistry.get(hit.chatId)?.jobId ?? null }))
        .sort(compareChatSearchHits);
      const total = outcomes.reduce((n, o) => n + o.total, 0);
      const end = offset + limit;
      const body: ChatSearchResponse = {
        query,
        hits: merged.slice(offset, depth),
        total,
        nextOffset: end < Math.min(total, CHAT_SEARCH_MAX_DEPTH) ? end : null,
        hosts: outcomes.map((o) => o.status),
      };
      return reply.code(200).send(body);
    },
  );
}
