// Chat-lifecycle REST endpoints.
//
// These mirror the WS surface events for HTTP clients (CLI cold-start,
// mobile pull-to-refresh) that don't keep a live socket open. State is
// served from an in-memory `ChatRegistry` populated by `chat.spawned` /
// `chat.state` events from the host.
//
// `POST /api/chats` allocates a ULID server-side, forwards a synthetic
// `chat.spawn_request` to the host over the daemon-link, and waits up
// to 5s for a `chat.error` matching the new chatId (or the host's
// `pending-spawn` placeholder for spawn-time failures). If one fires
// inside the window we return 400 with the error code synchronously
// (collapses fast spawn failures into a synchronous REST response —
// spec/04 implicitly expects this for `folder_not_found`). Otherwise
// we return 202 + the chatId; the actual `chat.spawned` arrives over WS.
//
// `archived` query parameter: `archived=only` (only archived) and
// `archived=include` (active + archived). Default omitted = active only.
// Anything else (including the legacy `archived=true` / `archived=all`) →
// 400 (group 8 docs pass tightened the enum to avoid ambiguity).
//
// NO FALLBACKS — folder-missing → 400; unknown chat → 404.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { verifySurfaceCredential } from '@patch/auth';
import { isReadOnlyMirrorThread, isReservedSpecialThread, TodoItem } from '@patch/wire';
import type { ChatErrorCode, ChatSpawnRequestEvent, WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { DaemonLink } from './daemon-link.js';
import type { ChatRegistry } from './chat-registry.js';
import type { ChatLogStore } from './chat-log-store.js';
import type { ComposerDraftStore } from './composer-drafts.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';
import { unknownChatReply } from './unknown-chat.js';

const SpawnBody = z
  .object({
    /**
     * The host to run on. REQUIRED (spec/01 § Endpoints, spec/04 § Spawn) —
     * a spawn that names no host is a 400 naming the field, never a spawn on
     * whichever host happens to be attached.
     */
    daemonId: z.string().min(1),
    folder: z.string().min(1),
    prompt: z.string().optional(),
    name: z.string().optional(),
    parentChatId: z.string().min(1).optional(),
    /** Idempotency: server forwards to host's spawn-dedupe. */
    localId: z.string().min(1).optional(),
    /** SDK model override (CLI `--model`). Forwarded to the host spawn RPC. */
    model: z.string().min(1).optional(),
    /** SDK permission mode (CLI `--dangerously-skip-permissions`). */
    permissionMode: z
      .enum(['auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan'])
      .optional(),
    /** The shared account the chat's turns start on (spec/10 § Backend credentials — preferred account). */
    preferredAccountId: z.string().min(1).optional(),
  })
  .strict();

/** `GET /api/models?daemonId=` — the host whose catalogue is being read. */
const ModelsQuery = z.object({ daemonId: z.string().min(1) }).strict();

/** `GET /api/skills?folder=&daemonId=` — the folder and host being listed. */
const SkillsQuery = z.object({ folder: z.string().min(1), daemonId: z.string().min(1) }).strict();

/** How long POST /api/chats blocks waiting for an immediate spawn-time chat.error. */
const SPAWN_ERROR_WAIT_MS = 5_000;

/** Host's placeholder chatId for spawn-time errors that pre-date a real chat. */
const PENDING_SPAWN_PLACEHOLDER = 'pending-spawn';

interface SpawnFailure {
  code: ChatErrorCode;
  message: string;
  /**
   * The chatId the host's `chat.error` actually went out under — the
   * allocated one, or `pending-spawn` from a host that refused before it read
   * the id we supplied. The hub fans that frame out to every surface, and a
   * surface builds a chat row from any chatId it has not seen before, so this
   * is the id whose row has to be retracted (see the failure response below).
   */
  wireChatId: string;
}

interface PendingSpawn {
  resolve: (result: SpawnFailure | 'spawned') => void;
  timeout: NodeJS.Timeout;
}

async function requireAuth(
  req: FastifyRequest,
  registry: Registry,
): Promise<{ accountId: string; surfaceId: string }> {
  const generic = (): Error & { statusCode?: number } => {
    const e = new Error('unauthenticated') as Error & { statusCode?: number };
    e.statusCode = 401;
    return e;
  };
  const account = registry.getAccount();
  if (!account) throw generic();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw generic();
  const jwt = authHeader.slice('Bearer '.length).trim();
  let claims;
  try {
    claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
  } catch {
    throw generic();
  }
  if (registry.isRevoked(claims.surface_id)) throw generic();
  return { accountId: account.accountId, surfaceId: claims.surface_id };
}

/**
 * The `model` field for a spawn frame: what the request named, else the
 * account default, else nothing at all (the host then uses the default the
 * server mirrored to it, and refuses the spawn if it has none).
 */
function spawnModelField(
  requested: string | undefined,
  accountDefault: string | undefined,
): { model?: string } {
  const model = requested ?? accountDefault;
  return model === undefined ? {} : { model };
}

export interface ChatRoutesDeps {
  logger: Logger;
  registry: Registry;
  daemonLink: DaemonLink;
  chatRegistry: ChatRegistry;
  /**
   * Server-owned composer drafts (spec/14 § Composer): a deleted chat's draft
   * is dropped here on soft-delete, the same "deleting the chat drops it" rule
   * that governs its localStorage/MMKV predecessors.
   */
  composerDrafts: ComposerDraftStore;
  /**
   * The transcripts the server has seen pass through it. Answers a history
   * read for a chat whose host is offline.
   */
  chatLogStore?: ChatLogStore;
  idGenerator: () => string;
  /**
   * The account's `defaultModel` — the model a spawn that names none runs on.
   *
   * Filled in HERE rather than left off: an omitted `model` used to resolve on
   * the machine, through its own last-used model, which drifted to whatever
   * anyone last ran there. The default is an account decision, so the account's
   * server is where it is applied.
   *
   * Absent (a test with no settings store) leaves the field off, which the
   * host then resolves against the default the server mirrored to it.
   */
  defaultModel?: () => string | undefined;
  /** Override the spawn-error wait window for tests. */
  spawnErrorWaitMs?: number;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRoutesDeps): void {
  // A chat the mirror does not hold: 404 only once every host has reported its
  // chats since the server started, else 503 naming the host still to report.
  const sendUnknownChat = (reply: FastifyReply, chatId: string): FastifyReply => {
    const { status, body } = unknownChatReply(deps, chatId);
    return reply.code(status).send(body);
  };
  // chatId → pending POST waiter. Populated when POST /api/chats forwards a
  // spawn; consumed when the host emits a matching `chat.error` (real id,
  // or 'pending-spawn' before the host learnt the server-allocated id).
  const pending = new Map<string, PendingSpawn>();
  // Single most-recent pending-spawn waiter — host may emit chat.error
  // before it knew the server-allocated chatId for purely-pre-daemon
  // failures (current host emits with the supplied chatId, but we keep
  // this as a safety net).
  let pendingPlaceholder: { chatId: string } | null = null;

  // Tap the host link so we can resolve pending POST waiters when the
  // host emits chat.error (failure) or chat.spawned (success) within
  // the 5s window. If the spawn succeeds, we return 202 immediately rather
  // than holding the request open for the full window.
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type === 'chat.error') {
      let target = event.chatId;
      if (target === PENDING_SPAWN_PLACEHOLDER && pendingPlaceholder) {
        target = pendingPlaceholder.chatId;
      }
      const w = pending.get(target);
      if (!w) return;
      pending.delete(target);
      if (pendingPlaceholder?.chatId === target) pendingPlaceholder = null;
      clearTimeout(w.timeout);
      w.resolve({
        code: event.error.code,
        message: event.error.message,
        wireChatId: event.chatId,
      });
      return;
    }
    if (event.type === 'chat.spawned') {
      const w = pending.get(event.chatId);
      if (!w) return;
      pending.delete(event.chatId);
      if (pendingPlaceholder?.chatId === event.chatId) pendingPlaceholder = null;
      clearTimeout(w.timeout);
      w.resolve('spawned');
      return;
    }
  });

  // ---- POST /api/chats ----
  app.post('/api/chats', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = SpawnBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    // The named machine must be one this account has registered (spec/04
    // § Spawn). Refused BEFORE anything is allocated or forwarded, so an
    // unknown machine leaves no chat behind anywhere.
    const unknownHost = checkRegisteredHost(deps.registry, parsed.data.daemonId);
    if (unknownHost) {
      deps.logger.warn(
        { daemonId: parsed.data.daemonId, folder: parsed.data.folder },
        'POST /api/chats rejected: unregistered daemonId',
      );
      return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
    }
    const chatId = deps.idGenerator();
    const event: ChatSpawnRequestEvent = {
      type: 'chat.spawn_request',
      daemonId: parsed.data.daemonId,
      folder: parsed.data.folder,
      chatId,
      ...(parsed.data.prompt !== undefined ? { prompt: parsed.data.prompt } : {}),
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.parentChatId !== undefined ? { parentChatId: parsed.data.parentChatId } : {}),
      ...(parsed.data.localId !== undefined ? { localId: parsed.data.localId } : {}),
      ...spawnModelField(parsed.data.model, deps.defaultModel?.()),
      ...(parsed.data.permissionMode !== undefined
        ? { permissionMode: parsed.data.permissionMode }
        : {}),
      ...(parsed.data.preferredAccountId !== undefined
        ? { preferredAccountId: parsed.data.preferredAccountId }
        : {}),
    };

    // Register a waiter BEFORE forwarding so we never miss a fast emit.
    const waitResult = new Promise<SpawnFailure | 'spawned' | 'timeout'>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(chatId);
        if (pendingPlaceholder?.chatId === chatId) pendingPlaceholder = null;
        resolve('timeout');
      }, deps.spawnErrorWaitMs ?? SPAWN_ERROR_WAIT_MS);
      pending.set(chatId, { resolve: (r) => resolve(r), timeout });
      pendingPlaceholder = { chatId };
    });

    deps.daemonLink.send(auth.surfaceId, event);
    deps.logger.info(
      { chatId, folder: parsed.data.folder, surfaceId: auth.surfaceId },
      'POST /api/chats forwarded spawn to host',
    );

    const result = await waitResult;
    if (result !== 'timeout' && result !== 'spawned') {
      deps.logger.warn(
        { chatId, code: result.code, message: result.message },
        'POST /api/chats: synchronous spawn failure',
      );
      let enriched = result.message;
      if (result.code === 'folder_not_found') {
        enriched = `folder does not exist on the host: ${parsed.data.folder}. Note: paths are checked on the host container/host, not the caller's machine.`;
      }
      // No `chatId` in the failure body: the spawn never created a chat, so
      // surfacing the server-allocated id would be misleading (it is absent
      // from GET /api/chats). E1-d6.
      //
      // `retractChatId` is that same id under a name that says what it is FOR,
      // and it is the other half of E1-d6 rather than a walk-back of it. The
      // host's refusal went out to every surface as a `chat.error` carrying
      // this id (ws-hub fans chat-scoped events out), and a surface draws a row
      // for any chatId it has not seen before — so refusing without naming the
      // id left a "New chat" row behind on the sidebar for a chat that does not
      // exist, one per failed spawn, until a reload. The caller is the only
      // party that can retract it: it is the only one that knows this
      // particular spawn was refused. spec/04 § Spawn.
      return reply.code(400).send({
        error: result.code,
        message: enriched,
        retractChatId: result.wireChatId,
      });
    }

    return reply.code(202).send({
      chatId,
      folder: parsed.data.folder,
      status: 'pending',
    });
  });

  // ---- GET /api/chats ----
  app.get('/api/chats', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const url = new URL(req.url, 'http://_');
    const archivedParam = url.searchParams.get('archived');
    let includeArchived = false;
    let archivedOnly = false;
    if (archivedParam !== null) {
      if (archivedParam === 'only') {
        archivedOnly = true;
      } else if (archivedParam === 'include') {
        includeArchived = true;
      } else {
        return reply.code(400).send({
          error: `archived must be 'only' or 'include' (got ${JSON.stringify(archivedParam)})`,
        });
      }
    }
    // Soft-deleted chats (spec/04 § Lifecycle) — the sidebar's Deleted section
    // fetches them via `?deleted=only`. Any other value is rejected (NO
    // FALLBACK), matching the `archived` param's strictness.
    const deletedParam = url.searchParams.get('deleted');
    let deletedOnly = false;
    if (deletedParam !== null) {
      if (deletedParam === 'only') {
        deletedOnly = true;
      } else {
        return reply.code(400).send({
          error: `deleted must be 'only' (got ${JSON.stringify(deletedParam)})`,
        });
      }
    }
    // Snoozed chats (spec/04 § Snooze) — hidden from the default active list
    // until their wake time; the sidebar's Snoozed section fetches them via
    // `?snoozed=only`, and `include` returns active + snoozed. Any other value
    // is rejected (NO FALLBACK), matching the other params' strictness.
    const snoozedParam = url.searchParams.get('snoozed');
    let snoozedOnly = false;
    let includeSnoozed = false;
    if (snoozedParam !== null) {
      if (snoozedParam === 'only') {
        snoozedOnly = true;
      } else if (snoozedParam === 'include') {
        includeSnoozed = true;
      } else {
        return reply.code(400).send({
          error: `snoozed must be 'only' or 'include' (got ${JSON.stringify(snoozedParam)})`,
        });
      }
    }
    // Hidden chats (spec/04 § Hidden) — running out of the active list; the
    // sidebar's Hidden section fetches them via `?hidden=only`. Any other value
    // is rejected (NO FALLBACK), matching the other params' strictness.
    const hiddenParam = url.searchParams.get('hidden');
    let hiddenOnly = false;
    if (hiddenParam !== null) {
      if (hiddenParam === 'only') {
        hiddenOnly = true;
      } else {
        return reply.code(400).send({
          error: `hidden must be 'only' (got ${JSON.stringify(hiddenParam)})`,
        });
      }
    }
    // Job-spawned chats (spec/08 § Action) — the sidebar's Automations group
    // fetches them via `?automations=only`, independent of archived/snoozed
    // status. Any other value is rejected (NO FALLBACK), matching the other
    // params' strictness.
    const automationsParam = url.searchParams.get('automations');
    let automationsOnly = false;
    if (automationsParam !== null) {
      if (automationsParam === 'only') {
        automationsOnly = true;
      } else {
        return reply.code(400).send({
          error: `automations must be 'only' (got ${JSON.stringify(automationsParam)})`,
        });
      }
    }
    // Sort direction (spec/14 § Sidebar item 6): `'asc'` is what Hidden and
    // Automations page in, matching their FIFO oldest-first display. Any
    // other value is rejected (NO FALLBACK), matching every other param here.
    const orderParam = url.searchParams.get('order');
    let order: 'asc' | 'desc' | undefined;
    if (orderParam !== null) {
      if (orderParam === 'asc' || orderParam === 'desc') {
        order = orderParam;
      } else {
        return reply
          .code(400)
          .send({ error: `order must be 'asc' or 'desc' (got ${JSON.stringify(orderParam)})` });
      }
    }
    // Pagination (spec/14 § Sidebar item 6: "load a limited number... then
    // load more on scroll"). `limit` absent → every matching chat, as before
    // every existing caller (the default active list included) relies on.
    // Present, it must be a `1..200` integer — same bound and NO-FALLBACK
    // strictness as `GET /api/chats/:id/history`'s own `limit`.
    let limit: number | undefined;
    const limitParam = url.searchParams.get('limit');
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isInteger(n) || n <= 0 || n > 200) {
        return reply.code(400).send({ error: 'limit must be an integer 1..200', got: limitParam });
      }
      limit = n;
    }
    let offset = 0;
    const offsetParam = url.searchParams.get('offset');
    if (offsetParam !== null) {
      const n = Number(offsetParam);
      if (!Number.isInteger(n) || n < 0) {
        return reply
          .code(400)
          .send({ error: 'offset must be a non-negative integer', got: offsetParam });
      }
      offset = n;
    }
    const full = deps.chatRegistry.list({
      includeArchived,
      archivedOnly,
      deletedOnly,
      snoozedOnly,
      includeSnoozed,
      hiddenOnly,
      automationsOnly,
      order,
    });
    const chats = limit === undefined ? full : full.slice(offset, offset + limit);
    const nextOffset =
      limit !== undefined && offset + chats.length < full.length ? offset + chats.length : null;
    return reply.code(200).send({ chats, nextOffset });
  });

  // ---- GET /api/chats/folders ----
  // The folder roster (spec/04 § Folders → Folder roster): one row per distinct
  // folder across every non-deleted chat, archived included.
  //
  // The sidebar's "Recent projects" is defined as every folder that has a chat
  // INCLUDING folders whose chats are all archived (spec/14 §4b), but it used to
  // be derived from the cold-start `GET /api/chats` roster — which excludes
  // archived chats — so archiving the last chat in a folder made the folder
  // vanish on the next reload. Serving the roster separately fixes that without
  // pulling the unbounded archived list into cold-start: this response is
  // O(folders), not O(chats).
  //
  // Registered BEFORE `/api/chats/:id` for legibility; Fastify's router prefers
  // the static segment either way (pinned by a test).
  app.get('/api/chats/folders', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    return reply.code(200).send({ folders: deps.chatRegistry.folders() });
  });

  // ---- GET /api/chats/counts ----
  // Section counts (spec/04 § Section counts): the size of each lifecycle
  // section, with no chat rows in the response.
  //
  // The sidebar's cold-storage rows are collapsed by default and their lists
  // load on expand, so a surface cannot measure them from its own chat list —
  // it holds only the sections already opened, and the cold-start
  // `GET /api/chats` excludes archived, snoozed and deleted chats entirely.
  // Serving bare totals is what lets a collapsed row carry a number without
  // fetching the unbounded lists behind it.
  //
  // Each total is `list()` under the SAME filter flag the section's own query
  // uses, deliberately reusing the predicates rather than restating them: the
  // number must equal the rows the surface gets on expanding, and sharing one
  // implementation is what guarantees that instead of merely asserting it.
  // Counting a filtered array is O(chats) over an in-memory map — the same
  // work the list route already does, minus serialising the rows.
  //
  // Registered BEFORE `/api/chats/:id` for legibility; Fastify's router prefers
  // the static segment either way (pinned by a test).
  app.get('/api/chats/counts', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    return reply.code(200).send({
      archived: deps.chatRegistry.list({ archivedOnly: true }).length,
      snoozed: deps.chatRegistry.list({ snoozedOnly: true }).length,
      hidden: deps.chatRegistry.list({ hiddenOnly: true }).length,
      deleted: deps.chatRegistry.list({ deletedOnly: true }).length,
      automations: deps.chatRegistry.list({ automationsOnly: true }).length,
    });
  });

  // ---- GET /api/chats/:id ----
  app.get<{ Params: { id: string } }>('/api/chats/:id', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const summary = deps.chatRegistry.get(req.params.id);
    if (!summary) {
      return sendUnknownChat(reply, req.params.id);
    }
    return reply.code(200).send(summary);
  });

  // ---- GET /api/chats/:id/history?since=<seq>&branchId=<id> ----
  // Returns the chat's events with seq >= since. The host owns Claude Code's
  // persisted JSONL (the server doesn't share its filesystem), so this
  // round-trips a `patch.chat_history.request` over the daemon-link and waits
  // up to 5s for the matching response. NO FALLBACK: timeout → 504; host
  // errors bubble up with a typed body; unknown chat → 404. `branchId` reads
  // that branch's own track (spec/04 § Branching) instead of the active one —
  // this is how the side threads panel (spec/14) pulls a tab's content, since
  // a side branch's messages are not broadcast live over the chat's WS.
  const HISTORY_REQUEST_TIMEOUT_MS = 5_000;
  const historyPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.chat_history.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.chat_history.response') return;
    const w = historyPending.get(event.requestId);
    if (!w) return;
    historyPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.get<{
    Params: { id: string };
    Querystring: { since?: string; limit?: string; branchId?: string };
  }>('/api/chats/:id/history', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    // Parse `since` strictly: a present-but-non-numeric value is a 400, not
    // a silently-ignored default (NO FALLBACK).
    let since: number | undefined;
    if (req.query?.since !== undefined && req.query.since !== '') {
      const n = Number(req.query.since);
      if (!Number.isInteger(n) || n < 0) {
        return reply
          .code(400)
          .send({ error: 'since must be a non-negative integer', got: req.query.since });
      }
      since = n;
    }
    let limit: number | undefined;
    if (req.query?.limit !== undefined && req.query.limit !== '') {
      const n = Number(req.query.limit);
      if (!Number.isInteger(n) || n <= 0 || n > 200) {
        return reply
          .code(400)
          .send({ error: 'limit must be an integer 1..200', got: req.query.limit });
      }
      limit = n;
    }
    // A host that is offline cannot answer, but the server holds what passed
    // through it. Side-branch reads name a track the server does not keep.
    const hostId = deps.chatRegistry.get(req.params.id)?.daemonId;
    if (
      deps.chatLogStore &&
      req.query?.branchId === undefined &&
      hostId !== undefined &&
      !deps.daemonLink.isOnline(hostId) &&
      deps.chatLogStore.has(req.params.id)
    ) {
      const held = deps.chatLogStore.read(req.params.id, (since ?? 0) - 1, limit);
      return reply.code(200).send({ events: held, fromServerCopy: true });
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.chat_history.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        historyPending.delete(requestId);
        resolveP('timeout');
      }, HISTORY_REQUEST_TIMEOUT_MS);
      historyPending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(auth.surfaceId, {
        type: 'patch.chat_history.request',
        requestId,
        chatId: req.params.id,
        ...(since !== undefined ? { since } : {}),
        ...(limit !== undefined ? { limit } : {}),
        // spec/14 § Side threads panel — pull a side thread's own track
        // through this REST path rather than the live WS stream.
        ...(req.query?.branchId ? { branchId: req.query.branchId } : {}),
      });
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      const status = code === 'chat_not_found' ? 404 : 502;
      return reply
        .code(status)
        .send({ error: code, message: result.error?.message ?? 'history error' });
    }
    return reply.code(200).send({
      events: result.events ?? [],
      ...(result.nextFromSeq !== undefined ? { nextFromSeq: result.nextFromSeq } : {}),
    });
  });

  // ---- GET /api/chats/:parentId/delegates/:id/history ----
  // The parent tool row's "open read-only transcript" (spec/14 § Main chat
  // panel — Delegate tool row). A subagent chat is never in `chatRegistry`
  // (spec/02 § Native subagent dispatch), so the ordinary route above can't
  // be reused as-is: this one gates on the PARENT being a real, known chat
  // instead, and carries `requireParent` so the host itself refuses to read
  // back anything that isn't actually that parent's own delegate.
  app.get<{ Params: { parentId: string; id: string }; Querystring: { since?: string } }>(
    '/api/chats/:parentId/delegates/:id/history',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      if (!deps.chatRegistry.get(req.params.parentId)) {
        return sendUnknownChat(reply, req.params.parentId);
      }
      let since: number | undefined;
      if (req.query?.since !== undefined && req.query.since !== '') {
        const n = Number(req.query.since);
        if (!Number.isInteger(n) || n < 0) {
          return reply
            .code(400)
            .send({ error: 'since must be a non-negative integer', got: req.query.since });
        }
        since = n;
      }
      const requestId = deps.idGenerator();
      const result = await new Promise<
        Extract<WireEvent, { type: 'patch.chat_history.response' }> | 'timeout'
      >((resolveP) => {
        const timeout = setTimeout(() => {
          historyPending.delete(requestId);
          resolveP('timeout');
        }, HISTORY_REQUEST_TIMEOUT_MS);
        historyPending.set(requestId, { resolve: resolveP, timeout });
        deps.daemonLink.send(auth.surfaceId, {
          type: 'patch.chat_history.request',
          requestId,
          chatId: req.params.id,
          requireParent: req.params.parentId,
          ...(since !== undefined ? { since } : {}),
        });
      });
      if (result === 'timeout') {
        return reply.code(504).send({ error: 'daemon_timeout' });
      }
      if (!result.ok) {
        const code = result.error?.code ?? 'internal';
        const status = code === 'chat_not_found' || code === 'not_a_delegate' ? 404 : 502;
        return reply
          .code(status)
          .send({ error: code, message: result.error?.message ?? 'history error' });
      }
      return reply.code(200).send({
        events: result.events ?? [],
        ...(result.nextFromSeq !== undefined ? { nextFromSeq: result.nextFromSeq } : {}),
      });
    },
  );

  // ---- POST /api/chats/:id/send-to ----
  // Forward a user-turn into a chat over the daemon-link as `chat.input`.
  const SendToBody = z
    .object({
      message: z.string(),
      localId: z.string().min(1).optional(),
      voicePrefix: z.string().optional(),
    })
    .strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/send-to', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = SendToBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    // NO SILENT FALLBACK (H1-d3): a send-to an unknown chatId must be rejected,
    // not optimistically queued — otherwise a misrouted message is accepted and
    // silently dropped host-side. Same existence check as the sibling
    // /files, /history, /stop routes.
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    // spec/06 ## Composer policy (H1-d2): Speakers is a read-only mirror.
    // This surface-JWT-authed route must enforce the SAME guard as
    // POST /api/threads/:thread/send-to and the WS hub's chat.input handler —
    // a surface cannot inject a user turn into a passive-mirror thread (whose
    // real ingress is the voice device). Manager stays writable.
    if (isReadOnlyMirrorThread(req.params.id)) {
      return reply.code(403).send({
        error: `thread ${req.params.id} is a read-only mirror; composer disabled (spec/06)`,
      });
    }
    const localId = parsed.data.localId ?? deps.idGenerator();
    const message =
      parsed.data.voicePrefix !== undefined && parsed.data.voicePrefix.length > 0
        ? parsed.data.voicePrefix + parsed.data.message
        : parsed.data.message;
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.input',
      chatId: req.params.id,
      message,
      localId,
    });
    return reply.code(200).send({ ok: true, queued: true, localId });
  });

  // ---- GET /api/chats/:id/files?path=<rel> ----
  // Group 19: surface file-browser fetches. Round-trips a
  // `patch.files.request` over the daemon-link and waits up to 5s for the
  // matching response. NO FALLBACK: timeout returns 504; host errors
  // bubble up with a typed body.
  const FILES_REQUEST_TIMEOUT_MS = 5_000;
  const filesPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.files.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.files.response') return;
    const w = filesPending.get(event.requestId);
    if (!w) return;
    filesPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.get<{
    Params: { id: string };
    Querystring: {
      path?: string;
      content?: string;
      recursive?: string;
      maxEntries?: string;
      ref?: string;
    };
  }>('/api/chats/:id/files', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    const requestId = deps.idGenerator();
    const path = (req.query?.path ?? '').toString();
    // Group 20 fix-7 #2: defense-in-depth path validation. The host
    // re-validates inside a sandbox, but rejecting at the boundary is
    // cheaper and removes the foot-gun of trusting host-side checks
    // alone. NO FALLBACK: any escape-attempt is a 400.
    if (path.includes('..') || path.startsWith('/')) {
      return reply.code(400).send({ error: 'path_invalid', message: 'path must be relative' });
    }
    const wantContent = req.query?.content === '1' || req.query?.content === 'true';
    const wantRecursive = req.query?.recursive === '1' || req.query?.recursive === 'true';
    // G3-d4: validate maxEntries at the HTTP boundary. The host's wire
    // schema requires a positive integer (z.number().int().positive()), so a
    // malformed value (NaN from Number('abc'), a negative, a non-integer) would
    // serialize to a frame the host rejects silently — the request would then
    // hang the full FILES_REQUEST_TIMEOUT and return a misleading 504
    // daemon_timeout for what is really a bad client param. NO FALLBACK: reject
    // fast with a typed 400 instead.
    let maxEntries: number | undefined;
    if (req.query?.maxEntries !== undefined && req.query.maxEntries !== '') {
      const n = Number(req.query.maxEntries);
      if (!Number.isInteger(n) || n <= 0) {
        return reply.code(400).send({
          error: 'maxEntries_invalid',
          message: 'maxEntries must be a positive integer',
        });
      }
      maxEntries = n;
    }
    const ref = req.query?.ref === 'head' ? ('head' as const) : undefined;
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.files.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        filesPending.delete(requestId);
        resolveP('timeout');
      }, FILES_REQUEST_TIMEOUT_MS);
      filesPending.set(requestId, { resolve: resolveP, timeout });
      const frame: WireEvent = {
        type: 'patch.files.request',
        requestId,
        chatId: req.params.id,
        path,
        ...(wantContent ? { content: true } : {}),
        ...(wantRecursive ? { recursive: true } : {}),
        ...(maxEntries !== undefined ? { maxEntries } : {}),
        ...(ref !== undefined ? { ref } : {}),
      };
      deps.daemonLink.send(auth.surfaceId, frame);
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      // G3: typed host error codes map to precise HTTP statuses. Client-side
      // problems are 4xx (not 502 bad-gateway); only a genuine host-side
      // failure is 502.
      const statusByCode: Record<string, number> = {
        chat_not_found: 404, // no such chat
        not_found: 404, // G3-d2: missing file path
        path_escape: 400, // path escaped the chat folder
        not_a_file: 400, // G3-d3: content requested for a directory
        no_head_baseline: 409, // G3-d1: no git HEAD to diff against
        internal: 502, // genuine host-side failure
      };
      const status = statusByCode[code] ?? 502;
      return reply
        .code(status)
        .send({ error: code, message: result.error?.message ?? 'files error' });
    }
    if (wantContent) {
      return reply.code(200).send({
        path: result.path ?? '',
        content: result.content ?? '',
        size: result.size ?? 0,
      });
    }
    return reply.code(200).send({ path: result.path ?? '', entries: result.entries ?? [] });
  });

  // ---- GET /api/chats/:id/files/raw?path=<rel> ----
  // Editor overhaul (binary preview): images/PDF preview in the file browser.
  // Round-trips the SAME `patch.files.request` / `patch.files.response` pair
  // as the JSON route above (same pending map, same timeout, same typed error
  // mapping), asking the host to base64-encode the bytes (`encoding:
  // 'base64'`) instead of decoding them as UTF-8, and answers with the raw
  // bytes under the file's real Content-Type rather than JSON.
  //
  // Still behind `requireAuth` — same bearer-header auth as every other route
  // here. That means a plain `<img src="...">` can't hit this directly (the
  // browser has no way to attach an Authorization header to an image-tag
  // request); the web client instead fetches this with the header, builds a
  // Blob, and points the `<img>`/`<embed>` at an object URL. NO FALLBACK: the
  // host round-trip's failure modes are the exact ones the JSON route
  // already has typed responses for.
  const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
  };
  function mimeTypeFor(path: string): string {
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
  }
  app.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>('/api/chats/:id/files/raw', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    const path = (req.query?.path ?? '').toString();
    // Same defense-in-depth as the JSON route, plus an empty path is never
    // valid here — there is no "raw bytes of the root directory".
    if (path === '' || path.includes('..') || path.startsWith('/')) {
      return reply.code(400).send({ error: 'path_invalid', message: 'path must be relative' });
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.files.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        filesPending.delete(requestId);
        resolveP('timeout');
      }, FILES_REQUEST_TIMEOUT_MS);
      filesPending.set(requestId, { resolve: resolveP, timeout });
      const frame: WireEvent = {
        type: 'patch.files.request',
        requestId,
        chatId: req.params.id,
        path,
        content: true,
        encoding: 'base64',
      };
      deps.daemonLink.send(auth.surfaceId, frame);
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      const statusByCode: Record<string, number> = {
        chat_not_found: 404,
        not_found: 404,
        path_escape: 400,
        not_a_file: 400,
        no_head_baseline: 409,
        internal: 502,
      };
      const status = statusByCode[code] ?? 502;
      return reply
        .code(status)
        .send({ error: code, message: result.error?.message ?? 'files error' });
    }
    const buffer = Buffer.from(result.content ?? '', 'base64');
    return reply.code(200).type(mimeTypeFor(path)).send(buffer);
  });

  // ---- POST /api/chats/:id/files ----
  // The file browser's create / rename / delete (spec/14 § File browser).
  // Round-trips a `patch.file_op.request` over the daemon-link, same rails and
  // same timeout as the listing above, and answers with what the host did.
  // NO FALLBACK: a timeout is a 504 and every refusal keeps its own status, so
  // a destructive operation can never read as having happened when it did not.
  const fileOpPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.file_op.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.file_op.response') return;
    const w = fileOpPending.get(event.requestId);
    if (!w) return;
    fileOpPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.post<{
    Params: { id: string };
    Body: { op?: string; path?: string; to?: string };
  }>('/api/chats/:id/files', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    const body = req.body ?? {};
    const ops = ['create', 'create_dir', 'delete', 'rename'] as const;
    const op = ops.find((o) => o === body.op);
    if (op === undefined) {
      return reply
        .code(400)
        .send({ error: 'op_invalid', message: `op must be one of ${ops.join(', ')}` });
    }
    // Defense in depth, exactly as the listing route does it: the host
    // re-validates against the real root, but an escape attempt is refused at
    // the boundary too. The chat folder itself is never a target, so an empty
    // path is as invalid as a traversing one.
    const bad = (p: string | undefined): boolean =>
      p === undefined || p === '' || p.includes('..') || p.startsWith('/');
    if (bad(body.path)) {
      return reply
        .code(400)
        .send({ error: 'path_invalid', message: 'path must be relative and non-empty' });
    }
    if (op === 'rename' && bad(body.to)) {
      return reply
        .code(400)
        .send({ error: 'path_invalid', message: 'to must be relative and non-empty' });
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.file_op.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        fileOpPending.delete(requestId);
        resolveP('timeout');
      }, FILES_REQUEST_TIMEOUT_MS);
      fileOpPending.set(requestId, { resolve: resolveP, timeout });
      const frame: WireEvent = {
        type: 'patch.file_op.request',
        requestId,
        chatId: req.params.id,
        op,
        path: body.path as string,
        ...(op === 'rename' ? { to: body.to as string } : {}),
      };
      deps.daemonLink.send(auth.surfaceId, frame);
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      const statusByCode: Record<string, number> = {
        chat_not_found: 404,
        not_found: 404,
        path_escape: 400,
        missing_target: 400,
        exists: 409,
        not_empty: 409,
        internal: 502,
      };
      return reply
        .code(statusByCode[code] ?? 502)
        .send({ error: code, message: result.error?.message ?? 'file operation failed' });
    }
    return reply.code(200).send({ path: result.path ?? '' });
  });

  // ---- GET /api/chats/:id/doc?path=<rel> ----
  // spec/14 § Document editor, step 2 of 3 — mode, suggestions, threads,
  // versions for one `.md` file. Same round-trip rails as GET /files above.
  const DOC_REQUEST_TIMEOUT_MS = 5_000;
  // Word import/export (spec/14 § Document editor, step 3 of 3): a PDF export
  // launches a real headless browser, and a .docx import walks + extracts
  // every image — both routinely slower than the sub-second sidecar RPCs
  // above, so they get a longer timeout rather than sharing the 5s one.
  const DOC_CONVERT_EXPORT_TIMEOUT_MS = 30_000;
  const docPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.doc.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.doc.response') return;
    const w = docPending.get(event.requestId);
    if (!w) return;
    docPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  const DOC_ERROR_STATUS: Record<string, number> = {
    chat_not_found: 404,
    not_found: 404,
    path_escape: 400,
    conflict: 409,
    internal: 502,
    invalid: 400,
    browser_missing: 503,
  };
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/chats/:id/doc',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      if (!deps.chatRegistry.get(req.params.id)) {
        return sendUnknownChat(reply, req.params.id);
      }
      const path = (req.query?.path ?? '').toString();
      if (path === '' || path.includes('..') || path.startsWith('/')) {
        return reply.code(400).send({ error: 'path_invalid', message: 'path must be relative' });
      }
      const requestId = deps.idGenerator();
      const result = await new Promise<
        Extract<WireEvent, { type: 'patch.doc.response' }> | 'timeout'
      >((resolveP) => {
        const timeout = setTimeout(() => {
          docPending.delete(requestId);
          resolveP('timeout');
        }, DOC_REQUEST_TIMEOUT_MS);
        docPending.set(requestId, { resolve: resolveP, timeout });
        deps.daemonLink.send(auth.surfaceId, {
          type: 'patch.doc.request',
          requestId,
          chatId: req.params.id,
          path,
        });
      });
      if (result === 'timeout') {
        return reply.code(504).send({ error: 'daemon_timeout' });
      }
      if (!result.ok) {
        const code = result.error?.code ?? 'internal';
        return reply
          .code(DOC_ERROR_STATUS[code] ?? 502)
          .send({ error: code, message: result.error?.message ?? 'doc error' });
      }
      return reply.code(200).send(result.view);
    },
  );

  // ---- POST /api/chats/:id/doc/action ----
  // spec/14 § Document editor, step 2 of 3 — every surface-facing doc
  // mutation (mode switch, accept/reject suggestion(s), comment/reply/
  // resolve, restore). `action` is forwarded verbatim; the host's own
  // `DocAction` schema (wire) is the real validation — this route only
  // checks the shape well enough to give a fast 400 instead of a 5s timeout
  // on something the host would reject outright.
  const docActionPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.doc_action.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.doc_action.response') return;
    const w = docActionPending.get(event.requestId);
    if (!w) return;
    docActionPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.post<{
    Params: { id: string };
    Body: { path?: string; action?: { op?: string } & Record<string, unknown> };
  }>('/api/chats/:id/doc/action', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    const body = req.body ?? {};
    const path = body.path ?? '';
    if (path === '' || path.includes('..') || path.startsWith('/')) {
      return reply.code(400).send({ error: 'path_invalid', message: 'path must be relative' });
    }
    if (!body.action || typeof body.action.op !== 'string') {
      return reply.code(400).send({ error: 'action_invalid', message: 'action.op is required' });
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.doc_action.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        docActionPending.delete(requestId);
        resolveP('timeout');
      }, DOC_REQUEST_TIMEOUT_MS);
      docActionPending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(auth.surfaceId, {
        type: 'patch.doc_action.request',
        requestId,
        chatId: req.params.id,
        path,
        action: body.action,
      } as WireEvent);
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      return reply
        .code(DOC_ERROR_STATUS[code] ?? 502)
        .send({ error: code, message: result.error?.message ?? 'doc action error' });
    }
    return reply.code(200).send(result.view);
  });

  // ---- POST /api/chats/:id/doc/convert ----
  // spec/14 § Document editor, step 3 of 3 — opening a `.docx` converts it to
  // the `.md` the editor actually opens. Same round-trip rails as doc/action
  // above.
  const docConvertPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.doc_convert.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.doc_convert.response') return;
    const w = docConvertPending.get(event.requestId);
    if (!w) return;
    docConvertPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    '/api/chats/:id/doc/convert',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      if (!deps.chatRegistry.get(req.params.id)) {
        return sendUnknownChat(reply, req.params.id);
      }
      const path = req.body?.path ?? '';
      if (path === '' || path.includes('..') || path.startsWith('/')) {
        return reply.code(400).send({ error: 'path_invalid', message: 'path must be relative' });
      }
      const requestId = deps.idGenerator();
      const result = await new Promise<
        Extract<WireEvent, { type: 'patch.doc_convert.response' }> | 'timeout'
      >((resolveP) => {
        // Chromium-free, but mammoth + the image extraction still take real
        // time on a large document — give it longer than the other doc routes.
        const timeout = setTimeout(() => {
          docConvertPending.delete(requestId);
          resolveP('timeout');
        }, DOC_CONVERT_EXPORT_TIMEOUT_MS);
        docConvertPending.set(requestId, { resolve: resolveP, timeout });
        deps.daemonLink.send(auth.surfaceId, {
          type: 'patch.doc_convert.request',
          requestId,
          chatId: req.params.id,
          path,
        });
      });
      if (result === 'timeout') {
        return reply.code(504).send({ error: 'daemon_timeout' });
      }
      if (!result.ok) {
        const code = result.error?.code ?? 'internal';
        return reply
          .code(DOC_ERROR_STATUS[code] ?? 502)
          .send({ error: code, message: result.error?.message ?? 'doc convert error' });
      }
      return reply.code(200).send({
        mdPath: result.mdPath,
        warnings: result.warnings ?? [],
        reused: result.reused ?? false,
      });
    },
  );

  // ---- POST /api/chats/:id/doc/export ----
  // spec/14 § Document editor, step 3 of 3 — Download/Save as .docx/.pdf/.md
  // from the editor's menu. Answers with the exported bytes directly (base64
  // over the host link, decoded back to binary here) so the surface can
  // hand the user a real download in the same round trip that also writes
  // the file beside the `.md` (`chatRunner.ts`'s `exportDoc`).
  const docExportPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.doc_export.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.doc_export.response') return;
    const w = docExportPending.get(event.requestId);
    if (!w) return;
    docExportPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.post<{ Params: { id: string }; Body: { path?: string; format?: string } }>(
    '/api/chats/:id/doc/export',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      if (!deps.chatRegistry.get(req.params.id)) {
        return sendUnknownChat(reply, req.params.id);
      }
      const path = req.body?.path ?? '';
      if (path === '' || path.includes('..') || path.startsWith('/')) {
        return reply.code(400).send({ error: 'path_invalid', message: 'path must be relative' });
      }
      const format = req.body?.format ?? '';
      if (format !== 'docx' && format !== 'pdf' && format !== 'md') {
        return reply
          .code(400)
          .send({ error: 'format_invalid', message: 'format must be docx, pdf or md' });
      }
      const requestId = deps.idGenerator();
      const result = await new Promise<
        Extract<WireEvent, { type: 'patch.doc_export.response' }> | 'timeout'
      >((resolveP) => {
        // A PDF export launches a real (headless) browser — slower than
        // every other doc route.
        const timeout = setTimeout(() => {
          docExportPending.delete(requestId);
          resolveP('timeout');
        }, DOC_CONVERT_EXPORT_TIMEOUT_MS);
        docExportPending.set(requestId, { resolve: resolveP, timeout });
        deps.daemonLink.send(auth.surfaceId, {
          type: 'patch.doc_export.request',
          requestId,
          chatId: req.params.id,
          path,
          format,
        });
      });
      if (result === 'timeout') {
        return reply.code(504).send({ error: 'daemon_timeout' });
      }
      if (!result.ok) {
        const code = result.error?.code ?? 'internal';
        return reply
          .code(DOC_ERROR_STATUS[code] ?? 502)
          .send({ error: code, message: result.error?.message ?? 'doc export error' });
      }
      const buffer = Buffer.from(result.dataBase64 ?? '', 'base64');
      const filename = (result.path ?? `export.${format}`).split('/').pop();
      return reply
        .code(200)
        .header('Content-Type', result.mimeType ?? 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('X-Patch-Doc-Path', result.path ?? '')
        .header('X-Patch-Doc-Warnings', JSON.stringify(result.warnings ?? []))
        .send(buffer);
    },
  );

  // ---- GET /api/chats/:id/background-task-stats?taskIds=a,b,c ----
  // What this chat's still-running background tasks are costing the machine,
  // for the background task bar (spec/14 § Main chat panel — Background task
  // bar). Measured on the chat's own host, where the processes are, so this is
  // the same host round-trip as /files.
  //
  // NO FALLBACK, and it is the whole point of the readout: the response carries
  // a stat ONLY for a task the host actually measured. An id that comes back
  // with no entry is passed through as absent — never padded to a zero, which
  // would make a task nobody can see a task doing nothing.
  const BACKGROUND_TASK_STATS_TIMEOUT_MS = 5_000;
  /** A background id is a bare token; anything else never reaches a host. */
  const BACKGROUND_ID = /^[A-Za-z0-9_-]+$/;
  /** The wire schema's own ceiling — this runs on a poll. */
  const MAX_TASK_IDS = 50;
  const statsPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.background_task_stats.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.background_task_stats.response') return;
    const w = statsPending.get(event.requestId);
    if (!w) return;
    statsPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.get<{ Params: { id: string }; Querystring: { taskIds?: string } }>(
    '/api/chats/:id/background-task-stats',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      if (!deps.chatRegistry.get(req.params.id)) {
        return sendUnknownChat(reply, req.params.id);
      }
      // Validated at the boundary rather than left to the host: the wire
      // schema is strict, so a malformed id would be dropped silently and the
      // caller would wait out the full timeout for a misleading 504.
      const ids = [
        ...new Set(
          (req.query?.taskIds ?? '')
            .toString()
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t !== ''),
        ),
      ];
      if (ids.length === 0) {
        return reply
          .code(400)
          .send({ error: 'taskIds_required', message: 'taskIds must name at least one task' });
      }
      if (ids.length > MAX_TASK_IDS || ids.some((t) => !BACKGROUND_ID.test(t))) {
        return reply.code(400).send({
          error: 'taskIds_invalid',
          message: `taskIds must be at most ${MAX_TASK_IDS} bare background ids`,
        });
      }
      const requestId = deps.idGenerator();
      const result = await new Promise<
        Extract<WireEvent, { type: 'patch.background_task_stats.response' }> | 'timeout'
      >((resolveP) => {
        const timeout = setTimeout(() => {
          statsPending.delete(requestId);
          resolveP('timeout');
        }, BACKGROUND_TASK_STATS_TIMEOUT_MS);
        statsPending.set(requestId, { resolve: resolveP, timeout });
        deps.daemonLink.send(auth.surfaceId, {
          type: 'patch.background_task_stats.request',
          requestId,
          chatId: req.params.id,
          taskIds: ids,
        });
      });
      if (result === 'timeout') {
        return reply.code(504).send({ error: 'daemon_timeout' });
      }
      if (!result.ok) {
        const code = result.error?.code ?? 'internal';
        const statusByCode: Record<string, number> = {
          chat_not_found: 404,
          // The host has no process table this host can read, so nothing here
          // is measurable — a different fact from "nothing is running".
          no_process_table: 501,
          internal: 502,
        };
        return reply
          .code(statusByCode[code] ?? 502)
          .send({ error: code, message: result.error?.message ?? 'background task stats error' });
      }
      return reply.code(200).send({ stats: result.stats ?? [] });
    },
  );

  // ---- GET /api/chats/:id/watch, POST /api/chats/:id/watch/:taskId/stop ----
  // The Background task bar's real data (spec/14 § Main chat panel —
  // Background task bar): this chat's `patch_watch` tasks, and a kill switch.
  // Same server→host→server round-trip as background-task-stats above — the
  // server has no filesystem access to the host's persisted watch records.
  const WATCH_REQUEST_TIMEOUT_MS = 5_000;
  const watchListPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.watch_list.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  const watchStopPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.watch_stop.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type === 'patch.watch_list.response') {
      const w = watchListPending.get(event.requestId);
      if (!w) return;
      watchListPending.delete(event.requestId);
      clearTimeout(w.timeout);
      w.resolve(event);
      return;
    }
    if (event.type === 'patch.watch_stop.response') {
      const w = watchStopPending.get(event.requestId);
      if (!w) return;
      watchStopPending.delete(event.requestId);
      clearTimeout(w.timeout);
      w.resolve(event);
    }
  });
  app.get<{ Params: { id: string } }>('/api/chats/:id/watch', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.watch_list.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        watchListPending.delete(requestId);
        resolveP('timeout');
      }, WATCH_REQUEST_TIMEOUT_MS);
      watchListPending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(auth.surfaceId, {
        type: 'patch.watch_list.request',
        requestId,
        chatId: req.params.id,
      });
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      const statusByCode: Record<string, number> = { chat_not_found: 404, internal: 502 };
      return reply
        .code(statusByCode[code] ?? 502)
        .send({ error: code, message: result.error?.message ?? 'watch list error' });
    }
    return reply.code(200).send({ tasks: result.tasks ?? [] });
  });

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/chats/:id/watch/:taskId/stop',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      if (!deps.chatRegistry.get(req.params.id)) {
        return sendUnknownChat(reply, req.params.id);
      }
      const requestId = deps.idGenerator();
      const result = await new Promise<
        Extract<WireEvent, { type: 'patch.watch_stop.response' }> | 'timeout'
      >((resolveP) => {
        const timeout = setTimeout(() => {
          watchStopPending.delete(requestId);
          resolveP('timeout');
        }, WATCH_REQUEST_TIMEOUT_MS);
        watchStopPending.set(requestId, { resolve: resolveP, timeout });
        deps.daemonLink.send(auth.surfaceId, {
          type: 'patch.watch_stop.request',
          requestId,
          chatId: req.params.id,
          taskId: req.params.taskId,
        });
      });
      if (result === 'timeout') {
        return reply.code(504).send({ error: 'daemon_timeout' });
      }
      if (!result.ok) {
        const code = result.error?.code ?? 'internal';
        const statusByCode: Record<string, number> = { chat_not_found: 404, internal: 502 };
        return reply
          .code(statusByCode[code] ?? 502)
          .send({ error: code, message: result.error?.message ?? 'watch stop error' });
      }
      return reply.code(200).send({ stopped: result.stopped ?? false });
    },
  );

  // ---- GET /api/skills?folder=&daemonId= ----
  // Lists the skills available in a folder's `.claude/skills` (backs the job
  // editor's Skill picker, the chat transcript's Skill tool-call link, and the
  // composer's `/` autocomplete). Folder-scoped, not chat-scoped — the chat
  // may not exist yet. Round-trips `patch.skills.request` over the
  // daemon-link (the host owns the project filesystem) and waits up to 5s.
  // `daemonId` is REQUIRED (like `/api/models`) and validated against the
  // registered-host list: skills are per-host, so with more than one
  // registered machine and no home host, falling back to "whichever host
  // last attached" can ask the wrong machine and come back missing a skill
  // that is real on the caller's actual host. NO FALLBACK: timeout → 504;
  // host errors map to a typed status.
  const SKILLS_REQUEST_TIMEOUT_MS = 5_000;
  const skillsPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.skills.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.skills.response') return;
    const w = skillsPending.get(event.requestId);
    if (!w) return;
    skillsPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.get('/api/skills', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const q = SkillsQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid query', issues: q.error.issues });
    }
    const { folder, daemonId } = q.data;
    const unknownHost = checkRegisteredHost(deps.registry, daemonId);
    if (unknownHost) {
      deps.logger.warn({ daemonId }, 'GET /api/skills rejected: unregistered daemonId');
      return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.skills.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        skillsPending.delete(requestId);
        resolveP('timeout');
      }, SKILLS_REQUEST_TIMEOUT_MS);
      skillsPending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(auth.surfaceId, {
        type: 'patch.skills.request',
        requestId,
        folder,
        daemonId,
      });
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      const status = code === 'folder_not_found' ? 404 : 502;
      return reply
        .code(status)
        .send({ error: code, message: result.error?.message ?? 'skills error' });
    }
    // `paths`/`descriptions`/`frontmatter` pass through only when the host
    // named them. Omitting them (rather than sending `{}`) keeps "this host
    // can't tell me where its skills live / what they do" distinct from "it
    // says there are none" — the surface offers an edit link, a tooltip, or a
    // preview panel only in the first case, and never guesses a path or
    // invents a description.
    return reply.code(200).send({
      skills: result.skills ?? [],
      ...(result.paths ? { paths: result.paths } : {}),
      ...(result.descriptions ? { descriptions: result.descriptions } : {}),
      ...(result.frontmatter ? { frontmatter: result.frontmatter } : {}),
    });
  });

  // ---- GET /api/models ----
  // The selectable models for a new chat (spec/14 § Model selector). The host
  // owns the Claude OAuth credential, so only it can read Anthropic's model
  // list — round-trip `patch.models.request` exactly like `patch.skills.*`.
  // NO FALLBACK: timeout → 504, host error → 502, never a baked-in list.
  const MODELS_REQUEST_TIMEOUT_MS = 10_000;
  const modelsPending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.models.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.models.response') return;
    const w = modelsPending.get(event.requestId);
    if (!w) return;
    modelsPending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.get('/api/models', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    // The catalogue is PER HOST (spec/02 § Model catalogue), so the caller
    // must say which. Guessing would offer the wrong machine's models for a
    // chat that is about to be pinned to a different one.
    const q = ModelsQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid query', issues: q.error.issues });
    }
    const { daemonId } = q.data;
    const unknownHost = checkRegisteredHost(deps.registry, daemonId);
    if (unknownHost) {
      deps.logger.warn({ daemonId }, 'GET /api/models rejected: unregistered daemonId');
      return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.models.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        modelsPending.delete(requestId);
        resolveP('timeout');
      }, MODELS_REQUEST_TIMEOUT_MS);
      modelsPending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(auth.surfaceId, { type: 'patch.models.request', requestId, daemonId });
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    // Partial failure is the NORMAL case with more than one backend: a host
    // whose second credential expired still offers the first backend's models.
    // Both lists are returned together and the picker shows the error against
    // the failing backend while the rest stay selectable (spec/02 § Model
    // catalogue). Only a host where NOTHING resolved is an error response.
    if (result.models.length === 0 && result.errors.length > 0) {
      const first = result.errors[0]!;
      return reply
        .code(502)
        .send({ error: first.code, message: first.message, errors: result.errors });
    }
    return reply.code(200).send({
      daemonId: result.daemonId,
      models: result.models,
      errors: result.errors,
      ...(result.fetchedAt !== undefined ? { fetchedAt: result.fetchedAt } : {}),
    });
  });

  // ---- POST /api/chats/:id/stop ----
  app.post<{ Params: { id: string } }>('/api/chats/:id/stop', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.stop_request',
      chatId: req.params.id,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/rotate ----
  // Manual trigger for the same session rotation ThreadRotator runs on a
  // schedule (spec/06 § Session rotation): retire the underlying Claude
  // session and start fresh, seeded with a handoff digest. Only reserved
  // special threads (Manager / Speakers) have a rotation concept —
  // an ordinary chat's "start fresh" is a new chat — so this mirrors the
  // DELETE route's guard. Fire-and-forget like /stop: the host's own NO
  // FALLBACK guard (mid-turn, no digest generator, digest failure) logs and
  // drops a refusal rather than answering it here.
  app.post<{ Params: { id: string } }>('/api/chats/:id/rotate', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!isReservedSpecialThread(req.params.id)) {
      return reply
        .code(403)
        .send({ error: `cannot rotate a non-special thread: ${req.params.id}` });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return reply.code(404).send({ error: `chat not found: ${req.params.id}` });
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.rotate_request',
      chatId: req.params.id,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- DELETE /api/chats/:id ----
  // Recoverable SOFT-DELETE (spec/04 § Lifecycle, spec/14 § Chat lifecycle):
  // forwards a stop + `chat.delete_request{deleted:true}` to the host and
  // flips the registry mirror to `deleted` so the chat leaves the active list
  // and appears under the sidebar's Deleted section. NOT a hard removal — the
  // on-disk transcript is untouched and the chat can be restored (POST
  // /api/chats/:id/restore).
  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    // Reserved special threads (Manager / Speakers) are part of the
    // install's fixed structure and must never be deleted (spec/14 & spec/15:
    // the "Delete chat" action is hidden for special threads). Enforce
    // server-side so a hand-crafted DELETE can't remove them.
    if (isReservedSpecialThread(req.params.id)) {
      return reply
        .code(403)
        .send({ error: `cannot delete reserved special thread: ${req.params.id}` });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.stop_request',
      chatId: req.params.id,
    });
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.delete_request',
      chatId: req.params.id,
      deleted: true,
    });
    deps.chatRegistry.setDeleted(req.params.id, true);
    // "One draft per chat. Deleting the chat drops it." (spec/14 § Composer) —
    // a soft-delete is not archiving, so unlike an archived chat this one does
    // not keep its draft for a restore.
    deps.composerDrafts.clear(req.params.id);
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/restore ----
  // Restore a soft-deleted chat back to the active list (spec/04 § Lifecycle).
  app.post<{ Params: { id: string } }>('/api/chats/:id/restore', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.delete_request',
      chatId: req.params.id,
      deleted: false,
    });
    deps.chatRegistry.setDeleted(req.params.id, false);
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/archive ----
  const ArchiveBody = z.object({ archived: z.boolean() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/archive', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = ArchiveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    // Reserved special threads hold fixed sidebar slots and have no "off the
    // home screen" state (spec/06 § Disabled — `setDisabled` is what they use
    // instead). Enforce here, not just host-side: this route is
    // fire-and-forget (it 200s before the host processes the forwarded
    // request), so a host-side-only rejection would still read as success to
    // the caller — which is exactly how the Manager thread ended up archived
    // in production.
    if (parsed.data.archived && isReservedSpecialThread(req.params.id)) {
      return reply
        .code(403)
        .send({ error: `cannot archive reserved special thread: ${req.params.id}` });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.archive_request',
      chatId: req.params.id,
      archived: parsed.data.archived,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/disable ----
  // spec/06 § Disabled — the real "off" switch for special threads, since
  // archive is refused for them. Only valid for Manager/Speakers.
  const DisableBody = z.object({ disabled: z.boolean() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/disable', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = DisableBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!isReservedSpecialThread(req.params.id)) {
      return reply
        .code(403)
        .send({ error: `not a special thread, use archive instead: ${req.params.id}` });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.disable_request',
      chatId: req.params.id,
      disabled: parsed.data.disabled,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/snooze ----
  // spec/04 § Snooze. `snoozedUntil` is an ABSOLUTE ms epoch (the surface
  // resolves its preset, so a slow request can't drift the wake time) or null
  // to unsnooze. A timestamp already in the past is a 400 — NO FALLBACK, the
  // caller is never silently given "now".
  const SnoozeBody = z.object({ snoozedUntil: z.number().int().nullable() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/snooze', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = SnoozeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    const { snoozedUntil } = parsed.data;
    if (snoozedUntil !== null && snoozedUntil <= Date.now()) {
      return reply.code(400).send({ error: `snoozedUntil is in the past: ${snoozedUntil}` });
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.snooze_request',
      chatId: req.params.id,
      snoozedUntil,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/hide ----
  // spec/04 § Hidden. `hidden: false` is the Hidden section's Show. The host
  // owns the rules (special threads and archived chats are refused there), so
  // this only validates the shape and that the chat exists.
  const HideBody = z.object({ hidden: z.boolean() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/hide', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = HideBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const chat = deps.chatRegistry.get(req.params.id);
    if (!chat) {
      return sendUnknownChat(reply, req.params.id);
    }
    if (parsed.data.hidden && chat.status !== 'active') {
      return reply
        .code(409)
        .send({ error: `only an active chat can be hidden (this one is ${chat.status})` });
    }
    if (parsed.data.hidden && isReservedSpecialThread(req.params.id)) {
      return reply.code(403).send({ error: `special threads cannot be hidden: ${req.params.id}` });
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.hide_request',
      chatId: req.params.id,
      hidden: parsed.data.hidden,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/pin ----
  const PinBody = z.object({ pinned: z.boolean() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/pin', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = PinBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.pin_request',
      chatId: req.params.id,
      pinned: parsed.data.pinned,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/goal ----
  // patch/todo.md — `/goal`: set (or clear, with null) the chat's goal. Forwards
  // chat.goal_request to the host, which persists it + echoes chat.state.
  const GoalBody = z.object({ goal: z.string().nullable() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/goal', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = GoalBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.goal_request',
      chatId: req.params.id,
      goal: parsed.data.goal,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/todos ----
  // spec/02 § Task list: a surface rewrote the chat's task list. Forwards
  // chat.todos_request (the WHOLE list) to the host, which adopts it, echoes
  // chat.state, and tells the agent about the edit on its next turn.
  const TodosBody = z.object({ todos: z.array(TodoItem) }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/todos', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = TodosBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.todos_request',
      chatId: req.params.id,
      todos: parsed.data.todos,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/rename ----
  // spec/04 § Name: set (or clear, with null) the chat's name. Forwards
  // chat.rename_request to the host, which persists it + echoes chat.state.
  const RenameBody = z.object({ name: z.string().nullable() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/rename', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = RenameBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.rename_request',
      chatId: req.params.id,
      name: parsed.data.name,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/reminder ----
  // patch/todo.md — Reminders: set (or clear, with null) the chat's reminder.
  // Forwards chat.reminder_request to the host, which persists it + echoes
  // chat.state so every surface shows the reminder banner at the top of the chat.
  const ReminderBody = z.object({ reminder: z.string().nullable() }).strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/reminder', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = ReminderBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.reminder_request',
      chatId: req.params.id,
      reminder: parsed.data.reminder,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/chats/:id/loop ----
  // `02-daemon.md` § Self-wake — `/loop <interval> <message>` typed in the
  // composer arms the SAME durable scheduler the agent's `patch_loop` tool
  // call reaches; `loop: null` cancels it (one pending wake per chat, loop or
  // plain one-shot, same as the agent path — arming/cancelling here can
  // replace a wake the agent armed and vice versa). Forwards chat.loop_request
  // to the host, which calls scheduleWake/cancelWake and echoes chat.state.
  const LoopBody = z
    .object({
      loop: z
        .object({
          message: z.string().min(1),
          every: z.union([z.string(), z.number()]),
          notAfter: z.string().optional(),
        })
        .nullable(),
    })
    .strict();
  app.post<{ Params: { id: string } }>('/api/chats/:id/loop', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = LoopBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    if (!deps.chatRegistry.get(req.params.id)) {
      return sendUnknownChat(reply, req.params.id);
    }
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.loop_request',
      chatId: req.params.id,
      loop: parsed.data.loop,
    });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/threads/:thread/send-to ----
  // Convenience alias: thread name → chatId `thread_<name>`.
  app.post<{ Params: { thread: string } }>('/api/threads/:thread/send-to', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = SendToBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const known = new Set(['manager', 'speakers']);
    if (!known.has(req.params.thread)) {
      return reply.code(400).send({
        error: `unknown thread: ${req.params.thread} (try manager/speakers)`,
      });
    }
    const chatId = `thread_${req.params.thread}`;
    // spec/06 ## Composer policy: Speakers is a read-only mirror.
    // A surface (this is a surface-JWT-authed HTTP route) cannot inject a user
    // turn there — only the voice device may. Agent-to-agent
    // delivery into these threads is the daemon-local UDS `patch_send_to`.
    if (isReadOnlyMirrorThread(chatId)) {
      return reply.code(403).send({
        error: `thread ${req.params.thread} is a read-only mirror; composer disabled (spec/06)`,
      });
    }
    const localId = parsed.data.localId ?? deps.idGenerator();
    const message =
      parsed.data.voicePrefix !== undefined && parsed.data.voicePrefix.length > 0
        ? parsed.data.voicePrefix + parsed.data.message
        : parsed.data.message;
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.input',
      chatId,
      message,
      localId,
    });
    return reply.code(200).send({ ok: true, queued: true, chatId, localId });
  });

  // Improve the spawn folder_not_found error message via the chat-error
  // pendingPlaceholder logic (route enriches in the response).
}
