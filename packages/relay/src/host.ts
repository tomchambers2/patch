// The server's side of a relayed connection (spec/10 § Relay). The Patch server
// dials OUT to the relay, which is why it works from behind a home router with
// no port opened and no address to give out; devices dial the same relay and are
// matched by channel. Each device gets its own encrypted session, and the host
// ends that session on the server's own loopback address: a request that comes
// through the tunnel is made again, as an ordinary request, against the server
// that is listening next door, and a socket is opened the same way. So nothing
// about the API changes for the relay, and nothing in it has to know.

import { ed25519 } from '@noble/curves/ed25519';
import { WebSocket as NodeWebSocket } from 'ws';
import {
  RelaySession,
  RelayCryptoError,
  channelFor,
  serverAccept,
  toBase64Url,
  type ServerIdentity,
} from './crypto.js';
import {
  MAX_CHUNK,
  Msg,
  decodeMessage,
  encodeMessage,
  json,
  parseJson,
  text,
  utf8,
  type RequestHead,
  type SocketClose,
  type SocketOpen,
} from './tunnel.js';

export interface RelayHostLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface RelayHostOptions {
  /** The relay's `wss://` address. */
  relayUrl: string;
  identity: ServerIdentity;
  /** Where the real server listens, e.g. `http://127.0.0.1:3000`. */
  target: string;
  logger?: RelayHostLogger;
  /** Streams one device may hold open at once. */
  maxStreamsPerClient?: number;
  /** The largest request body the tunnel accepts. */
  maxBodyBytes?: number;
  /** Reconnect backoff to the relay. */
  backoffMs?: { min: number; max: number };
}

export interface RelayHostStatus {
  /** True while the relay has accepted this server onto its channel. */
  connected: boolean;
  /** Devices with an established encrypted session right now. */
  sessions: number;
  /** Why the last attempt to reach the relay failed, if it did. */
  lastError: string | null;
}

interface Stream {
  head?: RequestHead;
  body: Uint8Array[];
  bytes: number;
  abort: AbortController;
  socket?: NodeWebSocket;
}

interface ClientState {
  session: RelaySession | null;
  streams: Map<number, Stream>;
}

const SOCKET_CODE_OK = (code: number): boolean =>
  code === 1000 ||
  (code >= 3000 && code <= 4999) ||
  (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006);

/** Headers on an answer that describe how the target sent it, not what it says. */
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

export class RelayHost {
  private ws: NodeWebSocket | null = null;
  private clients = new Map<number, ClientState>();
  private stopped = true;
  private connected = false;
  private lastError: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private readonly listeners = new Set<(s: RelayHostStatus) => void>();

  constructor(private readonly opts: RelayHostOptions) {}

  /** The channel devices reach this server on. */
  get channel(): string {
    return channelFor(this.opts.identity.publicKey);
  }

  status(): RelayHostStatus {
    let sessions = 0;
    for (const c of this.clients.values()) if (c.session) sessions++;
    return { connected: this.connected, sessions, lastError: this.lastError };
  }

  onStatus(listener: (s: RelayHostStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close(1000, 'stopping');
    this.ws = null;
    this.dropAll();
    this.setConnected(false);
  }

  private emitStatus(): void {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    this.emitStatus();
  }

  private connect(): void {
    const url = `${this.opts.relayUrl.replace(/\/+$/, '')}/v1/connect?channel=${this.channel}&role=server`;
    const ws = new NodeWebSocket(url);
    this.ws = ws;
    let openedAt = 0;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      try {
        if (isBinary) this.fromClient(data);
        else
          this.control(
            ws,
            JSON.parse(data.toString()) as { type: string; nonce?: string; cid?: number },
          );
      } catch (e) {
        this.opts.logger?.warn({ err: String(e) }, 'relay: dropped a bad frame');
      }
    });
    ws.on('open', () => {
      openedAt = Date.now();
    });
    ws.on('error', (e: Error) => {
      this.lastError = e.message;
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.dropAll();
      this.lastError =
        this.lastError ?? `relay closed the connection (${code} ${reason.toString()})`;
      this.setConnected(false);
      if (this.stopped) return;
      // A connection that held for a while was a good one: start the backoff over.
      if (openedAt && Date.now() - openedAt > 10_000) this.attempts = 0;
      const { min, max } = this.opts.backoffMs ?? { min: 1_000, max: 30_000 };
      const delay = Math.min(max, min * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
      this.retry = setTimeout(() => this.connect(), delay);
      this.retry.unref?.();
    });
  }

  private control(ws: NodeWebSocket, msg: { type: string; nonce?: string; cid?: number }): void {
    switch (msg.type) {
      case 'challenge': {
        const sig = ed25519.sign(
          utf8(`patch-relay-v1|${this.channel}|${msg.nonce ?? ''}`),
          this.opts.identity.secretKey,
        );
        ws.send(
          JSON.stringify({
            type: 'hello',
            publicKey: toBase64Url(this.opts.identity.publicKey),
            signature: toBase64Url(sig),
          }),
        );
        return;
      }
      case 'ready':
        this.lastError = null;
        this.setConnected(true);
        this.opts.logger?.info({ channel: this.channel }, 'relay: reachable through the relay');
        return;
      case 'open':
        if (typeof msg.cid === 'number')
          this.clients.set(msg.cid, { session: null, streams: new Map() });
        return;
      case 'close':
        if (typeof msg.cid === 'number') this.dropClient(msg.cid);
        return;
      default:
        return;
    }
  }

  private fromClient(frame: Buffer): void {
    if (frame.length < 4) return;
    const cid = frame.readUInt32BE(0);
    const client = this.clients.get(cid);
    if (!client) return;
    const payload = new Uint8Array(frame.buffer, frame.byteOffset + 4, frame.length - 4);
    if (client.session === null) {
      try {
        const accepted = serverAccept(this.opts.identity, payload);
        client.session = accepted.session;
        this.ws?.send(withCid(cid, accepted.reply));
        this.emitStatus();
      } catch (e) {
        this.opts.logger?.warn({ cid, err: String(e) }, 'relay: refused a device’s hello');
        this.ws?.send(JSON.stringify({ type: 'close', cid }));
        this.dropClient(cid);
      }
      return;
    }
    try {
      const msg = decodeMessage(client.session.open(payload));
      this.dispatch(cid, client, msg.type, msg.stream, msg.payload);
    } catch (e) {
      if (e instanceof RelayCryptoError) {
        this.opts.logger?.warn(
          { cid, err: e.message },
          'relay: a device’s session failed; ending it',
        );
        this.ws?.send(JSON.stringify({ type: 'close', cid }));
        this.dropClient(cid);
      } else {
        this.opts.logger?.warn({ cid, err: String(e) }, 'relay: bad tunnel message');
      }
    }
  }

  private reply(
    cid: number,
    client: ClientState,
    type: Parameters<typeof encodeMessage>[0],
    stream: number,
    payload?: Uint8Array,
  ): void {
    if (
      !client.session ||
      this.ws?.readyState !== NodeWebSocket.OPEN ||
      this.clients.get(cid) !== client
    )
      return;
    this.ws.send(withCid(cid, client.session.seal(encodeMessage(type, stream, payload))));
  }

  private dispatch(
    cid: number,
    client: ClientState,
    type: number,
    id: number,
    payload: Uint8Array,
  ): void {
    const say = (t: Parameters<typeof encodeMessage>[0], p?: Uint8Array): void =>
      this.reply(cid, client, t, id, p);
    const fail = (message: string): void => say(Msg.Error, json({ message }));
    switch (type) {
      case Msg.ReqHead: {
        if (client.streams.size >= (this.opts.maxStreamsPerClient ?? 64))
          return fail('too many open streams');
        client.streams.set(id, {
          head: parseJson<RequestHead>(payload),
          body: [],
          bytes: 0,
          abort: new AbortController(),
        });
        return;
      }
      case Msg.ReqBody: {
        const s = client.streams.get(id);
        if (!s) return;
        s.bytes += payload.length;
        if (s.bytes > (this.opts.maxBodyBytes ?? 256 * 1024 * 1024)) {
          client.streams.delete(id);
          return fail('request body too large');
        }
        s.body.push(payload.slice());
        return;
      }
      case Msg.ReqEnd: {
        const s = client.streams.get(id);
        if (s) void this.runRequest(client, s, id, say, fail);
        return;
      }
      case Msg.Cancel:
        client.streams.get(id)?.abort.abort();
        client.streams.delete(id);
        return;
      case Msg.WsOpen: {
        if (client.streams.size >= (this.opts.maxStreamsPerClient ?? 64))
          return fail('too many open streams');
        const { path, protocols } = parseJson<SocketOpen>(payload);
        const target = new NodeWebSocket(this.opts.target.replace(/^http/, 'ws') + path, protocols);
        const stream: Stream = { body: [], bytes: 0, abort: new AbortController(), socket: target };
        client.streams.set(id, stream);
        let opened = false;
        target.on('open', () => {
          opened = true;
          say(Msg.WsOpened);
        });
        target.on('message', (data: Buffer, isBinary: boolean) => {
          const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
          if (!isBinary) {
            say(Msg.WsText, bytes);
            return;
          }
          for (let at = 0; at < bytes.length || at === 0; at += MAX_CHUNK) {
            say(Msg.WsBinary, bytes.subarray(at, at + MAX_CHUNK));
            if (bytes.length === 0) break;
          }
        });
        target.on('error', (e: Error) => {
          if (!opened) fail(`could not open the socket: ${e.message}`);
        });
        target.on('close', (code: number, reason: Buffer) => {
          client.streams.delete(id);
          if (opened)
            say(Msg.WsClose, json({ code, reason: reason.toString() } satisfies SocketClose));
        });
        return;
      }
      case Msg.WsText:
        client.streams.get(id)?.socket?.send(text(payload));
        return;
      case Msg.WsBinary:
        client.streams.get(id)?.socket?.send(payload);
        return;
      case Msg.WsClose: {
        const s = client.streams.get(id);
        const { code, reason } = parseJson<SocketClose>(payload);
        client.streams.delete(id);
        s?.socket?.close(SOCKET_CODE_OK(code) ? code : 1000, reason);
        return;
      }
      default:
        return;
    }
  }

  private async runRequest(
    client: ClientState,
    s: Stream,
    id: number,
    say: (t: Parameters<typeof encodeMessage>[0], p?: Uint8Array) => void,
    fail: (message: string) => void,
  ): Promise<void> {
    const head = s.head as RequestHead;
    try {
      const noBody = head.method === 'GET' || head.method === 'HEAD';
      const body = noBody ? undefined : Buffer.concat(s.body);
      const res = await fetch(this.opts.target + head.path, {
        method: head.method,
        headers: head.headers,
        ...(body && body.length > 0 ? { body } : {}),
        redirect: 'manual',
        signal: s.abort.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!DROP_RESPONSE.has(k)) headers[k] = v;
      });
      say(Msg.ResHead, json({ status: res.status, statusText: res.statusText, headers }));
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let at = 0; at < value.length; at += MAX_CHUNK)
            say(Msg.ResBody, value.subarray(at, at + MAX_CHUNK));
        }
      }
      say(Msg.ResEnd);
    } catch (e) {
      if (!s.abort.signal.aborted)
        fail(`the server did not answer: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.streams.delete(id);
    }
  }

  private dropClient(cid: number): void {
    const c = this.clients.get(cid);
    if (!c) return;
    this.clients.delete(cid);
    for (const s of c.streams.values()) {
      s.abort.abort();
      s.socket?.terminate();
    }
    this.emitStatus();
  }

  private dropAll(): void {
    for (const cid of [...this.clients.keys()]) this.dropClient(cid);
  }
}

function withCid(cid: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, cid);
  out.set(payload, 4);
  return out;
}
