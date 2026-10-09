import { describe, it, expect } from 'vitest';
import type { ChatInputEvent, WireEvent } from '@patch/wire';
import { QueuePullClient } from '../src/queuePull.js';

const item = (localId: string): ChatInputEvent =>
  ({ type: 'chat.input', chatId: 'c1', message: localId, localId }) as ChatInputEvent;

describe('QueuePullClient', () => {
  function make(over: { online?: boolean; timeoutMs?: number } = {}) {
    const sent: WireEvent[] = [];
    const client = new QueuePullClient({
      emit: (e) => sent.push(e),
      isLinkOnline: () => over.online ?? true,
      timeoutMs: over.timeoutMs ?? 50,
    });
    return { client, sent };
  }

  it('asks nothing while the server is not running the queue', async () => {
    const { client, sent } = make();
    expect(await client.pull('c1')).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('asks nothing while the link to the server is down', async () => {
    const { client, sent } = make({ online: false });
    client.setEnabled(true);
    expect(await client.pull('c1')).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('returns what the server answers with, matched to its own request', async () => {
    const { client, sent } = make();
    client.setEnabled(true);
    const pulled = client.pull('c1');
    const request = sent[0] as { type: string; requestId: string; chatId: string };
    expect(request).toMatchObject({ type: 'patch.queue_pull.request', chatId: 'c1' });

    // An answer for some other request changes nothing.
    client.handleResponse({
      type: 'patch.queue_pull.response',
      requestId: 'other',
      items: [item('x')],
    });
    client.handleResponse({
      type: 'patch.queue_pull.response',
      requestId: request.requestId,
      items: [item('L1'), item('L2')],
    });
    expect((await pulled).map((i) => i.localId)).toEqual(['L1', 'L2']);
  });

  it('gives up after the timeout and returns nothing, so the turn is never held up', async () => {
    const { client } = make({ timeoutMs: 20 });
    client.setEnabled(true);
    expect(await client.pull('c1')).toEqual([]);
  });

  it('ignores a late answer', async () => {
    const { client, sent } = make({ timeoutMs: 10 });
    client.setEnabled(true);
    await client.pull('c1');
    const { requestId } = sent[0] as { requestId: string };
    expect(() =>
      client.handleResponse({ type: 'patch.queue_pull.response', requestId, items: [item('L')] }),
    ).not.toThrow();
  });
});
