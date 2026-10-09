// Unit tests for the durable self-wake scheduler (spec/02 § Self-wake), with a
// virtual clock + injected timers so firing is deterministic.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import { WakeScheduler, parseDelayMs, WAKE_PREFIX, type WakeRecord } from '../src/wake.js';

// Mirrors the private `MAX_TIMEOUT_MS` in src/wake.ts (setTimeout's signed
// 32-bit ms ceiling, ~24.8 days) — not exported, so duplicated here to drive
// the long-horizon chunked re-arm path.
const MAX_TIMEOUT_MS = 2_147_483_000;

const silent = pino({ level: 'silent' });

function harness() {
  let now = 1_000_000;
  let nextId = 1;
  const timers: { id: number; cb: () => void; at: number }[] = [];
  const setTimer = (cb: () => void, ms: number): number => {
    const id = nextId++;
    timers.push({ id, cb, at: now + ms });
    return id;
  };
  const clearTimer = (id: number): void => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const root = mkdtempSync(join(tmpdir(), 'patch-wake-'));
  const chatDirs = new Map<string, string>();
  const dirForChat = (chatId: string): string => {
    let d = chatDirs.get(chatId);
    if (!d) {
      d = join(root, chatId);
      mkdirSync(d, { recursive: true });
      chatDirs.set(chatId, d);
    }
    return d;
  };
  const delivered: Array<{ chatId: string; message: string }> = [];
  let busy = false;
  const deps = {
    deliver: (chatId: string, message: string) => {
      delivered.push({ chatId, message });
    },
    dirForChat,
    allChatIds: () => [...chatDirs.keys()],
    isBusy: () => busy,
    now: () => now,
    logger: silent,
    setTimer,
    clearTimer,
  };
  const sched = new WakeScheduler(deps);
  // Advance virtual time, firing any due timers in chronological order.
  async function advance(ms: number): Promise<void> {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const t = due[0]!;
      clearTimer(t.id);
      t.cb();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
  const at = (ms: number): number => now + ms;
  const setBusy = (v: boolean): void => {
    busy = v;
  };
  return {
    sched,
    deps,
    delivered,
    advance,
    at,
    dirForChat,
    getNow: () => now,
    root,
    chatDirs,
    setBusy,
  };
}

function rec(chatId: string, fireAt: number, extra: Partial<WakeRecord> = {}): WakeRecord {
  return { chatId, message: `nag ${chatId}`, fireAt, createdAt: 0, ...extra };
}

describe('WakeScheduler', () => {
  it('fires a scheduled wake at its time, prefixed, exactly once', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000)));
    await h.advance(9_000);
    expect(h.delivered).toHaveLength(0); // not yet
    await h.advance(2_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} nag c1` }]);
    // One-shot: the file is cleared, no second fire.
    await h.advance(60_000);
    expect(h.delivered).toHaveLength(1);
    expect(existsSync(join(h.dirForChat('c1'), 'wake.json'))).toBe(false);
  });

  it('re-scheduling REPLACES the pending wake (the loop)', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000), { message: 'first' }));
    h.sched.schedule(rec('c1', h.at(5_000), { message: 'second' }));
    await h.advance(6_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} second` }]);
    // The replaced (10s) timer must NOT also fire.
    await h.advance(10_000);
    expect(h.delivered).toHaveLength(1);
  });

  it('cancel disarms a pending wake before it fires', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000)));
    expect(h.sched.cancel('c1')).toBe(true);
    await h.advance(60_000);
    expect(h.delivered).toHaveLength(0);
    expect(h.sched.cancel('c1')).toBe(false); // nothing left
  });

  it('persists to wake.json and survives a restart (re-arm future)', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(20_000), { message: 'persisted' }));
    const onDisk = JSON.parse(readFileSync(join(h.dirForChat('c1'), 'wake.json'), 'utf8'));
    expect(onDisk.message).toBe('persisted');
    // Simulate a restart: a fresh scheduler over the SAME dirs reloads + arms.
    const fresh = new WakeScheduler(h.deps);
    fresh.loadAll();
    await h.advance(21_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} persisted` }]);
  });

  it('fires an OVERDUE wake once on boot (downtime catch-up)', async () => {
    const h = harness();
    // fireAt already in the past relative to now.
    h.sched.schedule(rec('c1', h.getNow() - 5_000, { message: 'overdue' }));
    // schedule() armed it with delay 0 → it fires on the next advance; but also
    // assert loadAll on a fresh instance fires it immediately.
    const fresh = new WakeScheduler(h.deps);
    fresh.loadAll();
    await h.advance(0);
    expect(h.delivered.some((d) => d.message === `${WAKE_PREFIX} overdue`)).toBe(true);
  });

  it('drops a wake whose notAfter has passed (does not fire)', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000), { notAfter: h.at(5_000), message: 'stale' }));
    await h.advance(11_000); // fire time reached, but past notAfter
    expect(h.delivered).toHaveLength(0);
    expect(existsSync(join(h.dirForChat('c1'), 'wake.json'))).toBe(false);
  });

  // A fireAt beyond setTimeout's signed-32-bit ms ceiling must re-arm in
  // MAX_TIMEOUT_MS-sized chunks rather than overflow into an (effectively
  // immediate) negative/truncated timeout.
  it('re-arms in chunks for a wake beyond the 32-bit setTimeout ceiling', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(MAX_TIMEOUT_MS + 10_000), { message: 'far future' }));
    // First chunk elapses: `arm` re-calls itself with the remaining delay —
    // must NOT have fired yet.
    await h.advance(MAX_TIMEOUT_MS);
    expect(h.delivered).toHaveLength(0);
    // The remaining (now sub-ceiling) delay fires normally.
    await h.advance(10_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} far future` }]);
  });

  it('logs (and swallows) a delivery failure instead of crashing, still one-shot', async () => {
    const h = harness();
    const errors: unknown[] = [];
    const failingLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (obj: unknown) => errors.push(obj),
    } as unknown as Logger;
    const failingSched = new WakeScheduler({
      ...h.deps,
      logger: failingLogger,
      deliver: () => {
        throw new Error('deliver boom');
      },
    });
    failingSched.schedule(rec('c-fail', h.at(1_000), { message: 'will fail' }));
    await h.advance(1_000);
    expect(errors).toHaveLength(1);
    // One-shot semantics hold even when delivery throws: file is cleared.
    expect(existsSync(join(h.dirForChat('c-fail'), 'wake.json'))).toBe(false);
  });

  it('drops a corrupt wake.json (unparseable / schema-invalid) instead of throwing', async () => {
    const h = harness();
    const dir = h.dirForChat('c-corrupt');
    writeFileSync(join(dir, 'wake.json'), 'not valid json {{{', 'utf8');
    const warnings: unknown[] = [];
    const warningLogger = {
      info: () => undefined,
      warn: (obj: unknown) => warnings.push(obj),
      error: () => undefined,
    } as unknown as Logger;
    const corruptSched = new WakeScheduler({ ...h.deps, logger: warningLogger });
    expect(corruptSched.peek('c-corrupt')).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(existsSync(join(dir, 'wake.json'))).toBe(false);
  });

  it('drops a wake with a passed notAfter when loading on boot (loadAll path)', async () => {
    const h = harness();
    const dir = h.dirForChat('c-boot-stale');
    // fireAt is still in the future — only notAfter has passed — so this
    // isolates loadAll's OWN notAfter guard from the fire()-time one (already
    // covered above), which would never be reached if loadAll didn't drop it
    // first.
    const staleRecord: WakeRecord = {
      chatId: 'c-boot-stale',
      message: 'stale-on-boot',
      fireAt: h.at(50_000),
      notAfter: h.getNow() - 1,
      createdAt: 0,
    };
    writeFileSync(join(dir, 'wake.json'), JSON.stringify(staleRecord), 'utf8');
    const fresh = new WakeScheduler(h.deps);
    fresh.loadAll();
    expect(existsSync(join(dir, 'wake.json'))).toBe(false);
    await h.advance(100_000);
    expect(h.delivered).toHaveLength(0);
  });

  it('loadAll skips chatIds with no persisted wake (read() returns null)', async () => {
    const h = harness();
    // Registered on disk (a known chat dir) but never scheduled — no wake.json.
    h.dirForChat('c-no-wake');
    h.sched.schedule(rec('c1', h.at(5_000), { message: 'still fires' }));
    const fresh = new WakeScheduler(h.deps);
    // Must not throw when a chatId has nothing to read.
    expect(() => fresh.loadAll()).not.toThrow();
    await h.advance(5_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} still fires` }]);
  });

  it('a recurring wake (`every` set) RE-ARMS on fire instead of clearing (the loop)', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000), { message: 'check the build', every: 10_000 }));
    await h.advance(10_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} check the build` }]);
    // Unlike a one-shot, the record survives the fire — re-persisted with a
    // fresh fireAt — so the file is NOT cleared.
    const onDisk = JSON.parse(readFileSync(join(h.dirForChat('c1'), 'wake.json'), 'utf8'));
    expect(onDisk.every).toBe(10_000);
    expect(onDisk.fireAt).toBe(h.getNow() + 10_000);
    expect(h.sched.peek('c1')).not.toBeNull();
    // It fires again on the next interval, mechanically, with no agent
    // re-arming it in between.
    await h.advance(10_000);
    expect(h.delivered).toHaveLength(2);
    await h.advance(10_000);
    expect(h.delivered).toHaveLength(3);
    expect(h.delivered.every((d) => d.message === `${WAKE_PREFIX} check the build`)).toBe(true);
  });

  it('a recurring wake keeps looping even when a delivery throws (mechanically guaranteed)', async () => {
    const h = harness();
    const errors: unknown[] = [];
    const failingLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (obj: unknown) => errors.push(obj),
    } as unknown as Logger;
    let calls = 0;
    const loopingSched = new WakeScheduler({
      ...h.deps,
      logger: failingLogger,
      deliver: (chatId, message) => {
        calls++;
        h.delivered.push({ chatId, message });
        if (calls === 1) throw new Error('deliver boom');
      },
    });
    loopingSched.schedule(rec('c-loop', h.at(5_000), { message: 'nag', every: 5_000 }));
    await h.advance(5_000);
    expect(errors).toHaveLength(1); // the first delivery's throw was caught + logged
    // The loop is still armed despite the throw — re-armed BEFORE delivering.
    expect(loopingSched.peek('c-loop')).not.toBeNull();
    await h.advance(5_000);
    expect(calls).toBe(2);
    expect(h.delivered).toHaveLength(2);
  });

  it('a recurring wake respects notAfter — stops looping once a fire would land past it', async () => {
    const h = harness();
    h.sched.schedule(
      rec('c1', h.at(5_000), { message: 'nag', every: 5_000, notAfter: h.at(7_000) }),
    );
    await h.advance(5_000); // fires within notAfter, re-arms for +5s (now past notAfter)
    expect(h.delivered).toHaveLength(1);
    await h.advance(5_000); // this fire would land past notAfter -> dropped
    expect(h.delivered).toHaveLength(1);
    expect(h.sched.peek('c1')).toBeNull();
  });

  it('cancel() stops a recurring wake just like a one-shot', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(5_000), { message: 'nag', every: 5_000 }));
    expect(h.sched.cancel('c1')).toBe(true);
    await h.advance(60_000);
    expect(h.delivered).toHaveLength(0);
  });

  it('a recurring wake survives a simulated host restart mid-loop', async () => {
    // Mirrors "persists to wake.json and survives a restart (re-arm future)"
    // above, but for the recurring case: a fresh scheduler over the SAME
    // on-disk record must not just re-arm the current tick, it must keep
    // re-arming every tick after — the loop itself has to survive the
    // restart, not just the single wake it happened to be mid-flight on.
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000), { message: 'mid-loop', every: 10_000 }));
    // "Crash": dispose the original scheduler's in-memory timer (a real crash
    // takes the whole process's timers with it) — wake.json remains on disk.
    h.sched.dispose();
    const onDiskBefore = JSON.parse(readFileSync(join(h.dirForChat('c1'), 'wake.json'), 'utf8'));
    expect(onDiskBefore.every).toBe(10_000);

    // Fresh scheduler over the same dirs reloads + re-arms from disk.
    const fresh = new WakeScheduler(h.deps);
    fresh.loadAll();
    await h.advance(10_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} mid-loop` }]);
    // The loop continues past the restart point — a SECOND tick still fires,
    // proving loadAll() re-armed the RECURRING record, not a one-shot copy.
    await h.advance(10_000);
    expect(h.delivered).toHaveLength(2);
    expect(fresh.peek('c1')).not.toBeNull();
  });

  it('an OVERDUE recurring wake catches up once on boot, then resumes its normal cadence', async () => {
    const h = harness();
    // fireAt already passed (long downtime) — catch-up fires once, and the
    // NEXT fireAt is computed from now + every, not backfilled per missed tick.
    h.sched.schedule(rec('c1', h.getNow() - 60_000, { message: 'overdue loop', every: 10_000 }));
    h.sched.dispose(); // "crash" — no dangling timer from the pre-restart scheduler
    const fresh = new WakeScheduler(h.deps);
    fresh.loadAll();
    await h.advance(0);
    expect(h.delivered.some((d) => d.message === `${WAKE_PREFIX} overdue loop`)).toBe(true);
    expect(h.delivered).toHaveLength(1); // exactly one catch-up fire, not one per missed interval
    await h.advance(10_000);
    expect(h.delivered).toHaveLength(2);
  });

  // spec/02 § Self-wake — "count the interval from the end of the turn": a
  // loop tick due while the chat is busy is absorbed (marked `waiting`), not
  // delivered — `WakeScheduler` itself has no notion of "turn", only of
  // `deps.isBusy`, so these drive that dependency directly.
  it('a loop tick due while the chat is busy is absorbed, not delivered — marked `waiting` instead', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000), { message: 'check it', every: 10_000 }));
    h.setBusy(true);
    await h.advance(10_000);
    expect(h.delivered).toHaveLength(0); // absorbed, not delivered
    const onDisk = JSON.parse(readFileSync(join(h.dirForChat('c1'), 'wake.json'), 'utf8'));
    expect(onDisk.waiting).toBe(true);
    expect(onDisk.every).toBe(10_000); // the loop itself is untouched, just paused
  });

  it('a busy loop tick arms no further timer — staying busy for many intervals absorbs just the one tick', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000), { message: 'check it', every: 10_000 }));
    h.setBusy(true);
    await h.advance(10_000); // first tick lands busy -> absorbed, no timer re-armed
    expect(h.delivered).toHaveLength(0);
    // No stacking: staying busy through several more would-be intervals does
    // not produce extra absorbed/queued copies — there is nothing left armed
    // to even fire again until `onTurnEnd` re-arms it.
    await h.advance(30_000);
    expect(h.delivered).toHaveLength(0);
    expect(h.sched.peek('c1')?.waiting).toBe(true);
  });

  it('onTurnEnd arms the next fireAt from NOW for a waiting loop, counted from the end of the turn', async () => {
    const h = harness();
    h.sched.schedule(rec('c1', h.at(10_000), { message: 'check it', every: 10_000 }));
    h.setBusy(true);
    await h.advance(10_000); // absorbed while busy
    expect(h.delivered).toHaveLength(0);

    h.setBusy(false);
    const turnEndAt = h.getNow();
    const rearmed = h.sched.onTurnEnd('c1');
    expect(rearmed).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(h.dirForChat('c1'), 'wake.json'), 'utf8'));
    expect(onDisk.waiting).toBeUndefined();
    expect(onDisk.fireAt).toBe(turnEndAt + 10_000); // from the end of the turn, not the original tick

    // Nothing lands before the fresh interval elapses...
    await h.advance(9_000);
    expect(h.delivered).toHaveLength(0);
    // ...and exactly one delivery lands once it does — no catch-up stacking
    // for the tick that was absorbed while busy.
    await h.advance(1_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} check it` }]);
  });

  it('onTurnEnd is a no-op for a chat with no wake, a one-shot wake, or a loop that is not waiting', () => {
    const h = harness();
    // No wake at all.
    expect(h.sched.onTurnEnd('c-none')).toBe(false);
    // A one-shot wake — unaffected by turn-end (one-shots just queue, per
    // existing behaviour; only `every` loops change).
    h.sched.schedule(rec('c-oneshot', h.at(10_000)));
    expect(h.sched.onTurnEnd('c-oneshot')).toBe(false);
    expect(h.sched.peek('c-oneshot')?.fireAt).toBe(h.at(10_000));
    // A loop that is counting down normally (never collided) — not waiting,
    // so its already-armed timer is left alone.
    h.sched.schedule(rec('c-loop', h.at(10_000), { every: 10_000 }));
    expect(h.sched.onTurnEnd('c-loop')).toBe(false);
    expect(h.sched.peek('c-loop')?.fireAt).toBe(h.at(10_000));
  });

  it('a loop found `waiting` on disk re-arms fresh on boot, instead of staying stuck or redelivering', async () => {
    // Simulates a host that crashed mid-turn with an absorbed tick still
    // marked `waiting` on disk — from the fresh process's point of view that
    // turn is over, so boot itself is what ends it (02-daemon.md § Self-wake,
    // "a waiting loop re-arms on boot").
    const h = harness();
    const dir = h.dirForChat('c1');
    const stale: WakeRecord = {
      chatId: 'c1',
      message: 'check it',
      fireAt: h.getNow() - 60_000, // stale — the absorbed tick, long past
      createdAt: 0,
      every: 10_000,
      waiting: true,
    };
    writeFileSync(join(dir, 'wake.json'), JSON.stringify(stale), 'utf8');

    const fresh = new WakeScheduler(h.deps);
    fresh.loadAll();
    // Re-armed fresh from boot time, NOT redelivered for the stale tick.
    expect(h.delivered).toHaveLength(0);
    const onDisk = JSON.parse(readFileSync(join(dir, 'wake.json'), 'utf8'));
    expect(onDisk.waiting).toBeUndefined();
    expect(onDisk.fireAt).toBe(h.getNow() + 10_000);

    await h.advance(10_000);
    expect(h.delivered).toEqual([{ chatId: 'c1', message: `${WAKE_PREFIX} check it` }]);
  });

  it('schedule() creates the chat dir itself when it does not already exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-wake-nodir-'));
    // Unlike the shared harness, this dirForChat does NOT pre-create the dir —
    // isolating `schedule()`'s own `existsSync(dir) || mkdirSync(dir)` guard.
    const dirForChat = (chatId: string): string => join(root, chatId);
    const sched = new WakeScheduler({
      deliver: () => undefined,
      dirForChat,
      allChatIds: () => [],
      isBusy: () => false,
      now: () => 1_000_000,
      logger: silent,
    });
    const dir = dirForChat('c-fresh');
    expect(existsSync(dir)).toBe(false);
    sched.schedule(rec('c-fresh', 1_010_000));
    expect(existsSync(join(dir, 'wake.json'))).toBe(true);
  });
});

describe('parseDelayMs', () => {
  it('parses compact, ISO, and bare-seconds forms', () => {
    expect(parseDelayMs('10m')).toBe(600_000);
    expect(parseDelayMs('90s')).toBe(90_000);
    expect(parseDelayMs('2h')).toBe(7_200_000);
    expect(parseDelayMs('1h30m')).toBe(5_400_000);
    expect(parseDelayMs('PT10M')).toBe(600_000);
    expect(parseDelayMs('PT1H30M')).toBe(5_400_000);
    // Seconds-only ISO form: exercises the `iso[1] ?? iso[2] ?? iso[3]` chain
    // all the way to its last fallback (hours/minutes both absent).
    expect(parseDelayMs('PT45S')).toBe(45_000);
    expect(parseDelayMs(45)).toBe(45_000);
    expect(parseDelayMs('600')).toBe(600_000);
  });
  it('throws on garbage (no silent fallback)', () => {
    expect(() => parseDelayMs('soon')).toThrow();
    expect(() => parseDelayMs('')).toThrow();
    expect(() => parseDelayMs(-5)).toThrow();
  });
});
