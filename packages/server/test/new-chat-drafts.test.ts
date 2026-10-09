// NewChatDraftStore (spec/14 § New chat drafts): persistence across a server
// restart, removal, and tolerance of a corrupt file.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewChatDraftStore } from '../src/new-chat-drafts.js';

const d = { id: 'draft-1', folder: '/p', text: 'hello' };

describe('NewChatDraftStore', () => {
  it('survives a restart, and a removal survives one too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncd-'));
    try {
      new NewChatDraftStore({ dataDir: dir }).set(d);
      const restarted = new NewChatDraftStore({ dataDir: dir });
      expect(restarted.list()).toMatchObject([d]);
      restarted.remove('draft-1');
      expect(new NewChatDraftStore({ dataDir: dir }).list()).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('whitespace-only text removes; remove always emits', () => {
    const store = new NewChatDraftStore({});
    const seen: string[] = [];
    store.onChange((c) => seen.push(c.type));
    store.set(d);
    store.set({ ...d, text: ' ' });
    store.remove('nope');
    expect(store.list()).toEqual([]);
    expect(seen).toEqual(['set', 'removed', 'removed']);
  });

  it('a corrupt file is logged and starts empty instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncd-'));
    try {
      writeFileSync(join(dir, 'new-chat-drafts.json'), '{not json');
      const warns: unknown[] = [];
      const store = new NewChatDraftStore({
        dataDir: dir,
        logger: { warn: (...a: unknown[]) => void warns.push(a) } as never,
      });
      expect(store.list()).toEqual([]);
      expect(warns).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
