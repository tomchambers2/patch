// spec/04 § Goals — the host half. After each turn settles on a chat with
// an active goal, `maybeEvaluateGoal` judges it via the injected
// `evaluateGoal` dependency: `not_met` resubmits with the reason as guidance,
// `met`/`impossible` clear the goal and record it on `lastGoal`, a run of
// `refused` verdicts trips the deadlock guard (and nothing else stops a goal
// early), and evaluation defers while the chat has a running `patch_watch` task.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

type GoalVerdict = {
  verdict: 'met' | 'not_met' | 'refused' | 'impossible';
  reason: string;
};
type EvaluateGoal = (input: {
  chatId: string;
  condition: string;
  transcript: string;
  turnsEvaluated: number;
  folder: string;
}) => Promise<GoalVerdict | null>;

/** A backend that replies with plain text, no tool calls, for every turn. */
function textBackend(reply = 'ok'): SdkBackend {
  return {
    async *run() {
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: reply, sessionId: 'sess' };
    },
  };
}

function setup(
  evaluateGoal: EvaluateGoal | undefined,
  opts: { backend?: SdkBackend; goalWatchPollMs?: number } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-goaleval-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-goaleval-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: opts.backend ?? textBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    ...(evaluateGoal ? { evaluateGoal } : {}),
    ...(opts.goalWatchPollMs !== undefined ? { goalWatchPollMs: opts.goalWatchPollMs } : {}),
  });
  return { daemon, folder, events };
}

describe('maybeEvaluateGoal — not_met', () => {
  it('resubmits with the evaluator reason as guidance, tagged goalTrigger, and counts the turn', async () => {
    const calls: number[] = [];
    const evaluateGoal: EvaluateGoal = async (input) => {
      calls.push(input.turnsEvaluated);
      // A goal now goes on until it is judged met, so end the loop here the way
      // a failed evaluation does: nothing is resubmitted after the first.
      return calls.length === 1 ? { verdict: 'not_met', reason: 'Tests are still red' } : null;
    };
    const { daemon, folder, events } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Get the test suite green');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(80);

    expect(calls[0]).toBe(1);
    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBe('Get the test suite green');
    expect(state?.goalProgress?.lastVerdict).toBe('not_met');
    expect(state?.goalProgress?.lastReason).toBe('Tests are still red');

    const resubmit = [...events]
      .reverse()
      .find(
        (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
          e.type === 'chat.message' && 'goalTrigger' in e && e.goalTrigger !== undefined,
      );
    expect(resubmit).toBeDefined();
    expect(resubmit?.content).toContain('Tests are still red');
    expect(resubmit?.goalTrigger).toEqual({ reason: 'Tests are still red' });
  });
});

describe('maybeEvaluateGoal — met', () => {
  it('clears the goal, records lastGoal, and marks the transcript — no resubmit', async () => {
    const evaluateGoal: EvaluateGoal = async () => ({ verdict: 'met', reason: 'All green' });
    const { daemon, folder, events } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Get the test suite green');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(80);

    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBeNull();
    expect(state?.goalProgress).toBeNull();
    expect(state?.lastGoal).toMatchObject({
      condition: 'Get the test suite green',
      outcome: 'met',
      reason: 'All green',
      turns: 1,
    });
    // A quiet transcript marker, not a new agent turn.
    const marker = events.find(
      (e) => e.type === 'chat.message' && e.role === 'system' && e.content.includes('All green'),
    );
    expect(marker).toBeDefined();
    // No `not_met` resubmit was sent.
    expect(events.some((e) => e.type === 'chat.message' && 'goalTrigger' in e)).toBe(false);
    // 'met' does not surface the chat — no report was declared.
    expect(state?.declaredStatus).toBeNull();
  });
});

describe('maybeEvaluateGoal — impossible', () => {
  it('clears the goal, records the outcome, and surfaces the chat as needing attention', async () => {
    const evaluateGoal: EvaluateGoal = async () => ({
      verdict: 'impossible',
      reason: 'The target repo was deleted',
    });
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Merge the PR');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(80);

    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBeNull();
    expect(state?.lastGoal).toMatchObject({
      outcome: 'impossible',
      reason: 'The target repo was deleted',
    });
    expect(state?.declaredStatus?.kind).toBe('report');
    expect(state?.declaredStatus?.text).toContain('The target repo was deleted');
  });
});

describe('maybeEvaluateGoal — relentless until met, stopped only by a deadlock', () => {
  it('keeps pushing through turns that use no tools, however many', async () => {
    let n = 0;
    const evaluateGoal: EvaluateGoal = async () => {
      n += 1;
      // The agent only ever replies in text (asking, offering, reporting). The
      // goal goes on until the evaluator says it is met.
      return n >= 8
        ? { verdict: 'met', reason: 'finally done' }
        : { verdict: 'not_met', reason: 'Yes, go ahead' };
    };
    const { daemon, folder } = setup(evaluateGoal, {
      backend: textBackend('Shall I go ahead with the next part?'),
    });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Do the thing');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(400);

    expect(n).toBe(8);
    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBeNull();
    expect(state?.lastGoal?.outcome).toBe('met');
    expect(state?.declaredStatus).toBeNull();
  });

  it('stops, keeping the goal set, when the agent declines three times running', async () => {
    const evaluateGoal = vi.fn(
      async (): Promise<GoalVerdict> => ({
        verdict: 'refused',
        reason: 'It will not run the migration',
      }),
    );
    const { daemon, folder } = setup(evaluateGoal, { backend: textBackend('I will not do that') });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Run the migration');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(300);

    expect(evaluateGoal).toHaveBeenCalledTimes(3);
    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBe('Run the migration');
    expect(state?.declaredStatus?.kind).toBe('report');
    expect(state?.declaredStatus?.text).toContain('deadlocked');
    expect(state?.declaredStatus?.text).toContain('It will not run the migration');
  });

  it('presses on after the first two refusals, resubmitting the reason as guidance', async () => {
    let n = 0;
    const evaluateGoal: EvaluateGoal = async () => {
      n += 1;
      return n <= 2
        ? { verdict: 'refused', reason: 'It declined; do it anyway' }
        : { verdict: 'met', reason: 'done' };
    };
    const { daemon, events, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Do the thing');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(300);

    const resubmits = events.filter(
      (e) =>
        e.type === 'chat.message' && (e as { goalTrigger?: unknown }).goalTrigger !== undefined,
    );
    expect(resubmits).toHaveLength(2);
    expect(daemon.chatState.get(chatId)?.lastGoal?.outcome).toBe('met');
  });

  it('counts only refusals in a row: an agent that goes back to work resets it', async () => {
    const script: GoalVerdict['verdict'][] = [
      'refused',
      'refused',
      'not_met',
      'refused',
      'refused',
      'met',
    ];
    let n = 0;
    const evaluateGoal: EvaluateGoal = async () => ({ verdict: script[n++]!, reason: 'because' });
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Do the thing');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(500);

    expect(n).toBe(6);
    const state = daemon.chatState.get(chatId);
    expect(state?.lastGoal?.outcome).toBe('met');
    expect(state?.declaredStatus).toBeNull();
  });

  it('uses the refusal limit Settings gives', async () => {
    const evaluateGoal = vi.fn(
      async (): Promise<GoalVerdict> => ({ verdict: 'refused', reason: 'no' }),
    );
    const { daemon, folder } = setup(evaluateGoal);
    daemon.setGoalRefusalLimit(2);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Do the thing');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(300);

    expect(evaluateGoal).toHaveBeenCalledTimes(2);
    expect(daemon.chatState.get(chatId)?.declaredStatus?.text).toContain('declined 2 times');
  });

  it('a new goal starts the count again', async () => {
    const evaluateGoal: EvaluateGoal = async () => ({ verdict: 'refused', reason: 'no' });
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'First');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(300);
    expect(daemon.chatState.get(chatId)?.declaredStatus?.text).toContain('deadlocked');

    await daemon.setGoal(chatId, 'Second');
    expect(daemon.chatState.get(chatId)?.goalRefusalStreak).toBe(0);
  });
});

describe('maybeEvaluateGoal — deferred while patch_watch is running', () => {
  // `WatchScheduler` only notices a process exited on its own resident poll
  // (`DEFAULT_POLL_MS` = 3s, not configurable per-daemon), so this waits out a
  // real one rather than faking it — slow, but it is exercising the real
  // "running" → "exited" transition `watch.count` reads.
  it('skips evaluation while a watch is running and runs it once the watch finishes', async () => {
    const evaluateGoal = vi.fn(
      async (): Promise<GoalVerdict> => ({ verdict: 'met', reason: 'done' }),
    );
    const { daemon, folder } = setup(evaluateGoal, { goalWatchPollMs: 300 });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Do the thing');
    daemon.startWatch(chatId, { command: 'sleep 0.2', description: 'a slow background task' });

    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(30);
    // The watch is still running — evaluation deferred, not skipped forever.
    expect(evaluateGoal).not.toHaveBeenCalled();
    expect(daemon.chatState.get(chatId)?.goalEvalAwaitingWatches).toBe(true);
    expect(daemon.chatState.get(chatId)?.goal).toBe('Do the thing');

    // Wait for watch.ts's own resident poll to notice the process exited,
    // then this chat's goal-poll to re-check.
    await tick(3800);
    expect(evaluateGoal).toHaveBeenCalled();
    expect(daemon.chatState.get(chatId)?.goal).toBeNull();
  }, 8000);
});

describe('maybeEvaluateGoal — patch_delegate', () => {
  // A parent whose delegate is still running has not finished its goal: the
  // delegate's result is the work it is waiting on. Judging it now would call
  // an idle parent "done" (or stalled) while the real work is in flight.
  it('skips evaluation while a delegate is running and runs it once the delegate has delivered', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const backend: SdkBackend = {
      async *run(o) {
        yield { type: 'result', sessionId: 'sess' };
        if (o.prompt.includes('slow-delegate-work')) await gate;
        yield { type: 'assistant', content: 'ok', sessionId: 'sess' };
      },
    };
    const evaluateGoal = vi.fn(
      async (): Promise<GoalVerdict> => ({ verdict: 'met', reason: 'done' }),
    );
    const { daemon, folder } = setup(evaluateGoal, { backend, goalWatchPollMs: 50 });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Do the thing');
    await daemon.createDelegate({ parentChatId: chatId, prompt: 'slow-delegate-work' });

    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(150);
    expect(evaluateGoal).not.toHaveBeenCalled();
    expect(daemon.chatState.get(chatId)?.goalEvalAwaitingWatches).toBe(true);
    expect(daemon.chatState.get(chatId)?.goal).toBe('Do the thing');

    release();
    await tick(600);
    expect(evaluateGoal).toHaveBeenCalled();
    expect(daemon.chatState.get(chatId)?.goal).toBeNull();
  });
});

describe('maybeEvaluateGoal — provider-agnostic', () => {
  it('judges a Codex-model chat the same way as a Claude chat', async () => {
    const seen: string[] = [];
    const evaluateGoal: EvaluateGoal = async (input) => {
      seen.push(input.chatId);
      return { verdict: 'met', reason: 'done' };
    };
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder, model: 'openai/gpt-5-codex' });
    await tick();
    await daemon.setGoal(chatId, 'Ship it');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(80);

    expect(seen).toEqual([chatId]);
    expect(daemon.chatState.get(chatId)?.goal).toBeNull();
  });
});

describe('maybeEvaluateGoal — pauses on a usage limit and resumes', () => {
  it('a not_met resubmit that hits a usage limit keeps the goal set, and resuming carries it through', async () => {
    // Call 1: the user's own turn (not_met -> triggers a resubmit).
    // Call 2: the goalTrigger resubmit — hits a usage limit, never settles.
    // Call 3: the SAME resubmit, re-sent after a manual resume — succeeds, met.
    let call = 0;
    const backend: SdkBackend = {
      async *run() {
        call += 1;
        if (call === 2) throw new Error('API Error: 429 (too many requests)');
        yield { type: 'result', sessionId: 'sess' };
        yield { type: 'assistant', content: 'ok', sessionId: 'sess' };
      },
    };
    let evalCalls = 0;
    const evaluateGoal: EvaluateGoal = async () => {
      evalCalls += 1;
      return evalCalls >= 2
        ? { verdict: 'met', reason: 'All done' }
        : { verdict: 'not_met', reason: 'Keep going' };
    };
    const { daemon, folder } = setup(evaluateGoal, { backend });
    daemon.setAutoResumeRateLimit(true);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Finish the job');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(80);

    // The resubmit hit the limit — paused, not erroring the goal away.
    let state = daemon.chatState.get(chatId);
    expect(state?.goal).toBe('Finish the job');
    expect(evalCalls).toBe(1);
    expect(state?.activity).toBe('errored');
    expect(state?.status).not.toBe('errored');

    // Resume: the same resubmit goes through, settles, and this time it's met.
    expect(daemon.resumeRateLimitedNow(chatId)).toBe(true);
    await tick(80);
    state = daemon.chatState.get(chatId);
    expect(state?.goal).toBeNull();
    expect(state?.lastGoal).toMatchObject({ outcome: 'met', reason: 'All done' });
  });
});

describe('setGoal', () => {
  it('starts fresh progress counters on a new goal and drops them on clear', async () => {
    const { daemon, folder } = setup(undefined);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.setGoal(chatId, 'first goal');
    expect(daemon.chatState.get(chatId)?.goalProgress).toMatchObject({
      turnsEvaluated: 0,
      tokensSpent: 0,
      lastVerdict: null,
    });

    await daemon.setGoal(chatId, null);
    expect(daemon.chatState.get(chatId)?.goalProgress).toBeNull();
  });
});
