// PersistentWsClient (group 14, H2). Drives:
//   - Cold first call connects + completes.
//   - On WS drop mid-stream the in-flight rejects and a follow-up request
//     reconnects + completes.
//   - Queue cap rejects N+1th request during reconnect.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import type { Logger } from 'pino';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { PersistentWsClient } from '../src/audio/persistent-ws.js';

const logger = pino({ level: 'silent' });

interface FakeSidecar {
  port: number;
  acceptedSockets: WebSocket[];
  /** Stop the server (drops all live conns). */
  stop(): Promise<void>;
  /** Start a new server on the same port. Reuses the saved port. */
  start(): Promise<void>;
}

async function startEchoSidecar(): Promise<FakeSidecar> {
  let wss: WebSocketServer;
  let port = 0;
  const acceptedSockets: WebSocket[] = [];

  const start = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wss = new WebSocketServer({ host: '127.0.0.1', port });
      wss.on('connection', (sock) => {
        acceptedSockets.push(sock);
        sock.on('message', (data: Buffer | string, isBinary: boolean) => {
          if (isBinary) return; // ignore binary in this fake
          try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as {
              requestId?: string;
              echo?: string;
            };
            if (typeof msg.echo === 'string') {
              setTimeout(() => {
                try {
                  sock.send(JSON.stringify({ requestId: msg.requestId, text: msg.echo }));
                } catch {
                  /* socket closed */
                }
              }, 5);
            }
          } catch {
            /* ignore */
          }
        });
      });
      wss.on('listening', () => {
        const addr = wss.address() as AddressInfo;
        port = addr.port;
        resolve();
      });
    });
  };

  await start();

  const stop = async (): Promise<void> => {
    for (const s of acceptedSockets) {
      try {
        s.terminate();
      } catch {
        /* ignore */
      }
    }
    acceptedSockets.length = 0;
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return {
    get port() {
      return port;
    },
    acceptedSockets,
    start,
    stop,
  };
}

describe('PersistentWsClient', () => {
  test('cold first call connects + completes', async () => {
    const sidecar = await startEchoSidecar();
    try {
      const client = new PersistentWsClient({
        url: `ws://127.0.0.1:${sidecar.port}`,
        logger,
      });
      const result = (await client.request({
        payload: JSON.stringify({ requestId: 'r1', echo: 'hello' }),
        handlers: {
          onJson: (msg: unknown) => {
            const m = msg as { text?: unknown };
            return { done: true, value: m.text };
          },
        },
      })) as string;
      expect(result).toBe('hello');
      await client.close();
    } finally {
      await sidecar.stop();
    }
  });

  test('reconnects after sidecar restart and completes the next call', async () => {
    const sidecar = await startEchoSidecar();
    const client = new PersistentWsClient({
      url: `ws://127.0.0.1:${sidecar.port}`,
      logger,
    });
    try {
      // First call — establishes the persistent socket.
      const r1 = (await client.request({
        payload: JSON.stringify({ requestId: 'r1', echo: 'one' }),
        handlers: {
          onJson: (msg: unknown) => ({
            done: true as const,
            value: (msg as { text: string }).text,
          }),
        },
      })) as string;
      expect(r1).toBe('one');
      // Kill the sidecar mid-life.
      await sidecar.stop();
      // The persistent socket will get a 'close' event next tick.
      await new Promise((r) => setTimeout(r, 50));
      // Restart on same port. Backoff is 1s, so wait ~1.2s before sending.
      await sidecar.start();
      // Issue the next request — it queues during 'reconnecting', then
      // dispatches once the backoff timer fires + the new socket is up.
      const r2 = (await client.request({
        payload: JSON.stringify({ requestId: 'r2', echo: 'two' }),
        handlers: {
          onJson: (msg: unknown) => ({
            done: true as const,
            value: (msg as { text: string }).text,
          }),
        },
      })) as string;
      expect(r2).toBe('two');
    } finally {
      await client.close();
      await sidecar.stop();
    }
  }, 8000);

  test('rejects when queue cap is exceeded', async () => {
    const sidecar = await startEchoSidecar();
    try {
      // Stop the sidecar so all requests stack up in the queue.
      await sidecar.stop();
      const client = new PersistentWsClient({
        url: `ws://127.0.0.1:${sidecar.port}`,
        logger,
        maxQueue: 2,
      });
      // Fire 2 requests — they'll queue in 'reconnecting' state.
      const p1 = client.request({
        payload: '{}',
        handlers: { onJson: () => ({ done: true as const, value: null }) },
      });
      const p2 = client.request({
        payload: '{}',
        handlers: { onJson: () => ({ done: true as const, value: null }) },
      });
      // The 3rd should fail synchronously with queue full.
      await expect(
        client.request({
          payload: '{}',
          handlers: { onJson: () => ({ done: true as const, value: null }) },
        }),
      ).rejects.toThrow(/queue full/);
      // Detach the queued promises so vitest doesn't see unhandled rejections.
      p1.catch(() => undefined);
      p2.catch(() => undefined);
      await client.close();
    } finally {
      await sidecar.stop();
    }
  });
});

// --- Fake-socket-driven internals ------------------------------------------
//
// The tests above exercise PersistentWsClient over a real `ws` server, which
// is great for the happy paths but makes the reconnect/backoff, malformed-
// frame, and error-handling branches slow or racy to drive deterministically.
// `wsCtor` is an explicit test hook (see PersistentWsOptions) for exactly
// this: substitute a fully-controlled fake socket + (where needed) fake
// timers so every internal branch can be triggered on demand.

class FakeSocket extends EventEmitter {
  sent: Array<string | Buffer> = [];
  sendError?: Error;
  closeError?: Error;
  closeCalled = false;

  send(data: string | Buffer, _opts?: { binary?: boolean }): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(): void {
    this.closeCalled = true;
    if (this.closeError) throw this.closeError;
  }
}

/** Builds a `wsCtor` whose every `new`'d instance is handed to `onCreate`. */
function fakeWsCtor(
  onCreate: (sock: FakeSocket, url: string) => void,
): new (url: string) => WebSocket {
  function Ctor(url: string): FakeSocket {
    const sock = new FakeSocket();
    onCreate(sock, url);
    return sock;
  }
  return Ctor as unknown as new (url: string) => WebSocket;
}

/** A `wsCtor` whose constructor throws on the Nth call (1-indexed) and below. */
function throwingWsCtor(
  failCount: number,
  onCreate: (sock: FakeSocket, url: string) => void,
): new (url: string) => WebSocket {
  let attempts = 0;
  function Ctor(url: string): FakeSocket {
    attempts++;
    if (attempts <= failCount) {
      throw new Error(`ctor failed (attempt ${attempts})`);
    }
    const sock = new FakeSocket();
    onCreate(sock, url);
    return sock;
  }
  return Ctor as unknown as new (url: string) => WebSocket;
}

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

/**
 * Drives a client through open + a single completed echo-style request.
 * `getSock` is read AFTER `request()` is issued (not before) — the wsCtor's
 * `onCreate` hook only fires synchronously inside `request()`'s `pump()` ->
 * `connect()` chain, so the socket reference isn't populated until then.
 */
async function connectAndComplete(
  client: PersistentWsClient,
  getSock: () => FakeSocket,
  echo: string,
): Promise<string> {
  const p = client.request({
    payload: JSON.stringify({ requestId: 'r', echo }),
    handlers: {
      onJson: (msg: unknown) => ({ done: true as const, value: (msg as { text: string }).text }),
    },
  });
  const sock = getSock();
  sock.emit('open');
  sock.emit('message', JSON.stringify({ text: echo }), false);
  return (await p) as string;
}

describe('PersistentWsClient internals (fake socket)', () => {
  test('wsCtor test hook is used verbatim (no real `ws` module touched)', async () => {
    let created: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((sock) => {
        created = sock;
      }),
    });
    const out = await connectAndComplete(client, () => created!, 'hi');
    expect(out).toBe('hi');
    expect(created).toBeDefined();
    await client.close();
  });

  test('request() rejects immediately once the client is closed', async () => {
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor(() => {}),
    });
    await client.close();
    await expect(
      client.request({ payload: '{}', handlers: { onJson: () => ({ done: true, value: null }) } }),
    ).rejects.toThrow(/client closed/);
  });

  test('sendOutOfBand returns false when not connected', () => {
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor(() => {}),
    });
    expect(client.sendOutOfBand('{}')).toBe(false);
  });

  test('sendOutOfBand sends over the open wire and returns true', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    await connectAndComplete(client, () => sock!, 'hi');
    const ok = client.sendOutOfBand(JSON.stringify({ cancel: true }));
    expect(ok).toBe(true);
    expect(sock!.sent).toContainEqual(JSON.stringify({ cancel: true }));
    await client.close();
  });

  test('sendOutOfBand swallows a send error and returns false', async () => {
    let sock: FakeSocket | undefined;
    const log = fakeLogger();
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger: log,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    await connectAndComplete(client, () => sock!, 'hi');
    sock!.sendError = new Error('send boom');
    const ok = client.sendOutOfBand('{}');
    expect(ok).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'send boom' }),
      expect.stringMatching(/out-of-band send failed/),
    );
    await client.close();
  });

  test('close() rejects an in-flight current request', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: null }) },
    });
    sock!.emit('open');
    // Give pump()/dispatchCurrent() a tick to run before closing mid-flight.
    await Promise.resolve();
    await client.close();
    await expect(p).rejects.toThrow(/client closed/);
  });

  test('close() swallows an error thrown by sock.close()', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    await connectAndComplete(client, () => sock!, 'hi');
    sock!.closeError = new Error('close boom');
    await expect(client.close()).resolves.toBeUndefined();
    expect(sock!.closeCalled).toBe(true);
  });

  test('ctor failures schedule a reconnect with doubling backoff, then succeed', async () => {
    vi.useFakeTimers();
    try {
      let sock: FakeSocket | undefined;
      const client = new PersistentWsClient({
        url: 'ws://fake',
        logger,
        // Fail the first two connect attempts (1s, then 2s backoff), succeed
        // on the third.
        wsCtor: throwingWsCtor(2, (s) => {
          sock = s;
        }),
      });
      const p = client.request({
        payload: JSON.stringify({ requestId: 'r', echo: 'ok' }),
        handlers: {
          onJson: (msg: unknown) => ({
            done: true as const,
            value: (msg as { text: string }).text,
          }),
        },
      });
      expect(client._stateForTest()).toBe('connecting');
      await vi.advanceTimersByTimeAsync(1000); // 1st backoff fires -> 2nd attempt (fails)
      await vi.advanceTimersByTimeAsync(2000); // 2nd backoff fires -> 3rd attempt (succeeds)
      expect(sock).toBeDefined();
      sock!.emit('open');
      sock!.emit('message', JSON.stringify({ text: 'ok' }), false);
      expect(await p).toBe('ok');
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a stray message with no in-flight request is dropped (logged + ignored)', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    await connectAndComplete(client, () => sock!, 'first');
    // No request is in flight now — an unsolicited frame must be dropped, not
    // throw or corrupt subsequent state.
    expect(() =>
      sock!.emit('message', JSON.stringify({ text: 'unsolicited' }), false),
    ).not.toThrow();
    // The client is still usable for a follow-up request.
    const p2 = client.request({
      payload: JSON.stringify({ requestId: 'r2', echo: 'second' }),
      handlers: {
        onJson: (msg: unknown) => ({ done: true as const, value: (msg as { text: string }).text }),
      },
    });
    sock!.emit('message', JSON.stringify({ text: 'second' }), false);
    expect(await p2).toBe('second');
    await client.close();
  });

  test('binary frames route to onBinary when a handler is provided', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const onBinary = vi.fn();
    const p = client.request({
      payload: '{}',
      handlers: {
        onBinary,
        onJson: () => ({ done: true as const, value: 'done' }),
      },
    });
    sock!.emit('open');
    const chunk = Buffer.from([1, 2, 3, 4]);
    sock!.emit('message', chunk, true);
    expect(onBinary).toHaveBeenCalledWith(chunk);
    sock!.emit('message', JSON.stringify({ end: true }), false);
    expect(await p).toBe('done');
    await client.close();
  });

  test('binary frames with no onBinary handler are dropped quietly', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: 'done' }) },
    });
    sock!.emit('open');
    expect(() => sock!.emit('message', Buffer.from([9, 9]), true)).not.toThrow();
    sock!.emit('message', JSON.stringify({ end: true }), false);
    expect(await p).toBe('done');
    await client.close();
  });

  test('a non-binary Buffer message is parsed as JSON text (not routed to onBinary)', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const onBinary = vi.fn();
    const p = client.request({
      payload: '{}',
      handlers: {
        onBinary,
        onJson: (msg: unknown) => ({ done: true as const, value: (msg as { text: string }).text }),
      },
    });
    sock!.emit('open');
    // isBinary=false but the payload arrives as a Buffer, not a string.
    sock!.emit('message', Buffer.from(JSON.stringify({ text: 'buffered-json' }), 'utf8'), false);
    expect(await p).toBe('buffered-json');
    expect(onBinary).not.toHaveBeenCalled();
    await client.close();
  });

  test('a plain string message resolves via the direct handleJson path', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: {
        onJson: (msg: unknown) => ({ done: true as const, value: (msg as { text: string }).text }),
      },
    });
    sock!.emit('open');
    sock!.emit('message', JSON.stringify({ text: 'plain-string' }), false);
    expect(await p).toBe('plain-string');
    await client.close();
  });

  test('malformed JSON from the sidecar rejects with a typed error', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: null }) },
    });
    sock!.emit('open');
    sock!.emit('message', 'not-json{', false);
    await expect(p).rejects.toThrow(/bad json from sidecar/);
    await client.close();
  });

  test('an onJson handler that throws rejects the request with that error', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: {
        onJson: () => {
          throw new Error('onJson exploded');
        },
      },
    });
    sock!.emit('open');
    sock!.emit('message', '{}', false);
    await expect(p).rejects.toThrow(/onJson exploded/);
    await client.close();
  });

  test('onJson returning false keeps the request pending for a later frame', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    let calls = 0;
    const p = client.request({
      payload: '{}',
      handlers: {
        onJson: (msg: unknown) => {
          calls++;
          const m = msg as { progress?: boolean; text?: string };
          if (m.progress) return false;
          return { done: true as const, value: m.text };
        },
      },
    });
    sock!.emit('open');
    sock!.emit('message', JSON.stringify({ progress: true }), false);
    // Still pending — give the event loop a beat to prove it hasn't resolved.
    let settled = false;
    p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    sock!.emit('message', JSON.stringify({ text: 'final' }), false);
    expect(await p).toBe('final');
    expect(calls).toBe(2);
    await client.close();
  });

  test('onJson returning a bare `true` resolves with the raw parsed JSON', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => true },
    });
    sock!.emit('open');
    sock!.emit('message', JSON.stringify({ some: 'payload' }), false);
    expect(await p).toEqual({ some: 'payload' });
    await client.close();
  });

  test('an onComplete callback that throws is swallowed, and the queue keeps draining', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p1 = client.request({
      payload: '{}',
      handlers: {
        onJson: () => ({ done: true as const, value: 'first' }),
        onComplete: () => {
          throw new Error('onComplete boom');
        },
      },
    });
    sock!.emit('open');
    sock!.emit('message', '{}', false);
    expect(await p1).toBe('first');
    // A second, queued request should still dispatch normally afterwards.
    const p2 = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: 'second' }) },
    });
    sock!.emit('message', '{}', false);
    expect(await p2).toBe('second');
    await client.close();
  });

  test('dispatchCurrent sends the binary payload right after the text payload', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const binaryPayload = Buffer.from([1, 2, 3]);
    const p = client.request({
      payload: 'text-payload',
      binaryPayload,
      handlers: { onJson: () => ({ done: true as const, value: 'ok' }) },
    });
    sock!.emit('open');
    expect(sock!.sent).toEqual(['text-payload', binaryPayload]);
    sock!.emit('message', '{}', false);
    expect(await p).toBe('ok');
    await client.close();
  });

  test('a send failure on dispatch rejects the request and triggers a reconnect', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
        s.sendError = new Error('dispatch send failed');
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: null }) },
    });
    sock!.emit('open');
    await expect(p).rejects.toThrow(/dispatch send failed/);
    expect(client._stateForTest()).toBe('reconnecting');
    await client.close();
  });

  test('onDisconnect("close") rejects an in-flight request as connection dropped', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: null }) },
    });
    sock!.emit('open');
    await Promise.resolve();
    sock!.emit('close');
    await expect(p).rejects.toThrow(/connection dropped \(close\)/);
    expect(client._stateForTest()).toBe('reconnecting');
    await client.close();
  });

  test('onDisconnect("error") logs + reconnects the same way as a close', async () => {
    let sock: FakeSocket | undefined;
    const log = fakeLogger();
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger: log,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: null }) },
    });
    sock!.emit('open');
    await Promise.resolve();
    sock!.emit('error', new Error('socket boom'));
    await expect(p).rejects.toThrow(/connection dropped \(error\)/);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'socket boom' }),
      expect.stringMatching(/persistent-ws: error/),
    );
    await client.close();
  });

  // A refused connect fires `error` AND `close` on the same socket. Each used to
  // schedule its own reconnect, so every failed attempt spawned two more: on
  // 2026-09-25 a dead Kokoro sidecar grew this to ~174k attempts a minute and
  // ran the host out of heap every ~12 minutes.
  test('error + close from one refused connect schedule ONE reconnect, not two', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const client = new PersistentWsClient({
        url: 'ws://fake',
        logger,
        wsCtor: fakeWsCtor((s) => {
          attempts++;
          queueMicrotask(() => {
            s.emit('error', new Error('connect ECONNREFUSED'));
            s.emit('close');
          });
        }),
      });
      const p = client.request({
        payload: '{}',
        handlers: { onJson: () => ({ done: true as const, value: null }) },
      });
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      // Run well past the 30s backoff cap: one attempt per 30s, not a swarm.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(vi.getTimerCount()).toBe(1);
      expect(attempts).toBeLessThan(30);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a late close from a replaced socket does not tear down the new one', async () => {
    vi.useFakeTimers();
    try {
      const socks: FakeSocket[] = [];
      const client = new PersistentWsClient({
        url: 'ws://fake',
        logger,
        wsCtor: fakeWsCtor((s) => {
          socks.push(s);
        }),
      });
      const p = client.request({
        payload: '{}',
        handlers: { onJson: () => ({ done: true as const, value: null }) },
      });
      p.catch(() => {});
      socks[0]!.emit('error', new Error('boom'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(socks).toHaveLength(2);
      socks[1]!.emit('open');
      socks[0]!.emit('close'); // stale
      expect(client._stateForTest()).toBe('open');
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('onDisconnect is a no-op once the client is already closed', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    await connectAndComplete(client, () => sock!, 'hi');
    await client.close();
    expect(client._stateForTest()).toBe('closed');
    // A late close/error event arriving after the client was closed must not
    // resurrect it into 'reconnecting'.
    expect(() => sock!.emit('close')).not.toThrow();
    expect(client._stateForTest()).toBe('closed');
  });

  test('_stateForTest and _queuedCountForTest reflect connecting/queued state', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    expect(client._stateForTest()).toBe('closed');
    expect(client._queuedCountForTest()).toBe(0);
    const p1 = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: 'a' }) },
    });
    // Still connecting — the request is queued (becomes `current` once open).
    expect(client._stateForTest()).toBe('connecting');
    const p2 = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: 'b' }) },
    });
    expect(client._queuedCountForTest()).toBe(2);
    sock!.emit('open');
    expect(client._stateForTest()).toBe('open');
    sock!.emit('message', '{}', false);
    expect(await p1).toBe('a');
    sock!.emit('message', '{}', false);
    expect(await p2).toBe('b');
    await client.close();
  });

  test('a request submitted while one is already in flight counts toward the queue cap', async () => {
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    // First request: dispatches immediately once open (becomes `current`).
    const p1 = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: 'a' }) },
    });
    sock!.emit('open');
    // `current` is now set and NOT yet resolved — a second request submitted
    // now must count `current` as 1 toward `inflight` (not just queue.length).
    expect(client._queuedCountForTest()).toBe(1);
    const p2 = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: 'b' }) },
    });
    expect(client._queuedCountForTest()).toBe(2); // current (1) + queued (1)
    sock!.emit('message', '{}', false); // completes p1, dispatches p2
    expect(await p1).toBe('a');
    sock!.emit('message', '{}', false);
    expect(await p2).toBe('b');
    await client.close();
  });

  test('pump() is a no-op for a stray "open" event that arrives after close()', async () => {
    // Realistic race: `close()` is called while a connect is still in
    // flight; the underlying socket's 'open' event can still land afterwards
    // (nothing unregisters the `once('open', ...)` listener). The 'open'
    // handler unconditionally relabels `state` (a cosmetic detail — `closed`
    // remains the authoritative flag), but pump()'s own `if (this.closed)
    // return` must stop it from doing any actual work (no dispatch, no
    // resurrecting the client as usable).
    let sock: FakeSocket | undefined;
    const client = new PersistentWsClient({
      url: 'ws://fake',
      logger,
      wsCtor: fakeWsCtor((s) => {
        sock = s;
      }),
    });
    const p = client.request({
      payload: '{}',
      handlers: { onJson: () => ({ done: true as const, value: null }) },
    });
    p.catch(() => undefined); // rejected by close() below — expected.
    expect(client._stateForTest()).toBe('connecting');
    await client.close();
    expect(() => sock!.emit('open')).not.toThrow();
    // The client stays permanently closed regardless of the stray event —
    // a fresh request still rejects immediately.
    await expect(
      client.request({ payload: '{}', handlers: { onJson: () => ({ done: true, value: null }) } }),
    ).rejects.toThrow(/client closed/);
    expect(sock!.sent).toEqual([]); // pump() never dispatched anything.
  });
});
