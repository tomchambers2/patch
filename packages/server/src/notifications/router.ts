// Notification router (group 11, spec/09).
//
// The host emits `notify` wire events upstream. The server is the
// canonical fanout point. Channel branches:
//
//   push      — Expo's push API. Suppressed if any surface heartbeat within
//               30s, unless priority='silent' or it is a call ring. 'urgent'
//               is suppressed like 'normal' — it differs only in its sound
//               (spec/09 § Reaching the user). Failures logged to
//               /data/undelivered.jsonl.
//   desktop   — forward `notify` wire event to all connected desktop surfaces.
//   speakers  — emit `notify` to voice-device surfaces (broadcast, or pinned
//               to deviceId when supplied). Surface-side TTS / firmware
//               handles playback.
//
// NO FALLBACKS:
//   - No push backend injected → fail loudly when channel='push' fires
// (server start-up does not pre-fail because notifications may never be used,
// but the first invocation of a channel without its dependency throws.)

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import type { NotifyActions, NotifyEvent, WireEvent } from '@patch/wire';
import type { PresenceTracker } from '../presence.js';
import type { Registry } from '../registry.js';
import type { WsHub } from '../ws-hub.js';
import { stripMarkdown } from './stripMarkdown.js';

export interface NotificationRouterDeps {
  logger: Logger;
  registry: Registry;
  presence: PresenceTracker;
  wsHub: WsHub;
  /** Where to land /data/undelivered.jsonl. */
  dataDir: string;
  /** Push backend — abstracts the Expo push API so tests can mock. */
  pushBackend?: PushBackend;
  /**
   * DEV/TEST-ONLY observer for the `speakers` channel. When set, every
   * speakers notify (e.g. an auto-routed Speakers-thread TTS reply) is recorded
   * before WS fanout, so the dev/test stack can assert TTS reached a device
   * even when no real voice-device surface is connected. Injected only by the
   * dev boot (app.ts, gated on PATCH_SPEAKERS_MOCK=1) — never in production.
   */
  speakersRecorder?: SpeakersTtsRecorder;
  /** Override clock. */
  nowMs?: () => number;
}

export interface PushBackend {
  /**
   * Send a push to a list of Expo push tokens. Throws on failure.
   *
   * `failed` is every token Expo rejected (logged to undelivered.jsonl).
   * `permanentlyRejected` is the subset whose rejection is permanent
   * (unregistered / malformed token) — the router prunes these from the
   * registry so they are never re-attempted (spec/09: no retry queue).
   */
  send(
    tokens: string[],
    payload: PushPayload,
  ): Promise<{ delivered: number; failed: string[]; permanentlyRejected: string[] }>;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  /** When true, the OS uses high-priority delivery. */
  urgent?: boolean;
  /** When true, it arrives with no sound and no vibration. */
  silent?: boolean;
  /**
   * When true, it plays the urgent sound instead of the ordinary one
   * (spec/09 § Reaching the user — urgent is normal with a more urgent sound).
   */
  urgentSound?: boolean;
}

export interface SpeakersTtsRecorder {
  /** Record a speakers-channel notify routed to a device. */
  record(entry: { ts: number; chatId: string; deviceId?: string; message: string }): void;
}

export interface RouteOptions {
  /**
   * Which surfaces count as "they'll see it anyway" for push suppression.
   *
   * `any` (default) is spec/09 § Presence heuristic as `patch_notify` obeys it.
   * `computer` narrows it to web/desktop, for the chat-completion notifier whose
   * whole point is reaching the phone when the user is away from the machine —
   * the phone being in hand must not suppress it.
   *
   * Server-internal: deliberately NOT a field on `NotifyEvent`. It is a routing
   * decision this server makes, not something a surface has any use for —
   * putting it on the wire would publish an implementation detail. (It was also
   * once unsafe: before spec/03 § Forward compatibility, an older surface
   * rejected any frame carrying a field it did not know.)
   */
  suppressOn?: 'any' | 'computer';

  /**
   * `desktop` channel only: skip a surface that already has `event.chatId`
   * focused (`chat.focus_change`) — it is already looking at the chat, so the
   * toast is spec/09 § Chat completion / § Waiting on you's own doorbell, not
   * one an agent asked for. Narrow and opt-in: those two callers set it, and
   * nothing else does — an agent's own `patch_notify` and a call ring
   * (`call-orchestrator.ts`) must reach every desktop surface regardless of
   * what is on screen, since those are asked for on purpose.
   */
  skipDesktopIfFocused?: boolean;
}

/**
 * Which pre-registered Android notification category (apps/mobile/src/lib/
 * notificationActions.ts) a push's `actions` should render under —
 * `'patch_reply'`/`'patch_permission'` are static (always present on the
 * phone from app boot); `'patch_dynamic'` carries a question's own option
 * text or `patch_notify`'s quickReplies, so it's only as fresh as the last
 * time this phone's JS rebuilt it.
 */
function categoryIdForActions(actions: NotifyActions): string {
  if (actions.kind === 'message') {
    return (actions.quickReplies?.length ?? 0) > 0 ? 'patch_dynamic' : 'patch_reply';
  }
  if (actions.kind === 'permission') return 'patch_permission';
  const options = actions.options;
  return options && options.length > 0 && options.length <= 3 ? 'patch_dynamic' : 'patch_reply';
}

export class NotificationRouter {
  private readonly deps: NotificationRouterDeps;

  constructor(deps: NotificationRouterDeps) {
    this.deps = deps;
  }

  /** Route an inbound `notify` event from the host. */
  async route(event: NotifyEvent, opts: RouteOptions = {}): Promise<void> {
    // No channel means the agent said only what it had to say and how much it
    // matters, which is all it can know. Where that lands is a fact about where
    // the user is: at a computer, the toast is in front of him and a push would
    // be a second copy of it; away from one, the phone is the only thing there.
    const channel = event.channel ?? this.routeFor();
    const routed: NotifyEvent = event.channel ? event : { ...event, channel };
    const log = this.deps.logger.child({ chatId: event.chatId, channel, routed: !event.channel });
    try {
      switch (channel) {
        case 'push':
          await this.routePush(routed, opts.suppressOn ?? 'any');
          break;
        case 'desktop':
          this.routeDesktop(routed, opts.skipDesktopIfFocused ?? false);
          break;
        case 'speakers':
          this.routeSpeakers(routed);
          break;
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'notify routing failed');
      this.logUndelivered({
        ts: this.now(),
        // The channel it was actually routed to, not the one it arrived with:
        // an undelivered line that says "channel: undefined" cannot be chased.
        channel,
        chatId: event.chatId,
        message: event.message,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Desktop when he is at a computer, phone when he is not — for every rung.
   * Urgent is normal with a more urgent sound, not a different destination.
   */
  private routeFor(): 'desktop' | 'push' {
    const account = this.deps.registry.getAccount();
    if (!account) return 'push';
    return this.deps.presence.isComputerActive(account.accountId, this.now()) ? 'desktop' : 'push';
  }

  private async routePush(event: NotifyEvent, suppressOn: 'any' | 'computer'): Promise<void> {
    const account = this.deps.registry.getAccount();
    if (!account) {
      throw new Error('push: no account bootstrapped');
    }
    if (!this.deps.pushBackend) {
      // NO FALLBACK — fail loudly per spec/09 + group 11 constraint.
      throw new Error('push: no push backend configured (inject pushBackend)');
    }
    // Suppression: the user being at a computer (or on the phone app) suppresses an ordinary push,
    // because the user is already somewhere the chat is visible. Which surfaces
    // count is the caller's call (see RouteOptions).
    //
    // The three levels are the agent's decision, not ours -- we only carry out
    // what each one means. 'urgent' is 'normal' with a more urgent sound, so it
    // is held back exactly as 'normal' is; only a call ring goes through
    // regardless. 'silent' is never suppressed, which reads backwards until you
    // see what it is for: it
    // makes no sound and asks for nothing now, so its whole value is being
    // there on the phone the next time the user looks. Suppressing it would
    // delete it rather than defer it.
    const isUrgent = event.priority === 'urgent' || event.kind === 'call';
    const isCall = event.kind === 'call';
    const isSilent = event.priority === 'silent';
    const active =
      suppressOn === 'computer'
        ? this.deps.presence.isComputerActive(account.accountId, this.now())
        : this.deps.presence.isActive(account.accountId, this.now());
    // A blocked-on-you ask is held back by nothing: dropping it for presence is
    // how `patch_ask_human` returned ok and the phone never buzzed.
    if (!isCall && !isSilent && event.kind !== 'ask' && active) {
      this.deps.logger.info(
        { chatId: event.chatId, suppressOn },
        'push suppressed: user is at a computer or has Patch open on the phone',
      );
      return;
    }
    const tokens = this.deps.registry.listPushTokens(account.accountId);
    if (tokens.length === 0) {
      this.logUndelivered({
        ts: this.now(),
        channel: 'push',
        chatId: event.chatId,
        message: event.message,
        error: 'no push tokens registered',
      });
      return;
    }
    const data: Record<string, string> = { chatId: event.chatId };
    if (event.kind) data['kind'] = event.kind;
    if (event.callId) data['callId'] = event.callId;
    if (event.deepLink) data['deepLink'] = event.deepLink;
    // spec/09 § Notification actions — Expo/FCM data values are strings
    // only, so the whole object travels as one JSON string the phone parses
    // back out (apps/mobile/src/lib/notificationActions.ts). `categoryId` is
    // the separate key Android's OWN notification builder reads to attach
    // action buttons to a remote push it displays itself — it looks the
    // category up from its on-device store, built at app-boot time
    // (`registerNotificationCategories`/`registerDynamicCategoryIfNeeded`),
    // entirely independently of the JS side having run for THIS push. Mirrors
    // `categoryIdentifierFor` (apps/mobile/src/lib/notificationActions.ts) —
    // deliberately duplicated, same convention as that module's own header.
    if (event.actions) {
      data['actions'] = JSON.stringify(event.actions);
      data['categoryId'] = categoryIdForActions(event.actions);
    }
    const payload: PushPayload = {
      title: event.kind === 'call' ? 'Patch is calling' : 'Patch',
      // The OS notification tray renders the body verbatim, not as markdown —
      // flatten it so `**x**` etc. don't show as literal syntax.
      body: stripMarkdown(event.message),
      data,
      urgent: isUrgent,
      silent: isSilent,
      urgentSound: event.priority === 'urgent' && !isCall,
    };
    const result = await this.deps.pushBackend.send(tokens, payload);
    // Success audit line — emit whenever Expo accepted at least one token, so a
    // daemon-originated patch_notify's ok:true is auditable end-to-end (the OS
    // push surface actually received it). Per-token failures are still
    // logged/appended below.
    if (result.delivered > 0) {
      this.deps.logger.info(
        { chatId: event.chatId, tokens: result.delivered, urgent: isUrgent, silent: isSilent },
        'push notify delivered',
      );
    }
    // Prune permanently-dead tokens BEFORE logging, so a subsequent push neither
    // re-attempts them nor re-logs an 'Expo rejected' entry (spec/09: no retry
    // queue; a stale/unregistered token must not re-fail on every push).
    if (result.permanentlyRejected.length > 0) {
      const removed = this.deps.registry.removePushTokens(result.permanentlyRejected);
      this.deps.logger.info(
        { removed, tokens: result.permanentlyRejected.length },
        'push: pruned permanently-rejected Expo push token(s) from registry',
      );
    }
    if (result.failed.length > 0) {
      // Per spec/09: "Expo push errors logged to /data/undelivered.jsonl." A
      // real Expo push send resolves with per-token failures (e.g. a
      // stale/unregistered token) rather than throwing, so the catch in
      // route() does not see these — log each rejected token here. NO
      // FALLBACK / NO retry.
      this.deps.logger.warn(
        { failed: result.failed.length, delivered: result.delivered },
        'push: partial failure',
      );
      this.logUndelivered({
        ts: this.now(),
        channel: 'push',
        chatId: event.chatId,
        message: event.message,
        error: `Expo push rejected ${result.failed.length} token(s): ${result.failed.join(', ')}`,
      });
    }
  }

  private routeDesktop(event: NotifyEvent, skipIfFocused: boolean): void {
    // Fanout to every connected desktop surface — except, when opted in, one
    // that already has this chat focused (RouteOptions.skipDesktopIfFocused).
    const wire: WireEvent = { ...event };
    const count = skipIfFocused
      ? this.deps.wsHub.sendToKindUnlessFocused('desktop', event.chatId, wire)
      : this.deps.wsHub.sendToKind('desktop', wire);
    if (count === 0) {
      this.deps.logger.info(
        { chatId: event.chatId, skipIfFocused },
        'desktop: no desktop surfaces connected, or all already have this chat focused',
      );
    } else {
      this.deps.logger.info({ chatId: event.chatId, surfaces: count }, 'desktop notify routed');
    }
  }

  private routeSpeakers(event: NotifyEvent): void {
    // DEV/TEST observability seam (no-op in production — recorder is undefined
    // unless the dev boot injected it). Records the TTS the host auto-routed
    // back to the originating device so the mock stack can assert D1-6.
    if (this.deps.speakersRecorder) {
      this.deps.speakersRecorder.record({
        ts: this.now(),
        chatId: event.chatId,
        ...(event.deviceId ? { deviceId: event.deviceId } : {}),
        message: event.message,
      });
    }
    // Fan out to voice-device surfaces. Surface-side TTS handles playback.
    let delivered = 0;
    if (event.deviceId) {
      // Specific device: scan voice-device surfaces with matching id.
      const ok = this.deps.wsHub.sendToSurface(event.deviceId, { ...event });
      delivered = ok ? 1 : 0;
    } else {
      delivered = this.deps.wsHub.sendToKind('voice-device', { ...event });
    }
    if (delivered === 0) {
      this.logUndelivered({
        ts: this.now(),
        channel: 'speakers',
        chatId: event.chatId,
        message: event.message,
        error: 'no speaker surfaces online',
      });
    } else {
      this.deps.logger.info(
        { chatId: event.chatId, surfaces: delivered },
        'speakers notify routed',
      );
    }
  }

  private logUndelivered(entry: {
    ts: number;
    channel: string;
    chatId: string;
    message: string;
    error: string;
  }): void {
    const path = join(this.deps.dataDir, 'undelivered.jsonl');
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.deps.logger.error(
        { err: (err as Error).message, path },
        'failed to write undelivered.jsonl',
      );
    }
  }

  private now(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }
}
