// What the two ends say to each other INSIDE the encrypted session: HTTP
// requests and WebSockets, multiplexed as numbered streams. The relay never
// sees any of this; it is the plaintext of a transport frame (crypto.ts).
//
//   [type u8][stream u32 BE][payload]
//
// A request is REQ_HEAD, any number of REQ_BODY chunks, REQ_END; the answer is
// RES_HEAD, RES_BODY chunks, RES_END (or RES_ERROR in place of any of them). A
// socket is WS_OPEN, then WS_OPENED, then WS_TEXT / WS_BINARY either way, then
// WS_CLOSE from whichever side ends it.

import { MAX_PLAINTEXT } from './crypto.js';
import { utf8Decode, utf8Encode } from './utf8.js';

// A plain object rather than an enum: this file is also bundled for the phone,
// whose compiler does not inline `const enum` across files.
export const Msg = {
  ReqHead: 1,
  ReqBody: 2,
  ReqEnd: 3,
  ResHead: 4,
  ResBody: 5,
  ResEnd: 6,
  Error: 7,
  Cancel: 8,
  WsOpen: 16,
  WsOpened: 17,
  WsText: 18,
  WsBinary: 19,
  WsClose: 20,
} as const;
export type MsgType = (typeof Msg)[keyof typeof Msg];

export interface TunnelMessage {
  type: MsgType;
  stream: number;
  payload: Uint8Array;
}

/** The most body bytes one frame carries: a frame's budget less the 5-byte header. */
export const MAX_CHUNK = MAX_PLAINTEXT - 5;

export type HeaderMap = Record<string, string>;

export interface RequestHead {
  method: string;
  /** Path and query only (`/api/chats?limit=5`), never an origin. */
  path: string;
  headers: HeaderMap;
}

export interface ResponseHead {
  status: number;
  statusText: string;
  headers: HeaderMap;
}

export interface SocketOpen {
  path: string;
  protocols: string[];
}

export interface SocketClose {
  code: number;
  reason: string;
}

export function encodeMessage(
  type: MsgType,
  stream: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream);
  out.set(payload, 5);
  return out;
}

export function decodeMessage(frame: Uint8Array): TunnelMessage {
  if (frame.length < 5) throw new Error('tunnel message is shorter than its header');
  return {
    type: frame[0] as MsgType,
    stream: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1),
    payload: frame.subarray(5),
  };
}

export const json = (value: unknown): Uint8Array => utf8Encode(JSON.stringify(value));
export const parseJson = <T>(payload: Uint8Array): T => JSON.parse(utf8Decode(payload)) as T;
export const utf8 = utf8Encode;
export const text = utf8Decode;

/** Split a body into frame-sized chunks. */
export function* chunks(body: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < body.length; at += MAX_CHUNK) yield body.subarray(at, at + MAX_CHUNK);
}

/** Headers a tunnel does not carry: they describe one hop, not the request. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);

export function carriedHeaders(headers: Iterable<[string, string]>): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of headers) {
    const name = k.toLowerCase();
    if (!HOP_BY_HOP.has(name)) out[name] = v;
  }
  return out;
}
