// WireTestClient — a tiny typed WebSocket client used by integration tests.
//
// Lives inside @patch/wire so any package's test suite can import it without
// a circular dep on @patch/server. Uses the `ws` library (Node WebSocket).
//
// Capabilities:
// - hello handshake on connect
// - typed event emitter via `on(eventType, handler)`
// - per-chat seq buffering
// - replay request via `replay(chatId, fromSeq)`
// - idempotent `sendInput({chatId, message, localId})` (server dedupes)
//
// Per portfolio convention: no fallbacks. If the WS errors we surface it.

import WebSocket from 'ws';
import { encode, decode } from './codec.js';
import {
  type WireEvent,
  type WireEventType,
  type ClientType,
  type HelloEvent,
  type ChatInputEvent,
  type ChatReplayEvent,
} from './events.js';

type EventForType<T extends WireEventType> = Extract<WireEvent, { type: T }>;
type Handler<T extends WireEventType> = (event: EventForType<T>) => void;

export interface WireTestClientOptions {
  url: string;
  clientType?: ClientType;
  clientVersion?: string;
  auth?: string;
  // Connection timeout for the initial handshake; default 5s.
  connectTimeoutMs?: number;
}

export class WireTestClient {
  private readonly url: string;
  private readonly hello: HelloEvent;
  private readonly connectTimeoutMs: number;
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<WireEventType, Set<Handler<WireEventType>>>();
  // Highest seq seen per chatId — used so callers can `replay(chatId, lastSeq)`.
  private readonly lastSeqByChat = new Map<string, number>();
  private readonly errorHandlers = new Set<(err: Error) => void>();
  private readonly closeHandlers = new Set<(code: number, reason: string) => void>();

  constructor(opts: WireTestClientOptions) {
    this.url = opts.url;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.hello = {
      type: 'hello',
      clientType: opts.clientType ?? 'surface-cli',
      clientVersion: opts.clientVersion ?? '0.0.0-test',
      ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
    };
  }

  /** Open the socket and send the `hello` frame. Resolves once `hello` is sent. */
  async connect(): Promise<void> {
    if (this.ws) throw new Error('WireTestClient already connected');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeAllListeners();
        // `terminate()` on a still-CONNECTING socket aborts the handshake and
        // emits its OWN 'error' asynchronously (ws's abortHandshake, via
        // process.nextTick) — since we just stripped every listener, that
        // event would otherwise have none attached and crash the process
        // (Node's default behavior for an unhandled EventEmitter 'error').
        // We already reject below with our own descriptive timeout error, so
        // swallow the internal one.
        ws.on('error', () => {});
        ws.terminate();
        reject(new Error(`WireTestClient: connect timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on('message', (data: WebSocket.RawData) => {
      // `decode` throws on malformed input — that's the contract. Surface it
      // by re-throwing on the next tick so node:test reports it as an
      // unhandled rejection / uncaught instead of swallowing.
      const buf = Array.isArray(data) ? Buffer.concat(data) : data;
      const event = decode(buf as Buffer);
      this.recordSeq(event);
      this.dispatch(event);
    });

    // PERSISTENT error/close listeners. The connect promise above consumed its
    // one-shot `once('error')`, leaving the socket with NO error listener — so
    // any post-connect socket error (server drop, mid-teardown reset) would emit
    // an 'error' event with no handler and CRASH the process (Node's default
    // behaviour for unhandled 'error' events). The long-lived TUI hit exactly
    // this. We forward both to registered handlers so the owner (PatchWsClient)
    // can react (reconnect) instead of dying. NOT a fallback that hides the
    // error — it is surfaced to handlers; with none registered we keep the
    // process alive rather than aborting the whole TUI on a transient socket
    // blip.
    ws.on('error', (err: Error) => {
      for (const h of this.errorHandlers) h(err);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      for (const h of this.closeHandlers) h(code, reason.toString());
    });

    ws.send(encode(this.hello));
  }

  /** Subscribe to post-connect socket errors. Returns an unsubscribe fn. */
  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /** Subscribe to socket close. Returns an unsubscribe fn. */
  onClose(handler: (code: number, reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  /** Send any wire event. Useful for tests that drive non-input flows. */
  send(event: WireEvent): void {
    const ws = this.requireOpen();
    ws.send(encode(event));
  }

  /**
   * Idempotent user-input send. `localId` is required by the wire schema;
   * if the caller omits it we synthesise one via `crypto.randomUUID()` so
   * the server can dedupe across retries. Tests asserting dedup behaviour
   * should pass an explicit `localId`.
   */
  sendInput(input: { chatId: string; message: string; localId?: string }): void {
    const event: ChatInputEvent = {
      type: 'chat.input',
      chatId: input.chatId,
      message: input.message,
      localId: input.localId ?? crypto.randomUUID(),
    };
    this.send(event);
  }

  /** Request replay of all events with seq > fromSeq for a chat. */
  replay(chatId: string, fromSeq: number): void {
    const event: ChatReplayEvent = { type: 'chat.replay', chatId, fromSeq };
    this.send(event);
  }

  /**
   * Last seq seen for a chat, or `undefined` if no chat-scoped event has
   * arrived. Note: `chat.replay { fromSeq }` requires a non-negative number
   * — call `replayFromLastSeen(chatId)` to handle the "nothing seen" case.
   */
  lastSeq(chatId: string): number | undefined {
    return this.lastSeqByChat.get(chatId);
  }

  /**
   * Convenience: request replay from the highest seq we've seen on this
   * chat, or from `-1` (i.e. all events, including seq 0) if we haven't seen
   * anything yet. Replay is exclusive (`seq > fromSeq`), so the never-seen
   * case must use `-1` — `0` would skip the first event.
   */
  replayFromLastSeen(chatId: string): void {
    this.replay(chatId, this.lastSeqByChat.get(chatId) ?? -1);
  }

  /** Subscribe to a single event type. Returns an unsubscribe function. */
  on<T extends WireEventType>(eventType: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    const generic = handler as unknown as Handler<WireEventType>;
    set.add(generic);
    return () => {
      set?.delete(generic);
    };
  }

  /** Wait for the next event of a given type (with optional predicate). */
  waitFor<T extends WireEventType>(
    eventType: T,
    predicate?: (event: EventForType<T>) => boolean,
    timeoutMs = 2000,
  ): Promise<EventForType<T>> {
    return new Promise<EventForType<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`WireTestClient.waitFor(${eventType}): timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsub = this.on(eventType, (event) => {
        if (predicate && !predicate(event)) return;
        clearTimeout(timer);
        unsub();
        resolve(event);
      });
    });
  }

  // --- internals ---

  private requireOpen(): WebSocket {
    const ws = this.ws;
    if (!ws) throw new Error('WireTestClient: not connected');
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WireTestClient: socket not open (readyState=${ws.readyState})`);
    }
    return ws;
  }

  private recordSeq(event: WireEvent): void {
    if ('seq' in event && 'chatId' in event && typeof event.chatId === 'string') {
      const prior = this.lastSeqByChat.get(event.chatId);
      if (prior === undefined || event.seq > prior) {
        this.lastSeqByChat.set(event.chatId, event.seq);
      }
    }
  }

  private dispatch(event: WireEvent): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      handler(event);
    }
  }
}
