// patch_call orchestrator (group 11, spec/09).
//
// Receives `patch.call` events from the host, fans out concurrent push
// (urgent) + desktop ring, tracks call state in memory, picks first-accept
// winner, and times out at 30s with a push fallback.

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  ChatCallRequestEvent,
  ChatCallResponseEvent,
  ChatCallTimeoutEvent,
  ChatCallWinnerEvent,
  NotifyEvent,
  ChatSpeakEvent,
  PatchCallEvent,
} from '@patch/wire';
import type { NotificationRouter } from './router.js';
import type { SurfaceKind, WsHub } from '../ws-hub.js';

/**
 * Group 12 (DX-3): only ringer-capable surfaces (mobile + desktop per spec/09)
 * should receive `chat.call_request`. Web and terminal don't ring; voice-device
 * is its own audio loop and must not double-ring. The accept/winner/timeout
 * fanout intentionally still goes to ALL surfaces (asymmetric) so any UI
 * showing pre-call hints can clear cleanly.
 */
const RINGER_KINDS: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['mobile', 'desktop']);

export interface CallState {
  callId: string;
  chatId: string;
  status: 'ringing' | 'accepted' | 'declined' | 'timeout' | 'spoken';
  startedAt: number;
  message?: string;
  acceptedSurfaceId?: string;
  timeoutHandle?: NodeJS.Timeout;
}

export interface CallOrchestratorDeps {
  logger: Logger;
  wsHub: WsHub;
  router: NotificationRouter;
  /** Default 30000. */
  timeoutMs?: number;
  nowMs?: () => number;
  idGenerator?: () => string;
  /**
   * The account's reach setting (spec/09 § Reaching the user). Under
   * `auto-notify` a call is spoken aloud instead of ringing. Unset behaves as
   * `notify`, which is the default and what every existing test expects.
   */
  reach?: () => 'notify' | 'auto-notify';
}

export class CallOrchestrator {
  private readonly calls = new Map<string, CallState>();
  /**
   * Group 12 (MED-4): GC window for resolved calls. Late `chat.call_response`
   * frames within this window still see the resolved state (so the dedupe
   * branch in `handleResponse` can log "response after resolve" rather than
   * "unknown call"). After it elapses we drop the entry to bound memory.
   */
  private static readonly GC_DELAY_MS = 60_000;

  constructor(private readonly deps: CallOrchestratorDeps) {}

  /** Schedule entry deletion `GC_DELAY_MS` after a call resolves. */
  private scheduleGc(callId: string): void {
    const t = setTimeout(() => {
      this.calls.delete(callId);
    }, CallOrchestrator.GC_DELAY_MS);
    t.unref?.();
  }

  /** Inbound from host: a chat invoked patch_call. */
  async startCall(event: PatchCallEvent): Promise<string> {
    const callId = this.deps.idGenerator ? this.deps.idGenerator() : randomUUID();
    const now = this.now();
    const state: CallState = {
      callId,
      chatId: event.chatId,
      status: 'ringing',
      startedAt: now,
      ...(event.message !== undefined ? { message: event.message } : {}),
    };
    this.calls.set(callId, state);

    // spec/09 § Reaching the user — under `auto-notify` a call does not ring.
    // The message is spoken aloud on the surface the user is at, in a short
    // session that holds no microphone, and nothing is accepted or answered.
    // The call resolves immediately: there is nobody to wait 30 seconds for.
    if (this.deps.reach?.() === 'auto-notify' && event.message !== undefined) {
      const speak: ChatSpeakEvent = {
        type: 'chat.speak',
        callId,
        chatId: event.chatId,
        message: event.message,
      };
      this.deps.wsHub.sendToKinds(RINGER_KINDS, speak);
      state.status = 'spoken';
      this.scheduleGc(callId);
      this.deps.logger.info({ callId, chatId: event.chatId }, 'call: spoken (auto-notify)');
      return callId;
    }

    // Fan out: concurrent push (urgent, kind=call) + desktop ring + chat.call_request.
    const ring: ChatCallRequestEvent = {
      type: 'chat.call_request',
      callId,
      chatId: event.chatId,
      ...(event.message !== undefined ? { message: event.message } : {}),
    };
    // Ringer-only fanout (mobile + desktop). Other surfaces still receive
    // chat.call_winner / chat.call_timeout below to clear any UI state.
    this.deps.wsHub.sendToKinds(RINGER_KINDS, ring);

    const desktopNotify: NotifyEvent = {
      type: 'notify',
      chatId: event.chatId,
      channel: 'desktop',
      message: event.message ?? 'Patch is calling',
      kind: 'call',
      callId,
    };
    const pushNotify: NotifyEvent = {
      type: 'notify',
      chatId: event.chatId,
      channel: 'push',
      message: event.message ?? 'Patch is calling',
      priority: 'urgent',
      kind: 'call',
      callId,
    };
    // Concurrent: don't await desktop (non-async); fire push.
    try {
      await this.deps.router.route(desktopNotify);
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message, callId }, 'call: desktop fanout failed');
    }
    try {
      await this.deps.router.route(pushNotify);
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message, callId }, 'call: push fanout failed');
    }

    // 30s timeout.
    const timeoutMs = this.deps.timeoutMs ?? 30_000;
    state.timeoutHandle = setTimeout(() => {
      void this.timeoutCall(callId);
    }, timeoutMs);
    state.timeoutHandle.unref?.();

    return callId;
  }

  /** Inbound from a surface: accept or decline. */
  handleResponse(surfaceId: string, event: ChatCallResponseEvent): void {
    const state = this.calls.get(event.callId);
    if (!state) {
      this.deps.logger.info(
        { callId: event.callId, surfaceId, response: event.response },
        'call: response for unknown call (already resolved?)',
      );
      return;
    }
    if (state.status !== 'ringing') {
      this.deps.logger.info(
        { callId: event.callId, status: state.status },
        'call: response after resolve — ignoring',
      );
      return;
    }
    if (event.response === 'accept') {
      state.status = 'accepted';
      state.acceptedSurfaceId = surfaceId;
      if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
      const winner: ChatCallWinnerEvent = {
        type: 'chat.call_winner',
        callId: event.callId,
        acceptedSurfaceId: surfaceId,
      };
      this.deps.wsHub.sendToAll(winner);
      this.deps.logger.info(
        { callId: event.callId, surfaceId, chatId: state.chatId },
        'call: accepted',
      );
      this.scheduleGc(event.callId);
      return;
    }
    // decline — but other surfaces may still accept. Don't resolve yet
    // unless this is the only ringing surface; let the timeout do it
    // otherwise. v1 keeps it simple: a decline doesn't end the call (per
    // spec/09 the user can decline on one device but accept on another).
    this.deps.logger.info(
      { callId: event.callId, surfaceId },
      'call: surface declined (others may still accept)',
    );
  }

  private async timeoutCall(callId: string): Promise<void> {
    const state = this.calls.get(callId);
    if (!state) return;
    if (state.status !== 'ringing') return;
    state.status = 'timeout';
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    const ev: ChatCallTimeoutEvent = { type: 'chat.call_timeout', callId };
    this.deps.wsHub.sendToAll(ev);
    // Fallback push.
    const fallback: NotifyEvent = {
      type: 'notify',
      chatId: state.chatId,
      channel: 'push',
      message: state.message ?? 'Missed call from Patch',
      priority: 'urgent',
    };
    try {
      await this.deps.router.route(fallback);
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message, callId },
        'call: timeout fallback push failed',
      );
    }
    this.deps.logger.info({ callId, chatId: state.chatId }, 'call: timed out');
    this.scheduleGc(callId);
  }

  /** Test introspection: number of in-memory call entries. */
  size(): number {
    return this.calls.size;
  }

  /** Test introspection. */
  getCall(callId: string): CallState | undefined {
    return this.calls.get(callId);
  }

  /** Clean up timeouts on shutdown. */
  shutdown(): void {
    for (const state of this.calls.values()) {
      if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    }
    this.calls.clear();
  }

  private now(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }
}
