// spec/12 § A turn is owed until it settles — a re-sent turn NAMES the bubble
// it already has.
//
// The host re-sends an owed turn itself: `resumeInterruptedTurns` replays
// `pendingTurns` after a restart (every deploy does one), and the SDK-error
// ladder re-enters `sendInput` on 10s/30s/90s. Both go through `runQuery`, which
// emits a fresh user `chat.message` at a fresh seq — so before this, one
// question that recovered twice reached the surfaces as three identical user
// messages. Tom photographed exactly that: "the human message shouldnt be
// repeated."
//
// `retryOfSeq` carries the ORIGINAL user message's seq on every attempt, so a
// surface folds the copy into the bubble already on screen. These cover the
// producer half: that the field is emitted, that it names the ORIGINAL rather
// than the rung before it, and that it survives a reload (Claude Code's
// transcript records each attempt as an ordinary user turn and knows nothing
// about the link, so the host keeps it in the chat's own meta).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;

/** A backend that throws `errMsg` every time, counting the attempts. */
function alwaysThrows(errMsg: string): { backend: SdkBackend; calls: () => number } {
  let calls = 0;
  return {
    backend: {
      async *run() {
        calls++;
        throw new Error(errMsg);
      },
    },
    calls: () => calls,
  };
}

function makeDaemon(backend: SdkBackend, tag: string) {
  const home = mkdtempSync(join(tmpdir(), `patch-${tag}-`));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `patch-${tag}-f-`)));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: `d-${tag}`,
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW,
    generateChatId: () => `chat-${tag}-${++id}`,
  });
  return { daemon, folder, events, metaStore };
}

function userMessages(events: WireEvent[], chatId: string): ChatMessageEvent[] {
  return events.filter(
    (e): e is ChatMessageEvent =>
      e.type === 'chat.message' && e.chatId === chatId && e.role === 'user',
  );
}

describe('the SDK-error ladder anchors every rung on the ORIGINAL turn', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits one user message per attempt, each naming the first one', async () => {
    const { backend, calls } = alwaysThrows('ECONNRESET');
    const { daemon, folder, events } = makeDaemon(backend, 'anchor');
    const chatId = await daemon.spawnChat({ folder, prompt: 'check rons messages' });
    await vi.advanceTimersByTimeAsync(100);
    // Walk the whole ladder (10s + 30s + 90s) and past the end of it.
    await vi.advanceTimersByTimeAsync(400_000);
    expect(calls()).toBe(4);

    const msgs = userMessages(events, chatId);
    expect(msgs).toHaveLength(4);
    // The first is the turn itself and names nothing — there is no earlier
    // bubble for it to fold into.
    expect(msgs[0]?.retryOfSeq).toBeUndefined();
    const original = msgs[0]!.seq;
    // Every rung after it names the ORIGINAL, never the rung before it. A chain
    // (each naming its predecessor) would still fold, but only if every
    // intermediate frame arrived — one dropped rung and the tail detaches into
    // a bubble of its own.
    expect(msgs.slice(1).map((m) => m.retryOfSeq)).toEqual([original, original, original]);
    daemon.shutdown();
  });
});

describe('a restart resume names the bubble the dead host drew', () => {
  it('re-sends with retryOfSeq once the interrupted turn had a message on the wire', async () => {
    // A turn is recorded as in-flight BEFORE the SDK runs it, which is BEFORE
    // its `chat.message` has taken a seq — so the crash marker has to be
    // re-written once the message lands. Without that re-write, the commonest
    // case of all (a deploy killing a live turn) resumes with no anchor and
    // draws the second bubble anyway.
    const gate: { release: () => void } = { release: () => {} };
    const held = new Promise<void>((r) => {
      gate.release = r;
    });
    const backend: SdkBackend = {
      async *run() {
        await held;
      },
    };
    const { daemon, folder, events, metaStore } = makeDaemon(backend, 'resume');
    const chatId = await daemon.spawnChat({ folder, prompt: 'owed work' });
    await new Promise((r) => setTimeout(r, 50));

    const original = userMessages(events, chatId)[0]!.seq;
    const pending = metaStore.read(chatId)?.pendingTurns ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.retryOfSeq).toBe(original);
    gate.release();
    daemon.shutdown();
  });
});

describe('the link survives a reload', () => {
  it('records a retry mark so replay can put retryOfSeq back on', async () => {
    // Claude Code persists each re-sent prompt as an ordinary user turn with no
    // idea it repeats an earlier one, so on a reload the fold would come apart
    // and the duplicate would be back — on refresh only, which is worse than
    // never folding at all.
    const { backend } = alwaysThrows('ECONNRESET');
    const { daemon, folder, events, metaStore } = makeDaemon(backend, 'marks');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const chatId = await daemon.spawnChat({ folder, prompt: 'check rons messages' });
    await vi.advanceTimersByTimeAsync(400_000);
    const msgs = userMessages(events, chatId);
    const original = msgs[0]!.seq;

    expect(metaStore.read(chatId)?.retryMarks).toEqual(
      msgs.slice(1).map((m) => ({ seq: m.seq, retryOfSeq: original })),
    );
    vi.useRealTimers();
    daemon.shutdown();
  });
});
