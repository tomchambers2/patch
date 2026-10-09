// Notification-related REST routes (group 11).
//
//  POST /api/auth/push/register    — JWT-authed; surface registers an Expo push token.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { verifySurfaceCredential } from '@patch/auth';
import type { ChatInputEvent } from '@patch/wire';
import type { Registry } from '../registry.js';
import type { DaemonLink } from '../daemon-link.js';

export interface NotificationRoutesDeps {
  logger: Logger;
  registry: Registry;
  daemonLink: DaemonLink;
  nowMs?: () => number;
  idGenerator?: () => string;
}

// Group 12 (LOW-2): tighten push token bounds. An Expo push token is
// `Expo[nent]PushToken[<id>]`, ~40-45 chars; cap at 4096 to make a multi-MB
// token attempt fail fast, and require the wrapper shape so a garbage value
// is rejected at registration rather than silently stored and only failing
// the first time a push is attempted (NO FALLBACK).
//
// The mobile client (apps/mobile/src/api/rest.ts) reports the originating
// platform alongside the token (`platform: 'android-expo'`). Accept it — a
// strict schema that rejected the field broke real device registration with a
// 400 (no token ever reached the registry, so the push channel could never
// deliver to a phone). We persist only the token; `platform` is informational.
const PushRegisterBody = z
  .object({
    token: z
      .string()
      .min(20)
      .max(4096)
      .regex(/^Expo(nent)?PushToken\[.+\]$/, 'not an Expo push token'),
    platform: z.string().min(1).max(64).optional(),
  })
  .strict();

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

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: NotificationRoutesDeps,
): void {
  const now = (): number => (deps.nowMs ? deps.nowMs() : Date.now());

  // ---- POST /api/auth/push/register ----
  app.post('/api/auth/push/register', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      // Defensive: requireAuth only ever throws via its internal `generic()`
      // helper, which always sets `.statusCode = 401` — the `?? 401` fallback
      // is unreachable unless requireAuth's contract changes.
      return (
        reply
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const parsed = PushRegisterBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    deps.registry.registerPushToken({
      surfaceId: auth.surfaceId,
      accountId: auth.accountId,
      token: parsed.data.token,
      registeredAt: now(),
    });
    deps.logger.info({ surfaceId: auth.surfaceId }, 'push token registered');
    return reply.code(200).send({ ok: true });
  });
}

/**
 * Hook for voice devices (group 23 will own the WSS; for now this is the
 * named entry point so other code can reach it). Routes a transcript into
 * the speakers thread with the originating deviceId attached.
 */
export function routeVoiceDeviceTranscript(opts: {
  deviceId: string;
  transcript: string;
  daemonLink: DaemonLink;
  idGenerator?: () => string;
}): void {
  const localId = `vd-${opts.deviceId}-${opts.idGenerator ? opts.idGenerator() : Date.now()}`;
  const event: ChatInputEvent = {
    type: 'chat.input',
    chatId: 'thread_speakers',
    message: opts.transcript,
    localId,
    source: { kind: 'voice-device', deviceId: opts.deviceId },
  };
  opts.daemonLink.send(`voice-device:${opts.deviceId}`, event);
}
