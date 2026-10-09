// Server-owned composer drafts (spec/14 § Composer, spec/15 § Composer).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { ComposerDraftStore, hasDraftText } from '../src/composer-drafts.js';

const logger = pino({ level: 'silent' });

describe('hasDraftText', () => {
  test('empty and whitespace-only are not drafts', () => {
    expect(hasDraftText('')).toBe(false);
    expect(hasDraftText('   \n\t ')).toBe(false);
  });
  test('anything else is', () => {
    expect(hasDraftText('hi')).toBe(true);
    expect(hasDraftText('  hi  ')).toBe(true);
  });
});

describe('ComposerDraftStore', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-composer-drafts-'));
    now = 1_700_000_000_000;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const nowMs = (): number => now;

  test('starts empty and lists nothing', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    expect(store.list()).toEqual([]);
    expect(store.get('c1')).toBeUndefined();
  });

  test('set stores the text stamped with the receipt time, and persists', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    store.set('c1', 'not sent yet');
    expect(store.get('c1')).toEqual({ chatId: 'c1', text: 'not sent yet', updatedAt: now });
    expect(JSON.parse(readFileSync(join(dir, 'composer-drafts.json'), 'utf8'))).toEqual({
      c1: { text: 'not sent yet', updatedAt: now },
    });
    // A fresh store reads the persisted draft back.
    expect(new ComposerDraftStore({ dataDir: dir, logger }).get('c1')?.text).toBe('not sent yet');
  });

  test('set with whitespace-only text clears instead of storing', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    store.set('c1', 'hello');
    store.set('c1', '   ');
    expect(store.get('c1')).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'composer-drafts.json'), 'utf8'))).toEqual({});
  });

  test('clear drops an existing draft and persists the removal', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    store.set('c1', 'hello');
    store.clear('c1');
    expect(store.get('c1')).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'composer-drafts.json'), 'utf8'))).toEqual({});
  });

  test('clear on a chat with no draft is a harmless no-op that still emits', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    const handler = vi.fn();
    store.onChange(handler);
    store.clear('never-had-one');
    expect(handler).toHaveBeenCalledWith({
      type: 'cleared',
      chatId: 'never-had-one',
      updatedAt: now,
    });
  });

  test('list returns every draft across chats', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    store.set('c1', 'first');
    now += 1000;
    store.set('c2', 'second');
    expect(store.list().sort((a, b) => a.chatId.localeCompare(b.chatId))).toEqual([
      { chatId: 'c1', text: 'first', updatedAt: 1_700_000_000_000 },
      { chatId: 'c2', text: 'second', updatedAt: 1_700_000_001_000 },
    ]);
  });

  test('onChange fires "set" on a write and "cleared" on a clear', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    const handler = vi.fn();
    store.onChange(handler);
    store.set('c1', 'hello');
    expect(handler).toHaveBeenCalledWith({
      type: 'set',
      chatId: 'c1',
      text: 'hello',
      updatedAt: now,
    });
    now += 5000;
    store.clear('c1');
    expect(handler).toHaveBeenCalledWith({ type: 'cleared', chatId: 'c1', updatedAt: now });
  });

  test('unsubscribing stops further notifications', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    const handler = vi.fn();
    const unsub = store.onChange(handler);
    unsub();
    store.set('c1', 'hello');
    expect(handler).not.toHaveBeenCalled();
  });

  test('a corrupt file starts empty, reported, rather than crashing', () => {
    writeFileSync(join(dir, 'composer-drafts.json'), '{not json', 'utf8');
    expect(new ComposerDraftStore({ dataDir: dir, logger }).list()).toEqual([]);
  });

  test('a file holding a non-object is treated as malformed, not partially read', () => {
    writeFileSync(join(dir, 'composer-drafts.json'), JSON.stringify(['nope']), 'utf8');
    expect(new ComposerDraftStore({ dataDir: dir, logger }).list()).toEqual([]);
  });

  test('a stored whitespace-only entry (written by an older/buggy build) is dropped on load', () => {
    writeFileSync(
      join(dir, 'composer-drafts.json'),
      JSON.stringify({ c1: { text: '   ', updatedAt: 1 }, c2: { text: 'real', updatedAt: 2 } }),
      'utf8',
    );
    const store = new ComposerDraftStore({ dataDir: dir, logger });
    expect(store.get('c1')).toBeUndefined();
    expect(store.get('c2')?.text).toBe('real');
  });

  test('with no dataDir the store works in memory only, without touching disk', () => {
    const store = new ComposerDraftStore({ logger, nowMs });
    store.set('c1', 'hello');
    expect(store.get('c1')?.text).toBe('hello');
    expect(existsSync(join(dir, 'composer-drafts.json'))).toBe(false);
  });
  test('the new-chat placeholder "new" is never a server draft', () => {
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    store.set('new', 'typed on one surface, belongs to no chat');
    expect(store.get('new')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test('a "new" entry already on disk is dropped on load', () => {
    writeFileSync(
      join(dir, 'composer-drafts.json'),
      JSON.stringify({
        new: { text: 'stale', updatedAt: now },
        c1: { text: 'real', updatedAt: now },
      }),
    );
    const store = new ComposerDraftStore({ dataDir: dir, logger, nowMs });
    expect(store.list().map((e) => e.chatId)).toEqual(['c1']);
  });
});
