// A host restart kills every in-flight turn on the host, and the last thing
// every deploy does is restart the host. Before this, that work simply stopped:
// the server resolved the chat to `errored` / `daemon_unavailable` and waited
// for a human. It is this that lets that error say "Connection to the host was
// lost. Message will resend." instead of asking the user to resend it.
//
// So the pump mirrors what the chat still owes the agent into meta.json
// (`pendingTurns`), and `hydrate` puts it back.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, INTERRUPTED_TURN_REMINDER, interruptedTurnResend } from '../src/chatRunner.js';
import { createMetaStore, type MetaStore } from '../src/meta.js';
import { createMockSdkBackend, TurnFailedError, type SdkBackend } from '../src/sdkBackend.js';

/** What the head turn 'running' is re-sent as. */
const RESENT = interruptedTurnResend(INTERRUPTED_TURN_REMINDER, 'running');

const silent = pino({ level: 'silent' });

/** A backend whose turns block until released — holds a turn in `running`. */
function gatedBackend() {
  const gates: Array<() => void> = [];
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  return {
    backend,
    prompts,
    releaseNext: (): void => void gates.shift()?.(),
    /**
     * Run the pump dry. Releasing the gates that exist right now only frees the
     * turn in the SDK — the one that drains in behind it registers a gate of its
     * own — so releasing has to be repeated until nothing new appears.
     */
    drain: async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        while (gates.length > 0) gates.shift()?.();
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  };
}

/**
 * A host over `home`. Restarting is modelled as building a SECOND host over
 * the SAME patch home — which is exactly what systemd does on `restart`: the
 * process is replaced, ~/.patch is not.
 */
function daemonOver(home: string, backend: SdkBackend) {
  const events: WireEvent[] = [];
  let id = 0;
  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, metaStore };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-resume-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rfolder-')));
  mkdirSync(folder, { recursive: true });
  return { home, folder };
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

const pendingOf = (metaStore: MetaStore, chatId: string) =>
  metaStore.read(chatId)?.pendingTurns ?? [];

/** Spawn a chat and settle one turn, so it has a resumable claudeSessionId. */
async function chatWithHistory(daemon: Daemon, folder: string, g: ReturnType<typeof gatedBackend>) {
  const chatId = await daemon.spawnChat({ folder });
  void daemon.sendInput({ chatId, message: 'first', localId: 'L0' });
  await tick();
  g.releaseNext();
  await tick();
  return chatId;
}

describe('resuming turns a host restart interrupted', () => {
  it('records the running turn and everything queued behind it, in order', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const { daemon, metaStore } = daemonOver(home, g.backend);
    const chatId = await chatWithHistory(daemon, folder, g);

    // A settled chat owes nothing.
    expect(pendingOf(metaStore, chatId)).toEqual([]);

    void daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'queued-a', localId: 'L2' });
    void daemon.sendInput({ chatId, message: 'queued-b', localId: 'L3' });
    await tick();

    // Head is the turn actually in the SDK; the rest are its queue, in arrival
    // order — i.e. exactly what a kill right now would destroy.
    // The head also carries `retryOfSeq` — the seq of the user bubble it is
    // ALREADY drawn as on every surface (spec/12 § A turn is owed until it
    // settles). Without it the resume below re-sends a message every surface
    // already has and draws it a second time, which is the duplicate-bubble
    // bug. The queued two have never run, so they have no bubble to name.
    expect(pendingOf(metaStore, chatId)).toEqual([
      { message: 'running', localId: 'L1', retryOfSeq: 2 },
      { message: 'queued-a', localId: 'L2' },
      { message: 'queued-b', localId: 'L3' },
    ]);

    await g.drain();
    expect(pendingOf(metaStore, chatId)).toEqual([]);
  });

  // Tom, live: a restart sometimes seemed to reprompt a conversation that had
  // already finished. The log's own `turn.end` is fsynced durably the moment
  // the turn settles, but `persistPendingTurns` — the meta.json rewrite that
  // would clear the now-stale head entry — is a SEPARATE write straight after
  // it, with nothing atomic tying the two together. A process killed in that
  // gap (a hard kill, not the graceful path above) leaves the log correctly
  // showing the turn as `completed` while meta.json still calls it owed.
  it('does not resend a pendingTurns head the chat log already shows settled', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const { daemon, metaStore } = daemonOver(home, g.backend);
    const chatId = await chatWithHistory(daemon, folder, g);

    void daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    g.releaseNext();
    await tick();
    // The turn genuinely completed — nothing owed, exactly like any other
    // settled turn.
    expect(pendingOf(metaStore, chatId)).toEqual([]);

    // Simulate the exact race: a process killed between the log's own
    // turn.end (already durable) and the meta.json rewrite that would have
    // cleared this. Force the stale head back the way that kill would leave it.
    metaStore.update(chatId, (m) => ({
      ...m,
      pendingTurns: [{ message: 'running', localId: 'L1', retryOfSeq: 2 }],
    }));

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // The chat's own transcript already has this turn's full reply — resending
    // it as "Carry on" would reprompt a finished conversation, so nothing goes
    // out, and the stale marker is cleared rather than repeatedly retried.
    expect(g2.prompts).toEqual([]);
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
  });

  // A turn parked for a stated rate limit closes its failed attempt with
  // outcome `failed`, never `completed`/`stopped` — the settled-head check
  // above must not mistake "legitimately still owed, waiting on a retry" for
  // "already finished".
  it('still resumes a turn parked for a stated rate limit across a restart', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    const RESETS_AT = 1_700_000_000_000 + 3_600_000;
    const rateLimited: SdkBackend = {
      run: async function* (): AsyncGenerator<never> {
        throw new TurnFailedError('rate limited', {
          kind: 'rate_limit',
          status: 'rejected',
          rateLimitType: 'seven_day',
          resetsAt: RESETS_AT,
        });
      },
    };
    const first = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: rateLimited,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-1',
      accountLimitInfo: () => ({ label: 'Default', scope: 'week' as const, resetsAt: RESETS_AT }),
    });
    const chatId = await first.spawnChat({ folder });
    await first.sendInput({ chatId, message: 'go', localId: 'L1' });
    expect(pendingOf(metaStore, chatId).length).toBe(1);
    first.shutdown();

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // Still owed: a `failed` close is not a settlement, so it resends like any
    // other interrupted turn (same head treatment a genuinely cut-off turn
    // gets — pendingTurns does not distinguish parked from running).
    expect(g2.prompts).toEqual([interruptedTurnResend(INTERRUPTED_TURN_REMINDER, 'go')]);
    await g2.drain();
  });

  it('a cancelled queued turn stops being owed', async () => {
    const g = gatedBackend();
    const { home, folder } = setup();
    const { daemon, metaStore } = daemonOver(home, g.backend);
    const chatId = await chatWithHistory(daemon, folder, g);

    void daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'doomed', localId: 'L2' });
    await tick();
    daemon.unqueueInput(chatId, 'L2');

    expect(pendingOf(metaStore, chatId)).toEqual([
      { message: 'running', localId: 'L1', retryOfSeq: 2 },
    ]);
  });

  it('hydrate re-sends the interrupted turns, telling the agent to continue', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = daemonOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);

    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    void first.daemon.sendInput({ chatId, message: 'queued-a', localId: 'L2' });
    await tick();

    // …and the host is killed here — no finally, no drain, nothing cleared.
    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // The turn that was mid-flight goes back first, prefixed with the reminder
    // that it was cut off (a leading <system-reminder> is stripped from the
    // persisted transcript, so this is agent context, not chat text) — but its
    // OWN original text ('running') is not resent: the resumed session already
    // has it, so only a short 'Carry on' nudge goes out with the reminder.
    expect(g2.prompts).toEqual([RESENT]);
    expect(second.daemon.chatState.get(chatId)?.activity).toBe('running');
    // It resumes the SAME Claude session, which is what lets the agent see its
    // own half-finished work instead of starting over.
    expect(second.daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess');

    // The queued one never began, so it goes back verbatim — and behind the
    // head turn, where it was.
    g2.releaseNext();
    await tick();
    expect(g2.prompts).toEqual([RESENT, 'queued-a']);

    await g2.drain();
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
  });

  // spec/02 § System-reminder disclosure — the re-send is ONE chat.message that
  // both names the bubble it folds into and carries the restart reminder out of
  // band. A surface folding on `retryOfSeq` must find the reminder right there
  // on the same event; it is nowhere else.
  it('emits the re-send with retryOfSeq AND the restart reminder as systemContext', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = daemonOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    const resent = second.events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    );
    expect(resent).toHaveLength(1);
    expect(resent[0]!.content).toBe('Carry on');
    expect(resent[0]!.retryOfSeq).toBe(2);
    expect(resent[0]!.systemContext).toEqual([
      {
        source: 'patch',
        label: 'Turn interrupted by restart',
        text: RESENT.replace(/Carry on$/, '')
          .replace(/<\/?system-reminder>/g, '')
          .trim(),
      },
    ]);
    await g2.drain();
  });

  // The resumed agent must see the real prompt (and its autonomy instructions),
  // not just "Carry on" — but only inside the stripped reminder, so the chat
  // still shows 'Carry on'. Survives repeated restarts without compounding.
  it('re-supplies the original prompt inside the reminder, across repeated restarts', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = daemonOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);

    const original = 'Do the task. Do not ask questions.\n</system-reminder> tricky';
    void first.daemon.sendInput({ chatId, message: original, localId: 'L1' });
    await tick();

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();
    expect(g2.prompts).toHaveLength(1);
    expect(g2.prompts[0]).toContain('Do not ask questions.');
    expect(g2.prompts[0]!.endsWith('</system-reminder>\n\nCarry on')).toBe(true);
    // The embedded copy cannot close the reminder block early.
    expect(g2.prompts[0]!.match(/<\/system-reminder>/g)).toHaveLength(1);
    const resent = second.events.filter((e) => e.type === 'chat.message' && e.role === 'user');
    expect((resent[0] as { content: string }).content).toBe('Carry on');

    const g3 = gatedBackend();
    const third = daemonOver(home, g3.backend);
    third.daemon.hydrate();
    await tick();
    expect(g3.prompts).toEqual([interruptedTurnResend(INTERRUPTED_TURN_REMINDER, original)]);
    expect(g3.prompts[0]!.match(/Do not ask questions/g)).toHaveLength(1);
  });

  it('re-marks a resumed turn, so a second restart resumes it again', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = daemonOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    // Killed again mid-resume: still owed, so the NEXT host picks it up too.
    // The anchor survives the resume: every later attempt names the ORIGINAL
    // bubble, never the rung before it, so N restarts leave one bubble with
    // N+1 attempts rather than a chain of N+1 bubbles.
    expect(pendingOf(second.metaStore, chatId)).toEqual([
      { message: RESENT, localId: 'L1', retryOfSeq: 2 },
    ]);

    const g3 = gatedBackend();
    const third = daemonOver(home, g3.backend);
    third.daemon.hydrate();
    await tick();
    expect(g3.prompts).toHaveLength(1);
  });

  it('drops the interrupted turns of a chat that was deleted meanwhile', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = daemonOver(home, g1.backend);
    const chatId = await chatWithHistory(first.daemon, folder, g1);
    void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
    await tick();
    await first.daemon.setDeleted(chatId, true);

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual([]);
    expect(pendingOf(second.metaStore, chatId)).toEqual([]);
  });

  it('a chat that was idle at the restart is not given a turn it never had', async () => {
    const g1 = gatedBackend();
    const { home, folder } = setup();
    const first = daemonOver(home, g1.backend);
    await chatWithHistory(first.daemon, folder, g1);

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toEqual([]);
  });
});

// pendingDecisions.ts: a permission/AskUserQuestion blocks the turn inside the
// SDK's canUseTool callback via an in-memory Promise (permissionGates) that
// cannot survive a restart — unlike the `gatedBackend()` cases above, which
// model an ordinary in-flight turn, this models the host dying while
// blocked on a HUMAN decision specifically, which is a much longer and more
// common wait (up to the 1h approval timeout, or unbounded for a question with
// expiry turned off) than a turn merely mid-tool-execution.
describe('a turn cut off while awaiting a permission/question decision', () => {
  it('tells the resumed agent what it had asked, and clears the persisted record', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    let id = 0;
    const first = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      permissionModeDefault: 'plan',
    });
    const chatId = await first.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    expect(first.chatState.get(chatId)?.activity).toBe('awaiting-permission');

    const chatDir = dirname(metaStore.pathFor(chatId));
    const decisionsFile = join(chatDir, 'pending-decisions.json');
    expect(existsSync(decisionsFile)).toBe(true);

    // Killed here — no answer was ever given, exactly the case
    // INTERRUPTED_TURN_REMINDER alone leaves the agent blind to.
    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();

    expect(g2.prompts).toHaveLength(1);
    const resent = g2.prompts[0]!;
    // Names what was actually asked (the mock's [[bash-permission]] trigger's
    // own description), not just "you were cut off".
    expect(resent).toContain('Run: echo hi');
    expect(resent).toContain('no answer was recorded');
    expect(resent).toContain('Do NOT assume it was approved');

    // spec/02 § System-reminder disclosure — the surface gets that same block
    // out of band on the re-send's chat.message, labelled as the
    // pending-decision variant, and never inlined into the bubble's text.
    const resentMsgs = second.events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    );
    expect(resentMsgs).toHaveLength(1);
    expect(resentMsgs[0]!.content).not.toContain('<system-reminder>');
    expect(resentMsgs[0]!.content).not.toContain('Run: echo hi');
    expect(resentMsgs[0]!.systemContext).toEqual([
      {
        source: 'patch',
        label: 'Turn interrupted by restart (pending decision)',
        text: expect.stringContaining('Run: echo hi'),
      },
    ]);
    await g2.drain();

    // Folded into the resumed turn's context now, so the on-disk copy would
    // only mislead a LATER restart into repeating context already delivered.
    expect(existsSync(decisionsFile)).toBe(false);
  });

  it('a decision answered before the restart leaves nothing to resume specially', async () => {
    const { home, folder } = setup();
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    let id = 0;
    const first = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      permissionModeDefault: 'plan',
    });
    const chatId = await first.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    const req = events.find((e) => e.type === 'chat.permission_request') as
      | { requestId: string }
      | undefined;
    expect(req).toBeDefined();
    first.submitPermissionResponse({ requestId: req!.requestId, decision: 'approve' });
    await tick();

    // Answered and settled in the SAME process — the ordinary, overwhelmingly
    // common case. Nothing should be left on disk for a restart to trip over.
    const chatDir = dirname(metaStore.pathFor(chatId));
    expect(existsSync(join(chatDir, 'pending-decisions.json'))).toBe(false);

    const g2 = gatedBackend();
    const second = daemonOver(home, g2.backend);
    second.daemon.hydrate();
    await tick();
    expect(g2.prompts).toEqual([]);
  });

  // Patch's own log is the record; the provider session is only a cache of it.
  // A restart must hand the model the whole conversation whether or not a native
  // session survives — not a contextless session that sees only "Carry on".
  describe('rebuilds the model context from the chat log', () => {
    type Opts = Parameters<SdkBackend['run']>[0];

    /** Records every run's options and holds each turn open until released. */
    function recordingBackend(sessionId: string | null) {
      const gates: Array<() => void> = [];
      const runs: Opts[] = [];
      const backend: SdkBackend = {
        async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
          runs.push(opts);
          await new Promise<void>((resolve) => gates.push(resolve));
          if (sessionId) yield { type: 'result', sessionId };
          yield {
            type: 'assistant',
            content: `reply:${opts.prompt}`,
            ...(sessionId ? { sessionId } : {}),
          };
        },
      };
      return {
        backend,
        runs,
        release: (): void => void gates.shift()?.(),
        drain: async (): Promise<void> => {
          for (let i = 0; i < 10; i++) {
            while (gates.length > 0) gates.shift()?.();
            await tick();
          }
        },
      };
    }

    const reseedOf = (o: Opts) =>
      (o.claudeSessionStore?.reseed?.events ?? []).filter(
        (t) => t.event.type === 'chat.message',
      ) as Array<{ event: { role: string; content: string } }>;
    const reseededTexts = (o: Opts): string[] => reseedOf(o).map((t) => t.event.content);

    function daemonWith(home: string, backend: SdkBackend, extra: Record<string, unknown> = {}) {
      const metaStore = createMetaStore(home);
      let id = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'fake-token',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-${++id}`,
        ...extra,
      } as ConstructorParameters<typeof Daemon>[0]);
      return { daemon, metaStore };
    }

    it('first-turn interruption: the provider never returned a session id, yet the original prompt is seeded', async () => {
      const r1 = recordingBackend(null);
      const { home, folder } = setup();
      const first = daemonWith(home, r1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({
        chatId,
        message: 'Autonomous job. Do not ask questions.',
        localId: 'L1',
      });
      await tick();
      expect(first.daemon.chatState.get(chatId)?.claudeSessionId).toBeUndefined();

      const r2 = recordingBackend('sess-2');
      const second = daemonWith(home, r2.backend);
      second.daemon.hydrate();
      await tick();

      expect(r2.runs).toHaveLength(1);
      expect(r2.runs[0]!.prompt.endsWith('Carry on')).toBe(true);
      expect(r2.runs[0]!.resumeSessionId).toBeTruthy();
      expect(reseededTexts(r2.runs[0]!)).toEqual(['Autonomous job. Do not ask questions.']);
      await r2.drain();
    });

    it('repeated reboot: every restart carries the full history, before and after an id exists', async () => {
      const r1 = recordingBackend(null);
      const { home, folder } = setup();
      const first = daemonWith(home, r1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({ chatId, message: 'original ask', localId: 'L1' });
      await tick();

      // Reboot 1 (no id yet), killed again before the provider answers.
      const r2 = recordingBackend(null);
      daemonWith(home, r2.backend).daemon.hydrate();
      await tick();
      expect(reseededTexts(r2.runs[0]!)).toEqual(['original ask']);

      // Reboot 2: the log now also holds the first resend.
      const r3 = recordingBackend('sess-3');
      daemonWith(home, r3.backend).daemon.hydrate();
      await tick();
      expect(r3.runs).toHaveLength(1);
      expect(reseededTexts(r3.runs[0]!)[0]).toBe('original ask');
      expect(r3.runs[0]!.prompt).toContain('original ask');
      expect(r3.runs[0]!.prompt.match(/<\/system-reminder>/g)).toHaveLength(1);
      await r3.drain();

      // Reboot 3, after a session id was captured and the turn settled: a plain
      // resume with nothing pending reseeds nothing.
      const r4 = recordingBackend('sess-3');
      daemonWith(home, r4.backend).daemon.hydrate();
      await tick();
      expect(r4.runs).toEqual([]);
    });

    it('missing native transcript: a session id with no transcript on disk is rebuilt from the log', async () => {
      const g1 = recordingBackend('sess-old');
      const { home, folder } = setup();
      const first = daemonWith(home, g1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({ chatId, message: 'turn one', localId: 'L0' });
      await tick();
      g1.release();
      await tick();
      void first.daemon.sendInput({ chatId, message: 'turn two', localId: 'L1' });
      await tick();
      expect(first.daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-old');

      // 'real' kind: sess-old has no <id>.jsonl under the claude projects dir.
      const g2 = recordingBackend('sess-new');
      const second = daemonWith(home, g2.backend, { sdkBackendKind: 'real' });
      second.daemon.hydrate();
      await tick();

      expect(g2.runs).toHaveLength(1);
      expect(g2.runs[0]!.resumeSessionId).not.toBe('sess-old');
      const texts = reseededTexts(g2.runs[0]!);
      expect(texts).toContain('turn one');
      expect(texts).toContain('reply:turn one');
      expect(texts).toContain('turn two');
      await g2.drain();
    });

    it('provider switch: a restart onto a Codex model rebuilds the Codex thread from the same log', async () => {
      const g1 = recordingBackend('sess-claude');
      const { home, folder } = setup();
      const first = daemonWith(home, g1.backend);
      const chatId = await first.daemon.spawnChat({ folder });
      void first.daemon.sendInput({ chatId, message: 'turn one', localId: 'L0' });
      await tick();
      g1.release();
      await tick();
      void first.daemon.sendInput({ chatId, message: 'turn two', localId: 'L1' });
      await tick();
      // The model moved to another provider while the host was down.
      first.metaStore.update(chatId, (m) => ({ ...m, model: 'openai/gpt-5.5' }));

      const g2 = recordingBackend(null);
      const second = daemonWith(home, g2.backend, {
        knownModelIds: undefined,
      });
      second.daemon.hydrate();
      await tick();

      expect(g2.runs).toHaveLength(1);
      const events = (g2.runs[0]!.codexReseed ?? g2.runs[0]!.codexAppendItems)?.events ?? [];
      const texts = events
        .filter((t) => t.event.type === 'chat.message')
        .map((t) => (t.event as { content: string }).content);
      expect(texts).toContain('turn one');
      expect(texts).toContain('turn two');
      await g2.drain();
    });
  });
});
