import { describe, it, expect } from 'vitest';
import { EventBuffer } from '../src/eventBuffer.js';

describe('EventBuffer', () => {
  it('drops oldest per-chat events when cap exceeded and reports count', () => {
    const drops: { chatId: string; droppedCount: number }[] = [];
    const buf = new EventBuffer({ maxPerChat: 3, onDrop: (d) => drops.push(d) });
    for (let i = 0; i < 5; i++) {
      buf.push({ type: 'chat.message', chatId: 'c1', role: 'assistant', content: `m${i}`, seq: i });
    }
    expect(drops).toEqual([
      { chatId: 'c1', droppedCount: 1 },
      { chatId: 'c1', droppedCount: 1 },
    ]);
    const drained = buf.drain();
    expect(drained).toHaveLength(3);
    expect((drained[0] as { content: string }).content).toBe('m2');
  });

  it('drains keeps insertion order (global first, then per-chat)', () => {
    const buf = new EventBuffer();
    buf.push({ type: 'daemon.online', daemonId: 'd1' });
    buf.push({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'a', seq: 0 });
    const drained = buf.drain();
    expect(drained.map((e) => e.type)).toEqual(['daemon.online', 'chat.message']);
    expect(buf.size()).toBe(0);
  });

  it('drops oldest global (chatId-less) events when the global cap is exceeded', () => {
    const buf = new EventBuffer({ maxGlobal: 3 });
    for (let i = 0; i < 5; i++) {
      buf.push({ type: 'daemon.online', daemonId: 'd1' });
    }
    // No onDrop callback for global overflow — just silently trims (mirrors
    // per-chat behaviour but has no chatId to report).
    expect(buf.size()).toBe(3);
    const drained = buf.drain();
    expect(drained).toHaveLength(3);
  });
});
