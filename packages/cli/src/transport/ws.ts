// WebSocket client used by the TUI. Wraps @patch/wire/test-client with
// reconnect-with-backoff and per-chat replay on reconnect.
//
// On reconnect: re-sends `hello`, then for every chatId we have seen we
// emit `chat.replay` from `lastSeq` so we don't miss events. NO FALLBACKS:
// a fatal handshake error surfaces.

import { WireTestClient } from '@patch/wire/test-client';
import type { ClientType, WireEvent, WireEventType } from '@patch/wire';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface PatchWsOptions {
  url: string;
  bearer: string | null;
  clientType?: ClientType;
  clientVersion?: string;
  /** Initial reconnect delay (ms). Doubles up to maxBackoffMs. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Test hook to disable auto-reconnect. */
  noAutoReconnect?: boolean;
}

type Listener<T extends WireEventType> = (e: Extract<WireEvent, { type: T }>) => void;

export class PatchWsClient {
  private readonly opts: PatchWsOptions;
  private client: WireTestClient | null = null;
  private state: ConnectionState = 'offline';
  private readonly listeners = new Map<WireEventType, Set<Listener<WireEventType>>>();
  /**
   * Event types we've already wired a forwarder for on the CURRENT client.
   * Reset on every (re)connect so each fresh client gets exactly one forwarder
   * per type — see `wireForwarders`. Without tracking this we'd either
   * double-wire (duplicate dispatch) or, in the connect race, never wire at all.
   */
  private readonly forwardedTypes = new Set<WireEventType>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly seenChatIds = new Set<string>();
  private backoffMs: number;
  private readonly maxBackoffMs: number;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(opts: PatchWsOptions) {
    this.opts = opts;
    this.backoffMs = opts.initialBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  getState(): ConnectionState {
    return this.state;
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  on<T extends WireEventType>(type: T, cb: Listener<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const generic = cb as unknown as Listener<WireEventType>;
    set.add(generic);
    // Make sure the underlying client forwards this type. The TUI mounts
    // ChatView and subscribes AFTER `connect()` is called but often BEFORE it
    // resolves — so neither the post-connect branch here nor `openOnce`'s
    // one-shot wiring loop (which ran when `listeners` was still empty) would
    // wire this type. `wireForwarders` reconciles both ends idempotently so the
    // forwarder always lands once a client exists. NO FALLBACK: without it the
    // stream silently never renders (G1-15).
    this.wireForwarders();
    return () => set?.delete(generic);
  }

  /**
   * Ensure the current client has exactly one forwarder per registered
   * listener type. Idempotent: safe to call on connect and on every `on()`.
   * No-op when there is no live client (forwarders are wired on the next
   * connect via this same method).
   */
  private wireForwarders(): void {
    const client = this.client;
    if (!client) return;
    for (const type of this.listeners.keys()) {
      if (this.forwardedTypes.has(type)) continue;
      this.forwardedTypes.add(type);
      client.on(type, (event) => this.dispatch(event));
    }
  }

  trackChat(chatId: string): void {
    this.seenChatIds.add(chatId);
  }

  /**
   * Track a chat AND immediately request a replay of its existing stream.
   *
   * The spawn path renders live because the surface is the one driving the
   * turn — events arrive as the host produces them. The ATTACH/resume/browse
   * paths join a chat that is already producing (or has already produced)
   * output, so without an explicit replay the event pane would stay empty
   * until the next live event. Adding the chat to `seenChatIds` also means any
   * future reconnect re-replays it via `openOnce`. NO FALLBACK: if we're not
   * connected yet, the chat is still tracked and the replay fires on connect.
   */
  attachChat(chatId: string): void {
    this.seenChatIds.add(chatId);
    if (this.client && this.state === 'connected') {
      this.client.replayFromLastSeen(chatId);
    }
  }

  /** Send a wire event. Throws if not connected. */
  send(event: WireEvent): void {
    if (!this.client) throw new Error('PatchWsClient: not connected');
    this.client.send(event);
  }

  sendInput(chatId: string, message: string, localId?: string): void {
    if (!this.client) throw new Error('PatchWsClient: not connected');
    this.seenChatIds.add(chatId);
    this.client.sendInput(
      localId === undefined ? { chatId, message } : { chatId, message, localId },
    );
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.openOnce();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.close();
    }
    this.setState('offline');
  }

  private async openOnce(): Promise<void> {
    this.setState(this.state === 'offline' ? 'connecting' : 'reconnecting');
    const client = new WireTestClient({
      url: this.opts.url,
      ...(this.opts.bearer !== null && this.opts.bearer !== undefined
        ? { auth: this.opts.bearer }
        : {}),
      ...(this.opts.clientType ? { clientType: this.opts.clientType } : {}),
      ...(this.opts.clientVersion ? { clientVersion: this.opts.clientVersion } : {}),
    });
    try {
      await client.connect();
    } catch (err) {
      this.client = null;
      if (!this.opts.noAutoReconnect && !this.closed) this.scheduleReconnect();
      throw err;
    }
    this.client = client;
    this.backoffMs = this.opts.initialBackoffMs ?? 500;
    // A long-lived TUI socket can drop (server restart, network blip) or emit a
    // late error AFTER connect. WireTestClient surfaces both via onError/onClose
    // instead of letting Node crash on an unhandled 'error'. We treat either as
    // a disconnect: drop the dead client and schedule a reconnect, which
    // re-wires forwarders and re-replays every seen chat so the stream resumes.
    const onDisconnect = (): void => {
      if (this.client !== client) return; // already replaced/closed
      this.client = null;
      this.forwardedTypes.clear();
      if (!this.opts.noAutoReconnect && !this.closed) this.scheduleReconnect();
      else this.setState('offline');
    };
    client.onError(onDisconnect);
    client.onClose(onDisconnect);
    // Fresh client => no forwarders yet. Wire one per registered listener type
    // AFTER `this.client` is set so the reconcile in `on()` and here agree on a
    // single source of truth. This closes the connect race: ChatView subscribes
    // while we are still `connecting`, so the forwarders MUST be (re)wired here
    // against the live client — not only in the pre-connect window.
    this.forwardedTypes.clear();
    this.wireForwarders();
    this.setState('connected');

    // Replay per chat we've already seen (best-effort — server returns
    // chat.error if the chat doesn't exist, which is fine). Runs AFTER
    // forwarders are wired so replayed events actually dispatch to listeners.
    for (const chatId of this.seenChatIds) {
      client.replayFromLastSeen(chatId);
    }

    // Auto-reconnect on close.
    // The WireTestClient internally holds the ws; we tap close via timer.
    // Since WireTestClient doesn't expose close events, we poll here only on
    // explicit failures via `send` / `connect`. For TUI use this is enough.
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.setState('reconnecting');
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.min(this.backoffMs, this.maxBackoffMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      void this.openOnce().catch(() => {
        if (!this.closed) this.scheduleReconnect();
      });
    }, wait);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.stateListeners) cb(state);
  }

  private dispatch(event: WireEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const cb of set) cb(event);
  }
}
