// The chat's own history log (spec/04 § History): `~/.patch/chats/<id>/events.jsonl`.
//
// Unit half: the ChatLog class on its own — append/read, torn-tail repair, the
// seq authority across restarts, reservations, blobs, re-send dedupe and the
// exact points it fsyncs. Host half: the log as the host writes it —
// persisted localIds, the restart re-send, and a failed append failing the turn.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { LogRecord, type LoggedEvent, type WireEvent } from '@patch/wire';
import { ChatLog, BLOB_INLINE_LIMIT_BYTES, type ChatLogFs } from '../src/chatLog.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type MockSdkBackend } from '../src/sdkBackend.js';

/** A real, complete 1x1 PNG — so the IHDR parse has something true to read. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeLog(home: string, extra: { fs?: Partial<ChatLogFs>; fsyncBatchMs?: number } = {}) {
  return new ChatLog({
    chatDir: (id) => join(home, 'chats', id),
    blobsDir: join(home, 'blobs'),
    logger: silent,
    now: () => 1_700_000_000_000,
    ...extra,
  });
}

function lines(home: string, chatId: string): LogRecord[] {
  return readFileSync(join(home, 'chats', chatId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => LogRecord.parse(JSON.parse(l)));
}

function msg(
  chatId: string,
  seq: number,
  content: string,
  role: 'user' | 'assistant' = 'assistant',
): LoggedEvent {
  return { type: 'chat.message', chatId, role, content, seq };
}

function appendEvent(
  log: ChatLog,
  chatId: string,
  ev: LoggedEvent,
  o: { sync?: boolean; dedupeKey?: string } = {},
) {
  return log.append(
    chatId,
    { k: 'event', event: ev },
    { branchId: `${chatId}-b0`, seq: ev.seq, ...o },
  );
}

describe('ChatLog', () => {
  it('appends records and reads them back, starting with log.start', () => {
    const home = tmp('chatlog-rt-');
    const log = makeLog(home);
    const s0 = log.allocate('c1', 0, 'c1-b0');
    appendEvent(log, 'c1', msg('c1', s0, 'hello', 'user'), { sync: true });
    const s1 = log.allocate('c1', 0, 'c1-b0');
    appendEvent(log, 'c1', msg('c1', s1, 'hi there'));
    log.append('c1', { k: 'turn.end', outcome: 'completed' }, { branchId: 'c1-b0', sync: true });
    log.closeAll();

    const recs = lines(home, 'c1');
    expect(recs.map((r) => r.rec.k)).toEqual(['log.start', 'event', 'event', 'turn.end']);
    expect(recs[0]!.rec).toEqual({ k: 'log.start', legacyUpTo: 0 });
    expect(recs[3]!.seq).toBe(1); // a non-event record carries the high-water seq

    const again = makeLog(home);
    expect(again.readEvents('c1').map((e) => e.event)).toEqual([
      msg('c1', 0, 'hello', 'user'),
      msg('c1', 1, 'hi there'),
    ]);
    expect(again.legacyUpTo('c1')).toBe(0);
  });

  it('starts an existing chat at its current seq: earlier seqs are legacy', () => {
    const home = tmp('chatlog-legacy-');
    const log = makeLog(home);
    log.hydrate('old', 42);
    expect(log.allocate('old', 42, 'old-b0')).toBe(42);
    log.closeAll();
    expect(lines(home, 'old')[0]!.rec).toEqual({ k: 'log.start', legacyUpTo: 42 });
    expect(makeLog(home).legacyUpTo('old')).toBe(42);
  });

  it('repairs a log truncated mid-line: the torn record is cut, everything before it kept', () => {
    const home = tmp('chatlog-torn-');
    const log = makeLog(home);
    for (let i = 0; i < 3; i++) {
      const seq = log.allocate('t', 0, 't-b0');
      appendEvent(log, 't', msg('t', seq, `message ${i}`));
    }
    log.closeAll();
    // The fixture: a crash half-way through writing the next record.
    const path = join(home, 'chats', 't', 'events.jsonl');
    const whole = readFileSync(path, 'utf8');
    const next = JSON.stringify({
      v: 1,
      seq: 3,
      at: 1,
      branchId: 't-b0',
      rec: { k: 'event', event: msg('t', 3, 'never finished') },
    });
    writeFileSync(path, whole + next.slice(0, 37));

    const reopened = makeLog(home);
    const r = reopened.hydrate('t', 0);
    expect(r.repaired).toEqual({ droppedBytes: 37 });
    expect(readFileSync(path, 'utf8')).toBe(whole);
    expect(r.nextSeq).toBe(3);
    expect(reopened.readEvents('t').map((e) => (e.event as { content: string }).content)).toEqual([
      'message 0',
      'message 1',
      'message 2',
    ]);
  });

  it('keeps a last record that is whole but lost only its newline', () => {
    const home = tmp('chatlog-nonl-');
    const log = makeLog(home);
    appendEvent(log, 'n', msg('n', log.allocate('n', 0, 'n-b0'), 'kept'));
    log.closeAll();
    const path = join(home, 'chats', 'n', 'events.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n$/, ''));
    const reopened = makeLog(home);
    expect(reopened.hydrate('n', 0).repaired).toBeNull();
    expect(reopened.readEvents('n')).toHaveLength(1);
  });

  it('hands out unique, never-decreasing seqs across restarts — including reservations and unrecorded ones', () => {
    const home = tmp('chatlog-seq-');
    const all: number[] = [];
    // Life 1: a streamed reply reserves 0, a tool call takes 1, the reply
    // finalises at 0 AFTER it — the file is not in seq order.
    {
      const log = makeLog(home);
      const reply = log.allocate('s', 0, 's-b0');
      log.reserve('s', reply, 's-b0');
      const call = log.allocate('s', 0, 's-b0');
      appendEvent(log, 's', {
        type: 'chat.tool_call',
        chatId: 's',
        tool: 'Read',
        args: {},
        callId: 'c1',
        seq: call,
      });
      appendEvent(log, 's', msg('s', reply, 'done'));
      all.push(reply, call);
      // Handed out and never recorded by anyone (e.g. an error sent out of band).
      all.push(log.allocate('s', 0, 's-b0'));
      log.closeAll(); // records the high-water mark
    }
    // Life 2: the process dies without a clean shutdown.
    {
      const log = makeLog(home);
      expect(log.hydrate('s', 0).nextSeq).toBe(3);
      const a = log.allocate('s', 0, 's-b0');
      log.reserve('s', a, 's-b0'); // written, never fsynced — a process crash keeps it
      all.push(a);
    }
    // Life 3.
    {
      const log = makeLog(home);
      log.hydrate('s', 0);
      all.push(log.allocate('s', 0, 's-b0'), log.allocate('s', 0, 's-b0'));
      log.closeAll();
    }
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(all).size).toBe(all.length);
    // A floor from another store (meta.json) is honoured too.
    const log = makeLog(home);
    expect(log.hydrate('s', 10).nextSeq).toBe(10);
  });

  it('finds the high-water mark past a long run of events after the last non-event record', () => {
    const home = tmp('chatlog-hw-');
    const log = makeLog(home);
    const big = 'x'.repeat(20_000); // records well past one 64 KB read chunk
    for (let i = 0; i < 40; i++)
      appendEvent(log, 'h', msg('h', log.allocate('h', 0, 'h-b0'), `${i}${big}`));
    log.closeAll();
    expect(makeLog(home).hydrate('h', 0).nextSeq).toBe(40);
  });

  it('closes a turn a dead process left open as interrupted', () => {
    const home = tmp('chatlog-open-');
    const log = makeLog(home);
    log.beginTurn('o', 'turn-1');
    log.append(
      'o',
      { k: 'turn.start', harness: 'claude', model: null, origin: 'user' },
      { branchId: 'o-b0' },
    );
    appendEvent(log, 'o', msg('o', log.allocate('o', 0, 'o-b0'), 'half way'));
    // no turn.end — the process died
    const r = makeLog(home).hydrate('o', 0);
    expect(r.interruptedTurnId).toBe('turn-1');
    const last = lines(home, 'o').at(-1)!;
    expect(last.rec).toEqual({ k: 'turn.end', outcome: 'interrupted' });
    expect(last.turnId).toBe('turn-1');
  });

  it('stores a large or image-carrying tool result as a content-addressed blob and reads it back', () => {
    const home = tmp('chatlog-blob-');
    const log = makeLog(home);
    const large = 'L'.repeat(BLOB_INLINE_LIMIT_BYTES + 10);
    const image = [
      { type: 'text', text: 'a picture' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
    ];
    const small = 'tiny';
    const results = [large, image, small];
    for (const [i, result] of results.entries()) {
      appendEvent(log, 'b', {
        type: 'chat.tool_result',
        chatId: 'b',
        tool: 'Read',
        callId: `call-${i}`,
        result,
        seq: log.allocate('b', 0, 'b-b0'),
      });
    }
    log.closeAll();
    const stored = lines(home, 'b')
      .filter((r) => r.rec.k === 'event')
      .map((r) => (r.rec as { event: { result: unknown } }).event.result);
    const largeRef = stored[0] as { $blob: string; bytes: number; mime: string; preview: string };
    expect(largeRef.$blob).toBe(createHash('sha256').update(JSON.stringify(large)).digest('hex'));
    expect(largeRef.bytes).toBe(JSON.stringify(large).length);
    expect(largeRef.preview).toBe('L'.repeat(200));
    expect(
      existsSync(
        join(home, 'blobs', 'sha256', largeRef.$blob.slice(0, 2), largeRef.$blob.slice(2)),
      ),
    ).toBe(true);
    // The image became a per-block reference and the result KEPT its shape, so
    // the surface can still draw the picture's box without opening the row.
    const imageBlocks = stored[1] as Array<{ type: string; text?: string; source?: unknown }>;
    expect(imageBlocks[0]).toEqual({ type: 'text', text: 'a picture' });
    const source = imageBlocks[1]!.source as {
      type: string;
      $blob: string;
      media_type: string;
      bytes: number;
      width: number;
      height: number;
    };
    const rawPng = Buffer.from(PNG_1X1, 'base64');
    expect(source.type).toBe('blob');
    expect(source.media_type).toBe('image/png');
    expect(source.$blob).toBe(createHash('sha256').update(rawPng).digest('hex'));
    expect(source.bytes).toBe(rawPng.length);
    // Read out of the PNG's own IHDR, so the transcript reserves the right box.
    expect(source.width).toBe(1);
    expect(source.height).toBe(1);
    // Stored DECODED, beside a sidecar naming its type, so it can be served
    // straight to an <img> with the right Content-Type.
    const imgPath = join(home, 'blobs', 'sha256', source.$blob.slice(0, 2), source.$blob.slice(2));
    expect(readFileSync(imgPath)).toEqual(rawPng);
    expect(JSON.parse(readFileSync(`${imgPath}.meta`, 'utf8'))).toEqual({ mime: 'image/png' });
    expect(stored[2]).toBe('tiny');
    // The log line stays small; the blob holds the bytes.
    expect(readFileSync(join(home, 'chats', 'b', 'events.jsonl'), 'utf8').length).toBeLessThan(
      4000,
    );
    const back = makeLog(home)
      .readEvents('b')
      .map((e) => (e.event as { result: unknown }).result);
    expect(back).toEqual(results);
  });

  it('drops a harness re-send within one turn, by dedupe key', () => {
    const home = tmp('chatlog-dedupe-');
    const log = makeLog(home);
    log.beginTurn('d', 'T1');
    expect(appendEvent(log, 'd', msg('d', 0, 'once'), { dedupeKey: 'claude:u-1:x' })).toBe(true);
    expect(appendEvent(log, 'd', msg('d', 1, 'once'), { dedupeKey: 'claude:u-1:x' })).toBe(false);
    log.endTurn('d');
    log.beginTurn('d', 'T2');
    expect(appendEvent(log, 'd', msg('d', 2, 'once'), { dedupeKey: 'claude:u-1:x' })).toBe(true);
    log.closeAll();
    expect(
      lines(home, 'd')
        .filter((r) => r.rec.k === 'event')
        .map((r) => r.seq),
    ).toEqual([0, 2]);
  });

  it('fsyncs at once only for the records that must not be lost, and batches the rest', async () => {
    const home = tmp('chatlog-fsync-');
    const kinds: string[] = [];
    let lastWritten = '';
    const spyFs: Partial<ChatLogFs> = {
      writeSync: ((fd: number, buf: unknown, ...rest: unknown[]) => {
        if (Buffer.isBuffer(buf)) {
          const rec = JSON.parse(buf.toString('utf8')) as LogRecord;
          lastWritten =
            rec.rec.k === 'event'
              ? `event:${(rec.rec.event as { role?: string }).role ?? rec.rec.event.type}`
              : rec.rec.k;
        }
        return (fs.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest);
      }) as ChatLogFs['writeSync'],
      fsyncSync: ((fd: number) => {
        kinds.push(lastWritten);
        fs.fsyncSync(fd);
      }) as ChatLogFs['fsyncSync'],
    };
    const log = makeLog(home, { fs: spyFs, fsyncBatchMs: 20 });
    const b = { branchId: 'f-b0' };
    appendEvent(log, 'f', msg('f', log.allocate('f', 0, 'f-b0'), 'hi', 'user'), { sync: true });
    appendEvent(log, 'f', msg('f', log.allocate('f', 0, 'f-b0'), 'reply'));
    log.append('f', { k: 'thinking', text: 'hmm' }, b);
    expect(kinds).toEqual(['log.start', 'event:user']);
    await new Promise((r) => setTimeout(r, 60));
    expect(kinds).toEqual(['log.start', 'event:user', 'thinking']); // the batch timer
    log.append(
      'f',
      { k: 'session', harness: 'claude', model: null, sessionId: 'S', reason: 'start' },
      { ...b, sync: true },
    );
    log.append(
      'f',
      { k: 'permission.decision', requestId: 'r', decision: 'approve', by: 'user' },
      { ...b, sync: true },
    );
    log.append('f', { k: 'turn.end', outcome: 'completed' }, { ...b, sync: true });
    expect(kinds.slice(3)).toEqual(['session', 'permission.decision', 'turn.end']);
    log.append('f', { k: 'permission.mode', mode: 'plan' }, b);
    log.closeAll(); // shutdown fsyncs what the timer has not reached
    expect(kinds.slice(6)).toEqual(['permission.mode']);
  });

  it('seeks through the sparse index without missing a reply finalised after later seqs', () => {
    const home = tmp('chatlog-index-');
    const log = makeLog(home);
    for (let i = 0; i < 600; i++) {
      if (i === 300) {
        const reserved = log.allocate('x', 0, 'x-b0');
        log.reserve('x', reserved, 'x-b0');
        for (let j = 0; j < 300; j++)
          appendEvent(log, 'x', msg('x', log.allocate('x', 0, 'x-b0'), `after ${j}`));
        appendEvent(log, 'x', msg('x', reserved, 'streamed reply'));
      }
      appendEvent(log, 'x', msg('x', log.allocate('x', 0, 'x-b0'), `m${i}`));
    }
    log.closeAll();
    const reader = makeLog(home);
    const from = reader.readEvents('x', 300).map((e) => e.record.seq);
    expect(from).toContain(300); // the reserved seq, written ~300 records later
    expect(Math.min(...from)).toBe(300);
    expect(new Set(from).size).toBe(from.length);
    expect(from.length).toBe(901 - 300);
  });
});

// ---------------------------------------------------------------------------
// The host writing it

function makeDaemon(
  home: string,
  sdk = createMockSdkBackend(),
  extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {},
) {
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    ...extra,
  });
  return { daemon, sdk, events };
}

describe('Host → history log', () => {
  it('writes turn.start, the user message, session, replies and turn.end for a turn', async () => {
    const home = tmp('chatlog-daemon-');
    const folder = tmp('chatlog-daemon-folder-');
    const { daemon, sdk } = makeDaemon(home);
    sdk.enqueue([
      { type: 'system', sessionId: 'S1' },
      { type: 'system', thinking: 'let me think', nativeId: 'u-think' },
      { type: 'assistant', content: 'the answer', nativeId: 'u-1' },
      {
        type: 'result',
        sessionId: 'S1',
        raw: { type: 'result', usage: { input_tokens: 3 }, total_cost_usd: 0.01 },
      },
    ]);
    await daemon.spawnChat({ folder, chatId: 'dc' });
    await daemon.sendInput({ chatId: 'dc', message: 'question', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    daemon.shutdown();
    const recs = lines(home, 'dc');
    expect(
      recs.map((r) =>
        r.rec.k === 'event' ? `event:${(r.rec.event as { role: string }).role}` : r.rec.k,
      ),
    ).toEqual([
      'log.start',
      'turn.start',
      'event:user',
      'session',
      'thinking',
      'event:assistant',
      'turn.end',
    ]);
    const start = recs[1]!.rec as { localId?: string; origin: string };
    expect(start).toMatchObject({
      k: 'turn.start',
      harness: 'claude',
      origin: 'user',
      localId: 'L1',
    });
    expect(recs[3]!.rec).toMatchObject({ k: 'session', sessionId: 'S1', reason: 'start' });
    expect(recs[5]!.nativeRef).toEqual({ harness: 'claude', sessionId: 'S1', id: 'u-1' });
    expect(recs[6]!.rec).toEqual({
      k: 'turn.end',
      outcome: 'completed',
      usage: { input_tokens: 3, totalCostUsd: 0.01 },
    });
    // One turn id on every record of the turn.
    const turnIds = new Set(recs.slice(1).map((r) => r.turnId));
    expect(turnIds.size).toBe(1);
    expect([...turnIds][0]).toBeTruthy();
  });

  it('remembers accepted localIds across a restart; the restart re-send still runs under its original id', async () => {
    const home = tmp('chatlog-ids-');
    const folder = tmp('chatlog-ids-folder-');
    {
      const { daemon, sdk } = makeDaemon(home);
      sdk.enqueue([{ type: 'assistant', content: 'one', sessionId: 'S' }]);
      await daemon.spawnChat({ folder, chatId: 'ids' });
      await daemon.sendInput({ chatId: 'ids', message: 'first', localId: 'L-first' });
      await new Promise((r) => setTimeout(r, 20));
      daemon.shutdown();
    }
    // A surface redelivers L-first after the restart: re-acked, not re-run.
    {
      const { daemon, sdk, events } = makeDaemon(home);
      daemon.hydrate();
      await daemon.sendInput({ chatId: 'ids', message: 'first', localId: 'L-first' });
      expect(sdk.lastOptions()).toBeUndefined();
      expect(events.filter((e) => e.type === 'chat.input_ack')).toHaveLength(1);
      daemon.shutdown();
    }
    // The previous host died mid-turn on L-second: its restart re-send keeps
    // the original id and must run even though the log has seen that id. The
    // backend yields its reply and then blocks forever — so the log records
    // turn.start and the reply but never turn.end, genuinely mid-turn (not
    // settled) when shutdown hits, which is what "died mid-turn" means to the
    // log a restart reads.
    {
      const heldOpen: MockSdkBackend = {
        async *run() {
          yield { type: 'assistant', content: 'two', sessionId: 'S' };
          await new Promise<void>(() => undefined);
        },
        enqueue: () => undefined,
        lastOptions: () => undefined,
      };
      const { daemon } = makeDaemon(home, heldOpen);
      daemon.hydrate();
      void daemon.sendInput({ chatId: 'ids', message: 'second', localId: 'L-second' });
      await new Promise((r) => setTimeout(r, 20));
      daemon.shutdown();
    }
    const metaStore = createMetaStore(home);
    metaStore.update('ids', (m) => ({
      ...m,
      pendingTurns: [{ message: 'second', localId: 'L-second' }],
    }));
    {
      const { daemon, sdk } = makeDaemon(home);
      // chatState is empty until hydrate; the log already knows L-second.
      sdk.enqueue([{ type: 'assistant', content: 'two again', sessionId: 'S' }]);
      daemon.hydrate();
      await new Promise((r) => setTimeout(r, 30));
      // The restart resend does not carry the original turn's own text (that's
      // already in the resumed session's history) — just the reminder + a short
      // 'Carry on' nudge. Confirms the resend actually reached the SDK.
      expect(sdk.lastOptions()?.prompt).toContain('Carry on');
      daemon.shutdown();
    }
    const starts = lines(home, 'ids').filter((r) => r.rec.k === 'turn.start');
    expect(starts.map((r) => (r.rec as { localId?: string }).localId)).toEqual([
      'L-first',
      'L-second',
      'L-second',
    ]);
  });

  it('fails the turn loudly with history_write_failed when an append fails — and does not show what it could not record', async () => {
    const home = tmp('chatlog-fail-');
    const folder = tmp('chatlog-fail-folder-');
    const failing: Partial<ChatLogFs> = {
      writeSync: ((fd: number, buf: unknown, ...rest: unknown[]) => {
        if (Buffer.isBuffer(buf) && buf.toString('utf8').includes('unrecordable')) {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        return (fs.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest);
      }) as ChatLogFs['writeSync'],
    };
    const metaStore = createMetaStore(home);
    const chatLog = new ChatLog({
      chatDir: (id) => join(home, 'chats', id),
      blobsDir: join(home, 'blobs'),
      logger: silent,
      now: () => Date.now(),
      fs: failing,
    });
    const { daemon, sdk, events } = makeDaemon(home, createMockSdkBackend(), {
      metaStore,
      chatLog,
    });
    sdk.enqueue([
      { type: 'assistant', content: 'unrecordable reply', sessionId: 'S' },
      { type: 'assistant', content: 'after it', sessionId: 'S' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go', chatId: 'fail' });
    await new Promise((r) => setTimeout(r, 30));
    const shown = events
      .filter((e) => e.type === 'chat.message')
      .map((e) => (e as { content: string }).content);
    expect(shown).toEqual(['go']);
    const err = events.find((e) => e.type === 'chat.error') as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe('history_write_failed');
    expect(err.error.message).toMatch(/ENOSPC/);
    expect(daemon.chatState.get('fail')?.activity).toBe('errored');
    expect(metaStore.read('fail')?.lastError?.code).toBe('history_write_failed');
    // Replayed later, the failure must be flagged so a surface draws an error
    // card rather than a paragraph that reads as the model talking.
    const replayed: Array<{ type: string; error?: true; content?: string }> = [];
    daemon.replayChat('fail', -1, (e) => replayed.push(e as never));
    const failed = replayed.find(
      (e) => e.type === 'chat.message' && /turn failed/i.test(e.content ?? ''),
    );
    expect(failed?.error).toBe(true);
    daemon.shutdown();
    const end = lines(home, 'fail').filter((r) => r.rec.k === 'turn.end');
    expect(end.map((r) => r.rec)).toEqual([
      {
        k: 'turn.end',
        outcome: 'failed',
        error: { code: 'history_write_failed', message: expect.stringMatching(/ENOSPC/) },
      },
    ]);
  });

  it('says so in the chat when the log it reopens had a torn tail', async () => {
    const home = tmp('chatlog-torn-daemon-');
    const folder = tmp('chatlog-torn-daemon-folder-');
    {
      const { daemon, sdk } = makeDaemon(home);
      sdk.enqueue([{ type: 'assistant', content: 'fine', sessionId: 'S' }]);
      await daemon.spawnChat({ folder, prompt: 'go', chatId: 'torn' });
      await new Promise((r) => setTimeout(r, 20));
      daemon.shutdown();
    }
    const path = join(home, 'chats', 'torn', 'events.jsonl');
    fs.appendFileSync(path, '{"v":1,"seq":9,"at":1,"bra');
    const { daemon, events } = makeDaemon(home);
    daemon.hydrate();
    const note = events.find((e) => e.type === 'chat.message') as {
      role: string;
      content: string;
      seq: number;
    };
    expect(note.role).toBe('system');
    expect(note.content).toMatch(/unclean shutdown/);
    expect((note as { error?: true }).error).toBe(true);
    daemon.shutdown();
    const last = lines(home, 'torn')
      .filter((r) => r.rec.k === 'event')
      .at(-1)!;
    expect((last.rec as { event: { content: string } }).event.content).toMatch(/unclean shutdown/);
    expect(last.seq).toBe(note.seq);
    mkdirSync(folder, { recursive: true });
  });
});
