// spec/20-hooks.md § On the agent's response — the host half. After a turn
// settles (checkAgentResponseHooks on), the host asks the server which
// agent_response hooks match via `hook.agent_response_check_request`, then
// acts on the `hook.agent_response_outcome` the server answers with: a
// `block` resubmits as a visible `[hook: blocked]` turn, an `advise` (or a
// failed/timed-out hook) rides the chat's NEXT turn instead of forcing one,
// and three consecutive blocks trip the loop guard instead of resubmitting
// a fourth time.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { HookAgentResponseOutcomeEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A backend that replies with scripted text for each prompt, no tool calls. */
function textBackend(script: Record<string, string> = {}) {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts) {
      prompts.push(opts.prompt);
      const reply = script[opts.prompt] ?? `reply:${opts.prompt}`;
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: reply, sessionId: 'sess' };
    },
  };
  return { backend, prompts };
}

function setup(backend: SdkBackend, opts: { checkAgentResponseHooks?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-arh-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-arhfolder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    checkAgentResponseHooks: opts.checkAgentResponseHooks ?? false,
  });
  return { daemon, folder, events };
}

type CheckRequest = Extract<WireEvent, { type: 'hook.agent_response_check_request' }>;

function lastCheckRequest(events: WireEvent[]): CheckRequest | undefined {
  return [...events].reverse().find((e) => e.type === 'hook.agent_response_check_request') as
    | CheckRequest
    | undefined;
}

function outcome(
  req: CheckRequest,
  results: HookAgentResponseOutcomeEvent['results'],
): HookAgentResponseOutcomeEvent {
  return {
    type: 'hook.agent_response_outcome',
    daemonId: req.daemonId,
    chatId: req.chatId,
    checkId: req.checkId,
    results,
  };
}

describe('agent-response hooks — the host half (spec/20-hooks.md § On the agent’s response)', () => {
  it('checkAgentResponseHooks off (default): no check-request is ever sent', async () => {
    const { backend } = textBackend();
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    expect(lastCheckRequest(events)).toBeUndefined();
  });

  it('checkAgentResponseHooks on: fires a check-request with the full reply and a tool tally', async () => {
    const { backend } = textBackend({ hi: 'the full reply text' });
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    const req = lastCheckRequest(events);
    expect(req).toBeDefined();
    expect(req?.chatId).toBe(chatId);
    expect(req?.reply).toBe('the full reply text');
    expect(req?.specialThread).toBe(false);
    expect(req?.toolCallsSummary).toBe('No tool calls');
  });

  it('fires for a Codex-model chat too — not gated to Claude like the AI status summary is', async () => {
    const { backend } = textBackend({ hi: 'codex reply' });
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder, model: 'openai/gpt-5-codex' });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    const req = lastCheckRequest(events);
    expect(req).toBeDefined();
    expect(req?.reply).toBe('codex reply');
  });

  it('a block outcome resubmits as a visible [hook: blocked] turn carrying the analysis', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    const req = lastCheckRequest(events);
    daemon.handleHookAgentResponseOutcome(
      outcome(req!, [
        {
          hookId: 'h1',
          hookName: 'no secrets',
          status: 'ok',
          decision: 'block',
          analysis: 'the reply contains a credential',
          durationMs: 1,
        },
      ]),
    );
    await tick(60);
    const resubmit = prompts.find((p) => p.includes('[hook: blocked]'));
    expect(resubmit).toBeDefined();
    expect(resubmit).toContain('no secrets');
    expect(resubmit).toContain('the reply contains a credential');

    // The resubmit turn carries `hookTrigger` so a surface renders it as
    // quiet furniture (spec/14 § Agent-response hooks), not a user bubble —
    // and, per spec/20-hooks.md, the row IS what the agent received: the
    // persisted content is the same analysis the prompt above carried.
    const persisted = [...events]
      .reverse()
      .find((e) => e.type === 'chat.message' && e.role === 'user' && 'hookTrigger' in e) as
      | { content: string; hookTrigger?: { hooks: Array<{ hookId: string; hookName: string }> } }
      | undefined;
    expect(persisted).toBeDefined();
    expect(persisted?.hookTrigger?.hooks).toEqual([{ hookId: 'h1', hookName: 'no secrets' }]);
    expect(persisted?.content).toBe(resubmit);
  });

  it('an advise outcome does not resubmit, but its note rides the chat’s next turn', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    const req = lastCheckRequest(events);
    const promptCountBefore = prompts.length;
    daemon.handleHookAgentResponseOutcome(
      outcome(req!, [
        {
          hookId: 'h1',
          hookName: 'tone check',
          status: 'ok',
          decision: 'advise',
          analysis: 'a little terse',
          durationMs: 1,
        },
      ]),
    );
    await tick(60);
    // No redo fired by the advise itself.
    expect(prompts.length).toBe(promptCountBefore);

    await daemon.sendInput({ chatId, message: 'thanks', localId: 'u2' });
    await tick(60);
    // The model's actual prompt carries the advice (spec/20-hooks.md: "passed
    // to the agent with its next turn").
    const next = prompts[prompts.length - 1]!;
    expect(next).toContain('<system-reminder>');
    expect(next).toContain('tone check');
    expect(next).toContain('a little terse');
    expect(next).toContain('thanks');
    // The PERSISTED/displayed turn is just "thanks" — the reminder is
    // stripped from the bubble and carried out-of-band as a systemContext
    // disclosure instead (spec/02 § System-reminder disclosure; spec/20-hooks.md:
    // "no invisible injection" — the disclosure is what the agent received).
    const persisted = [...events]
      .reverse()
      .find((e) => e.type === 'chat.message' && e.role === 'user' && e.content === 'thanks') as
      | { systemContext?: Array<{ label: string; text: string }> }
      | undefined;
    expect(persisted).toBeDefined();
    expect(persisted?.systemContext?.[0]?.label).toBe('Hook advice');
    expect(persisted?.systemContext?.[0]?.text).toContain('tone check');

    // Consumed once — a THIRD turn carries nothing further.
    await daemon.sendInput({ chatId, message: 'again', localId: 'u3' });
    await tick(60);
    expect(prompts[prompts.length - 1]).toBe('again');
  });

  it('a failed/timeout result is never resubmitted, but still draws a disclosure on the next turn', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    const req = lastCheckRequest(events);
    const promptCountBefore = prompts.length;
    daemon.handleHookAgentResponseOutcome(
      outcome(req!, [
        {
          hookId: 'h1',
          hookName: 'flaky',
          status: 'timeout',
          durationMs: 20000,
          error: 'no answer within 15000ms',
        },
      ]),
    );
    await tick(60);
    // Not resubmitted — no new turn fired by the failure itself.
    expect(prompts.length).toBe(promptCountBefore);

    await daemon.sendInput({ chatId, message: 'next turn', localId: 'u2' });
    await tick(60);
    const next = prompts[prompts.length - 1]!;
    expect(next).toContain('could not be run');
    expect(next).toContain('flaky');
    expect(next).toContain('no answer within 15000ms');

    const persisted = [...events]
      .reverse()
      .find((e) => e.type === 'chat.message' && e.role === 'user' && e.content === 'next turn') as
      | { systemContext?: Array<{ label: string; text: string }> }
      | undefined;
    expect(persisted?.systemContext?.[0]?.label).toBe('Hook failed');
  });

  it('a stale outcome (superseded checkId) is ignored', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    const staleReq = lastCheckRequest(events)!;

    // A second turn supersedes the pending check.
    await daemon.sendInput({ chatId, message: 'again', localId: 'u2' });
    await tick(60);
    const promptCountBefore = prompts.length;

    daemon.handleHookAgentResponseOutcome(
      outcome(staleReq, [
        {
          hookId: 'h1',
          hookName: 'no secrets',
          status: 'ok',
          decision: 'block',
          analysis: 'stale',
          durationMs: 1,
        },
      ]),
    );
    await tick(60);
    expect(prompts.length).toBe(promptCountBefore);
  });

  it('loop guard: the 4th consecutive block stops resubmitting and surfaces the chat instead', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);

    const block = (analysis: string): HookAgentResponseOutcomeEvent['results'] => [
      {
        hookId: 'h1',
        hookName: 'no secrets',
        status: 'ok',
        decision: 'block',
        analysis,
        durationMs: 1,
      },
    ];

    for (let i = 1; i <= 3; i++) {
      const req = lastCheckRequest(events)!;
      daemon.handleHookAgentResponseOutcome(outcome(req, block(`attempt ${i}`)));
      await tick(60);
    }
    // Three blocks resubmitted (the original turn + 3 resubmits = 4 prompts).
    expect(prompts.filter((p) => p.includes('[hook: blocked]')).length).toBe(3);

    const fourthReq = lastCheckRequest(events)!;
    const promptCountBefore = prompts.length;
    daemon.handleHookAgentResponseOutcome(outcome(fourthReq, block('attempt 4')));
    await tick(60);
    // No 4th resubmit.
    expect(prompts.length).toBe(promptCountBefore);

    const lastState = [...events]
      .reverse()
      .find((e) => e.type === 'chat.state' && e.chatId === chatId) as
      | { statusKind?: string; statusSummary?: string }
      | undefined;
    expect(lastState?.statusKind).toBe('report');
    expect(lastState?.statusSummary).toContain('attempt 4');
  });

  it('a hidden chat: a block resubmits the same quiet way, still hidden', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);
    const req = lastCheckRequest(events);
    daemon.handleHookAgentResponseOutcome(
      outcome(req!, [
        {
          hookId: 'h1',
          hookName: 'no secrets',
          status: 'ok',
          decision: 'block',
          analysis: 'x',
          durationMs: 1,
        },
      ]),
    );
    await tick(60);
    expect(prompts.some((p) => p.includes('[hook: blocked]'))).toBe(true);
    const state = [...events].reverse().find((e) => e.type === 'chat.state') as
      | { hidden?: boolean }
      | undefined;
    expect(state?.hidden).toBe(true);
  });

  it('a hidden chat: the loop guard tripping surfaces it (un-hides) when resubmitting stops', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);

    const block = (analysis: string): HookAgentResponseOutcomeEvent['results'] => [
      {
        hookId: 'h1',
        hookName: 'no secrets',
        status: 'ok',
        decision: 'block',
        analysis,
        durationMs: 1,
      },
    ];
    for (let i = 1; i <= 4; i++) {
      const req = lastCheckRequest(events)!;
      daemon.handleHookAgentResponseOutcome(outcome(req, block(`attempt ${i}`)));
      await tick(60);
    }
    expect(prompts.filter((p) => p.includes('[hook: blocked]')).length).toBe(3);

    const lastState = [...events].reverse().find((e) => e.type === 'chat.state') as
      | { hidden?: boolean; statusKind?: string }
      | undefined;
    expect(lastState?.statusKind).toBe('report');
    // Declaring a status is itself a needs-attention claim — it un-hides.
    expect(lastState?.hidden).toBe(false);
  });

  it('a genuine turn in between resets the loop-guard counter', async () => {
    const { backend, prompts } = textBackend();
    const { daemon, folder, events } = setup(backend, { checkAgentResponseHooks: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'hi', localId: 'u1' });
    await tick(60);

    const block = (analysis: string): HookAgentResponseOutcomeEvent['results'] => [
      {
        hookId: 'h1',
        hookName: 'no secrets',
        status: 'ok',
        decision: 'block',
        analysis,
        durationMs: 1,
      },
    ];

    for (let i = 1; i <= 3; i++) {
      const req = lastCheckRequest(events)!;
      daemon.handleHookAgentResponseOutcome(outcome(req, block(`attempt ${i}`)));
      await tick(60);
    }
    expect(prompts.filter((p) => p.includes('[hook: blocked]')).length).toBe(3);

    // A genuine user turn breaks the streak.
    await daemon.sendInput({ chatId, message: 'a real follow-up', localId: 'u2' });
    await tick(60);

    const req = lastCheckRequest(events)!;
    daemon.handleHookAgentResponseOutcome(outcome(req, block('attempt after reset')));
    await tick(60);
    // Allowed to resubmit again — the guard did not stay tripped.
    expect(prompts.filter((p) => p.includes('[hook: blocked]')).length).toBe(4);
  });
});
