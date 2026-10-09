// REST for the shared settings (spec/01 § Endpoints, spec/03 § Settings).
//
// Every write is committed by the server and answered with the committed
// result; none asks a host, so none waits for one or fails because one is
// offline. Hosts learn of it from the snapshot that follows.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccountStrategy, ProviderKeyId, SharedSettingsPatch } from '@patch/wire';
import type { Registry } from './registry.js';
import { requireAuth } from './folder-routes.js';
import { SettingsError, type BackendId, type SharedSettingsService } from './shared-settings.js';

export interface SettingsRoutesDeps {
  registry: Registry;
  shared: SharedSettingsService;
}

const Backend = z.enum(['claude-code', 'codex']);
const AddBody = z
  .object({
    token: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
  })
  .strict();
const PatchBody = z
  .object({ label: z.string().min(1).optional(), token: z.string().min(1).optional() })
  .strict();
const OrderBody = z.object({ accountIds: z.array(z.string().min(1)).min(1) }).strict();
const StrategyBody = z.object({ strategy: AccountStrategy }).strict();
const AdoptBody = z.object({ daemonId: z.string().min(1) }).strict();
const KeyBody = z.object({ value: z.string().min(1) }).strict();
const ClaudeAdoptBody = z
  .object({ daemonId: z.string().min(1), target: z.enum(['shared', 'darwin', 'linux']) })
  .strict();

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): void {
  const { shared } = deps;

  /** Auth, parse, run, answer with the committed state — or the refusal. */
  const handle =
    <B>(
      schema: z.ZodType<B> | undefined,
      run: (req: FastifyRequest, body: B) => Promise<void> | void,
    ) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      let body = undefined as B;
      if (schema) {
        const parsed = schema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
        }
        body = parsed.data;
      }
      try {
        await run(req, body);
      } catch (e) {
        if (e instanceof SettingsError) {
          return reply.code(e.status).send({ error: e.code, message: e.message });
        }
        throw e;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropping `type` from the broadcast event shape, not using it
      const { type: _type, ...state } = shared.changedEvent();
      return reply.code(200).send(state);
    };

  const backendOf = (req: FastifyRequest): BackendId => {
    const parsed = Backend.safeParse((req.params as { backendId?: string }).backendId);
    if (!parsed.success) {
      throw new SettingsError(
        404,
        'unknown_backend',
        `No backend ${(req.params as { backendId?: string }).backendId}`,
      );
    }
    return parsed.data;
  };
  const accountOf = (req: FastifyRequest): string =>
    (req.params as { accountId: string }).accountId;

  app.get(
    '/api/settings/shared',
    handle(undefined, () => undefined),
  );

  app.patch(
    '/api/settings/shared',
    handle(SharedSettingsPatch, (_req, body) => {
      shared.update(body);
    }),
  );

  app.get(
    '/api/accounts/:backendId',
    handle(undefined, (req) => void backendOf(req)),
  );

  app.post(
    '/api/accounts/:backendId',
    handle(AddBody, async (req, body) => {
      const backend = backendOf(req);
      if (backend === 'claude-code') {
        if (!body.token) throw new SettingsError(400, 'invalid_input', 'A token is required');
        await shared.addClaude(body.token, body.label);
      } else {
        if (!body.apiKey) {
          throw new SettingsError(
            400,
            'invalid_input',
            'An OpenAI API key is required; a ChatGPT sign-in runs on a host',
          );
        }
        await shared.addCodexApiKey(body.apiKey, body.label);
      }
    }),
  );

  app.patch(
    '/api/accounts/:backendId/:accountId',
    handle(PatchBody, async (req, body) => {
      const backend = backendOf(req);
      if (body.token !== undefined) {
        if (backend !== 'claude-code') {
          throw new SettingsError(
            400,
            'invalid_input',
            'Reconnect an OpenAI login by signing in again',
          );
        }
        await shared.connectClaude(accountOf(req), body.token);
      }
      if (body.label !== undefined) shared.relabel(backend, accountOf(req), body.label);
    }),
  );

  app.post(
    '/api/accounts/:backendId/:accountId/disconnect',
    handle(undefined, (req) => shared.disconnect(backendOf(req), accountOf(req))),
  );

  app.delete(
    '/api/accounts/:backendId/:accountId',
    handle(undefined, (req) => shared.remove(backendOf(req), accountOf(req))),
  );

  app.put(
    '/api/accounts/:backendId/order',
    handle(OrderBody, (req, body) => shared.order(backendOf(req), body.accountIds)),
  );

  app.put(
    '/api/accounts/:backendId/strategy',
    handle(StrategyBody, (req, body) => shared.setStrategy(backendOf(req), body.strategy)),
  );

  app.post(
    '/api/accounts/:backendId/adopt',
    handle(AdoptBody, async (req, body) => {
      const backend = backendOf(req);
      await shared.adoptInto(body.daemonId, backend === 'codex' ? 'codex-login' : 'claude-login');
    }),
  );

  const keyOf = (req: FastifyRequest) => {
    const parsed = ProviderKeyId.safeParse((req.params as { keyId?: string }).keyId);
    if (!parsed.success) {
      throw new SettingsError(
        404,
        'unknown_key',
        `No provider key ${(req.params as { keyId?: string }).keyId}`,
      );
    }
    return parsed.data;
  };

  app.put(
    '/api/providers/keys/:keyId',
    handle(KeyBody, (req, body) => shared.setProviderKey(keyOf(req), body.value)),
  );

  app.delete(
    '/api/providers/keys/:keyId',
    handle(undefined, (req) => shared.revokeProviderKey(keyOf(req))),
  );

  app.post(
    '/api/providers/keys/:keyId/adopt',
    handle(AdoptBody, async (req, body) => {
      await shared.adoptInto(body.daemonId, 'provider-key', keyOf(req));
    }),
  );

  app.post(
    '/api/settings/claude/adopt',
    handle(ClaudeAdoptBody, async (_req, body) => {
      await shared.adoptInto(body.daemonId, 'claude-settings', body.target);
    }),
  );
}
