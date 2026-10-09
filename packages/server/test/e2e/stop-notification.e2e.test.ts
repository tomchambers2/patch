// End-to-end: stopping a chat raises no "finished" notification
// (spec/09 § A turn the user stopped).
//
// The decision is the server's, but the fact it decides on is the host's, and
// the two halves are only correct together: the host has to stamp
// `turnStopped` on the frame that settles the stopped turn and clear it as the
// next turn starts, and the server has to read it off THAT frame rather than
// off `chat.stopped` — which, on a bare stop, the host does not emit until
// after the idle frame has already been handled.
//
// Unit tests cover each half against a hand-built frame stream, so a host that
// stopped stamping the field (or a server reading the wrong one) would leave
// both suites green and put the push back on Tom's phone. This drives the REAL
// server + REAL host over the REAL WebSocket link and watches what the
// notification router is actually asked to send.

import { describe, it, expect, afterEach } from 'vitest';
import type { NotifyEvent } from '@patch/wire';
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
  // Recorded, not delivered: the channels themselves have their own tests, and
  // what is under test here is which turns the server decides to announce.
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

describe('e2e: a stopped chat is silent, the turn after it is not', () => {
  it('raises nothing for a stopped turn, then announces the next one that finishes', async () => {
    // A turn long enough to still be running when the stop lands.
    h = await startHarness({ turnDelayMs: 1500 });
    const jwt = await h.mintSurface('srf-stop');
    const client = await h.connectSurface('srf-stop-b');
    const raised = recordNotifications(h);
    const chatId = await spawnChat(h, jwt);
    client.send({ type: 'chat.focus_change', chatId });

    const states = record(client, ['chat.state', 'chat.stopped']);
    const idles = (): number =>
      states.filter((e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'idle')
        .length;

    // ---- Tom sends a turn, then stops it.
    client.sendInput({ chatId, message: 'a long turn', localId: 'L1' });
    await until(
      () =>
        states.some(
          (e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'running',
        ),
      3000,
      'turn running',
    );
    const idlesBeforeStop = idles();
    client.send({ type: 'chat.stop_request', chatId });

    await until(
      () => states.some((e) => e.type === 'chat.stopped' && e.chatId === chatId),
      3000,
      'chat.stopped received',
    );
    await until(() => idles() > idlesBeforeStop, 3000, 'chat settled to idle after the stop');

    // The settling frame says the turn was stopped, and the server stayed quiet.
    const settled = states.filter(
      (e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'idle',
    );
    expect((settled.at(-1) as { turnStopped?: boolean }).turnStopped).toBe(true);
    expect(raised.filter((n) => n.chatId === chatId)).toEqual([]);

    // ---- Tom sends another turn and lets it finish. The chat is not silenced.
    const idlesAfterStop = idles();
    client.sendInput({ chatId, message: 'and now finish', localId: 'L2' });
    await until(() => idles() > idlesAfterStop, 8000, 'the second turn settled');

    const finished = states.filter(
      (e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'idle',
    );
    expect((finished.at(-1) as { turnStopped?: boolean }).turnStopped).toBe(false);
    expect(raised.filter((n) => n.chatId === chatId).map((n) => n.channel)).toEqual([
      'desktop',
      'push',
    ]);

    await client.close();
  });
});
