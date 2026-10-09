// The server's copy of each chat's transcript (spec/01 § Message log): what
// passes through is kept, so a chat on a host that is asleep stays readable.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatLogStore } from '../src/chat-log-store.js';

const logger = pino({ level: 'silent' });

const message = (chatId: string, seq: number, content = `m${seq}`): WireEvent =>
  ({ type: 'chat.message', chatId, role: 'assistant', content, seq }) as WireEvent;

describe('ChatLogStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chatlog-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads back what passed through, in seq order, after the given seq', () => {
    const store = new ChatLogStore({ logger });
    for (const seq of [3, 1, 2]) store.observe(message('c1', seq));
    expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(store.read('c1', 1).map((e) => (e as { seq: number }).seq)).toEqual([2, 3]);
    expect(store.read('c1', -1, 2)).toHaveLength(2);
    expect(store.read('other', -1)).toEqual([]);
    expect(store.has('c1')).toBe(true);
    expect(store.has('other')).toBe(false);
  });

  test('keeps the transcript and ignores live-only frames', () => {
    const store = new ChatLogStore({ logger });
    store.observe({
      type: 'chat.message_delta',
      chatId: 'c1',
      messageSeq: 1,
      delta: 'x',
    } as WireEvent);
    store.observe({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'l',
      message: 'q',
      queueSeq: 1,
    } as WireEvent);
    store.observe({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 2,
      tool: 'Bash',
      args: {},
      callId: 'k',
    } as WireEvent);
    expect(store.read('c1', -1).map((e) => e.type)).toEqual(['chat.tool_call']);
  });

  test('the same event seen twice is held once, and a later version replaces it', () => {
    const store = new ChatLogStore({ logger });
    store.observe(message('c1', 1, 'first'));
    store.observe(message('c1', 1, 'first'));
    store.observe(message('c1', 1, 'second'));
    const held = store.read('c1', -1);
    expect(held).toHaveLength(1);
    expect((held[0] as { content: string }).content).toBe('second');
  });

  test('drops the routing tag a replayed event carries', () => {
    const store = new ChatLogStore({ logger });
    store.observe({ ...message('c1', 1), forSurfaceId: 'srf-1' } as WireEvent);
    expect('forSurfaceId' in (store.read('c1', -1)[0] as object)).toBe(false);
  });

  test('survives a restart, and ignores a torn last line', async () => {
    const first = new ChatLogStore({ dataDir: dir, logger });
    first.observe(message('c1', 1));
    first.observe(message('c1', 2));
    await first.flush();

    appendFileSync(join(dir, 'chat-logs', 'c1.jsonl'), '{"type":"chat.message","chatId":"c1","se');
    const second = new ChatLogStore({ dataDir: dir, logger });
    expect(second.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([1, 2]);
  });

  test('an unchanged event is not written again', async () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.observe(message('c1', 1));
    store.observe(message('c1', 1));
    await store.flush();
    expect(
      readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });

  test('a chat id cannot escape the log directory', async () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.observe(message('../../evil', 1));
    await store.flush();
    expect(readFileSync(join(dir, 'chat-logs', '______evil.jsonl'), 'utf8')).toContain('"seq":1');
  });

  test('commit says what it did: new, a resend, an update, a contradiction', () => {
    const store = new ChatLogStore({ logger });
    expect(store.commit(message('c1', 1, 'first'))).toBe('new');
    expect(store.commit(message('c1', 1, 'first'))).toBe('duplicate');
    expect(store.commit(message('c1', 1, 'edited'))).toBe('updated');
    // A tool call is a different event from the message that holds seq 1.
    expect(
      store.commit({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq: 1,
        tool: 'Bash',
        args: {},
        callId: 'k',
      } as WireEvent),
    ).toBe('conflict');
    // The contradiction kept nothing and left the held message alone.
    expect((store.read('c1', -1)[0] as { content: string }).content).toBe('edited');
    expect(
      store.commit({
        type: 'chat.message_delta',
        chatId: 'c1',
        messageSeq: 1,
        delta: 'x',
      } as WireEvent),
    ).toBe('ignored');
    expect(store.commit({ ...message('c1', 2), seq: -1 } as WireEvent)).toBe('ignored');
  });

  test('is on disk the moment commit returns', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit(message('c1', 1));
    expect(readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8')).toContain('"seq":1');
    // Another process starting now reads it back.
    expect(new ChatLogStore({ dataDir: dir, logger }).highWater('c1')).toBe(1);
  });

  test("a person's own message is also fsynced, and written once", () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.commit({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hi',
      seq: 0,
    } as WireEvent);
    expect(
      readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });

  test('highWater is the highest seq held, or -1 for a chat it holds nothing for', () => {
    const store = new ChatLogStore({ logger });
    expect(store.highWater('c1')).toBe(-1);
    store.commit(message('c1', 3));
    store.commit(message('c1', 9));
    store.commit(message('c1', 5));
    expect(store.highWater('c1')).toBe(9);
  });

  test('a batched replay is kept event by event', () => {
    const store = new ChatLogStore({ logger });
    store.observe({
      type: 'chat.replay_batch',
      chatId: 'c1',
      events: [message('c1', 1), message('c1', 2)],
      done: true,
    } as WireEvent);
    expect(store.read('c1', -1)).toHaveLength(2);
  });

  describe('large tool results', () => {
    const result = (chatId: string, seq: number, body: unknown): WireEvent =>
      ({
        type: 'chat.tool_result',
        chatId,
        callId: `k${seq}`,
        tool: 'Bash',
        result: body,
        seq,
      }) as WireEvent;
    const big = 'x'.repeat(10_000);

    test('are kept as a reference to a stored body, and the body can be read back', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(result('c1', 1, [{ type: 'text', text: big }]));
      const held = (store.read('c1', -1)[0] as { result: Record<string, unknown> }).result;
      expect(held).toMatchObject({ bytes: expect.any(Number), mime: 'application/json' });
      expect(String(held['$blob'])).toMatch(/^[0-9a-f]{64}$/);
      expect(String(held['preview']).length).toBeLessThanOrEqual(200);
      const body = store.readBlob(String(held['$blob']))!;
      expect(JSON.parse(body.bytes.toString('utf8'))).toEqual([{ type: 'text', text: big }]);
      // The log line itself is small.
      expect(readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8').length).toBeLessThan(1_000);
    });

    test('leave a small result inline', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(result('c1', 1, 'ok'));
      expect((store.read('c1', -1)[0] as { result: string }).result).toBe('ok');
    });

    test('a resend of a big result is a duplicate, and the body is stored once', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      expect(store.commit(result('c1', 1, big))).toBe('new');
      expect(store.commit(result('c1', 1, big))).toBe('duplicate');
      expect(store.commit(result('c2', 1, big))).toBe('new'); // same body, another chat
    });

    test('survive a restart', () => {
      const first = new ChatLogStore({ dataDir: dir, logger });
      first.commit(result('c1', 1, big));
      const ref = (first.read('c1', -1)[0] as { result: { $blob: string } }).result.$blob;
      const second = new ChatLogStore({ dataDir: dir, logger });
      expect(second.readBlob(ref)).not.toBeNull();
      expect((second.read('c1', -1)[0] as { result: { $blob: string } }).result.$blob).toBe(ref);
    });

    test('a reference the host already made is kept as it is', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      const ref = { $blob: 'a'.repeat(64), bytes: 9_999, mime: 'application/json', preview: 'p' };
      store.commit(result('c1', 1, ref));
      expect((store.read('c1', -1)[0] as { result: unknown }).result).toEqual(ref);
      expect(store.readBlob('a'.repeat(64))).toBeNull(); // the body is the host's to give
    });

    test('are kept inline when there is nowhere to store a body', () => {
      const store = new ChatLogStore({ logger });
      store.commit(result('c1', 1, big));
      expect((store.read('c1', -1)[0] as { result: string }).result).toBe(big);
    });

    test('a result that is missing or null is small, so it stays as it is', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(result('c1', 1, null));
      store.commit({
        type: 'chat.tool_result',
        chatId: 'c1',
        callId: 'k2',
        tool: 'T',
        seq: 2,
      } as WireEvent);
      const held = store.read('c1', -1) as Array<{ result?: unknown }>;
      expect(held[0]!.result).toBeNull();
      expect('result' in held[1]!).toBe(false);
    });

    test('only a well-formed hash is looked up', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      expect(store.readBlob('../../etc/passwd')).toBeNull();
      expect(store.readBlob('nothex')).toBeNull();
    });
  });

  describe('what it does when things go wrong or are odd', () => {
    const warnings = (): { logger: { warn: (o: unknown, m?: string) => void }; seen: string[] } => {
      const seen: string[] = [];
      return { logger: { warn: (_o, m) => seen.push(String(m)) }, seen };
    };
    const toolResult = (seq: number, body: unknown): WireEvent =>
      ({
        type: 'chat.tool_result',
        chatId: 'c1',
        callId: `k${seq}`,
        tool: 'T',
        result: body,
        seq,
      }) as WireEvent;
    const previewOfStored = (store: ChatLogStore): string =>
      (store.read('c1', -1)[0] as { result: { preview: string } }).result.preview;

    test('keeps only the newest events of a chat in memory, up to the cap', () => {
      const store = new ChatLogStore({ logger, maxEventsPerChat: 3 });
      for (let seq = 1; seq <= 5; seq++) store.commit(message('c1', seq));
      expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([3, 4, 5]);
    });

    test('tells a provider context apart from an error at the same seq', () => {
      const store = new ChatLogStore({ logger });
      store.commit({
        type: 'chat.provider_context',
        chatId: 'c1',
        providerType: 'x',
        text: 't',
        seq: 1,
      } as WireEvent);
      expect(
        store.commit({
          type: 'chat.error',
          chatId: 'c1',
          error: { code: 'internal', message: 'm' },
          seq: 1,
        } as WireEvent),
      ).toBe('conflict');
    });

    test('previews a big text result by its start, cut to 200 characters', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(toolResult(1, 'a'.repeat(9_000)));
      expect(previewOfStored(store)).toBe('a'.repeat(200));
    });

    test('previews a big block result by its text blocks, with [image] for a picture and nothing for the rest', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(
        toolResult(1, [
          'a bare string block',
          null,
          { type: 'image', source: {} },
          { type: 'text', text: 'first line' },
          { type: 'text', text: 7 },
          { type: 'text', text: 'x'.repeat(9_000) },
        ]),
      );
      const preview = previewOfStored(store);
      expect(preview.startsWith('[image]\nfirst line\nxxx')).toBe(true);
      expect(preview).toHaveLength(200);
    });

    test('previews a big result that has no text blocks by its JSON', () => {
      const store = new ChatLogStore({ dataDir: dir, logger });
      store.commit(toolResult(1, { rows: Array.from({ length: 2_000 }, (_, i) => i) }));
      expect(previewOfStored(store).startsWith('{"rows":[0,1,2')).toBe(true);
    });

    test('keeps a big result inline, and says so, when its body cannot be stored', () => {
      const { logger: l, seen } = warnings();
      mkdirSync(join(dir, 'chat-logs'), { recursive: true });
      writeFileSync(join(dir, 'chat-logs', 'blobs'), 'in the way'); // a file where the blob directory goes
      const store = new ChatLogStore({ dataDir: dir, logger: l });
      const body = 'z'.repeat(9_000);
      expect(store.commit(toolResult(1, body))).toBe('new');
      expect((store.read('c1', -1)[0] as { result: string }).result).toBe(body);
      expect(seen.join(' ')).toContain('could not store a large result');
    });

    test('says so, and carries on in memory, when the log file cannot be written', () => {
      const { logger: l, seen } = warnings();
      mkdirSync(join(dir, 'chat-logs', 'c1.jsonl'), { recursive: true }); // a directory where the file goes
      const store = new ChatLogStore({ dataDir: dir, logger: l });
      expect(store.commit(message('c1', 1))).toBe('new');
      expect(
        store.commit({
          type: 'chat.message',
          chatId: 'c1',
          role: 'user',
          content: 'hi',
          seq: 2,
        } as WireEvent),
      ).toBe('new');
      expect(seen.filter((m) => m.includes('could not write the chat log'))).toHaveLength(2);
      expect(store.read('c1', -1)).toHaveLength(2);
    });

    test("says so, and starts empty, when a chat's log file cannot be read", () => {
      const { logger: l, seen } = warnings();
      mkdirSync(join(dir, 'chat-logs', 'c1.jsonl'), { recursive: true });
      const store = new ChatLogStore({ dataDir: dir, logger: l });
      expect(store.has('c1')).toBe(false);
      expect(seen.join(' ')).toContain('could not read the chat log');
    });

    test('skips blank lines and records without a seq when reading a log back', () => {
      mkdirSync(join(dir, 'chat-logs'), { recursive: true });
      writeFileSync(
        join(dir, 'chat-logs', 'c1.jsonl'),
        [
          '',
          JSON.stringify({
            type: 'chat.message',
            chatId: 'c1',
            role: 'user',
            content: 'a',
            seq: 4,
          }),
          '{"type":"chat.message"}',
          '',
        ].join('\n'),
      );
      const store = new ChatLogStore({ dataDir: dir, logger });
      expect(store.read('c1', -1).map((e) => (e as { seq: number }).seq)).toEqual([4]);
    });

    test('flush resolves at once, since every write was already made', async () => {
      await expect(new ChatLogStore({ logger }).flush()).resolves.toBeUndefined();
    });
  });
});
