// Batch REST endpoints (spec/14 § Batch mode).
//
// Account-wide, server-owned state (`BatchStore`) — there is no host
// round-trip, unlike most chat-lifecycle routes, because a batch is not a
// per-chat or per-host fact. `BatchNotifier.recomputeTriggers()` is called
// after every mutation that could complete the check-in or ending condition,
// since those also react to chat activity the mutation itself didn't touch.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from '../registry.js';
import { BatchCheckInChoice, type BatchRecord, type BatchStore } from './store.js';
import type { BatchNotifier } from '../notifications/batch.js';

async function requireAuth(req: FastifyRequest, registry: Registry): Promise<void> {
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
}

export interface BatchRoutesDeps {
  registry: Registry;
  store: BatchStore;
  notifier: BatchNotifier;
}

interface BatchResponse {
  batch: BatchRecord | null;
  carryover: string[];
}

function snapshot(deps: BatchRoutesDeps): BatchResponse {
  return { batch: deps.store.current(), carryover: deps.store.carryoverMembers() };
}

async function authOr401(
  req: FastifyRequest,
  reply: FastifyReply,
  registry: Registry,
): Promise<boolean> {
  try {
    await requireAuth(req, registry);
    return true;
  } catch (e) {
    await reply
      .code((e as Error & { statusCode?: number }).statusCode ?? 401)
      .send({ error: (e as Error).message });
    return false;
  }
}

const StartBody = z.object({ checkIn: BatchCheckInChoice }).strict();
const OpenedBody = z.object({ chatId: z.string().min(1) }).strict();

export function registerBatchRoutes(app: FastifyInstance, deps: BatchRoutesDeps): void {
  app.get('/api/batch', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    return reply.code(200).send(snapshot(deps));
  });

  app.post('/api/batch/start', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    deps.store.start(parsed.data.checkIn);
    deps.notifier.recomputeTriggers();
    return reply.code(200).send(snapshot(deps));
  });

  app.delete<{ Params: { chatId: string } }>('/api/batch/members/:chatId', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    deps.store.removeMember(req.params.chatId);
    deps.notifier.recomputeTriggers();
    return reply.code(200).send(snapshot(deps));
  });

  // Manual check-in (spec/09 § Batch check-in — does NOT fire the
  // notification; the user is already looking at the view).
  app.post('/api/batch/check-in-now', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    deps.store.checkIn();
    deps.notifier.recomputeTriggers();
    return reply.code(200).send(snapshot(deps));
  });

  // spec/14 § Batch mode — ending: opening a chat anywhere counts, so every
  // surface calls this on opening ANY chat; it is a no-op unless that chat is
  // a member of the running batch.
  app.post('/api/batch/opened', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    const parsed = OpenedBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    deps.store.markOpened(parsed.data.chatId);
    deps.notifier.recomputeTriggers();
    return reply.code(200).send(snapshot(deps));
  });
}
