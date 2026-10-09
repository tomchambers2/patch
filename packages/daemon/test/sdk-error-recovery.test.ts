// Recovery from SDK failures that used to end a chat silently.
//
// On 2026-08-26 nine queued app-update jobs were lost: each spawned chat threw
// "You've hit your limit · resets 5pm (UTC)" on its first turn, the rate-limit
// detector did not recognise that wording, and the generic error path dropped
// the turn. The tasks were left with no label, no comment and no worker, and
// nothing noticed for two days. These tests cover the three holes that made
// that possible.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;

/** A backend whose first run throws `errMsg`; later runs replay `after`. */
function throwingOnce(errMsg: string, after: SdkEnvelope[] = []): SdkBackend {
  let calls = 0;
  return {
    async *run() {
      calls++;
      if (calls === 1) throw new Error(errMsg);
      for (const ev of after) yield ev;
    },
  };
}

/** A backend that never succeeds, and counts how often it was asked to. */
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

function resumingAt(events: WireEvent[], chatId: string): number | null {
  const paused = events.find(
    (e) =>
      e.type === 'chat.state' &&
      (e as { chatId: string }).chatId === chatId &&
      (e as { rateLimitResumingAt?: number | null }).rateLimitResumingAt != null,
  ) as { rateLimitResumingAt: number } | undefined;
  return paused?.rateLimitResumingAt ?? null;
}

// The exact string the SDK threw on 2026-08-26, copied from the host log.
const REAL_LIMIT = "Claude Code returned an error result: You've hit your limit · resets 5pm (UTC)";

describe('a usage limit phrased as prose is still a usage limit', () => {
  it('arms an auto-resume instead of discarding the turn', async () => {
    const { daemon, folder, events } = makeDaemon(
      throwingOnce(REAL_LIMIT, [
        { type: 'assistant', content: 'resumed' },
        { type: 'result', sessionId: 's1' },
      ] as SdkEnvelope[]),
      'prose',
    );
    daemon.setAutoResumeRateLimit(true);
    const chatId = await daemon.spawnChat({ folder, prompt: 'do the task' });
    await new Promise((r) => setTimeout(r, 40));

    expect(resumingAt(events, chatId)).toBeGreaterThan(NOW);
    // Parked, not dead — but shown as errored, never as a finished turn.
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    daemon.shutdown();
  });

  it('is recognised however the limit is worded', async () => {
    const wordings = [REAL_LIMIT, 'API Error: 429 usage_limit_exceeded', 'Usage limit reached'];
    for (const [i, msg] of wordings.entries()) {
      const { daemon, folder, events } = makeDaemon(throwingOnce(msg), `word${i}`);
      daemon.setAutoResumeRateLimit(true);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 40));
      expect(resumingAt(events, chatId), msg).toBeGreaterThan(NOW);
      daemon.shutdown();
    }
  });
});

describe('a transient SDK error is retried, not dropped', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-sends the turn after the first backoff step and the chat recovers', async () => {
    const { daemon, folder } = makeDaemon(
      throwingOnce('socket hang up', [
        { type: 'assistant', content: 'second time lucky' },
        { type: 'result', sessionId: 's2' },
      ] as SdkEnvelope[]),
      'retry',
    );
    const chatId = await daemon.spawnChat({ folder, prompt: 'flaky' });
    await vi.advanceTimersByTimeAsync(100);
    // The failure is still reported — surfaces must see it.
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');

    // First ladder step is 10s; the retry then lands on its own.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    daemon.shutdown();
  });

  it('gives up after the ladder rather than retrying forever', async () => {
    const { backend, calls } = alwaysThrows('ECONNRESET');
    const { daemon, folder } = makeDaemon(backend, 'giveup');
    const chatId = await daemon.spawnChat({ folder, prompt: 'never works' });
    await vi.advanceTimersByTimeAsync(100);
    // Walk the whole ladder (10s + 30s + 90s) and well past the end of it.
    await vi.advanceTimersByTimeAsync(400_000);
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    // One original attempt plus three retries, and no more however long we wait.
    expect(calls()).toBe(4);
    daemon.shutdown();
  });

  // spec/09 § A turn that failed — the server notifies on the edge into
  // `errored`, so each such frame has to say whether the ladder will go again.
  it('marks every rung but the last as retrying on the frame that errors', async () => {
    const { backend } = alwaysThrows('ECONNRESET');
    const { daemon, folder, events } = makeDaemon(backend, 'retrying');
    const chatId = await daemon.spawnChat({ folder, prompt: 'never works' });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(400_000);
    const edges: (boolean | undefined)[] = [];
    let prev: string | undefined;
    for (const e of events) {
      if (e.type !== 'chat.state' || e.chatId !== chatId) continue;
      if (e.activity === 'errored' && prev !== 'errored') edges.push(e.turnRetrying);
      prev = e.activity;
    }
    expect(edges).toEqual([true, true, true, false]);
    daemon.shutdown();
  });
});

describe('why a chat died survives the host that killed it', () => {
  it('persists lastError for a generic sdk_error, not just an invalid session', async () => {
    const { daemon, folder, metaStore } = makeDaemon(throwingOnce('kaboom'), 'persist');
    const chatId = await daemon.spawnChat({ folder, prompt: 'boom' });
    await new Promise((r) => setTimeout(r, 40));
    daemon.shutdown();

    // Read it back the way a restarted host would.
    const meta = metaStore.read(chatId);
    expect(meta?.lastError?.code).toBe('sdk_error');
    expect(meta?.lastError?.message).toContain('kaboom');
  });
});

describe('a restart mid-wait does not lose the turn', () => {
  it('persists a turn parked for a rate-limit reset, so the next host resumes it', async () => {
    // A 5-hour limit parks a turn for hours; every deploy restarts the host
    // inside that window. The timer dies with the process — meta.json is what
    // the next host reads, so the park has to be written there too.
    const { daemon, folder, metaStore } = makeDaemon(throwingOnce(REAL_LIMIT), 'park');
    daemon.setAutoResumeRateLimit(true);
    const chatId = await daemon.spawnChat({ folder, prompt: 'owed work' });
    await new Promise((r) => setTimeout(r, 40));

    const meta = metaStore.read(chatId);
    expect(meta?.pendingTurns?.map((t) => t.message)).toContain('owed work');
    daemon.shutdown();
  });

  it('persists a turn parked between backoff steps too', async () => {
    const { daemon, folder, metaStore } = makeDaemon(throwingOnce('socket hang up'), 'parkb');
    const chatId = await daemon.spawnChat({ folder, prompt: 'retry me' });
    await new Promise((r) => setTimeout(r, 40));

    const meta = metaStore.read(chatId);
    expect(meta?.pendingTurns?.map((t) => t.message)).toContain('retry me');
    daemon.shutdown();
  });

  it('stops owing the turn once it has been re-sent', async () => {
    const { daemon, folder, metaStore } = makeDaemon(
      throwingOnce('socket hang up', [
        { type: 'assistant', content: 'ok now' },
        { type: 'result', sessionId: 's3' },
      ] as SdkEnvelope[]),
      'unpark',
    );
    const chatId = await daemon.spawnChat({ folder, prompt: 'transient' });
    await new Promise((r) => setTimeout(r, 40));
    expect(metaStore.read(chatId)?.pendingTurns?.length).toBe(1);

    // Let the 10s first rung fire for real.
    await new Promise((r) => setTimeout(r, 10_500));
    expect(metaStore.read(chatId)?.pendingTurns ?? []).toHaveLength(0);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    daemon.shutdown();
  }, 20_000);
});
