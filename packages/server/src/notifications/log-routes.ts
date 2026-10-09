// Agent-notification log REST (spec/09 § bell).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from '../registry.js';
import type { NotificationLog } from './log.js';

async function requireAuth(req: FastifyRequest, registry: Registry): Promise<void> {
  const account = registry.getAccount();
  const header = req.headers.authorization;
  if (!account || !header?.startsWith('Bearer ')) throw new Error('unauthenticated');
  const claims = await verifySurfaceCredential(header.slice('Bearer '.length).trim(), {
    userPublicKey: account.userPublicKey,
  });
  if (registry.isRevoked(claims.surface_id)) throw new Error('unauthenticated');
}

const ReadBody = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export function registerNotificationLogRoutes(
  app: FastifyInstance,
  deps: { registry: Registry; log: NotificationLog },
): void {
  app.get('/api/notifications', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    return reply.code(200).send(deps.log.snapshot());
  });

  app.post('/api/notifications/read', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const parsed = ReadBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    deps.log.markRead(parsed.data);
    return reply.code(200).send(deps.log.snapshot());
  });
}
