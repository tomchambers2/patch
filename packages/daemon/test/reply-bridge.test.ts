import { describe, it, expect } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';

const state = (chatId: string, activity: 'running' | 'idle') =>
  ({ type: 'chat.state', chatId, activity }) as unknown as WireEvent;
const msg = (chatId: string, role: 'user' | 'assistant', content: string, localId?: string) =>
  ({
    type: 'chat.message',
    chatId,
    role,
    content,
    seq: 1,
    ...(localId !== undefined ? { localId } : {}),
  }) as unknown as WireEvent;

describe('voice reply bridge — a turn identified by its localId', () => {
  it('is not settled or filled by another turn that is running when it is registered', async () => {
    const bridge = createVoiceReplyBridge();
    // A turn is already running on the chat; ours is queued behind it.
    bridge.observe(state('c', 'running'));
    const reply = bridge.awaitReply('c', undefined, 'mine');
    bridge.observe(msg('c', 'assistant', "the other turn's text"));
    bridge.observe(state('c', 'idle'));
    expect(bridge.pendingCount()).toBe(1);
    // Our turn starts: its own user message arms the waiter.
    bridge.observe(state('c', 'running'));
    bridge.observe(msg('c', 'user', 'ls the folder', 'mine'));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(state('c', 'idle'));
    await expect(reply).resolves.toBe('ten files');
  });

  it('leaves out what the voice itself wrote into the chat while the agent worked', async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c', undefined, 'mine');
    bridge.observe(msg('c', 'user', 'ls', 'mine'));
    bridge.observe(msg('c', 'assistant', "[voice • web] It's started."));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(state('c', 'idle'));
    await expect(reply).resolves.toBe('ten files');
  });

  it('a turn registered without a localId is armed by the chat going running, as before', async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c');
    bridge.observe(state('c', 'running'));
    bridge.observe(msg('c', 'assistant', 'hello'));
    bridge.observe(state('c', 'idle'));
    await expect(reply).resolves.toBe('hello');
  });

  it("keeps the turn's text when the host re-emits running after the reply (summaries, status)", async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c');
    bridge.observe(state('c', 'running'));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(state('c', 'running'));
    bridge.observe(state('c', 'idle'));
    await expect(reply).resolves.toBe('ten files');
  });

  it('keeps it for a turn identified by localId too', async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c', undefined, 'mine');
    bridge.observe(state('c', 'running'));
    bridge.observe(msg('c', 'user', 'ls', 'mine'));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(state('c', 'running'));
    bridge.observe(state('c', 'idle'));
    await expect(reply).resolves.toBe('ten files');
  });
});
