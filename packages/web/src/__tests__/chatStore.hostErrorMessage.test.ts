// A failure the host writes into the transcript as a system message must land
// as an error card, not as a plain paragraph that reads as the model talking.
import { describe, it, expect } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';

describe('chat.message with error: true', () => {
  it('becomes one error entry, once, however often it is replayed', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'ce', folder: '~/p' });
    const ev = {
      type: 'chat.message' as const,
      chatId: 'ce',
      role: 'system' as const,
      content: 'This turn failed: Codex process exited (0)',
      error: true as const,
      seq: 7,
    };
    s.applyEvent(ev);
    s.applyEvent(ev);
    const list = useChatStore.getState().timelines['ce'] ?? [];
    const errs = list.filter((e) => e.seq === 7);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.kind).toBe('error');
    expect(errs[0]!.content).toBe('This turn failed: Codex process exited (0)');
  });

  it('leaves an ordinary system message alone', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'cf', folder: '~/p' });
    s.applyEvent({ type: 'chat.message', chatId: 'cf', role: 'system', content: 'note', seq: 3 });
    expect(useChatStore.getState().timelines['cf']?.[0]?.kind).toBe('message');
  });
});
