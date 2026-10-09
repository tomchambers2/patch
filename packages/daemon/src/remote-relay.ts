// The calling machine's half of a cross-host `patch_peek` / `patch_history` /
// `patch_send_to` (spec/03 § Cross-chat tools). Generalises the wait-for-the-
// named-machine's-answer shape `remote-spawn.ts` already established for
// `patch_spawn` — emit a request carrying a fresh requestId, resolve or
// reject on that requestId's `.response`.
//
// "A tool result is part of a turn in progress, so it resolves rather than
// buffering the way `chat.input` does, and the agent decides what to do."
//
// NO FALLBACK. Before this existed, `patch_peek`/`patch_history`/`patch_send_to`
// only ever asked the CALLING machine's own local chat state, so a chatId that
// lived on another registered host — one `patch_list_chats` had just named —
// 404'd as `chat_not_found`, indistinguishable from a chat that never existed.

import type { WireEvent } from '@patch/wire';

/** How long the calling machine waits for the owning machine's answer. */
export const REMOTE_RELAY_TIMEOUT_MS = 15_000;

/** A cross-host relay the owning machine refused, or never answered. */
export class RemoteRelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteRelayError';
  }
}

export interface RemoteRelayCoordinator<TResult> {
  /**
   * Emit a request built by `build(requestId)` and resolve/reject on the
   * matching `.response`. `describeTimeout` renders the message for an
   * unanswered call — the only per-call-site text, since everything else
   * about the wait is identical across peek/history/send_to.
   */
  call(build: (requestId: string) => WireEvent, describeTimeout: () => string): Promise<TResult>;
  /** Feed an inbound `.response` in. Returns false for an unknown requestId. */
  resolve(event: {
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
  }): boolean;
}

export function createRemoteRelayCoordinator<TResult = unknown>(deps: {
  emit: (event: WireEvent) => void;
  onUnknownResponse: (requestId: string) => void;
  timeoutMs?: number;
  /** Injectable so a test can assert correlation without racing the clock. */
  newRequestId?: () => string;
  /** Prefix for minted ids — lets several coordinators share one server-side route map with no risk of collision. */
  idPrefix?: string;
}): RemoteRelayCoordinator<TResult> {
  const timeoutMs = deps.timeoutMs ?? REMOTE_RELAY_TIMEOUT_MS;
  const prefix = deps.idPrefix ?? 'rrelay';
  const newRequestId =
    deps.newRequestId ??
    (() => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const waiters = new Map<
    string,
    (outcome: { ok: true; result: TResult } | { ok: false; code: string; message: string }) => void
  >();

  return {
    async call(build, describeTimeout) {
      const requestId = newRequestId();
      return await new Promise<TResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(requestId);
          reject(new RemoteRelayError('sdk_error', describeTimeout()));
        }, timeoutMs);
        timer.unref?.();
        waiters.set(requestId, (outcome) => {
          clearTimeout(timer);
          if (outcome.ok) {
            resolve(outcome.result);
            return;
          }
          reject(new RemoteRelayError(outcome.code, outcome.message));
        });
        deps.emit(build(requestId));
      });
    },

    resolve(event) {
      const waiter = waiters.get(event.requestId);
      if (!waiter) {
        deps.onUnknownResponse(event.requestId);
        return false;
      }
      waiters.delete(event.requestId);
      if (event.ok) {
        waiter({ ok: true, result: event.result as TResult });
        return true;
      }
      waiter({
        ok: false,
        code: event.error?.code ?? 'sdk_error',
        message: event.error?.message ?? 'the owning machine refused the call without a reason',
      });
      return true;
    },
  };
}
