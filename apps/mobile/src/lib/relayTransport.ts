// The phone's way through a relay (spec/10 § Relay).
//
// A device paired through a relay has no address for its server, so every
// request is addressed to a placeholder origin (`config.ts` RELAY_ORIGIN).
// This installs a global `fetch` and `WebSocket` that carry anything addressed
// there through the encrypted session and leave everything else to the platform.
// Nothing else in the app knows a relay exists, which is the point: the REST
// client, the live socket and the voice sockets all keep building their URLs the
// way they always did.

import { getRandomValues } from 'expo-crypto';
import { RelayConnection, type RelayHttpResponse, type WebSocketCtor, utf8 } from '@patch/relay';
import { RELAY_ORIGIN, getRoute } from '../config';

const RELAY_WS_ORIGIN = RELAY_ORIGIN.replace(/^https:/, 'wss:');

type FetchLike = (input: unknown, init?: RequestInit) => Promise<Response>;

let installed = false;
let nativeFetch: FetchLike | null = null;
let NativeWebSocket: WebSocketCtor | null = null;
let connection: RelayConnection | null = null;
let connectionKey = '';

/** The session to the paired server, made again if the route has changed. */
function route(): RelayConnection {
  const r = getRoute();
  if (r === null || r.kind !== 'relay')
    throw new Error('This device is not paired through a relay');
  const key = `${r.relay.url}|${r.relay.channel}|${r.relay.serverKey}`;
  if (connection === null || key !== connectionKey) {
    connection?.close();
    connectionKey = key;
    connection = RelayConnection.to(r.relay, { WebSocket: NativeWebSocket as WebSocketCtor });
  }
  return connection;
}

/** `idle`, `connecting`, `connected` or `offline` (with why) — for the connection banner. */
export function relayStatus(): {
  state: 'idle' | 'connecting' | 'connected' | 'offline';
  error: string | null;
} {
  return connection?.status ?? { state: 'idle', error: null };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const bytesOf = async (buffer: ArrayBuffer): Promise<Uint8Array> => new Uint8Array(buffer);

/** React Native's form data is a list of parts, some of them files on the device. */
interface NativePart {
  fieldName: string;
  string?: string;
  uri?: string;
  name?: string;
  type?: string;
}

async function nativeFormBody(
  parts: NativePart[],
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const boundary = `----patch${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const out: Uint8Array[] = [];
  for (const p of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${p.fieldName}"` +
      (p.uri !== undefined ? `; filename="${p.name ?? 'file'}"` : '');
    const type =
      p.uri !== undefined ? `\r\nContent-Type: ${p.type ?? 'application/octet-stream'}` : '';
    out.push(utf8(`--${boundary}\r\n${disposition}${type}\r\n\r\n`));
    out.push(
      p.uri !== undefined
        ? await bytesOf(await (await (nativeFetch as FetchLike)(p.uri)).arrayBuffer())
        : utf8(p.string ?? ''),
    );
    out.push(utf8('\r\n'));
  }
  out.push(utf8(`--${boundary}--\r\n`));
  return { bytes: concat(out), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function bodyBytes(
  body: unknown,
): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return { bytes: utf8(body) };
  if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body) };
  if (ArrayBuffer.isView(body))
    return { bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
  if (typeof (body as { getParts?: unknown }).getParts === 'function') {
    return nativeFormBody((body as { getParts(): NativePart[] }).getParts());
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return {
      bytes: utf8(body.toString()),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // Let the platform lay it out, then take the bytes and the boundary it chose.
    const req = new Request('http://relay.invalid/', { method: 'POST', body });
    return {
      bytes: new Uint8Array(await req.arrayBuffer()),
      contentType: req.headers.get('content-type') ?? '',
    };
  }
  return { bytes: new Uint8Array(await new Response(body as Blob).arrayBuffer()) };
}

function headerPairs(headers: unknown): Array<[string, string]> {
  if (headers === undefined || headers === null) return [];
  const out: Array<[string, string]> = [];
  new Headers(headers as HeadersInit).forEach((v: string, k: string) => out.push([k, v]));
  return out;
}

const NO_BODY = new Set([101, 204, 205, 304]);

async function relayFetch(input: unknown, init: RequestInit | undefined): Promise<Response> {
  if (init?.signal?.aborted) throw new DOMException('The request was aborted', 'AbortError');
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  const url = request ? request.url : String(input);
  const path = url.slice(RELAY_ORIGIN.length) || '/';
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = headerPairs(init?.headers ?? request?.headers);
  const payload = await bodyBytes(
    init?.body ??
      (request && method !== 'GET' && method !== 'HEAD' ? await request.arrayBuffer() : null),
  );
  if (payload?.contentType !== undefined && !headers.some(([k]) => k === 'content-type')) {
    headers.push(['content-type', payload.contentType]);
  }
  const res: RelayHttpResponse = await route().fetch(path, {
    method,
    headers,
    ...(payload ? { body: payload.bytes } : {}),
    ...(init?.signal ? { signal: init.signal as never } : {}),
  });
  return new Response(NO_BODY.has(res.status) ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** The CSPRNG the key exchange draws on; some engines have none until it is given one. */
function ensureRandom(): void {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
  if (g.crypto?.getRandomValues === undefined) {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues },
      configurable: true,
      writable: true,
    });
  }
}

/** Install once at start-up, before anything makes a request. `WebSocket` is for tests. */
export function installRelayTransport(deps: { WebSocket?: WebSocketCtor } = {}): void {
  if (installed) return;
  installed = true;
  ensureRandom();
  nativeFetch = (globalThis.fetch as FetchLike).bind(globalThis);
  const Platform = globalThis.WebSocket as unknown as WebSocketCtor;
  NativeWebSocket = deps.WebSocket ?? Platform;

  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string }).url ?? '');
    return url.startsWith(RELAY_ORIGIN)
      ? relayFetch(input, init)
      : (nativeFetch as FetchLike)(input, init);
  }) as typeof fetch;

  class RoutedWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    constructor(url: string, protocols?: string | string[]) {
      if (url.startsWith(RELAY_WS_ORIGIN)) {
        const wanted =
          protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
        return route().openSocket(url.slice(RELAY_WS_ORIGIN.length) || '/', wanted) as never;
      }
      return new (Platform as unknown as new (u: string, p?: string | string[]) => object)(
        url,
        protocols,
      ) as never;
    }
  }
  globalThis.WebSocket = RoutedWebSocket as never;
}
