// Persistent WebSocket client for the Python sidecars (group 14, H2).
//
// Each call to KokoroBackend.synthesize() / LocalWhisperBackend.transcribe()
// used to open a fresh WS to the Python sidecar — the TCP+WS handshake
// alone burns ~tens to hundreds of ms, directly eating the <600ms
// first-frame and <1500ms local-whisper budgets.
//
// This module owns ONE long-lived WS per sidecar URL, reused across all
// requests. Lifecycle:
//
//   - Lazy open: first request forces a connect.
//   - Reconnect: on close/error, mark 'reconnecting', exponential backoff
//     (1s, 2s, 4s, max 30s), retry indefinitely. Inbound calls during
//     reconnect are queued (cap 10); the 11th rejects with a typed error.
//   - Per-request multiplex: requests hold the wire by FIFO. The wire
//     protocol on the sidecar side is intentionally point-to-point — we
//     do NOT pretend to round-robin concurrent inferences (Kokoro and
//     faster-whisper are both single-stream models on a single GPU/CPU
//     anyway). What's saved is the connection-setup cost.
//
// NO FALLBACK: if a request would exceed the queue cap, throw. If reconnect
// fails terminally (which it shouldn't with infinite backoff), throw.

import type { Logger } from 'pino';
import { WebSocket as WsImpl, type WebSocket as WsSocket } from 'ws';

export interface RequestHandlers {
  /** Called for every binary frame inbound during this request. */
  onBinary?: (data: Buffer) => void;
  /**
   * Called for every JSON text frame inbound during this request.
   * Return `true` to mark the request as complete (resolve with the JSON).
   */
  onJson: (msg: unknown) => boolean | { done: true; value: unknown };
  /** Optional: called once when the request completes (cleanup). */
  onComplete?: () => void;
}

export interface PendingRequest {
  /** The text payload to send once the wire is owned. */
  payload: string;
  /** Optional binary payload sent immediately AFTER the text payload. */
  binaryPayload?: Buffer;
  handlers: RequestHandlers;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface PersistentWsOptions {
  url: string;
  logger: Logger;
  /** Cap of in-flight + queued requests during reconnect. Default 10. */
  maxQueue?: number;
  /** Test hook: substitute the WS constructor. */
  wsCtor?: new (url: string) => WsSocket;
}

type ConnState = 'closed' | 'connecting' | 'open' | 'reconnecting';

export class PersistentWsClient {
  private readonly url: string;
  private readonly log: Logger;
  private readonly maxQueue: number;
  private readonly wsCtor: new (url: string) => WsSocket;
  private state: ConnState = 'closed';
  private sock?: WsSocket;
  private current?: PendingRequest;
  private queue: PendingRequest[] = [];
  private backoffMs = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(opts: PersistentWsOptions) {
    this.url = opts.url;
    this.log = opts.logger;
    this.maxQueue = opts.maxQueue ?? 10;
    // A STATIC import, not a runtime `require('ws')`. The bundled host has no
    // node_modules to require from, so a runtime resolve fails on every
    // installed machine ("Cannot find module 'ws'") while working fine from a
    // source checkout — the exact shape of bug an artifact must not carry.
    this.wsCtor = opts.wsCtor ?? (WsImpl as unknown as new (url: string) => WsSocket);
  }

  /**
   * Submit a request. Resolves with whatever value the handlers' final
   * onJson returns ({done:true, value}); rejects on connection terminal
   * failure or queue overflow.
   */
  request(args: {
    payload: string;
    binaryPayload?: Buffer;
    handlers: RequestHandlers;
  }): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('persistent-ws: client closed'));
    }
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        payload: args.payload,
        ...(args.binaryPayload !== undefined ? { binaryPayload: args.binaryPayload } : {}),
        handlers: args.handlers,
        resolve,
        reject,
      };
      const inflight = (this.current ? 1 : 0) + this.queue.length;
      if (inflight >= this.maxQueue) {
        reject(new Error(`persistent-ws: queue full (cap=${this.maxQueue})`));
        return;
      }
      this.queue.push(pending);
      this.pump();
    });
  }

  /**
   * Fire-and-forget out-of-band send. Used for control envelopes (e.g. a
   * cancel for a streaming request) that must NOT wait for the FIFO queue
   * to drain. Returns true if the frame was sent, false if the wire wasn't
   * open. Errors are logged + swallowed.
   */
  sendOutOfBand(payload: string): boolean {
    if (this.state !== 'open' || !this.sock) return false;
    try {
      this.sock.send(payload);
      return true;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'persistent-ws: out-of-band send failed');
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.current) {
      this.current.reject(new Error('persistent-ws: client closed'));
      this.current = undefined;
    }
    while (this.queue.length > 0) {
      const q = this.queue.shift();
      if (q) q.reject(new Error('persistent-ws: client closed'));
    }
    if (this.sock) {
      try {
        this.sock.close();
      } catch {
        /* ignore */
      }
    }
    this.state = 'closed';
  }

  // --- internals ----------------------------------------------------------

  private pump(): void {
    if (this.closed) return;
    if (this.state === 'open' && !this.current && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.current = next;
        this.dispatchCurrent();
      }
      return;
    }
    if (this.state === 'closed') {
      this.connect();
    }
  }

  private connect(): void {
    /* v8 ignore next -- defensive: connect()'s only caller (pump()) already returns early when `this.closed`, synchronously, so this can never observe `closed === true`. */
    if (this.closed) return;
    this.state = 'connecting';
    let sock: WsSocket;
    try {
      sock = new this.wsCtor(this.url);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, url: this.url }, 'persistent-ws: ctor failed');
      this.scheduleReconnect();
      return;
    }
    this.sock = sock;
    sock.once('open', () => {
      this.log.info({ url: this.url }, 'persistent-ws: connected');
      this.state = 'open';
      this.backoffMs = 1000; // reset backoff on success
      this.pump();
    });
    sock.on('message', (data: Buffer | string, isBinary: boolean) => {
      this.onMessage(data, isBinary);
    });
    // A refused connect fires `error` AND `close`, and a replaced socket can
    // still close late. Only the live socket's first event counts: each extra
    // one used to schedule its own reconnect, doubling the attempts per round.
    sock.on('close', () => {
      this.onDisconnect('close', sock);
    });
    sock.on('error', (err: Error) => {
      this.log.warn({ err: err.message, url: this.url }, 'persistent-ws: error');
      this.onDisconnect('error', sock);
    });
  }

  private onMessage(data: Buffer | string, isBinary: boolean): void {
    if (!this.current) {
      // Stray frame outside any request — log + drop.
      this.log.debug('persistent-ws: stray frame outside any request');
      return;
    }
    if (isBinary || (typeof data !== 'string' && data instanceof Buffer && (data as Buffer))) {
      // We treat anything non-string as binary IFF the ws layer says so OR
      // it's a Buffer that isn't being parsed as JSON by the handler. Try
      // JSON first if it's a Buffer that looks like a string; otherwise
      // pass to onBinary.
      if (isBinary && this.current.handlers.onBinary) {
        this.current.handlers.onBinary(data as Buffer);
        return;
      }
      if (!isBinary) {
        /* v8 ignore next -- unreachable: `!isBinary` here already forced the outer condition's `typeof data !== 'string'` clause true, so `data` is always a Buffer at this point. */
        const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
        this.handleJson(text);
        return;
      }
      // isBinary true but no onBinary handler — drop quietly.
      return;
    }
    this.handleJson(data as string);
  }

  private handleJson(text: string): void {
    /* v8 ignore next -- defensive: both call sites (onMessage) already return early on `!this.current`, synchronously, before reaching either call to handleJson(). */
    if (!this.current) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.current.reject(
        new Error(`persistent-ws: bad json from sidecar: ${(err as Error).message}`),
      );
      this.endCurrent();
      return;
    }
    let result;
    try {
      result = this.current.handlers.onJson(parsed);
    } catch (err) {
      this.current.reject(err as Error);
      this.endCurrent();
      return;
    }
    if (result === false) return;
    // Done.
    if (typeof result === 'object' && result !== null && 'value' in result) {
      this.current.resolve((result as { value: unknown }).value);
    } else {
      this.current.resolve(parsed);
    }
    this.endCurrent();
  }

  private endCurrent(): void {
    /* v8 ignore next -- defensive: all 3 call sites (handleJson) already return early on `!this.current` before reaching endCurrent(). */
    if (!this.current) return;
    try {
      this.current.handlers.onComplete?.();
    } catch {
      /* ignore */
    }
    this.current = undefined;
    this.pump();
  }

  private dispatchCurrent(): void {
    /* v8 ignore next -- defensive: the `!this.current` half is unreachable — dispatchCurrent()'s only caller (pump()) always sets `this.current = next` immediately, synchronously, before calling it. */
    if (!this.sock || !this.current) return;
    try {
      this.sock.send(this.current.payload);
      if (this.current.binaryPayload !== undefined) {
        this.sock.send(this.current.binaryPayload, { binary: true });
      }
    } catch (err) {
      this.current.reject(err as Error);
      this.current = undefined;
      this.onDisconnect('send-failed', this.sock);
    }
  }

  private onDisconnect(reason: string, sock: WsSocket): void {
    if (this.state === 'closed' || this.closed) return;
    if (sock !== this.sock) return;
    this.log.warn(
      { reason, url: this.url, queued: this.queue.length, hadCurrent: !!this.current },
      'persistent-ws: disconnected; will reconnect',
    );
    if (this.current) {
      // Re-queue the in-flight request? No — the sidecar may have already
      // started work on it; we can't safely resume mid-stream. Reject.
      this.current.reject(new Error(`persistent-ws: connection dropped (${reason})`));
      this.current = undefined;
    }
    this.state = 'reconnecting';
    this.sock = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    /* v8 ignore next -- defensive: both callers (connect()'s catch, onDisconnect()) only reach here synchronously when `!this.closed`; onDisconnect() itself already guards on `this.closed` at its top. */
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.state = 'closed';
      this.pump();
    }, delay);
  }

  // Test helpers.
  _stateForTest(): ConnState {
    return this.state;
  }
  _queuedCountForTest(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }
}
