// Importing the standalone Pad service's designs (spec/14 § Pads).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importStandalone } from '../src/pads/import-standalone.js';
import { PadStore } from '../src/pads/store.js';

function standalone() {
  const root = mkdtempSync(join(tmpdir(), 'pad-import-'));
  const from = join(root, 'pad');
  mkdirSync(join(from, 'designs'), { recursive: true });
  const folder = (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
    return dir;
  };
  const design = (slug: string, dir: string, extra: object = {}) => {
    writeFileSync(
      join(from, 'designs', `${slug}.json`),
      JSON.stringify({
        slug,
        name: slug.toUpperCase(),
        dir,
        chat: 'c1',
        createdAt: 100,
        updatedAt: 200,
        changes: [
          {
            id: 'a1',
            kind: 'delete',
            screen: 'index',
            status: 'sent',
            batch: 'b1',
            createdAt: 150,
            target: { selector: 'h1', label: 'h1' },
          },
        ],
        batches: [
          {
            id: 'b1',
            sentAt: 160,
            changeIds: ['a1'],
            status: 'sent',
            pictures: [{ name: 'b1-1.png', numbers: [1] }],
          },
        ],
        ...extra,
      }),
    );
  };
  return { root, from, folder, design, padsDir: join(root, 'patch-pads') };
}

describe('importStandalone', () => {
  it('brings a design over whole: files, changes, an unanswered batch, journal and pictures', () => {
    const t = standalone();
    t.design('care', t.folder('care', { 'index.html': '<title>Home</title>', 'a.css': 'x{}' }));
    writeFileSync(join(t.from, 'designs', 'care.journal.jsonl'), '{"op":"add"}\n');
    mkdirSync(join(t.from, 'pictures', 'care'), { recursive: true });
    writeFileSync(join(t.from, 'pictures', 'care', 'b1-1.png'), 'png');

    const res = importStandalone({ from: t.from, padsDir: t.padsDir });
    expect(res).toEqual({ imported: ['care'], skipped: [], failed: [] });
    const store = new PadStore(t.padsDir);
    const pad = store.mustGet('care');
    expect(pad).toMatchObject({
      id: 'care',
      name: 'CARE',
      chatId: 'c1',
      app: null,
      createdAt: 100,
      updatedAt: 200,
    });
    expect(pad.batches[0]).toMatchObject({ status: 'sent' }); // still awaiting the agent
    expect(pad.changes[0]).toMatchObject({ id: 'a1', status: 'sent' });
    expect(readFileSync(join(store.filesDir('care'), 'a.css'), 'utf8')).toBe('x{}');
    expect(store.journalFor('care')).toHaveLength(1);
    expect(existsSync(join(store.picturesDir('care'), 'b1-1.png'))).toBe(true);
  });

  it('skips what is already in Patch, never overwriting it', () => {
    const t = standalone();
    t.design('care', t.folder('care', { 'index.html': '<title>Home</title>' }));
    importStandalone({ from: t.from, padsDir: t.padsDir });
    const store = new PadStore(t.padsDir);
    const pad = store.mustGet('care');
    pad.name = 'Renamed in Patch';
    store.save(pad);
    const again = importStandalone({ from: t.from, padsDir: t.padsDir });
    expect(again.skipped).toEqual([{ slug: 'care', reason: 'already in Patch' }]);
    expect(store.mustGet('care').name).toBe('Renamed in Patch');
  });

  it('reports a design whose folder is gone or whose screens cannot be read, and imports nothing of it', () => {
    const t = standalone();
    t.design('gone', join(t.root, 'no-such-folder'));
    t.design('empty', t.folder('empty', { 'notes.txt': 'x' }));
    t.design('fine', t.folder('fine', { 'index.html': '' }));
    const res = importStandalone({ from: t.from, padsDir: t.padsDir });
    expect(res.imported).toEqual(['fine']);
    expect(res.failed.map((f) => f.slug).sort()).toEqual(['empty', 'gone']);
    expect(res.failed.find((f) => f.slug === 'gone')!.reason).toMatch(/no longer exists/);
    expect(res.failed.find((f) => f.slug === 'empty')!.reason).toMatch(/screens cannot be read/);
    expect(new PadStore(t.padsDir).get('gone')).toBeNull();
    expect(new PadStore(t.padsDir).get('empty')).toBeNull();
  });
});
