// Pads — store, screens and message formatting (spec/14 § Pads).

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PadError, PadStore, slugify, validId, validateChange } from '../src/pads/store.js';
import { screensFor, ScreensError } from '../src/pads/screens.js';
import { batchMessage, describeChange } from '../src/pads/format.js';

const T = { selector: 'html > body > h1:nth-of-type(1)', label: 'h1 "Credit"' };

let store: PadStore;
beforeEach(() => {
  store = new PadStore(mkdtempSync(join(tmpdir(), 'pads-store-')));
  store.create({ name: 'Settings', app: 'Patch', chatId: 'c1', device: 'desktop' });
});

describe('ids', () => {
  it('slugifies names and refuses traversal', () => {
    expect(slugify('Patch Settings — v2!')).toBe('patch-settings-v2');
    expect(slugify('***')).toBe('pad');
    expect(validId('ok-1')).toBe(true);
    expect(validId('../x')).toBe(false);
  });
  it('gives a second pad of the same name its own id', () => {
    const b = store.create({ name: 'Settings', app: null, chatId: 'c1', device: 'phone' });
    expect(b.id).not.toBe('settings');
    expect(store.list()).toHaveLength(2);
  });
  it('needs a chat to deliver to', () => {
    expect(() => store.create({ name: 'x', app: null, chatId: '', device: 'desktop' })).toThrow(
      /chatId is required/,
    );
  });
});

describe('changes', () => {
  it('folds repeated moves of one element into one pending move', () => {
    const a = store.addChange('settings', {
      screen: 'home',
      kind: 'move',
      target: T,
      dx: 10,
      dy: 0,
    });
    const b = store.addChange('settings', {
      screen: 'home',
      kind: 'move',
      target: T,
      dx: 40,
      dy: 5,
    });
    expect(b.id).toBe(a.id);
    expect(store.get('settings')!.changes).toHaveLength(1);
    expect(store.get('settings')!.changes[0]).toMatchObject({ dx: 40, dy: 5 });
  });
  it('keeps the original before-text through a second text edit', () => {
    store.addChange('settings', {
      screen: 'home',
      kind: 'text',
      target: T,
      before: 'Credit',
      after: 'Credits',
    });
    const c = store.addChange('settings', {
      screen: 'home',
      kind: 'text',
      target: T,
      before: 'Credits',
      after: 'More',
    });
    expect(c).toMatchObject({ before: 'Credit', after: 'More' });
  });
  it('never folds notes or deletions', () => {
    store.addChange('settings', { screen: 'home', kind: 'note', target: T, text: 'a' });
    store.addChange('settings', { screen: 'home', kind: 'note', target: T, text: 'b' });
    store.addChange('settings', { screen: 'home', kind: 'delete', target: T });
    store.addChange('settings', { screen: 'home', kind: 'delete', target: T });
    expect(store.get('settings')!.changes).toHaveLength(4);
  });
  it('journals add, update and remove so nothing is lost to a delete', () => {
    const c = store.addChange('settings', { screen: 'home', kind: 'note', target: T, text: 'a' });
    store.updateChange('settings', c.id, { text: 'b' });
    store.removeChange('settings', c.id);
    expect(store.journalFor('settings').map((j) => j.op)).toEqual(['add', 'update', 'remove']);
    expect(store.get('settings')!.changes).toHaveLength(0);
  });
  it('rejects bad input loudly', () => {
    expect(() =>
      validateChange({ kind: 'move', target: T, screen: 'home', dx: 'x', dy: 1 }),
    ).toThrow(PadError);
    expect(() => validateChange({ kind: 'nope', target: T, screen: 'home' })).toThrow(
      /kind must be/,
    );
    expect(() => validateChange({ kind: 'delete', target: T })).toThrow(/screen is required/);
    expect(() =>
      validateChange({
        kind: 'draw',
        target: T,
        screen: 'home',
        points: [[1, 1]],
        color: '#fff',
        width: 3,
      }),
    ).toThrow(/points/);
  });
  it('a corrupt pad.json is a loud failure, not an empty pad', () => {
    writeFileSync(join(store.dir('settings'), 'pad.json'), '{ nope');
    expect(() => store.get('settings')).toThrow();
  });
});

describe('batches', () => {
  it('marks only the batch’s changes sent and reply closes the oldest open batch', () => {
    const c = store.addChange('settings', { screen: 'home', kind: 'delete', target: T });
    const { batch } = store.openBatch('settings');
    // A change made while the pictures were drawing must stay pending.
    const late = store.addChange('settings', {
      screen: 'home',
      kind: 'note',
      target: T,
      text: 'late',
    });
    store.commitBatch('settings', batch);
    const pad = store.get('settings')!;
    expect(pad.changes.find((x) => x.id === c.id)!.status).toBe('sent');
    expect(pad.changes.find((x) => x.id === late.id)!.status).toBe('pending');
    store.reply('settings', 'done it');
    const after = store.get('settings')!;
    expect(after.changes.find((x) => x.id === c.id)!.status).toBe('done');
    expect(after.batches[0]).toMatchObject({ status: 'done', reply: 'done it' });
  });
  it('refuses a reply when no batch is open', () => {
    expect(() => store.reply('settings', 'hi')).toThrow(/no open batch for this pad/);
  });
  it('refuses to send nothing', () => {
    expect(() => store.openBatch('settings')).toThrow(/nothing to send/);
  });
});

describe('screens', () => {
  const mk = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pads-screens-'));
    for (const [n, c] of Object.entries(files)) {
      mkdirSync(join(dir, n, '..'), { recursive: true });
      writeFileSync(join(dir, n), c);
    }
    return dir;
  };
  it('lists top-level html files, index first, named by title', () => {
    const dir = mk({ 'b.html': '<title>Bee</title>', 'index.html': '<title>Home</title>' });
    expect(screensFor(dir).map((s) => [s.id, s.name])).toEqual([
      ['index', 'Home'],
      ['b', 'Bee'],
    ]);
  });
  it('reads pad.json, including #fragment paths', () => {
    const dir = mk({
      'index.html': '',
      'pad.json': JSON.stringify({
        screens: [
          { name: 'A', path: 'index.html#a' },
          { name: 'B', path: 'index.html#b' },
        ],
      }),
    });
    expect(screensFor(dir).map((s) => s.path)).toEqual(['index.html#a', 'index.html#b']);
  });
  it('fails loudly on a bad manifest', () => {
    expect(() => screensFor(mk({ 'pad.json': '{' }))).toThrow(ScreensError);
    expect(() =>
      screensFor(
        mk({ 'pad.json': JSON.stringify({ screens: [{ name: 'A', path: '../x.html' }] }) }),
      ),
    ).toThrow(/outside/);
    expect(() => screensFor(mk({ 'x.txt': '' }))).toThrow(/no .html files/);
  });
});

describe('message', () => {
  it('describes each kind in plain terms', () => {
    expect(describeChange({ ...base('move'), dx: -5, dy: 10 } as never)).toBe(
      'Moved h1 "Credit" 5px left, 10px down',
    );
    expect(describeChange({ ...base('delete') } as never)).toBe('Deleted h1 "Credit"');
  });
  it('numbers changes screen by screen, with their pictures, and says how to reply', () => {
    const pad = store.get('settings')!;
    const text = batchMessage({
      pad,
      changes: [
        { ...base('delete'), screen: 'home' },
        { ...base('note'), screen: 'about', text: 'bigger' },
      ] as never,
      screens: [
        { id: 'home', name: 'Home', path: 'index.html' },
        { id: 'about', name: 'About', path: 'about.html' },
      ],
      pictures: [
        { n: 1, url: 'https://x/p1.png' },
        { n: 2, problem: 'boom' },
      ],
    });
    expect(text).toContain('[Pad] Tom sent 2 changes on "Settings" (pad id: settings)');
    expect(text).toContain('Screen "Home" (index.html):');
    expect(text).toContain('picture: https://x/p1.png');
    expect(text).toContain('no picture: boom');
    expect(text.split('\n').at(-1)).toBe(
      'Open each picture, make the changes in the source, then call patch_pad_update(padId, dir) and patch_pad_reply(padId, text)',
    );
  });
});

function base(kind: string): Record<string, unknown> {
  return { id: 'x', kind, screen: 'home', status: 'pending', createdAt: 0, target: T };
}

describe('screen widths', () => {
  it('keeps a captured screen’s width and refuses a silly one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pads-width-'));
    writeFileSync(join(dir, 'a.html'), '');
    writeFileSync(
      join(dir, 'pad.json'),
      JSON.stringify({ screens: [{ name: 'A', path: 'a.html', width: 1400 }] }),
    );
    expect(screensFor(dir)[0]).toMatchObject({ id: 'a', width: 1400 });
    writeFileSync(
      join(dir, 'pad.json'),
      JSON.stringify({ screens: [{ name: 'A', path: 'a.html', width: 5 }] }),
    );
    expect(() => screensFor(dir)).toThrow(/width outside/);
  });
});
