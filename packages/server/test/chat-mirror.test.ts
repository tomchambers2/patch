// The server's durable copy of chat messages (spec/04 § History — server
// mirror). Persists what already streams through the server so an offline
// host's chats stay searchable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { ChatMirror } from '../src/chat-mirror.js';

const msg = (chatId: string, seq: number, role: 'user' | 'assistant' | 'system', content: string) =>
  ({ type: 'chat.message', chatId, seq, role, content }) as WireEvent;

describe('ChatMirror', () => {
  let dir: string;
  const warn = vi.fn();
  const logger = { warn } as never;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-mirror-'));
    warn.mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists user and assistant messages and survives a restart', () => {
    const m = new ChatMirror({ dataDir: dir, logger });
    m.observe(msg('c1', 0, 'user', 'fix the boiler'));
    m.observe(msg('c1', 1, 'assistant', 'the boiler pressure is low'));
    const again = new ChatMirror({ dataDir: dir, logger });
    expect(again.messages('c1').map((x) => x.seq)).toEqual([0, 1]);
    expect(again.chatIds()).toEqual(['c1']);
  });

  it('ignores system messages and other events', () => {
    const m = new ChatMirror({ dataDir: dir, logger });
    m.observe(msg('c1', 0, 'system', 'compacted'));
    m.observe({ type: 'daemon.online', daemonId: 'd1' } as WireEvent);
    expect(m.chatIds()).toEqual([]);
  });

  it('is idempotent when a replay re-sends a seq, and unpacks batches', () => {
    const m = new ChatMirror({ dataDir: dir, logger });
    m.observe(msg('c1', 0, 'user', 'hello there'));
    m.observe({
      type: 'chat.replay_batch',
      events: [msg('c1', 0, 'user', 'hello there'), msg('c1', 1, 'assistant', 'hi')],
    } as unknown as WireEvent);
    expect(m.messages('c1')).toHaveLength(2);
  });

  it('a later copy of the same seq does not duplicate it, even after restart', () => {
    new ChatMirror({ dataDir: dir, logger }).observe(msg('c1', 4, 'user', 'once'));
    new ChatMirror({ dataDir: dir, logger }).observe(msg('c1', 4, 'user', 'once'));
    expect(new ChatMirror({ dataDir: dir, logger }).messages('c1')).toHaveLength(1);
  });

  it('a corrupt file is logged loudly and skipped, not thrown', () => {
    const m = new ChatMirror({ dataDir: dir, logger });
    m.observe(msg('good', 0, 'user', 'fine'));
    const files = readdirSync(join(dir, 'chat-mirror'));
    expect(files).toHaveLength(1);
    writeFileSync(
      join(dir, 'chat-mirror', 'bad.jsonl'),
      '{"seq":0,"role":"user","content":"x"}\n{not json\n',
    );
    const fresh = new ChatMirror({ dataDir: dir, logger });
    expect(fresh.messages('bad').map((x) => x.content)).toEqual(['x']);
    expect(warn).toHaveBeenCalled();
    expect(fresh.messages('good')).toHaveLength(1);
  });

  it('refuses chat ids that are not safe file names', () => {
    const m = new ChatMirror({ dataDir: dir, logger });
    m.observe(msg('../escape', 0, 'user', 'nope'));
    expect(m.chatIds()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('search finds every term in a message, newest match as the snippet', () => {
    const m = new ChatMirror({ dataDir: dir, logger });
    m.observe(msg('c1', 0, 'user', 'the boiler is leaking'));
    m.observe(msg('c1', 1, 'assistant', 'check the boiler pressure gauge'));
    m.observe(msg('c1', 2, 'user', 'unrelated'));
    const r = m.search('boiler pressure', 'c1');
    expect(r).toMatchObject({ messageMatches: 1, snippet: { role: 'assistant', seq: 1 } });
    expect(r!.snippet!.highlights.length).toBe(2);
    expect(m.search('boiler', 'c1')).toMatchObject({ messageMatches: 2, snippet: { seq: 1 } });
    expect(m.search('zebra', 'c1')).toBeNull();
    expect(m.search('boiler', 'missing')).toBeNull();
  });
});
