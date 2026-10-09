// Kokoro mock-sidecar streaming test (group 13).

import { describe, test, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { Logger } from 'pino';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createKokoro, validateKokoroModel, type KokoroChunk } from '../src/audio/kokoro.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const logger = pino({ level: 'silent' });

describe('createKokoro (mock backend)', () => {
  test('isReady() is always true; close() is a no-op', async () => {
    const k = createKokoro({ backend: 'mock', logger });
    expect(k.isReady()).toBe(true);
    await expect(k.close()).resolves.toBeUndefined();
  });

  test('synthesize() accepts an optional voice argument without throwing', async () => {
    const k = createKokoro({ backend: 'mock', logger });
    // Mock backend ignores the voice but the interface must accept it.
    const synth = await k.synthesize('hello world', 'af_sky');
    const chunks = [];
    for await (const c of synth.iterator) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('streams chunks; first chunk has first=true', async () => {
    const k = createKokoro({ backend: 'mock', logger });
    const synth = await k.synthesize('hello world');
    const chunks = [];
    for await (const c of synth.iterator) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    const first = chunks[0];
    if (!first) throw new Error('expected at least one chunk');
    expect(first.first).toBe(true);
    expect(first.pcm).toBeInstanceOf(Int16Array);
    // All samples are 24kHz 240 = 10ms frames in mock.
    expect(first.pcm.length).toBe(240);
    // Subsequent chunks have first=false.
    for (let i = 1; i < chunks.length; i++) {
      const ch = chunks[i];
      if (!ch) throw new Error('missing chunk');
      expect(ch.first).toBe(false);
    }
  });

  test('cancel() halts the stream', async () => {
    const k = createKokoro({ backend: 'mock', logger });
    const synth = await k.synthesize('the quick brown fox jumps over the lazy dog');
    const it = synth.iterator;
    const collected = [];
    const first = await it.next();
    if (first.done) throw new Error('expected first chunk');
    collected.push(first.value);
    await synth.cancel();
    // Pull a few more — generator should terminate quickly.
    for (let i = 0; i < 10; i++) {
      const r = await it.next();
      if (r.done) break;
      collected.push(r.value);
    }
    // Cancel was meaningful — we never drained more than 8 (mock cap).
    expect(collected.length).toBeLessThanOrEqual(8);
  });

  test('cancel() during the inter-chunk pause (mid-await, before the 80ms pacing delay elapses) halts promptly', async () => {
    const k = createKokoro({ backend: 'mock', logger });
    const synth = await k.synthesize(
      'a much longer utterance to guarantee several chunks are queued up',
    );
    const it = synth.iterator;
    const first = await it.next();
    expect(first.done).toBe(false);
    // Starts the i=1 iteration, which immediately awaits the 80ms
    // inter-chunk pacing delay (see MOCK_TTS_CHUNK_INTERVAL_MS).
    const secondPromise = it.next();
    // Cancel while the generator is still inside that delay — this is the
    // race that exercises the second `if (cancelled) return;` check (after
    // the pacing await), distinct from the one before it.
    await synth.cancel();
    const second = await secondPromise;
    expect(second.done).toBe(true);
  });
});

describe('validateKokoroModel (startup gate, spec/07 § sidecar lifecycle)', () => {
  test('mock backend needs nothing', () => {
    expect(() => validateKokoroModel({ kokoroBackend: 'mock' })).not.toThrow();
    expect(() =>
      validateKokoroModel({ kokoroBackend: 'mock', kokoroModelPath: undefined }),
    ).not.toThrow();
  });

  test('real backend with no resolved model path at all aborts loudly', () => {
    expect(() => validateKokoroModel({ kokoroBackend: 'real' })).toThrow(
      /no Kokoro model path resolved/,
    );
    expect(() => validateKokoroModel({ kokoroBackend: 'real', kokoroModelPath: '' })).toThrow(
      /no Kokoro model path resolved/,
    );
  });

  test('an OPERATOR-named model path that is not there aborts loudly', () => {
    expect(() =>
      validateKokoroModel(
        {
          kokoroBackend: 'real',
          kokoroModelPath: '/no/such/kokoro.onnx',
          kokoroModelPathFromEnv: true,
        },
        () => false,
      ),
    ).toThrow(/does not exist on disk/);
  });

  test('the host-local component simply not downloaded yet does NOT abort boot', () => {
    // spec/02 § Optional components: Kokoro is a ~340 MB per-machine download.
    // A freshly installed machine has not got it, which is the designed state —
    // the component reports `not installed` and voice is disabled until it is
    // there. Aborting here would mean no host can start on a new machine at
    // all (spec/11: "installs and runs on a machine carrying only an OS").
    expect(() =>
      validateKokoroModel(
        {
          kokoroBackend: 'real',
          kokoroModelPath: '/home/u/.patch/components/kokoro',
          kokoroModelPathFromEnv: false,
        },
        () => false,
      ),
    ).not.toThrow();
  });

  test('real backend with an existing model file passes', () => {
    expect(() =>
      validateKokoroModel(
        { kokoroBackend: 'real', kokoroModelPath: '/models/kokoro.onnx' },
        (p) => p === '/models/kokoro.onnx',
      ),
    ).not.toThrow();
  });
});

// --- RealKokoroBackend --------------------------------------------------
//
// These tests extend `createKokoro`'s own mock/fake-sidecar approach to the
// `real` backend, driving it two ways:
//   1. External `sidecarUrl` (spawnsOwn=false) — a fake WS server stands in
//      for the Python sidecar, matching the wire protocol used by the
//      pcm-alignment regression test elsewhere in this package.
//   2. No `sidecarUrl` (spawnsOwn=true) — `node:child_process.spawn` is
//      mocked so the process-lifecycle logic (spawn args, exit/error
//      handlers, respawn-on-next-request, close()) can be driven without a
//      real `uv`/Python sidecar.

async function startWsServer(
  onConnection: (sock: WebSocket) => void,
  port = 0,
): Promise<{ port: number; close(): Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const actualPort = await new Promise<number>((resolve) => {
    wss.on('listening', () => resolve((wss.address() as AddressInfo).port));
  });
  wss.on('connection', onConnection);
  return {
    port: actualPort,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

function parseJson(raw: Buffer | string): Record<string, unknown> {
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as Record<
    string,
    unknown
  >;
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

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

describe('RealKokoroBackend (external sidecarUrl — operator-owned process)', () => {
  test('streams PCM frames with a correct first flag, then ends; isReady() stays false', async () => {
    const server = await startWsServer((sock) => {
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') {
          for (let f = 0; f < 3; f++) {
            const buf = Buffer.alloc(2);
            buf.writeInt16LE(f + 1, 0);
            sock.send(buf, { binary: true });
          }
          sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
        }
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      // External URL — the host never spawns anything, so `ready` never
      // flips true; the operator owns the sidecar's lifecycle.
      expect(k.isReady()).toBe(false);
      const synth = await k.synthesize('hello');
      const chunks: KokoroChunk[] = [];
      for await (const c of synth.iterator) chunks.push(c);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]?.first).toBe(true);
      expect(chunks[1]?.first).toBe(false);
      expect(chunks[2]?.first).toBe(false);
      expect(k.isReady()).toBe(false);
    } finally {
      await k.close();
      await server.close();
    }
  });

  test('synthesize() forwards an optional voice to the sidecar JSON frame', async () => {
    let receivedMsg: Record<string, unknown> | undefined;
    const server = await startWsServer((sock) => {
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') {
          receivedMsg = msg;
          sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
        }
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const synth = await k.synthesize('speak now', 'af_sky');
      while (!(await synth.iterator.next()).done) {
        /* drain */
      }
      expect(receivedMsg).toBeDefined();
      expect(receivedMsg?.voice).toBe('af_sky');
      expect(receivedMsg?.text).toBe('speak now');
    } finally {
      await k.close();
      await server.close();
    }
  });

  test('synthesize() without a voice omits the voice field from the sidecar JSON frame', async () => {
    let receivedMsg: Record<string, unknown> | undefined;
    const server = await startWsServer((sock) => {
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') {
          receivedMsg = msg;
          sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
        }
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const synth = await k.synthesize('speak now');
      while (!(await synth.iterator.next()).done) {
        /* drain */
      }
      expect(receivedMsg).toBeDefined();
      expect(receivedMsg).not.toHaveProperty('voice');
    } finally {
      await k.close();
      await server.close();
    }
  });

  test('getClient() memoizes the persistent connection across multiple synthesize() calls', async () => {
    let connections = 0;
    const server = await startWsServer((sock) => {
      connections++;
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') {
          sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
        }
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const s1 = await k.synthesize('one');
      while (!(await s1.iterator.next()).done) {
        /* drain */
      }
      const s2 = await k.synthesize('two');
      while (!(await s2.iterator.next()).done) {
        /* drain */
      }
      expect(connections).toBe(1);
    } finally {
      await k.close();
      await server.close();
    }
  });

  test('cancel() sends an out-of-band {requestId,cancel:true} frame and the iterator terminates', async () => {
    let sawCancel: unknown;
    let onCancelReceived: (() => void) | undefined;
    const cancelReceived = new Promise<void>((resolve) => {
      onCancelReceived = resolve;
    });
    const server = await startWsServer((sock) => {
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (msg.cancel === true) {
          sawCancel = msg;
          sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
          onCancelReceived?.();
          return;
        }
        if (typeof msg.text === 'string') {
          const buf = Buffer.alloc(2);
          buf.writeInt16LE(7, 0);
          sock.send(buf, { binary: true });
          // No `end` yet — mimics a long, still-streaming utterance.
        }
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const synth = await k.synthesize('hello');
      const first = await synth.iterator.next();
      expect(first.done).toBe(false);
      await synth.cancel();
      // The iterator itself can terminate synchronously (the `cancelled` flag
      // is checked before awaiting anything new) — wait for the network
      // round-trip separately before asserting on what the sidecar received.
      const second = await synth.iterator.next();
      expect(second.done).toBe(true);
      await cancelReceived;
      expect(sawCancel).toMatchObject({ cancel: true });
      // Idempotent per the interface contract.
      await expect(synth.cancel()).resolves.toBeUndefined();
    } finally {
      await k.close();
      await server.close();
    }
  });

  test('a sidecar drop mid-stream (no `end` frame) surfaces via the iterator instead of hanging', async () => {
    const server = await startWsServer((sock) => {
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') {
          const buf = Buffer.alloc(2);
          buf.writeInt16LE(3, 0);
          sock.send(buf, { binary: true });
          setTimeout(() => sock.terminate(), 20);
        }
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const synth = await k.synthesize('hello');
      const chunks: KokoroChunk[] = [];
      for await (const c of synth.iterator) chunks.push(c);
      expect(chunks).toHaveLength(1);
    } finally {
      await k.close();
      await server.close();
    }
  }, 10_000);

  test('non-"end" JSON frames (e.g. progress) from the sidecar are ignored mid-stream', async () => {
    const server = await startWsServer((sock) => {
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') {
          const buf1 = Buffer.alloc(2);
          buf1.writeInt16LE(5, 0);
          sock.send(buf1, { binary: true });
          sock.send(JSON.stringify({ requestId: msg.requestId, progress: 0.5 }));
          const buf2 = Buffer.alloc(2);
          buf2.writeInt16LE(6, 0);
          sock.send(buf2, { binary: true });
          sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
        }
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const synth = await k.synthesize('hello');
      const chunks: KokoroChunk[] = [];
      for await (const c of synth.iterator) chunks.push(c);
      expect(chunks).toHaveLength(2);
    } finally {
      await k.close();
      await server.close();
    }
  });

  test('an odd-byte-length PCM frame is a protocol violation the sidecar must never send', async () => {
    // Reproduces the invariant check in the onBinary handler. A throw inside
    // a `ws` 'message' listener surfaces as an uncaughtException (verified
    // directly against the real `ws` library — it is NOT caught internally),
    // so we install a one-shot process handler to observe it rather than let
    // it crash the test worker.
    let serverSock: WebSocket | undefined;
    let onRequestReceived: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      onRequestReceived = resolve;
    });
    const server = await startWsServer((sock) => {
      serverSock = sock;
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') onRequestReceived?.();
      });
    });
    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      await k.synthesize('hello');
      await requestReceived;
      const errPromise = new Promise<Error>((resolve) => {
        process.once('uncaughtException', resolve);
      });
      serverSock!.send(Buffer.alloc(3), { binary: true }); // 3 bytes: odd length.
      const err = await errPromise;
      expect(err.message).toMatch(/pcm16 frame has odd byte length/);
    } finally {
      await k.close();
      await server.close();
    }
  });
});

describe('RealKokoroBackend (spawned sidecar — host-owned process)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  test('synthesize() throws when KOKORO_MODEL_PATH is missing (no sidecarUrl to fall back on)', async () => {
    const k = createKokoro({ backend: 'real', logger });
    await expect(k.synthesize('hi')).rejects.toThrow(/KOKORO_MODEL_PATH missing/);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('spawns `uv run` with the expected env/cwd, and isReady() flips true', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const k = createKokoro({
      backend: 'real',
      logger,
      modelPath: '/models/kokoro.onnx',
      sidecarCwd: '/opt/kokoro-sidecar',
    });
    try {
      expect(k.isReady()).toBe(false);
      await k.synthesize('hello');
      expect(k.isReady()).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'uv',
        ['run', '--no-sync', 'python', '-m', 'patch_kokoro_sidecar'],
        expect.objectContaining({
          env: expect.objectContaining({
            KOKORO_MODEL_PATH: '/models/kokoro.onnx',
            KOKORO_SIDECAR_HOST: '127.0.0.1',
            KOKORO_SIDECAR_PORT: '5019',
          }),
          cwd: '/opt/kokoro-sidecar',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } finally {
      await k.close();
    }
  });

  test('a second synthesize() call reuses the already-spawned (not-yet-killed) process', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const k = createKokoro({ backend: 'real', logger, modelPath: '/models/kokoro.onnx' });
    try {
      await k.synthesize('one');
      await k.synthesize('two');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await k.close();
    }
  });

  test('proc "exit" flips isReady() back to false and clears the process (next call respawns)', async () => {
    const fakeProc1 = new FakeChildProcess();
    const fakeProc2 = new FakeChildProcess();
    vi.mocked(spawn)
      .mockReturnValueOnce(fakeProc1 as unknown as ChildProcess)
      .mockReturnValueOnce(fakeProc2 as unknown as ChildProcess);
    const k = createKokoro({ backend: 'real', logger, modelPath: '/models/kokoro.onnx' });
    try {
      await k.synthesize('hello');
      expect(k.isReady()).toBe(true);
      fakeProc1.emit('exit', 1, null);
      expect(k.isReady()).toBe(false);
      await k.synthesize('hello again');
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(k.isReady()).toBe(true);
    } finally {
      await k.close();
    }
  });

  test('stdout/stderr are tailed (last lines) into the exit warn log', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const log = fakeLogger();
    const k = createKokoro({ backend: 'real', logger: log, modelPath: '/models/kokoro.onnx' });
    try {
      await k.synthesize('hello');
      fakeProc.stdout.emit('data', Buffer.from('loading model\n'));
      fakeProc.stderr.emit('data', Buffer.from('a stderr warning\n'));
      fakeProc.emit('exit', 1, null);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 1,
          signal: null,
          tail: expect.stringContaining('a stderr warning'),
        }),
        expect.stringMatching(/exited; will respawn/),
      );
    } finally {
      await k.close();
    }
  });

  test('proc "error" flips isReady() back to false and logs the spawn error', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const log = fakeLogger();
    const k = createKokoro({ backend: 'real', logger: log, modelPath: '/models/kokoro.onnx' });
    try {
      await k.synthesize('hello');
      expect(k.isReady()).toBe(true);
      fakeProc.emit('error', new Error('spawn ENOENT'));
      expect(k.isReady()).toBe(false);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'spawn ENOENT' }),
        expect.stringMatching(/spawn error/),
      );
    } finally {
      await k.close();
    }
  });

  test('close() kills a live spawned process', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const k = createKokoro({ backend: 'real', logger, modelPath: '/models/kokoro.onnx' });
    await k.synthesize('hello');
    await k.close();
    expect(fakeProc.killed).toBe(true);
  });

  test('close() does not re-kill a process that is already killed', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const k = createKokoro({ backend: 'real', logger, modelPath: '/models/kokoro.onnx' });
    await k.synthesize('hello');
    fakeProc.killed = true;
    const killSpy = vi.spyOn(fakeProc, 'kill');
    await k.close();
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('full round-trip over the default loopback port once spawned', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const server = await startWsServer((sock) => {
      sock.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        if (typeof msg.text === 'string') {
          const buf = Buffer.alloc(2);
          buf.writeInt16LE(9, 0);
          sock.send(buf, { binary: true });
          sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
        }
      });
    });
    // resolvedUrl()'s no-sidecarUrl branch, on a port nothing else can hold:
    // pinned to DEFAULT_KOKORO_PORT this bound 5019, which the real host's own
    // sidecar owns on every Patch host — EADDRINUSE, and a 15s timeout, on the
    // machines that matter. That the default IS 5019 is asserted above, where the
    // spawn env is checked.
    const k = createKokoro({
      backend: 'real',
      logger,
      modelPath: '/models/kokoro.onnx',
      sidecarPort: server.port,
    });
    try {
      const synth = await k.synthesize('hello');
      const chunks: KokoroChunk[] = [];
      for await (const c of synth.iterator) chunks.push(c);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.first).toBe(true);
    } finally {
      await k.close();
      await server.close();
    }
  });
});
