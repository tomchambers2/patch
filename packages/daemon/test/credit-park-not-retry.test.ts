// A turn blocked on credit WAITS, and is still there when credit comes back.
//
// The lived failure, 6 Oct 2026, chat 01M3Y2GYHVQB6N1N3MV6WH6P32 ("Cadence
// Automation Integration Setup") on the Mac. Both of the host's Claude accounts
// hit their spend limit at 19:00. Claude Code said so, and said when it lifted:
//
//   You've hit your monthly spend limit · raise it at
//   claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit
//   resets 9pm (Europe/London)
//
// Nothing could read `(Europe/London)` — only `(UTC)` was parsed — so the
// account was sidelined with no reset instant, the credit retry armed nothing,
// and the turn fell through to a 60-SECOND GUESS. That guess re-ran a real turn
// against a host the host had just reported as having no credit anywhere,
// once a minute, 48 times. The 49th died with `Claude Code process exited with
// code 143` instead of a limit message, which put it on the generic retry
// ladder, which spent four attempts and left the chat errored reading that —
// with no trace that it had ever been about credit. The limit reset at 21:00
// and nothing resumed. It sat dead for thirteen hours.
//
// So: four behaviours, each of which on its own would have ended the loop.

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { isAccountExhaustedError } from '../src/accountFailover.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
// Midday, so the 9pm reset the refusal states is still ahead — a weekly limit
// whose stated hour has already passed names no day and is deliberately unread
// (see `parseLimitResetsAt`).
const NOW = Date.UTC(2023, 10, 14, 12, 0, 0);

/** The refusal as the Mac logged it — reset stated in the holder's own zone. */
const LONDON_SPEND_LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message · ' +
  'your weekly limit resets 9pm (Europe/London)';

/** The same refusal with no reset stated at all — nothing to arm a timer for. */
const NO_RESET_SPEND_LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message';

/** What the 49th re-run actually died of: a killed `claude`, saying nothing. */
const PROCESS_KILLED = 'Claude Code process exited with code 143';

function alwaysFailing(message: string, runs: { n: number }): SdkBackend {
  return {
    run: (): AsyncGenerator<SdkEnvelope> => {
      runs.n += 1;
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        throw new Error(message);
        yield { type: 'result', raw: {} };
      }
      return gen();
    },
  };
}

function setup(opts: { failWith: string; hostOutOfCredit?: boolean; autoResume?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'patch-credit-park-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-credit-park-f-')));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const runs = { n: 0 };
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: alwaysFailing(opts.failWith, runs),
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW,
    generateChatId: () => 'chat-credit',
    // Nowhere to fail over to: every key on this host is spent. This is the
    // answer the real rotation gave 48 times.
    nextAccountAfterExhausted: () => undefined,
    ...(opts.hostOutOfCredit !== undefined ? { hostOutOfCredit: () => opts.hostOutOfCredit! } : {}),
  });
  // On, as it is on the hosts this happened to — it is what the Mac's
  // "scheduling auto-resume" line comes from. The runner defaults it off, so a
  // test that left it off would exercise the no-park path instead and prove
  // nothing about the loop.
  daemon.setAutoResumeRateLimit(opts.autoResume ?? true);
  return { daemon, events, folder, metaStore, runs };
}

/** The last `chat.state` frame, which is what every surface renders from. */
function lastState(events: WireEvent[]): Extract<WireEvent, { type: 'chat.state' }> | undefined {
  return events
    .filter((e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state')
    .at(-1);
}

describe('out of credit with NO stated reset: park, do not guess a minute', () => {
  it('arms no resume at all rather than re-running in 60 seconds', async () => {
    const { daemon, events, folder, runs } = setup({ failWith: NO_RESET_SPEND_LIMIT });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    // ONE run. Before the fix a timer was armed for NOW + 60s, and the whole
    // cycle began again — each go a fresh `claude` process against a host with
    // no credit, none of which could ever succeed.
    expect(runs.n).toBe(1);
    // And nothing claims a resume time. `rateLimitResumingAt` is what draws
    // "paused — resuming at HH:MM": the 60-second fallback published itself
    // here, so every unstated limit promised to lift in a minute.
    expect(lastState(events)?.rateLimitResumingAt).toBeNull();
    daemon.shutdown();
  });

  it('still OWES the turn — parked, so credit returning runs it', async () => {
    const { daemon, folder, metaStore } = setup({ failWith: NO_RESET_SPEND_LIMIT });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    // Not retrying must not mean dropping it. The turn is on disk...
    expect(metaStore.read(chatId)?.pendingTurns?.[0]?.message).toBe('go');
    // ...and the credit-return path finds it. This is `resumeParked` in
    // `creditResume.ts`, the thing a key being added or a usage reading calls.
    expect(daemon.resumeAllRateLimited()).toBe(1);
    daemon.shutdown();
  });

  it('records the block where a RESTART can still find it', async () => {
    const { daemon, folder, metaStore } = setup({ failWith: NO_RESET_SPEND_LIMIT });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    // `armCreditRetryFromDisk` and `resumeErroredOnExhaustedAccount` re-derive
    // everything from the PERSISTED failure. The park used to write nothing to
    // disk at all, so a restart during a limit left the turn in `pendingTurns`
    // with no record of why it was owed.
    const meta = metaStore.read(chatId);
    expect(isAccountExhaustedError(String(meta?.lastError?.message))).toBe(true);
    // The chat is errored to LOOK at and `active` to LIVE: the lifecycle status
    // is what archiving and the sidebar read, and a turn still owed is not a
    // dead chat. (Asserted here because the resume path must not need it.)
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    expect(daemon.chatState.get(chatId)?.status).not.toBe('errored');
    daemon.shutdown();
  });
});

describe('a reset stated in the holder’s own zone is read, so the wait is the real one', () => {
  it('schedules the resume for the stated reset, not for a minute away', async () => {
    const { daemon, events, folder, runs } = setup({ failWith: LONDON_SPEND_LIMIT });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    expect(runs.n).toBe(1);
    const resumingAt = lastState(events)?.rateLimitResumingAt;
    // 14 Nov 2023 is GMT, so London 21:00 is 21:00Z. The point is only that it
    // is the stated hour and nowhere near the 60-second fallback.
    expect(resumingAt).toBe(Date.UTC(2023, 10, 14, 21, 0, 0));
    expect(resumingAt).toBeGreaterThan(NOW + 60_000);
    daemon.shutdown();
  });
});

describe('a failure that says nothing, on a host with no credit, is still a credit block', () => {
  it('does not go on the retry ladder', async () => {
    const { daemon, events, folder, runs } = setup({
      failWith: PROCESS_KILLED,
      hostOutOfCredit: true,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    expect(runs.n).toBe(1);
    // The ladder announces itself on the failing frame so the server knows
    // whether to notify. Three attempts 90 seconds apart cannot outlast a
    // weekly window, and the fourth failure is what the chat is left reading.
    expect(lastState(events)?.turnRetrying).not.toBe(true);
    daemon.shutdown();
  });

  it('keeps the real error AND says what patch knows, so the resume can find it', async () => {
    const { daemon, folder, metaStore } = setup({
      failWith: PROCESS_KILLED,
      hostOutOfCredit: true,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    const message = String(metaStore.read(chatId)?.lastError?.message);
    // Recognisable to the credit-return sweep, which classifies by text. THIS
    // is what was missing: the chat was left reading "Claude Code process
    // exited with code 143", so when the limit reset nothing could tell the
    // turn had ever been blocked on credit.
    expect(isAccountExhaustedError(message)).toBe(true);
    // And the real failure is preserved in full — patch does not get to replace
    // a message it has no account of, only to say what else it knows.
    expect(message).toContain(PROCESS_KILLED);
    // Parked, so there is a turn for the resume to run.
    expect(metaStore.read(chatId)?.pendingTurns?.[0]?.message).toBe('go');
    // AND THE SWEEP FINDS IT. This failure says nothing about a limit, so it
    // never reaches the rate-limit park and `resumeAllRateLimited` will never
    // see it — the ERRORED list is the only one that can rescue it, and that
    // list used to filter on a lifecycle status a credit block never sets. This
    // is the exact turn that sat dead for thirteen hours.
    expect(daemon.resumeAllRateLimited()).toBe(0);
    expect(daemon.resumeErroredOnExhaustedAccount()).toBe(1);
    daemon.shutdown();
  });

  it('leaves an ordinary blip on the ladder — a host WITH credit is unchanged', async () => {
    const { daemon, events, folder } = setup({
      failWith: PROCESS_KILLED,
      hostOutOfCredit: false,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    // Nothing about credit here, so the retry ladder is still the right answer
    // and still says so. (Its first rung is 10s; this asserts the DECISION, not
    // the wait.)
    await vi.waitFor(() => expect(lastState(events)?.turnRetrying).toBe(true));
    // And it does NOT claim the lifecycle status: the ladder is about to run the
    // turn again, so the chat is not a thing waiting to be rescued.
    expect(daemon.chatState.get(chatId)?.status).not.toBe('errored');
    daemon.shutdown();
  });

  it('parks and records it the same way with auto-resume turned OFF', async () => {
    // With auto-resume off there is no park path to fall into at all — the
    // failure goes straight to the tail that decides park-vs-ladder. A credit
    // block has to be recoverable there too, or turning the setting off turns
    // off the recovery with it.
    const { daemon, folder, metaStore, runs } = setup({
      failWith: PROCESS_KILLED,
      hostOutOfCredit: true,
      autoResume: false,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    expect(runs.n).toBe(1);
    const meta = metaStore.read(chatId);
    expect(isAccountExhaustedError(String(meta?.lastError?.message))).toBe(true);
    expect(meta?.pendingTurns?.[0]?.message).toBe('go');
    expect(daemon.resumeErroredOnExhaustedAccount()).toBe(1);
    daemon.shutdown();
  });
});
