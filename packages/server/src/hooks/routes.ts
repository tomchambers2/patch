// REST routes for hook CRUD + `POST /api/hooks/check` (spec/20-hooks.md).
// JWT-authed, same scheme as `/api/jobs` (`../jobs/routes.ts`).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { HookImages, HOOK_IMAGES_MAX, HOOK_IMAGE_MAX_BASE64 } from '@patch/wire/hooks';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { requireAuth } from '../folder-routes.js';
import type { Registry } from '../registry.js';
import type { ChatRegistry } from '../chat-registry.js';
import { HookCreateBody, HookPatchBody, type HooksInterface } from './types.js';
import { HookValidationError } from './validate.js';
import type { HookRunner } from './runner.js';

// Room for the most images a check may carry, plus the message text.
const HOOK_CHECK_BODY_LIMIT = HOOK_IMAGES_MAX * HOOK_IMAGE_MAX_BASE64 + 1024 * 1024;

const SPECIAL_THREAD_ID_SET = new Set<string>(Object.values(SPECIAL_THREAD_IDS));

export interface HookRoutesDeps {
  logger: Logger;
  registry: Registry;
  hooks: HooksInterface;
  chatRegistry: ChatRegistry;
  runner: HookRunner;
}

async function withAuth(
  req: FastifyRequest,
  registry: Registry,
): Promise<{ statusCode: number; error: string } | null> {
  try {
    await requireAuth(req, registry);
    return null;
  } catch (e) {
    return {
      statusCode: (e as Error & { statusCode?: number }).statusCode ?? 401,
      error: (e as Error).message,
    };
  }
}

export function registerHookRoutes(app: FastifyInstance, deps: HookRoutesDeps): void {
  app.get('/api/hooks', async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    return reply.code(200).send({ hooks: deps.hooks.list() });
  });

  app.get<{ Params: { id: string } }>('/api/hooks/:id', async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    const hook = deps.hooks.get(req.params.id);
    if (!hook) return reply.code(404).send({ error: 'hook not found' });
    return reply.code(200).send(hook);
  });

  app.post('/api/hooks', async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    const parsed = HookCreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    try {
      const hook = deps.hooks.create(parsed.data);
      deps.logger.info({ hookId: hook.id, name: hook.name, kind: hook.kind }, 'hooks: created');
      return reply.code(201).send(hook);
    } catch (err) {
      if (err instanceof HookValidationError) {
        return reply.code(400).send({
          error: 'invalid body',
          issues: [
            { code: z.ZodIssueCode.custom, path: err.field.split('.'), message: err.message },
          ],
        });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/hooks/:id', async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    if (!deps.hooks.get(req.params.id)) return reply.code(404).send({ error: 'hook not found' });
    const parsed = HookPatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    try {
      const hook = deps.hooks.patch(req.params.id, parsed.data);
      return reply.code(200).send(hook);
    } catch (err) {
      if (err instanceof HookValidationError) {
        return reply.code(400).send({
          error: 'invalid body',
          issues: [
            { code: z.ZodIssueCode.custom, path: err.field.split('.'), message: err.message },
          ],
        });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/hooks/:id', async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    const deleted = deps.hooks.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'hook not found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/hooks/:id/enable', async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    if (!deps.hooks.get(req.params.id)) return reply.code(404).send({ error: 'hook not found' });
    return reply.code(200).send(deps.hooks.enable(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/hooks/:id/disable', async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    if (!deps.hooks.get(req.params.id)) return reply.code(404).send({ error: 'hook not found' });
    return reply.code(200).send(deps.hooks.disable(req.params.id));
  });

  app.post('/api/hooks/check', { bodyLimit: HOOK_CHECK_BODY_LIMIT }, async (req, reply) => {
    const authErr = await withAuth(req, deps.registry);
    if (authErr) return reply.code(authErr.statusCode).send({ error: authErr.error });
    const parsed = z
      .object({ chatId: z.string().min(1), message: z.string(), images: HookImages.optional() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const { chatId, message, images } = parsed.data;
    const chat = deps.chatRegistry.get(chatId);
    if (!chat) {
      // No chat to resolve host/folder from yet (a brand-new, not-yet-spawned
      // chat) — nothing to check against, so the send proceeds uncounted
      // (spec/20-hooks.md § Checking a message: "no matching hooks").
      return reply.code(200).send({ decision: 'pass', results: [] });
    }
    const result = await deps.runner.check({
      message,
      ...(images !== undefined ? { images } : {}),
      chatId,
      folder: chat.folder,
      daemonId: chat.daemonId,
      specialThread: SPECIAL_THREAD_ID_SET.has(chatId),
    });
    return reply.code(200).send(result);
  });
}
