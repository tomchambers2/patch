// spec/02 § Questions are not approvals — a message sent while the agent's
// `AskUserQuestion` is still on screen cancels the question.
//
// The case this exists for: the agent asks, the card renders, the chat parks in
// `awaiting-permission`, and the user answers in the composer instead of on the
// card — which is the normal thing to do when none of the options is the answer.
// No surface stops him typing, so the message is accepted and queued, and then
// nothing happens at all. The turn is suspended inside `canUseTool` on the
// question's gate, and the queue only drains when that turn ends, so the typed
// message waits behind the very thing it was meant to answer until somebody
// presses Cancel by hand (or the question's expiry window runs out).
//
// Driven through the host's public API against the mock backend's
// `[[ask-user-question]]` trigger, which — like the real SDK's `canUseTool` —
// awaits `onPermissionRequest` before doing anything else, so the turn really is
// blocked while the test sends. Deliberately host-side rather than in the web
// composer: the wedge is in the host's pump, so fixing it there fixes it for
// web, desktop, mobile and voice at once.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, QUESTION_SUPERSEDED_MESSAGE, questionExpiredMessage } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-askq-cancel-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-askq-cancel-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    // The mode the mock blocks an ordinary Bash call under, so the "an approval
    // is NOT a question" case has something real to hold open.
    permissionModeDefault: 'default',
  });
  return { daemon, events, folder };
}

async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function permissionRequest(events: WireEvent[]): { requestId: string; request: { tool: string } } {
  const req = events.find((e) => e.type === 'chat.permission_request');
  expect(req).toBeDefined();
  return req as unknown as { requestId: string; request: { tool: string } };
}

function permissionResponses(
  events: WireEvent[],
): Array<{ requestId: string; approve: boolean; decision?: string; chatId?: string }> {
  return events.filter((e) => e.type === 'chat.permission_response') as unknown as Array<{
    requestId: string;
    approve: boolean;
    decision?: string;
    chatId?: string;
  }>;
}

function toolResult(events: WireEvent[], tool: string): string | undefined {
  const ev = events.find((e) => e.type === 'chat.tool_result' && e.tool === tool) as
    | { result: unknown }
    | undefined;
  return ev === undefined ? undefined : String(ev.result);
}

/** Assistant text the mock produced — `[mock] echo: <prompt>` per turn. */
function assistantText(events: WireEvent[]): string[] {
  return (
    events.filter((e) => e.type === 'chat.message' && e.role === 'assistant') as unknown as Array<{
      content: string;
    }>
  ).map((e) => e.content);
}

const TYPED = 'neither — use Temporal, and check the bundle size';

describe('sending a message cancels the outstanding AskUserQuestion (spec/02)', () => {
  it('denies the question, then runs the typed message as the next turn', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();

    const req = permissionRequest(events);
    expect(req.request.tool).toBe('AskUserQuestion');
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    expect(permissionResponses(events)).toHaveLength(0);

    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick();

    // The question was resolved by the host, not by the user's hand: one
    // response, a plain deny, carrying the chatId so the open card flips itself
    // to Cancelled on every surface (spec/03 — no new wire field for this).
    const responses = permissionResponses(events);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.requestId).toBe(req.requestId);
    expect(responses[0]?.decision).toBe('deny');
    expect(responses[0]?.approve).toBe(false);
    expect(responses[0]?.chatId).toBe(chatId);

    // The tool call genuinely did not run: the agent is told it was denied and
    // is never handed an empty answer (§ Questions are not approvals).
    expect(
      events.find((e) => e.type === 'chat.tool_call' && e.tool === 'AskUserQuestion'),
    ).toBeUndefined();

    // ...and the typed message is not stuck behind it — it ran as its own turn,
    // and the chat is idle rather than parked.
    expect(assistantText(events)).toContain(`[mock] echo: ${TYPED}`);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
  });

  it('does not queue the message behind an agent that keeps working after the question is cancelled', async () => {
    // A real agent carries on after a refusal (it writes a reply), so the typed
    // message used to sit QUEUED until that reply finished. A question is not a
    // running turn: the message replaces it and runs at once.
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]][[linger]]' });
    await tick();
    permissionRequest(events);

    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick(100);

    expect(assistantText(events)).toContain(`[mock] echo: ${TYPED}`);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('tells the AGENT the question was superseded, not refused, and points it at the message', async () => {
    // `deny` on the wire cannot say WHY, so the deny message is the agent's only
    // account of what happened (spec/02 § Questions are not approvals — the same
    // reasoning as the expiry text). Left bare, the tool result reads "Permission
    // denied by user", i.e. the user REFUSED — which is the class of bug this
    // section exists to prevent, and would have the agent apologise for asking
    // instead of reading the answer that is sitting in the next turn.
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    permissionRequest(events);

    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick();

    const result = toolResult(events, 'AskUserQuestion');
    // Asserted present FIRST: a host that never resolves the question emits no
    // tool result at all, and `undefined === undefined` would quietly pass every
    // "is not the wrong text" line below it.
    expect(result).toBeDefined();
    expect(result).toBe(QUESTION_SUPERSEDED_MESSAGE);
    expect(result).not.toBe('Permission denied by user');
    // Distinct from the expiry account too: somebody DID see this one.
    expect(result).not.toBe(questionExpiredMessage(60));
  });

  it('cancels EVERY question outstanding on the chat, not just the first', async () => {
    // A turn whose subagents each asked can have more than one open at once, and
    // leaving any of them pending wedges the turn just as thoroughly as leaving
    // the first. Injected rather than driven through the mock, which asks once.
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    const a = daemon.injectPermissionRequest(chatId, 'AskUserQuestion', 'first question');
    const b = daemon.injectPermissionRequest(chatId, 'AskUserQuestion', 'second question');
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick();

    expect(
      permissionResponses(events)
        .map((r) => r.requestId)
        .sort(),
    ).toEqual([a, b].sort());
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
  });

  it('leaves a chat with no question outstanding completely alone', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick();

    expect(permissionResponses(events)).toHaveLength(0);
    expect(assistantText(events)).toContain(`[mock] echo: ${TYPED}`);
  });

  it('a redelivered input does not cancel a question a second time', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    permissionRequest(events);

    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick();
    // spec/12 § Guaranteed input delivery — the surface's blind retry. It must
    // stay the no-op it already was: the turn it re-acks has run, and there is
    // no second question for it to answer.
    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick();

    expect(permissionResponses(events)).toHaveLength(1);
    expect(assistantText(events).filter((t) => t === `[mock] echo: ${TYPED}`)).toHaveLength(1);
  });
});

describe('typing does NOT decide a tool approval (spec/02)', () => {
  it('leaves a pending Bash approval pending, and the message queued behind it', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();

    const req = permissionRequest(events);
    expect(req.request.tool).toBe('Bash');

    await daemon.sendInput({ chatId, message: TYPED, localId: 'local-1' });
    await tick();

    // Nothing was decided on the user's behalf. An approval left waiting is a
    // turn paused ON PURPOSE — auto-denying it on a keystroke would be the
    // destructive surprise the expiry window deliberately declines to inflict.
    expect(permissionResponses(events)).toHaveLength(0);
    expect(daemon.getPendingPermissionForChat(chatId)).toBe(req.requestId);
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    expect(assistantText(events)).not.toContain(`[mock] echo: ${TYPED}`);

    // Answering it by hand still drains the queue, so the message was queued
    // rather than dropped.
    daemon.submitPermissionResponse({ requestId: req.requestId, decision: 'approve' });
    await tick(80);
    expect(assistantText(events)).toContain(`[mock] echo: ${TYPED}`);
  });
});

describe("only a person's message answers a question (spec/02)", () => {
  it.each([
    ['machine origin', { origin: 'machine' as const }],
    ['job fire', { jobTrigger: true }],
  ])('a %s leaves the question open, and the user can still answer it', async (_n, extra) => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    await daemon.sendInput({ chatId, message: 'automated nudge', localId: 'local-1', ...extra });
    await tick();

    expect(permissionResponses(events)).toHaveLength(0);
    expect(daemon.getPendingPermissionForChat(chatId)).toBe(req.requestId);

    daemon.submitPermissionResponse({
      requestId: req.requestId,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which one?': 'Other text' }),
    });
    await tick(80);
    const responses = permissionResponses(events);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.approve).toBe(true);
    expect(toolResult(events, 'AskUserQuestion')).not.toBe(QUESTION_SUPERSEDED_MESSAGE);
  });
});
