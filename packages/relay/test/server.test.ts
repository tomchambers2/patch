import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ed25519 } from '@noble/curves/ed25519';
import { createRelayServer, type RelayServerHandle } from '../src/server.js';
import {
  channelFor,
  generateServerIdentity,
  toBase64Url,
  type ServerIdentity,
} from '../src/crypto.js';

let relay: RelayServerHandle;
let base: string;

beforeEach(async () => {
  relay = await createRelayServer({ port: 0, host: '127.0.0.1', maxClientsPerChannel: 3 });
  base = `ws://127.0.0.1:${relay.port}`;
});
afterEach(async () => {
  await relay.close();
});

/** A socket that records everything it is sent from the moment it is created. */
class Tape {
  readonly texts: Record<string, unknown>[] = [];
  readonly binaries: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.binaries.push(new Uint8Array(data));
      else this.texts.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString() };
    });
  }
  async until<T>(pick: () => T | undefined, ms = 2000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = pick();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('timed out waiting on the tape');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  text(type: string): Promise<Record<string, unknown>> {
    return this.until(() => this.texts.find((t) => t['type'] === type));
  }
  closedWith(): Promise<{ code: number; reason: string }> {
    return this.until(() => this.closed ?? undefined);
  }
}

const open = (url: string): Tape => new Tape(new WebSocket(url));

async function connectServer(
  id: ServerIdentity = generateServerIdentity(),
): Promise<{ id: ServerIdentity; tape: Tape }> {
  const channel = channelFor(id.publicKey);
  const tape = open(`${base}/v1/connect?channel=${channel}&role=server`);
  const challenge = await tape.text('challenge');
  const sig = ed25519.sign(
    new TextEncoder().encode(`patch-relay-v1|${channel}|${String(challenge['nonce'])}`),
    id.secretKey,
  );
  tape.ws.send(
    JSON.stringify({
      type: 'hello',
      publicKey: toBase64Url(id.publicKey),
      signature: toBase64Url(sig),
    }),
  );
  await tape.text('ready');
  return { id, tape };
}

describe('a server joining its channel', () => {
  it('proves it holds the key the channel is named for', async () => {
    const { tape } = await connectServer();
    expect(tape.closed).toBeNull();
    expect(relay.stats().servers).toBe(1);
  });

  it('is refused if it signs with a different key — nobody else can squat a channel', async () => {
    const owner = generateServerIdentity();
    const squatter = generateServerIdentity();
    const channel = channelFor(owner.publicKey);
    const tape = open(`${base}/v1/connect?channel=${channel}&role=server`);
    const challenge = await tape.text('challenge');
    const sig = ed25519.sign(
      new TextEncoder().encode(`patch-relay-v1|${channel}|${String(challenge['nonce'])}`),
      squatter.secretKey,
    );
    tape.ws.send(
      JSON.stringify({
        type: 'hello',
        publicKey: toBase64Url(squatter.publicKey),
        signature: toBase64Url(sig),
      }),
    );
    expect((await tape.closedWith()).code).toBe(4401);
    expect(relay.stats().servers).toBe(0);
  });

  it('is refused if it replays a signature made for another challenge', async () => {
    const id = generateServerIdentity();
    const channel = channelFor(id.publicKey);
    const tape = open(`${base}/v1/connect?channel=${channel}&role=server`);
    await tape.text('challenge');
    const old = ed25519.sign(
      new TextEncoder().encode(`patch-relay-v1|${channel}|some-other-nonce`),
      id.secretKey,
    );
    tape.ws.send(
      JSON.stringify({
        type: 'hello',
        publicKey: toBase64Url(id.publicKey),
        signature: toBase64Url(old),
      }),
    );
    expect((await tape.closedWith()).code).toBe(4401);
  });

  it('is refused if it never answers the challenge', async () => {
    const quick = await createRelayServer({ port: 0, host: '127.0.0.1', helloTimeoutMs: 50 });
    const tape = open(
      `ws://127.0.0.1:${quick.port}/v1/connect?channel=abcdefghijklmnopqrstuv&role=server`,
    );
    expect((await tape.closedWith()).code).toBe(4408);
    await quick.close();
  });

  it('is replaced by a newer connection from the same server, which wins the channel', async () => {
    const first = await connectServer();
    const second = await connectServer(first.id);
    expect((await first.tape.closedWith()).code).toBe(4409);
    expect(second.tape.closed).toBeNull();
    expect(relay.stats().servers).toBe(1);
  });
});

describe('a client reaching a server', () => {
  it('is told the server is offline when nothing holds the channel', async () => {
    const tape = open(
      `${base}/v1/connect?channel=${channelFor(generateServerIdentity().publicKey)}&role=client`,
    );
    expect((await tape.closedWith()).code).toBe(4404);
  });

  it('is announced to the server, and bytes flow both ways, labelled so clients cannot mix', async () => {
    const { id, tape: server } = await connectServer();
    const channel = channelFor(id.publicKey);
    const a = open(`${base}/v1/connect?channel=${channel}&role=client`);
    const b = open(`${base}/v1/connect?channel=${channel}&role=client`);
    await a.text('ready');
    await b.text('ready');
    const opens = await server.until(() =>
      server.texts.filter((t) => t['type'] === 'open').length === 2
        ? server.texts.filter((t) => t['type'] === 'open')
        : undefined,
    );
    const [ca, cb] = opens.map((o) => o['cid'] as number) as [number, number];
    expect(ca).not.toBe(cb);

    a.ws.send(Uint8Array.of(1, 2, 3));
    b.ws.send(Uint8Array.of(9, 9));
    await server.until(() => (server.binaries.length === 2 ? true : undefined));
    const byCid = new Map(
      server.binaries.map((f) => [
        new DataView(f.buffer, f.byteOffset).getUint32(0),
        Array.from(f.slice(4)),
      ]),
    );
    expect(byCid.get(ca)).toEqual([1, 2, 3]);
    expect(byCid.get(cb)).toEqual([9, 9]);

    const frame = new Uint8Array(6);
    new DataView(frame.buffer).setUint32(0, cb);
    frame.set([7, 7], 4);
    server.ws.send(frame);
    await b.until(() => (b.binaries.length ? true : undefined));
    expect(Array.from(b.binaries[0]!)).toEqual([7, 7]);
    expect(a.binaries).toHaveLength(0);
  });

  it('tells the server when a client leaves, and the client when the server closes it', async () => {
    const { id, tape: server } = await connectServer();
    const channel = channelFor(id.publicKey);
    const c = open(`${base}/v1/connect?channel=${channel}&role=client`);
    await c.text('ready');
    const cid = (await server.text('open'))['cid'] as number;
    server.ws.send(JSON.stringify({ type: 'close', cid }));
    expect((await c.closedWith()).code).toBe(4410);
    const d = open(`${base}/v1/connect?channel=${channel}&role=client`);
    await d.text('ready');
    d.ws.close();
    const closed = await server.until(() =>
      server.texts.find((t) => t['type'] === 'close' && t['cid'] !== cid),
    );
    expect(closed['type']).toBe('close');
  });

  it('is dropped when its server goes away', async () => {
    const { id, tape: server } = await connectServer();
    const c = open(`${base}/v1/connect?channel=${channelFor(id.publicKey)}&role=client`);
    await c.text('ready');
    server.ws.close();
    expect((await c.closedWith()).code).toBe(4503);
  });

  it('is refused beyond the per-channel limit', async () => {
    const { id } = await connectServer();
    const channel = channelFor(id.publicKey);
    const held = [1, 2, 3].map(() => open(`${base}/v1/connect?channel=${channel}&role=client`));
    for (const h of held) await h.text('ready');
    const over = open(`${base}/v1/connect?channel=${channel}&role=client`);
    expect((await over.closedWith()).code).toBe(4429);
  });

  it('is dropped for a frame larger than the limit', async () => {
    const { id } = await connectServer();
    const c = open(`${base}/v1/connect?channel=${channelFor(id.publicKey)}&role=client`);
    await c.text('ready');
    c.ws.send(new Uint8Array(200_000));
    expect((await c.closedWith()).code).toBe(1009);
  });

  it('cannot talk to the server in text: only the relay speaks control', async () => {
    const { id, tape: server } = await connectServer();
    const c = open(`${base}/v1/connect?channel=${channelFor(id.publicKey)}&role=client`);
    await c.text('ready');
    c.ws.send(JSON.stringify({ type: 'open', cid: 99 }));
    expect((await c.closedWith()).code).toBe(4400);
    expect(server.texts.filter((t) => t['type'] === 'open' && t['cid'] === 99)).toHaveLength(0);
  });
});

describe('the endpoint', () => {
  it('answers /healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('refuses anything that is not a well-formed connect', async () => {
    const bad = open(`${base}/v1/connect?channel=x&role=wizard`);
    expect((await bad.closedWith()).code).toBe(4400);
    const worse = new WebSocket(`${base}/elsewhere`);
    const failed = await new Promise<boolean>((resolve) => {
      worse.on('error', () => resolve(true));
      worse.on('open', () => resolve(false));
    });
    expect(failed).toBe(true);
  });
});
