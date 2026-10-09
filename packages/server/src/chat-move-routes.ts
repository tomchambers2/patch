// Moving a chat to another host (spec/04 § Moving a chat to another host).
//
//   POST /api/chats/:id/move   {daemonId, folder}
//
// The server is the only party that can reach both machines, so it drives the
// move as three round trips — `export` on the chat's host, `import` on the
// target with what came back, `retire` on the old host — and then points its
// own chat mirror at the new host, which is what routes every later frame for
// the chat there. The target announces the chat itself (`chat.spawned` +
// `chat.state`), so every surface learns the new host and folder the same way
// it learns about any chat.
//
// NO FALLBACK: a step that fails ends the move there with its own reason. After
// a failed import the old host is told to `release` the chat, so it carries on
// where it was. A retire that fails after a good import still counts the chat
// as moved — the new copy is the live one and the old one takes no turns — but
// the reply says so rather than reading as a clean move.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ChatMoveBundle, ChatMoveErrorCode, ChatMoveOp, WireEvent } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';
import type { DaemonLink } from './daemon-link.js';
import type { Registry } from './registry.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';
import { requireAuth } from './folder-routes.js';

export interface ChatMoveRoutesDeps {
  logger: Logger;
  registry: Registry;
  daemonLink: DaemonLink;
  chatRegistry: ChatRegistry;
  idGenerator: () => string;
  /** Per-step wait. Injectable so a test need not sit through the real one. */
  stepTimeoutMs?: number;
}

/** A bundle can be tens of megabytes each way; still bounded. */
export const CHAT_MOVE_STEP_TIMEOUT_MS = 120_000;

type Response = Extract<WireEvent, { type: 'patch.chat_move.response' }>;

const STATUS_BY_CODE: Record<ChatMoveErrorCode, number> = {
  not_found: 404,
  busy: 409,
  unsupported: 422,
  folder_not_found: 400,
  already_exists: 409,
  too_large: 413,
  internal: 502,
};

export function registerChatMoveRoutes(app: FastifyInstance, deps: ChatMoveRoutesDeps): void {
  const timeoutMs = deps.stepTimeoutMs ?? CHAT_MOVE_STEP_TIMEOUT_MS;
  const pending = new Map<
    string,
    { resolve: (ev: Response | 'timeout') => void; timer: NodeJS.Timeout; daemonId: string }
  >();
  /** Chats with a move in flight — a second move of the same chat is refused. */
  const moving = new Set<string>();

  deps.daemonLink.onEvent((event: WireEvent, from) => {
    if (event.type !== 'patch.chat_move.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    if (event.daemonId !== w.daemonId || (from !== null && from !== w.daemonId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.daemonId, answered: event.daemonId, from },
        'chat move: response from a machine that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timer);
    w.resolve(event);
  });

  function step(
    daemonId: string,
    surfaceId: string,
    chatId: string,
    op: ChatMoveOp,
    extra: { folder?: string; bundle?: ChatMoveBundle } = {},
  ): Promise<Response | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve('timeout');
      }, timeoutMs);
      pending.set(requestId, { resolve, timer, daemonId });
      deps.daemonLink.sendTo(daemonId, surfaceId, {
        type: 'patch.chat_move.request',
        requestId,
        daemonId,
        chatId,
        op,
        ...extra,
      });
    });
  }

  function hostLabel(daemonId: string): string {
    return deps.registry.hostName(daemonId) ?? daemonId;
  }

  app.post<{ Params: { id: string }; Body: { daemonId?: unknown; folder?: unknown } }>(
    '/api/chats/:id/move',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      const chatId = req.params.id;
      const chat = deps.chatRegistry.get(chatId);
      if (!chat) {
        return reply.code(404).send({ error: 'chat_not_found', message: `no chat ${chatId}` });
      }
      const target = req.body?.daemonId;
      const folder = req.body?.folder;
      if (typeof target !== 'string' || target.length === 0) {
        return reply
          .code(400)
          .send({ error: 'daemonId_required', message: 'name the machine to move it to' });
      }
      if (typeof folder !== 'string' || !folder.startsWith('/')) {
        return reply.code(400).send({
          error: 'folder_required',
          message: 'name the absolute folder it will run in on that machine',
        });
      }
      const unknownHost = checkRegisteredHost(deps.registry, target);
      if (unknownHost) return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
      const source = chat.daemonId;
      if (source === target) {
        return reply
          .code(400)
          .send({ error: 'same_host', message: `this chat is already on ${hostLabel(target)}` });
      }
      for (const host of [source, target]) {
        if (!deps.daemonLink.isOnline(host)) {
          return reply.code(503).send({
            error: 'host_offline',
            message: `${hostLabel(host)} is offline`,
            daemonId: host,
          });
        }
      }
      if (moving.has(chatId)) {
        return reply.code(409).send({ error: 'busy', message: 'this chat is already being moved' });
      }

      moving.add(chatId);
      const log = deps.logger.child({ chatId, from: source, to: target, folder });
      try {
        const fail = (
          stepName: string,
          host: string,
          res: Response | 'timeout',
        ): { status: number; body: { error: string; message: string } } => {
          if (res === 'timeout') {
            return {
              status: 504,
              body: {
                error: 'daemon_timeout',
                message: `${hostLabel(host)} did not answer the ${stepName} in time`,
              },
            };
          }
          const code = res.error?.code ?? 'internal';
          return {
            status: STATUS_BY_CODE[code],
            body: {
              error: code,
              message: `${hostLabel(host)}: ${res.error?.message ?? `${stepName} failed`}`,
            },
          };
        };

        const exported = await step(source, auth.surfaceId, chatId, 'export');
        if (exported === 'timeout' || !exported.ok || !exported.bundle) {
          // A late export may still have frozen the chat; lifting that is harmless if not.
          if (exported === 'timeout') void step(source, auth.surfaceId, chatId, 'release');
          const f = fail('export', source, exported);
          log.warn({ ...f.body }, 'chat move: export failed');
          return reply.code(f.status).send(f.body);
        }
        log.info({ files: exported.bundle.files.length }, 'chat move: exported');

        const imported = await step(target, auth.surfaceId, chatId, 'import', {
          folder,
          bundle: exported.bundle,
        });
        if (imported === 'timeout' || !imported.ok) {
          const released = await step(source, auth.surfaceId, chatId, 'release');
          const f = fail('import', target, imported);
          log.warn(
            { ...f.body, released: released !== 'timeout' && released.ok },
            'chat move: import failed; released on the old host',
          );
          return reply.code(f.status).send(f.body);
        }

        // From here the chat IS on the target: route everything for it there.
        deps.chatRegistry.rehome(chatId, target, folder);
        log.info('chat move: imported; rehomed');

        const retired = await step(source, auth.surfaceId, chatId, 'retire');
        if (retired === 'timeout' || !retired.ok) {
          const f = fail('retire', source, retired);
          log.error({ ...f.body }, 'chat move: arrived, but the old copy was not retired');
          return reply.code(502).send({
            error: 'retire_failed',
            message: `Moved to ${hostLabel(target)}, but ${hostLabel(source)} kept its copy: ${f.body.message}`,
            chatId,
            daemonId: target,
            folder,
          });
        }
        log.info('chat move: done');
        return reply.send({ ok: true, chatId, daemonId: target, folder });
      } finally {
        moving.delete(chatId);
      }
    },
  );
}
