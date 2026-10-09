// readTrack: parent-cut-plus-own-records (spec/04 § Branching).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { LoggedEvent } from '@patch/wire';
import { ChatLog } from '../src/chatLog.js';
import { readTrack } from '../src/readTrack.js';
import type { ChatMeta } from '../src/meta.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'patch-readtrack-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeLog(home: string): ChatLog {
  return new ChatLog({
    chatDir: (id) => join(home, 'chats', id),
    blobsDir: join(home, 'blobs'),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
}

function msg(
  chatId: string,
  seq: number,
  content: string,
  role: 'user' | 'assistant' = 'assistant',
): LoggedEvent {
  return { type: 'chat.message', chatId, role, content, seq };
}

describe('readTrack', () => {
  it('returns every record on a chat with no branches (a synthesized single root)', () => {
    const home = tmp();
    const log = makeLog(home);
    const chatId = 'chat-1';
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 0, 'hi', 'user') },
      { branchId: 'chat-1-b0', seq: 0 },
    );
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 1, 'hello') },
      { branchId: 'chat-1-b0', seq: 1 },
    );
    const meta: ChatMeta = {
      chatId,
      folder: '/x',
      name: null,
      nextSeq: 2,
      createdAt: 1,
      updatedAt: 1,
    };
    const track = readTrack(log, chatId, meta, 'chat-1-b0');
    expect(track.map((t) => t.event)).toEqual([
      msg(chatId, 0, 'hi', 'user'),
      msg(chatId, 1, 'hello'),
    ]);
  });

  it('an edit fork REPLACES the edited message: the parent keeps its own, the fork gets its own new one', () => {
    const home = tmp();
    const log = makeLog(home);
    const chatId = 'chat-2';
    // Parent (b0): seq 0 (the question being edited), seq 1 (original reply).
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 0, 'question', 'user') },
      { branchId: 'chat-2-b0', seq: 0 },
    );
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 1, 'original answer') },
      { branchId: 'chat-2-b0', seq: 1 },
    );
    // Fork (b1), editing seq 0: its own rephrased question + its own reply.
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 2, 'question, rephrased', 'user') },
      { branchId: 'chat-2-b1', seq: 2 },
    );
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 3, 'forked answer') },
      { branchId: 'chat-2-b1', seq: 3 },
    );

    const meta: ChatMeta = {
      chatId,
      folder: '/x',
      name: null,
      nextSeq: 4,
      createdAt: 1,
      updatedAt: 1,
      activeBranchId: 'chat-2-b1',
      branches: [
        {
          branchId: 'chat-2-b0',
          parentBranchId: null,
          forkFromSeq: null,
          label: 'main',
          createdAt: 1,
        },
        {
          branchId: 'chat-2-b1',
          parentBranchId: 'chat-2-b0',
          forkFromSeq: 0,
          label: 'edit 1',
          createdAt: 2,
        },
      ],
    };

    const forkTrack = readTrack(log, chatId, meta, 'chat-2-b1');
    // NONE of the parent's records: seq 0 is the edited message (replaced by
    // the fork's own seq 2), and seq 1 (the parent's own answer to it) never
    // belonged to this track either.
    expect(forkTrack.map((t) => t.record.seq)).toEqual([2, 3]);
    expect(forkTrack.map((t) => (t.event as { content: string }).content)).toEqual([
      'question, rephrased',
      'forked answer',
    ]);

    const mainTrack = readTrack(log, chatId, meta, 'chat-2-b0');
    expect(mainTrack.map((t) => t.record.seq)).toEqual([0, 1]);
  });

  it('a side thread SHARES the anchor message with its parent, unlike an edit fork', () => {
    const home = tmp();
    const log = makeLog(home);
    const chatId = 'chat-side';
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 0, 'question', 'user') },
      { branchId: 'b0', seq: 0 },
    );
    log.append(chatId, { k: 'event', event: msg(chatId, 1, 'answer') }, { branchId: 'b0', seq: 1 });
    // A side thread hung off the answer (seq 1): its own follow-up question.
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 2, 'a side question', 'user') },
      { branchId: 'b1', seq: 2 },
    );

    const meta: ChatMeta = {
      chatId,
      folder: '/x',
      name: null,
      nextSeq: 3,
      createdAt: 1,
      updatedAt: 1,
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
        {
          branchId: 'b1',
          parentBranchId: 'b0',
          forkFromSeq: 1,
          label: 'side 1',
          createdAt: 2,
          sideThread: true,
        },
      ],
    };

    const sideTrack = readTrack(log, chatId, meta, 'b1');
    // Includes the anchor (seq 1) it hangs off, unlike an edit fork.
    expect(sideTrack.map((t) => t.record.seq)).toEqual([0, 1, 2]);
  });

  it('a two-level fork chain includes each ancestor only up to (excluding) its own fork point', () => {
    const home = tmp();
    const log = makeLog(home);
    const chatId = 'chat-3';
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 0, 'a', 'user') },
      { branchId: 'b0', seq: 0 },
    );
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 1, 'b', 'user') },
      { branchId: 'b0', seq: 1 },
    );
    log.append(chatId, { k: 'event', event: msg(chatId, 2, 'c') }, { branchId: 'b0', seq: 2 });
    // b1 edits seq 1 ('b'): keeps 'a', replaces 'b'/'c' with its own seq 3.
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 3, 'd', 'user') },
      { branchId: 'b1', seq: 3 },
    );
    // b2 forks from b1 at seq 3 (keeps 'a', drops b1's own 'd', edited again).
    log.append(chatId, { k: 'event', event: msg(chatId, 4, 'e') }, { branchId: 'b2', seq: 4 });

    const meta: ChatMeta = {
      chatId,
      folder: '/x',
      name: null,
      nextSeq: 5,
      createdAt: 1,
      updatedAt: 1,
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
        { branchId: 'b1', parentBranchId: 'b0', forkFromSeq: 1, label: 'edit 1', createdAt: 2 },
        { branchId: 'b2', parentBranchId: 'b1', forkFromSeq: 3, label: 'edit 2', createdAt: 3 },
      ],
    };

    const track = readTrack(log, chatId, meta, 'b2');
    // b0 contributes only seq 0 ('a' — below b1's own fork point at seq 1,
    // exclusive); b1 contributes NOTHING (its own seq 3 is what b2 edited);
    // b2 contributes its own seq 4.
    expect(track.map((t) => t.record.seq)).toEqual([0, 4]);
  });

  it('honours fromSeq exclusively, same as chat.replay', () => {
    const home = tmp();
    const log = makeLog(home);
    const chatId = 'chat-4';
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 0, 'a', 'user') },
      { branchId: 'chat-4-b0', seq: 0 },
    );
    log.append(
      chatId,
      { k: 'event', event: msg(chatId, 1, 'b') },
      { branchId: 'chat-4-b0', seq: 1 },
    );
    const meta: ChatMeta = {
      chatId,
      folder: '/x',
      name: null,
      nextSeq: 2,
      createdAt: 1,
      updatedAt: 1,
    };
    const track = readTrack(log, chatId, meta, 'chat-4-b0', 0);
    expect(track.map((t) => t.record.seq)).toEqual([1]);
  });
});
