// Manager sweep REST endpoints (spec/06 § Sweep — "Visible" / "Check now").

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from './registry.js';
import type { ManagerSweeper, SweepRunStore } from './manager-sweep.js';

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

export interface ManagerSweepRoutesDeps {
  registry: Registry;
  sweeper: ManagerSweeper;
  runs: SweepRunStore;
}

export function registerManagerSweepRoutes(
  app: FastifyInstance,
  deps: ManagerSweepRoutesDeps,
): void {
  // The Manager view's "Last sweep" line + its expanded run list (spec/06 §
  // Sweep — "Sweep runs are also listed like job runs").
  app.get<{ Querystring: { limit?: string } }>('/api/manager/sweeps', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    const rawLimit = req.query?.limit;
    const limit = rawLimit ? Math.min(200, Math.max(1, Number(rawLimit) || 50)) : 50;
    return reply.code(200).send({ runs: deps.runs.recent(limit) });
  });

  // "Check now" (spec/06 § Sweep) — the Manager view's button and the
  // `patch-cli` command both land here. Still gated: nothing pending is
  // still no model call, reported back as `fired: false`.
  app.post('/api/manager/sweep/check-now', async (req, reply) => {
    if (!(await authOr401(req, reply, deps.registry))) return;
    const fired = deps.sweeper.checkNow();
    return reply.code(200).send({ fired });
  });
}
