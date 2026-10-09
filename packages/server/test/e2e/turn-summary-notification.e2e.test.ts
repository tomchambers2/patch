// End-to-end: the "finished" notification says what the agent actually did
// (spec/09 § What the message says).
//
// Tom: "patch notify needs to take specific text from the agent and use it. not
// just the starting message". The fix has three halves that are only correct
// together — the host stamps the turn's own closing words onto the frame that
// settles it, the WIRE has to carry a field neither end validated before, and
// the server has to prefer it over the async status summary. Unit tests cover
// each half against hand-built frames, and every one of them would stay green if
// the codec dropped the field in transit: the frames they build never go near
// encode/decode, and the server's ingress decoder is STRICT, so a `chat.state`
// the wire schema had not been taught about would be refused outright.
//
// So this drives the REAL server + REAL host over the REAL WebSocket link,
// and asserts both ends of it: that the settling frame reaches a surface still
// carrying the text, and that the notification the server raises is built from
// it.

import { describe, it, expect, afterEach } from 'vitest';
import type { NotifyEvent, WireEvent } from '@patch/wire';
import { startHarness, record, until, type E2EHarness } from './harness.js';
import type { RouteOptions } from '../../src/notifications/router.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

/** Every notification the server RAISED, recorded before any channel runs. */
function recordNotifications(harness: E2EHarness): NotifyEvent[] {
  const raised: NotifyEvent[] = [];
  const router = harness.built.notificationRouter;
  router.route = async (event: NotifyEvent, _opts: RouteOptions = {}): Promise<void> => {
    raised.push(event);
  };
  return raised;
}

async function spawnChat(harness: E2EHarness, jwt: string): Promise<string> {
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { daemonId: harness.daemonId, folder: harness.folder },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { chatId: string }).chatId;
}

type StateFrame = Extract<WireEvent, { type: 'chat.state' }> & { turnSummary?: string | null };

/**
 * A chat's `chat.state` frames, in arrival order. Deliberately not "the last
 * idle frame": a chat emits idle → idle for its own reasons (the preview
 * landing, a title arriving), so the frame that SETTLED a turn is specifically
 * the first idle after that turn's running.
 */
function framesFor(states: WireEvent[], chatId: string): StateFrame[] {
  return states.filter(
    (e): e is StateFrame => e.type === 'chat.state' && e.chatId === chatId,
  ) as StateFrame[];
}

function runningCount(states: WireEvent[], chatId: string): number {
  return framesFor(states, chatId).filter((e) => e.activity === 'running').length;
}

/** The frame that settled the most recent run, if it has settled. */
function settlingFrame(states: WireEvent[], chatId: string): StateFrame | undefined {
  const frames = framesFor(states, chatId);
  const lastRunning = frames.map((e) => e.activity).lastIndexOf('running');
  if (lastRunning < 0) return undefined;
  return frames.slice(lastRunning + 1).find((e) => e.activity === 'idle');
}

const CLOSING = 'Dug over the top bed and sowed rocket. Nothing else outstanding.';

describe("e2e: the finished notification carries the turn's own closing text", () => {
  it('reaches the surface on the settling frame and becomes the notification', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-summary');
    const client = await h.connectSurface('srf-summary-b');
    const raised = recordNotifications(h);
    const chatId = await spawnChat(h, jwt);
    client.send({ type: 'chat.focus_change', chatId });

    const states = record(client, ['chat.state']);
    const runs = runningCount(states, chatId);

    h.sdk.enqueue([{ type: 'assistant', content: CLOSING }]);
    client.sendInput({ chatId, message: 'do the beds', localId: 'L1' });
    await until(() => runningCount(states, chatId) > runs, 8000, 'the turn started');
    await until(() => settlingFrame(states, chatId) !== undefined, 8000, 'the turn settled');

    // The wire carried it: through the host's real serverLink, the server's
    // STRICT ingress decode, and back out to a real surface socket.
    expect(settlingFrame(states, chatId)?.turnSummary).toBe(CLOSING);

    // And the doorbell was built from it. The name is still the chat's own
    // title; what has changed is the half after the colon, which before this
    // was the async status summary and so, on this frame, almost always nothing.
    await until(() => raised.some((n) => n.chatId === chatId), 3000, 'the doorbell rang');
    const name = settlingFrame(states, chatId)?.name;
    expect(name).toBeTruthy();
    expect(raised.find((n) => n.chatId === chatId)?.message).toBe(`${name} finished: ${CLOSING}`);

    await client.close();
  });

  // NO FALLBACK: a turn that says nothing gets no words put in its mouth, and
  // the notification reads exactly as it did before the field existed.
  it('a turn that ends on a tool call says only that the chat finished', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-summary2');
    const client = await h.connectSurface('srf-summary2-b');
    const raised = recordNotifications(h);
    const chatId = await spawnChat(h, jwt);
    client.send({ type: 'chat.focus_change', chatId });

    const states = record(client, ['chat.state']);

    // Turn one speaks, so its words are sitting in the host's rolling message
    // window when turn two settles without adding any of its own.
    let runs = runningCount(states, chatId);
    h.sdk.enqueue([{ type: 'assistant', content: CLOSING }]);
    client.sendInput({ chatId, message: 'do the beds', localId: 'L1' });
    await until(() => runningCount(states, chatId) > runs, 8000, 'the first turn started');
    await until(() => settlingFrame(states, chatId) !== undefined, 8000, 'the first turn settled');
    expect(settlingFrame(states, chatId)?.turnSummary).toBe(CLOSING);

    runs = runningCount(states, chatId);
    h.sdk.enqueue([
      { type: 'tool_use', tool: { name: 'Bash', args: { command: 'ls' }, callId: 'tc-1' } },
      { type: 'tool_result', toolResult: { name: 'Bash', callId: 'tc-1', result: 'ok' } },
    ]);
    client.sendInput({ chatId, message: 'and again', localId: 'L2' });
    await until(() => runningCount(states, chatId) > runs, 8000, 'the second turn started');
    await until(() => settlingFrame(states, chatId) !== undefined, 8000, 'the second turn settled');

    expect(settlingFrame(states, chatId)?.turnSummary).toBeNull();

    await until(
      () => raised.filter((n) => n.chatId === chatId).length >= 2,
      3000,
      'both doorbells',
    );
    const second = raised.filter((n) => n.chatId === chatId).at(-1)?.message ?? '';
    expect(second.endsWith(' finished')).toBe(true);
    expect(second).not.toContain(CLOSING);

    await client.close();
  });
});
