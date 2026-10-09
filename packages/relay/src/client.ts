// The device's side of a relayed connection: dial the relay, prove (by the
// handshake) that the far end is the server the pairing code named, then make
// HTTP requests and open WebSockets through the encrypted session as though the
// server were next door.
//
// Isomorphic on purpose — the phone (React Native), a browser and Node all run
// this file — so it takes the WebSocket class as a parameter instead of reaching
// for one.

import {
  RelaySession,
  channelFor,
  clientHandshake,
  fromBase64Url,
  RelayCryptoError,
} from './crypto.js';
import {
  Msg,
  carriedHeaders,
  chunks,
  decodeMessage,
  encodeMessage,
  json,
  parseJson,
  text,
  utf8,
  type HeaderMap,
  type RequestHead,
  type ResponseHead,
  type SocketClose,
  type SocketOpen,
} from './tunnel.js';

/** The slice of the WebSocket API this file uses; `ws`, browsers and React Native all have it. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

/** What a pairing code carries about a relayed server (`@patch/wire` `PairingRelay`). */
export interface RelayTarget {
  url: string;
  channel: string;
  serverKey: string;
}

export interface RelayConnectOptions {
  WebSocket: WebSocketCtor;
  /** Give up on the relay and the handshake after this long. */
  timeoutMs?: number;
}

export interface RelayRequestInit {
  method?: string;
  headers?: HeaderMap | Iterable<[string, string]>;
  body?: Uint8Array | string | null;
  signal?: { aborted: boolean; addEventListener(type: 'abort', cb: () => void): void } | null;
}

export interface RelayHttpResponse {
  status: number;
  statusText: string;
  headers: HeaderMap;
  body: Uint8Array;
}

export class RelayError extends Error {
  constructor(
    message: string,
    /** The relay's close code when the relay ended it. */
    readonly code?: number,
  ) {
    super(message);
  }
}

const OPEN = 1;

interface PendingRequest {
  resolve(r: RelayHttpResponse): void;
  reject(e: Error): void;
  head: ResponseHead | null;
  parts: Uint8Array[];
}

export class RelayClient {
  private nextStream = 1;
  private readonly requests = new Map<number, PendingRequest>();
  private readonly sockets = new Map<number, TunnelSocket>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private ended: string | null = null;

  private constructor(
    private readonly ws: WebSocketLike,
    private readonly session: RelaySession,
  ) {
    ws.onmessage = (ev) => {
      try {
        this.receive(new Uint8Array(ev.data as ArrayBuffer));
      } catch (e) {
        this.end(
          e instanceof RelayCryptoError ? e.message : `bad frame from the relay: ${String(e)}`,
        );
      }
    };
    ws.onclose = (ev) => this.end(`relay closed the connection (${ev.code} ${ev.reason})`.trim());
    ws.onerror = () => this.end('relay connection failed');
  }

  /** Connect, handshake, and return a ready client. Rejects with a `RelayError` saying why not. */
  static connect(target: RelayTarget, opts: RelayConnectOptions): Promise<RelayClient> {
    const serverKey = fromBase64Url(target.serverKey);
    if (channelFor(serverKey) !== target.channel) {
      return Promise.reject(
        new RelayError('the pairing code’s channel does not belong to its server key'),
      );
    }
    return new Promise((resolve, reject) => {
      const handshake = clientHandshake(serverKey);
      const ws = new opts.WebSocket(
        `${target.url.replace(/\/+$/, '')}/v1/connect?channel=${target.channel}&role=client`,
      );
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const fail = (e: RelayError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        reject(e);
      };
      const timer = setTimeout(
        () => fail(new RelayError('timed out reaching the server through the relay')),
        opts.timeoutMs ?? 15_000,
      );
      let ready = false;
      ws.onmessage = (ev) => {
        try {
          if (!ready) {
            // The relay's own "ready" is a text frame; everything after is binary.
            if (
              typeof ev.data !== 'string' ||
              (JSON.parse(ev.data) as { type?: string }).type !== 'ready'
            ) {
              throw new RelayError('the relay did not say ready');
            }
            ready = true;
            ws.send(handshake.hello);
            return;
          }
          const session = handshake.finish(new Uint8Array(ev.data as ArrayBuffer));
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(new RelayClient(ws, session));
        } catch (e) {
          fail(
            e instanceof RelayError
              ? e
              : new RelayError(e instanceof Error ? e.message : String(e)),
          );
        }
      };
      ws.onclose = (ev) =>
        fail(
          new RelayError(
            ev.code === 4404
              ? 'the server is offline'
              : `relay closed the connection (${ev.code} ${ev.reason})`.trim(),
            ev.code,
          ),
        );
      ws.onerror = () => fail(new RelayError('could not reach the relay'));
    });
  }

  get closed(): boolean {
    return this.ended !== null;
  }

  /** Be told once when the session ends, for any reason. */
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.end('closed by this device');
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  private send(
    type: Parameters<typeof encodeMessage>[0],
    stream: number,
    payload?: Uint8Array,
  ): void {
    if (this.ended !== null) throw new RelayError(`the connection is closed: ${this.ended}`);
    this.ws.send(this.session.seal(encodeMessage(type, stream, payload)));
  }

  /** One HTTP request through the tunnel; the whole answer is buffered. */
  fetch(path: string, init: RelayRequestInit = {}): Promise<RelayHttpResponse> {
    if (this.ended !== null)
      return Promise.reject(new RelayError(`the connection is closed: ${this.ended}`));
    if (init.signal?.aborted) return Promise.reject(new RelayError('aborted'));
    const stream = this.nextStream++;
    return new Promise<RelayHttpResponse>((resolve, reject) => {
      this.requests.set(stream, { resolve, reject, head: null, parts: [] });
      try {
        const head: RequestHead = {
          method: (init.method ?? 'GET').toUpperCase(),
          path,
          headers: carriedHeaders(
            init.headers === undefined
              ? []
              : Symbol.iterator in Object(init.headers)
                ? (init.headers as Iterable<[string, string]>)
                : Object.entries(init.headers),
          ),
        };
        this.send(Msg.ReqHead, stream, json(head));
        const body =
          typeof init.body === 'string' ? utf8(init.body) : (init.body ?? new Uint8Array(0));
        for (const part of chunks(body)) this.send(Msg.ReqBody, stream, part);
        this.send(Msg.ReqEnd, stream);
      } catch (e) {
        this.requests.delete(stream);
        reject(e instanceof Error ? e : new RelayError(String(e)));
        return;
      }
      init.signal?.addEventListener('abort', () => {
        if (!this.requests.delete(stream)) return;
        try {
          this.send(Msg.Cancel, stream);
        } catch {
          /* the session is already over */
        }
        reject(new RelayError('aborted'));
      });
    });
  }

  /**
   * A WebSocket to `path` on the server, through the tunnel. Pass `socket` to
   * bring up one that was handed out before the session existed.
   */
  openSocket(
    path: string,
    protocols: string[] = [],
    socket: TunnelSocket = new TunnelSocket(),
  ): TunnelSocket {
    const stream = this.nextStream++;
    socket.bind(
      (type, payload) => this.send(type, stream, payload),
      () => this.sockets.delete(stream),
    );
    this.sockets.set(stream, socket);
    try {
      this.send(Msg.WsOpen, stream, json({ path, protocols } satisfies SocketOpen));
    } catch (e) {
      this.sockets.delete(stream);
      queueMicrotask(() => socket.fail(e instanceof Error ? e.message : String(e)));
    }
    return socket;
  }

  private receive(frame: Uint8Array): void {
    const msg = decodeMessage(this.session.open(frame));
    const pending = this.requests.get(msg.stream);
    switch (msg.type) {
      case Msg.ResHead:
        if (pending) pending.head = parseJson<ResponseHead>(msg.payload);
        return;
      case Msg.ResBody:
        pending?.parts.push(msg.payload.slice());
        return;
      case Msg.ResEnd: {
        if (!pending?.head) return;
        this.requests.delete(msg.stream);
        const body = new Uint8Array(pending.parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of pending.parts) {
          body.set(p, at);
          at += p.length;
        }
        pending.resolve({ ...pending.head, body });
        return;
      }
      case Msg.Error:
        if (pending) {
          this.requests.delete(msg.stream);
          pending.reject(new RelayError(parseJson<{ message: string }>(msg.payload).message));
        } else
          this.sockets.get(msg.stream)?.fail(parseJson<{ message: string }>(msg.payload).message);
        return;
      case Msg.WsOpened:
        this.sockets.get(msg.stream)?.opened();
        return;
      case Msg.WsText:
        this.sockets.get(msg.stream)?.message(text(msg.payload));
        return;
      case Msg.WsBinary:
        this.sockets.get(msg.stream)?.message(msg.payload.slice().buffer);
        return;
      case Msg.WsClose: {
        const c = parseJson<SocketClose>(msg.payload);
        this.sockets.get(msg.stream)?.closed(c.code, c.reason);
        return;
      }
      default:
        return; // a message type from a newer peer: ignored, as the wire protocol does everywhere
    }
  }

  private end(reason: string): void {
    if (this.ended !== null) return;
    this.ended = reason;
    for (const p of this.requests.values()) p.reject(new RelayError(reason));
    this.requests.clear();
    for (const s of this.sockets.values()) s.closed(1006, reason);
    this.sockets.clear();
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }
}

type Listener = (ev: never) => void;

/** A WebSocket on the other side of a tunnel, with the shape of the browser's. */
export class TunnelSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  readyState = 0;
  protocol = '';
  onopen: ((ev: { type: 'open' }) => void) | null = null;
  onmessage: ((ev: { type: 'message'; data: string | ArrayBuffer }) => void) | null = null;
  onclose:
    | ((ev: { type: 'close'; code: number; reason: string; wasClean: boolean }) => void)
    | null = null;
  onerror: ((ev: { type: 'error'; message: string }) => void) | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  private emit: (type: Parameters<typeof encodeMessage>[0], payload?: Uint8Array) => void = () => {
    throw new RelayError('socket is not connected yet');
  };
  private forget: () => void = () => undefined;

  /** @internal Attach the session this socket rides on. */
  bind(
    emit: (type: Parameters<typeof encodeMessage>[0], payload?: Uint8Array) => void,
    forget: () => void,
  ): void {
    this.emit = emit;
    this.forget = forget;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== OPEN) throw new RelayError('socket is not open');
    if (typeof data === 'string') this.emit(Msg.WsText, utf8(data));
    else {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      this.emit(Msg.WsBinary, bytes);
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    try {
      this.emit(Msg.WsClose, json({ code, reason } satisfies SocketClose));
    } catch {
      /* the session is already over; closed() follows */
    }
    this.closed(code, reason);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, ev: Record<string, unknown>): void {
    const event = { type, ...ev };
    (this[`on${type}` as 'onopen'] as ((e: unknown) => void) | null)?.(event);
    for (const l of this.listeners.get(type) ?? []) (l as (e: unknown) => void)(event);
  }

  /** @internal */
  opened(): void {
    if (this.readyState !== 0) return;
    this.readyState = OPEN;
    this.dispatch('open', {});
  }

  /** @internal */
  message(data: string | ArrayBuffer): void {
    if (this.readyState === OPEN) this.dispatch('message', { data });
  }

  /** @internal */
  closed(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.forget();
    this.dispatch('close', { code, reason, wasClean: code === 1000 });
  }

  /** @internal The far end could not open or keep the socket. */
  fail(message: string): void {
    if (this.readyState === 3) return;
    this.dispatch('error', { message });
    this.closed(1006, message);
  }
}

/**
 * A route to one server that outlives any one session: it dials when first used
 * and again after a session has ended, so callers just ask. A socket asked for
 * while the session is still coming up is handed back at once (connecting) and
 * opens when it does.
 */
export class RelayConnection {
  private current: Promise<RelayClient> | null = null;
  private state: 'idle' | 'connecting' | 'connected' | 'offline' = 'idle';
  private lastError: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly connect: () => Promise<RelayClient>) {}

  static to(target: RelayTarget, opts: RelayConnectOptions): RelayConnection {
    return new RelayConnection(() => RelayClient.connect(target, opts));
  }

  get status(): { state: 'idle' | 'connecting' | 'connected' | 'offline'; error: string | null } {
    return { state: this.state, error: this.lastError };
  }

  onStatus(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: 'idle' | 'connecting' | 'connected' | 'offline', error: string | null): void {
    this.state = state;
    this.lastError = error;
    for (const l of this.listeners) l();
  }

  /** The live session, dialling one if there is none. */
  async session(): Promise<RelayClient> {
    if (this.current) {
      const existing = await this.current.catch(() => null);
      if (existing && !existing.closed) return existing;
      this.current = null;
    }
    this.set('connecting', null);
    const pending = this.connect();
    this.current = pending;
    try {
      const client = await pending;
      this.set('connected', null);
      client.onClose((reason) => {
        if (this.current === pending) this.set('offline', reason);
      });
      return client;
    } catch (e) {
      if (this.current === pending) this.current = null;
      this.set('offline', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async fetch(path: string, init?: RelayRequestInit): Promise<RelayHttpResponse> {
    return (await this.session()).fetch(path, init);
  }

  openSocket(path: string, protocols: string[] = []): TunnelSocket {
    const socket = new TunnelSocket();
    this.session().then(
      (client) => {
        if (socket.readyState === 0) client.openSocket(path, protocols, socket);
      },
      (e: unknown) => socket.fail(e instanceof Error ? e.message : String(e)),
    );
    return socket;
  }

  close(): void {
    const pending = this.current;
    this.current = null;
    this.set('idle', null);
    void pending?.then(
      (c) => c.close(),
      () => undefined,
    );
  }
}
