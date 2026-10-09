// Cross-machine `patch_spawn`: emit the request, wait for THAT machine's
// answer (spec/03 § Cross-chat tools).
//
// "A tool result is part of a turn in progress, so it resolves rather than
// buffering the way `chat.input` does, and the agent decides what to do."
//
// NO FALLBACK. Before this existed the spawn was fire-and-forget: the tool
// returned `created:'remote'` the moment the frame left, so a target machine
// that refused (no model catalogue, unknown folder) created nothing while the
// calling agent was told it had succeeded — and went on orchestrating a chat
// that did not exist. Every outcome here, including an expiry, is either the
// real chatId or a loud error naming the machine.

import type { ChatErrorCode, WireEvent } from '@patch/wire';
import { RemoteSpawnError } from './control.js';
import { FolderNotFoundError, NoModelCatalogueError } from './chatRunner.js';

/**
 * The wire code for a spawn this machine could not perform, as sent back to the
 * machine that asked. The distinctions matter to the caller's agent: a missing
 * folder is fixed by naming a different folder, a missing catalogue by naming a
 * model or connecting the credential on that machine (spec/04 § Spawn). Folding
 * either into `sdk_error` would tell the agent to retry the same doomed call.
 */
export function describeSpawnFailure(err: unknown): { code: ChatErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof FolderNotFoundError) return { code: 'folder_not_found', message };
  if (err instanceof NoModelCatalogueError) return { code: 'no_model_catalogue', message };
  return { code: 'sdk_error', message };
}

/** How long the calling machine waits for the named machine's answer. */
export const REMOTE_SPAWN_TIMEOUT_MS = 30_000;

export interface RemoteSpawnRequest {
  host: string;
  sourceChatId: string;
  folder: string;
  model?: string;
  prompt?: string;
}

export interface RemoteSpawnCoordinator {
  /** Emit the request and resolve/reject on the target machine's response. */
  spawn(req: RemoteSpawnRequest): Promise<{ chatId?: string }>;
  /** Feed an inbound `patch.spawn.response` in. Unknown ids are reported, never swallowed. */
  resolve(event: {
    requestId: string;
    ok: boolean;
    chatId?: string;
    error?: { code: string; message: string };
  }): void;
}

export function createRemoteSpawnCoordinator(deps: {
  emit: (event: WireEvent) => void;
  onUnknownResponse: (requestId: string) => void;
  timeoutMs?: number;
  /** Injectable so a test can assert correlation without racing the clock. */
  newRequestId?: () => string;
}): RemoteSpawnCoordinator {
  const timeoutMs = deps.timeoutMs ?? REMOTE_SPAWN_TIMEOUT_MS;
  const newRequestId =
    deps.newRequestId ??
    (() => `rspawn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const waiters = new Map<
    string,
    (outcome: { ok: true; chatId?: string } | { ok: false; code: string; message: string }) => void
  >();

  return {
    async spawn(req) {
      const requestId = newRequestId();
      return await new Promise<{ chatId?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(requestId);
          reject(
            new RemoteSpawnError(
              'sdk_error',
              `patch_spawn: machine ${req.host} did not answer within ${Math.round(timeoutMs / 1000)}s; the chat may or may not have been created there`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiters.set(requestId, (outcome) => {
          clearTimeout(timer);
          if (outcome.ok) {
            resolve(outcome.chatId !== undefined ? { chatId: outcome.chatId } : {});
            return;
          }
          reject(
            new RemoteSpawnError(
              outcome.code,
              `patch_spawn: machine ${req.host} refused: ${outcome.message}`,
            ),
          );
        });
        deps.emit({
          type: 'patch.spawn',
          sourceChatId: req.sourceChatId,
          daemonId: req.host,
          folder: req.folder,
          ...(req.model !== undefined ? { model: req.model } : {}),
          prompt: req.prompt ?? '',
          requestId,
        });
      });
    },

    resolve(event) {
      const waiter = waiters.get(event.requestId);
      if (!waiter) {
        deps.onUnknownResponse(event.requestId);
        return;
      }
      waiters.delete(event.requestId);
      if (event.ok) {
        waiter({ ok: true, ...(event.chatId !== undefined ? { chatId: event.chatId } : {}) });
        return;
      }
      waiter({
        ok: false,
        code: event.error?.code ?? 'sdk_error',
        message: event.error?.message ?? 'the target machine refused the spawn without a reason',
      });
    },
  };
}
