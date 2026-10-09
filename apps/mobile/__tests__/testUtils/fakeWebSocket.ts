// A controllable fake WebSocket for unit-testing PatchWs (src/api/ws.ts) and
// the voice-call audio WS (src/lib/voiceCall.ts) without a real network
// connection. Node 22+ ships a real global WebSocket (undici) that would
// otherwise try an actual TCP connect — this stand-in replaces it for the
// duration of a test via installFakeWebSocket()/restoreWebSocket().
//
// Every constructed instance is recorded in `instances` so a test can grab
// "the socket the code under test just opened" and drive its lifecycle
// (onopen/onmessage/onclose/onerror) or inspect what it sent.
import { vi } from 'vitest';

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  send = vi.fn((data: unknown) => {
    this.sent.push(data);
  });
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: _code, reason: _reason });
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /** Test helper: simulate the connection opening. */
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  /** Test helper: simulate an inbound message (string JSON or binary). */
  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  emitError(e: unknown = { type: 'error' }): void {
    this.onerror?.(e);
  }
  /** Close with a code + reason, as a real server close does (e.g. 4401 auth). */
  emitClose(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(code === undefined ? {} : { code, reason: reason ?? '' });
  }

  static instances: FakeWebSocket[] = [];
  /** Most recently constructed socket, or throws if none. */
  static last(): FakeWebSocket {
    const i = FakeWebSocket.instances.at(-1);
    if (!i) throw new Error('FakeWebSocket: no instance constructed yet');
    return i;
  }
  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

let _prev: typeof WebSocket | undefined;
export function installFakeWebSocket(): void {
  _prev = globalThis.WebSocket;
  FakeWebSocket.reset();
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}
export function restoreWebSocket(): void {
  if (_prev) globalThis.WebSocket = _prev;
}
