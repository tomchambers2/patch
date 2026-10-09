// Failover in the REAL turn path (chatRunner), not just the rotation helper.
//
// The lived failure: a chat on an account that hit its spend limit errored,
// burned three retries and stopped — while a second, funded account sat unused.
// These assert the turn actually moves and runs again.
//
// A chat has NO account (spec/10-auth.md § Backend credentials): every turn
// asks the host for a credential and the host answers with the first stored key
// that has credit. So what a failure has to name is the key the turn RAN on,
// which arrives on the credential itself — nothing is stamped on the chat.

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const SPEND_LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'your weekly limit resets 8pm (UTC)';

/**
 * A backend whose FIRST run hits the spend limit and whose later runs succeed.
 *
 * Keyed on invocation count rather than on the account: `SdkRunOptions` carries
 * the resolved OAuth token, not the account id, so the account is not visible
 * from in here. What matters is that the failure is followed by another run at
 * all — that is the failover.
 */
function backendFailingFirst(runs: { n: number }): SdkBackend {
  return {
    run: (_opts: SdkRunOptions): AsyncGenerator<SdkEnvelope> => {
      runs.n += 1;
      const first = runs.n === 1;
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        if (first) throw new Error(SPEND_LIMIT);
        yield { type: 'assistant', content: 'done', raw: {} };
        yield { type: 'result', sessionId: 'sess-1', content: 'done', raw: {} };
      }
      return gen();
    },
  };
}

function setup(opts: {
  nextAccount?: (chatId: string, spent: string | undefined, msg: string) => string | undefined;
  /** Which key the host hands this turn, as `resolveOAuth` reports it. */
  runsOn?: string;
}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-failover-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-failover-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const runs = { n: 0 };
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: backendFailingFirst(runs),
    resolveOAuth: () => ({
      ok: true as const,
      accessToken: 'tok',
      ...(opts.runsOn !== undefined ? { accountId: opts.runsOn } : {}),
    }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    ...(opts.nextAccount ? { nextAccountAfterExhausted: opts.nextAccount } : {}),
  });
  return { daemon, events, folder, metaStore, runs };
}

describe('a spent account moves the chat on and the turn runs again', () => {
  it('reports the key the turn RAN on, and re-runs the turn', async () => {
    const calls: { spent: string | undefined; msg: string }[] = [];
    const { daemon, folder, metaStore, runs } = setup({
      runsOn: 'a1',
      nextAccount: (_chatId, spent, msg) => {
        calls.push({ spent, msg });
        return 'a2';
      },
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    // Asked, and told which key ran dry — the one the host handed this turn.
    // Anything else marks a key that is fine and leaves the spent one looking
    // healthy, which is how a host with two spent keys failed over for ever.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.spent).toBe('a1');
    expect(calls[0]?.msg).toContain('spend limit');
    // The turn ran AGAIN — the failover is not a relabelling of a dead chat.
    expect(runs.n).toBeGreaterThanOrEqual(2);
    // And nothing about an account is written to the chat, in memory or on
    // disk: the next turn asks the host again, so a key that has just reset is
    // used again with nothing having to remember to move anything back.
    expect(metaStore.read(chatId)).not.toHaveProperty('accountId');
    expect(daemon.chatState.get(chatId)).not.toHaveProperty('accountId');
  });

  it('does NOT mark the chat errored — the turn is being retried, not lost', async () => {
    const { daemon, folder } = setup({ nextAccount: () => 'a2' });
    const chatId = await daemon.spawnChat({ folder, accountId: 'a1' });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(daemon.chatState.get(chatId)?.status).not.toBe('errored');
  });

  it('leaves the chat alone when no account has any credit', async () => {
    // Nothing to switch to: it must fall through to the ordinary wait, not
    // silently re-run on the same spent account forever.
    const { daemon, folder, runs } = setup({ runsOn: 'a1', nextAccount: () => undefined });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(runs.n).toBe(1);
    expect(daemon.chatState.get(chatId)?.activity).not.toBe('running');
  });

  it('gives up after ONE go on each account — it does not fail over in a loop', async () => {
    // The lived failure (2026-09-07): both of the host's accounts were spent,
    // and the rotation kept offering a2 because nothing had taught it a2 was
    // spent either. So the host read "a1 is out, move to a2" every single
    // time and re-ran the turn ~once a second for hours, spawning a fresh
    // `claude` process each go, none of which could ever succeed. A turn gets
    // one attempt per key and then waits for the reset — whatever the rotation
    // claims is available.
    let asked = 0;
    const home = mkdtempSync(join(tmpdir(), 'patch-failover-loop-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-failover-loopf-')));
    const runs = { n: 0 };
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (): AsyncGenerator<SdkEnvelope> => {
          runs.n += 1;
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            throw new Error(SPEND_LIMIT);
            yield { type: 'result', raw: {} };
          }
          return gen();
        },
      },
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => undefined,
      logger: silent,
      // A REAL clock, deliberately: the re-queued failover turn is keyed by a
      // localId stamped with `now`, so a frozen clock makes the second re-queue
      // look like a duplicate of the first and hides the loop entirely.
      now: () => Date.now(),
      generateChatId: () => 'chat-loop',
      // A rotation that has not learned a2 is spent either — exactly what the
      // real one did, because every failure was attributed to a1.
      nextAccountAfterExhausted: () => {
        asked += 1;
        return 'a2';
      },
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    // The failover re-queues the turn asynchronously, so the loop this is about
    // only shows up over time: wait until the runs stop coming rather than
    // reading the count the instant `sendInput` returns (which is 2 either way).
    let last = -1;
    for (let i = 0; i < 20 && last !== runs.n; i++) {
      last = runs.n;
      await new Promise((r) => setTimeout(r, 50));
    }
    // The original turn plus exactly one failover run. Before the fix this kept
    // climbing for as long as the process lived.
    expect(runs.n).toBe(2);
    expect(asked).toBe(2);
    expect(daemon.chatState.get(chatId)?.activity).not.toBe('running');
  });

  it("hands the host the limit's OWN reset instant, not just the sentence", async () => {
    // The reset the host records is what arms the retry for the whole machine.
    // Claude Code states it twice — as an exact epoch in `quotaLimits.resetsAt`
    // and, sometimes, as prose ("resets 8pm (UTC)") — and the host was reading
    // only the prose. A refusal that carries the structured field and no
    // sentence therefore sidelined the account with NO reset time at all, so
    // nothing was armed for its return and it stayed sidelined until someone
    // touched a credential.
    const RESETS_AT = 1_700_000_000_000 + 3 * 3_600_000;
    const home = mkdtempSync(join(tmpdir(), 'patch-failover-limit-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-failover-limitf-')));
    const seen: ({ resetsAt?: number } | undefined)[] = [];
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (): AsyncGenerator<SdkEnvelope> => {
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            throw new TurnFailedError(
              'Claude Code returned an error result: 5-hour limit reached',
              {
                kind: 'rate_limit',
                status: 'rejected',
                resetsAt: RESETS_AT,
              },
            );
            yield { type: 'result', raw: {} };
          }
          return gen();
        },
      },
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-limit',
      nextAccountAfterExhausted: (_chatId, _spent, _msg, limit) => {
        seen.push(limit);
        return undefined;
      },
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.resetsAt).toBe(RESETS_AT);
    daemon.shutdown();
  });

  it('is not consulted for a failure that is not about credit', async () => {
    // A 529 clears on the account you are already on; switching would be churn.
    let asked = 0;
    const home = mkdtempSync(join(tmpdir(), 'patch-failover-x-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-failover-xf-')));
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (): AsyncGenerator<SdkEnvelope> => {
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            throw new Error('API Error: 529 overloaded_error');
            yield { type: 'result', raw: {} };
          }
          return gen();
        },
      },
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-x',
      nextAccountAfterExhausted: () => {
        asked += 1;
        return 'a2';
      },
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(asked).toBe(0);
  });
});

describe('which account a turn ran on is said (spec/10 § Backend credentials)', () => {
  function switching(opts: { spent: boolean; until?: number }) {
    const home = mkdtempSync(join(tmpdir(), 'patch-switch-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-switch-folder-')));
    const events: WireEvent[] = [];
    const runs = { n: 0 };
    const turns: Array<{ chatId: string; preferredAccountId?: string } | undefined> = [];
    let resolved = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backendFailingFirst(runs),
      // The first turn runs on a1; the re-run, a1 being spent, on a2.
      resolveOAuth: (_model, turn) => {
        turns.push(turn);
        resolved += 1;
        return { ok: true as const, accessToken: 'tok', accountId: resolved === 1 ? 'a1' : 'a2' };
      },
      accountLabel: (_model, id) => ({ a1: 'work', a2: 'personal' })[id],
      accountSpent: (_model, id) =>
        id === 'a1' && opts.spent
          ? { spent: true, ...(opts.until ? { until: opts.until } : {}) }
          : { spent: false },
      nextAccountAfterExhausted: () => 'a2',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-1',
    });
    return { daemon, events, folder, turns };
  }

  it('a turn that moved because the last account ran out says so, once, with when it comes back', async () => {
    const { daemon, events, folder } = switching({ spent: true, until: 1_700_000_500_000 });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'chat.message' && e.accountSwitch !== undefined)).toBe(
        true,
      ),
    );
    const lines = events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.accountSwitch !== undefined,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      role: 'system',
      content: 'Switched from work to personal — work is out of credit',
      accountSwitch: { from: 'work', to: 'personal', until: 1_700_000_500_000 },
    });
  });

  it('a move that is the strategy working, not a spent account, says nothing', async () => {
    const { daemon, events, folder } = switching({ spent: false });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'chat.state' && e.account?.id === 'a2')).toBe(true),
    );
    expect(events.some((e) => e.type === 'chat.message' && e.accountSwitch !== undefined)).toBe(
      false,
    );
  });

  it('the chat’s state names the account its latest turn ran on', async () => {
    const { daemon, events, folder } = switching({ spent: true });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === 'chat.state').at(-1)).toMatchObject({
        account: { id: 'a2', label: 'personal' },
      }),
    );
  });

  it('asks for the credential with the chat and its preferred account', async () => {
    const { daemon, folder, turns } = switching({ spent: false });
    const chatId = await daemon.spawnChat({ folder, preferredAccountId: 'a2' });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(turns[0]).toEqual({ chatId, preferredAccountId: 'a2' });
  });
});
