// spec/12 § A usage or rate limit — only a reset the provider STATED reaches
// the notice.
//
// When nothing states one, auto-resume still has to pick some instant to wake
// up on, and it invents a minute. That instant was being published as the
// limit's `resetsAt` too, so the countdown promised a reset the limit had never
// mentioned — and sixty seconds later the notice degraded to "It should be back
// now" over an account that was in fact spent for days. Observed live: a chat
// parked at 19:47 on a monthly spend limit resetting Sep 15, telling the reader
// it was over at 19:48.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { LimitFacts, SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const STATED_RESET = NOW + 3 * 3_600_000;
/** `FALLBACK_DELAY_MS` — the minute auto-resume invents when told nothing. */
const INVENTED = NOW + 60_000;

/** A limit stated as prose only, with no reset instant anywhere in it. */
const NO_RESET_SENTENCE =
  'Claude Code returned an error result: You have hit your usage limit for this account.';

function alwaysFails(err: () => Error): SdkBackend {
  return {
    run: (): AsyncGenerator<SdkEnvelope> => {
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        throw err();
      }
      return gen();
    },
  };
}

function setup(opts: { err: () => Error; accountResetsAt?: number }) {
  const home = mkdtempSync(join(tmpdir(), 'patch-limitreset-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-limitreset-f-')));
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: alwaysFails(opts.err),
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
    now: () => NOW,
    generateChatId: () => 'chat-1',
    accountLimitInfo: () => ({
      label: 'Default',
      scope: 'session' as const,
      ...(opts.accountResetsAt !== undefined ? { resetsAt: opts.accountResetsAt } : {}),
    }),
  });
  daemon.setAutoResumeRateLimit(true);
  return { daemon, events, folder };
}

const lastState = (events: WireEvent[]): ChatStateEvent | undefined =>
  events.filter((e): e is ChatStateEvent => e.type === 'chat.state').at(-1);

const stated = (facts: LimitFacts) => (): TurnFailedError =>
  new TurnFailedError(NO_RESET_SENTENCE, facts);

describe('the reset a limit notice is allowed to state', () => {
  it('states none when nothing stated one, even though a resume is armed', async () => {
    const { daemon, events, folder } = setup({ err: stated({ kind: 'rate_limit' }) });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const s = lastState(events);
    // The pause is real and the wake-up is armed for the invented minute…
    expect(s?.rateLimitResumingAt).toBe(INVENTED);
    expect(s?.resumeKind).toBe('rate_limit');
    expect(s?.limitBlock?.scope).toBe('session');
    // …but the limit itself made no promise, so the notice makes none either.
    // With no reset the surface draws no countdown at all, which is the point:
    // it can never decay into "that was N minutes ago".
    expect(s?.limitBlock?.resetsAt).toBeUndefined();
    daemon.shutdown();
  });

  it('states the one the failure carried', async () => {
    const { daemon, events, folder } = setup({
      err: stated({ kind: 'rate_limit', resetsAt: STATED_RESET }),
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const s = lastState(events);
    expect(s?.limitBlock?.resetsAt).toBe(STATED_RESET);
    // The resume is armed for it too — a stated reset is a real wait, not a
    // fallback minute.
    expect(s?.rateLimitResumingAt).toBe(STATED_RESET);
    daemon.shutdown();
  });

  it('prefers the account window’s own figure over the failure’s', async () => {
    // The window's reading beats whichever window Claude Code felt like naming.
    const accountResetsAt = NOW + 90 * 60_000;
    const { daemon, events, folder } = setup({
      err: stated({ kind: 'rate_limit', resetsAt: STATED_RESET }),
      accountResetsAt,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(lastState(events)?.limitBlock?.resetsAt).toBe(accountResetsAt);
    daemon.shutdown();
  });

  // Todoist: "patch error is wrong" — the banner read "That was 20690 days 23
  // hours ago", the signature of a `now - resetsAt` done against epoch 0. An
  // account probe reporting `resetsAt: 0` (an empty/zero Anthropic header —
  // see @patch/auth's claude-usage.test.ts) used to survive the `??` chain
  // here unchanged, because 0 is neither null nor undefined.
  it('does not treat the account window’s epoch-0 reset as a stated one', async () => {
    const { daemon, events, folder } = setup({
      err: stated({ kind: 'rate_limit', resetsAt: STATED_RESET }),
      accountResetsAt: 0,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    // Falls through to the failure's own stated reset instead of using 0.
    expect(lastState(events)?.limitBlock?.resetsAt).toBe(STATED_RESET);
    daemon.shutdown();
  });

  it('states none when the only reset offered anywhere is epoch 0', async () => {
    const { daemon, events, folder } = setup({
      err: stated({ kind: 'rate_limit' }),
      accountResetsAt: 0,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    // Same treatment as "nothing stated one" above — never `now - 0`.
    expect(lastState(events)?.limitBlock?.resetsAt).toBeUndefined();
    daemon.shutdown();
  });
});
