// Word import/export (spec/14 § Document editor, step 3 of 3) — exercises
// the `Daemon.convertDocx`/`Daemon.exportDoc` methods the server's
// `patch.doc_convert.request`/`patch.doc_export.request` RPCs and the
// agent's `patch_doc_convert`/`patch_doc_export` tools (mcp.ts →
// `/internal/doc/*`, control.ts) all resolve to — the same harness
// `doc-actions.test.ts` uses for the step-2 doc methods.

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createHistoryReader } from '../src/history.js';
import { readSidecar } from '../src/docSidecar.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-docconv-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-docconv-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: {
      run: async function* () {
        yield { type: 'assistant' as const, content: 'ok', sessionId: 'S1' };
      },
    },
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-docconv-claude-')),
    }),
  });
  return { daemon, events, folder };
}

async function simpleFixtureDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun('Meeting Notes')],
          }),
          new Paragraph({ children: [new TextRun('Discussed the roadmap.')] }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('Daemon.convertDocx', () => {
  it('converts a .docx to a sibling .md, leaving the original untouched', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const docxBytes = await simpleFixtureDocx();
    writeFileSync(join(folder, 'report.docx'), docxBytes);

    const result = await daemon.convertDocx(chatId, 'report.docx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mdPath).toBe('report.md');
    expect(result.value.reused).toBe(false);

    const markdown = readFileSync(join(folder, 'report.md'), 'utf8');
    expect(markdown).toContain('# Meeting Notes');
    expect(markdown).toContain('Discussed the roadmap.');
    // The original .docx is byte-for-byte untouched.
    expect(readFileSync(join(folder, 'report.docx'))).toEqual(docxBytes);
    expect(events.some((e) => e.type === 'patch.file_changed' && e.path === 'report.md')).toBe(
      true,
    );
  });

  it('records what .docx the .md came from, for the reuse check', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'report.docx'), await simpleFixtureDocx());
    await daemon.convertDocx(chatId, 'report.docx');

    const sidecar = readSidecar(join(folder, 'report.md'));
    expect(sidecar.sourceDocx).toEqual({
      path: 'report.docx',
      mtimeMs: statSync(join(folder, 'report.docx')).mtimeMs,
    });
    expect(sidecar.importWarnings).toEqual([]);
  });

  it('reuses the existing .md without reconverting when the .docx has not changed', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'report.docx'), await simpleFixtureDocx());
    await daemon.convertDocx(chatId, 'report.docx');

    // An edit made to the .md since the first conversion — must survive a
    // second convert of the SAME, unchanged .docx.
    writeFileSync(join(folder, 'report.md'), '# Meeting Notes (edited by hand)\n');

    const second = await daemon.convertDocx(chatId, 'report.docx');
    expect(second).toEqual({
      ok: true,
      value: { mdPath: 'report.md', warnings: [], reused: true },
    });
    expect(readFileSync(join(folder, 'report.md'), 'utf8')).toBe(
      '# Meeting Notes (edited by hand)\n',
    );
  });

  it('reconverts, keeping the previous content as a version, when the .docx changed since', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const docxPath = join(folder, 'report.docx');
    writeFileSync(docxPath, await simpleFixtureDocx());
    await daemon.convertDocx(chatId, 'report.docx');
    // A real edit through the host's own write path — see below why a raw
    // `writeFileSync` wouldn't do: history only versions changes that went
    // through `writeFile` (an out-of-band write is invisible to it either
    // way, same as a `.git` checkout touching the file would be).
    daemon.writeFile(chatId, 'report.md', '# hand-edited\n');

    // Re-save the .docx from "Word" — new content, new mtime.
    const newer = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun('Revised Notes')],
            }),
          ],
        },
      ],
    });
    writeFileSync(docxPath, Buffer.from(await Packer.toBuffer(newer)));
    utimesSync(docxPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const second = await daemon.convertDocx(chatId, 'report.docx');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reused).toBe(false);
    expect(readFileSync(join(folder, 'report.md'), 'utf8')).toContain('Revised Notes');

    const sidecar = readSidecar(join(folder, 'report.md'));
    expect(sidecar.versions.some((v) => v.content === '# hand-edited\n')).toBe(true);
  });

  it('refuses a non-.docx path', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), '# Notes\n');
    const result = await daemon.convertDocx(chatId, 'notes.md');
    expect(result).toEqual({ ok: false, code: 'invalid', message: expect.any(String) });
  });

  it('refuses an unknown chat', async () => {
    const { daemon } = setup();
    const result = await daemon.convertDocx('no-such-chat', 'report.docx');
    expect(result).toEqual({ ok: false, code: 'chat_not_found', message: expect.any(String) });
  });
});

describe('Daemon.exportDoc', () => {
  it('exports to .docx, writing the file beside the .md and returning its bytes', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), '# Notes\n\nSome **bold** text.\n');

    const result = await daemon.exportDoc(chatId, 'notes.md', 'docx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe('notes.docx');
    expect(result.value.warnings).toEqual([]);
    expect(readFileSync(join(folder, 'notes.docx'))).toEqual(result.value.buffer);

    const parsed = await mammoth.convertToHtml({ path: join(folder, 'notes.docx') });
    expect(parsed.value).toContain('Notes');
    expect(parsed.value).toContain('<strong>bold</strong>');
    expect(events.some((e) => e.type === 'patch.file_changed' && e.path === 'notes.docx')).toBe(
      true,
    );
  });

  it('exports to .md as the document’s own current bytes, with nothing new written', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), '# Notes\n');

    const result = await daemon.exportDoc(chatId, 'notes.md', 'md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe('notes.md');
    expect(result.value.buffer.toString('utf8')).toBe('# Notes\n');
  });

  it('refuses a non-.md path', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'report.docx'), await simpleFixtureDocx());
    const result = await daemon.exportDoc(chatId, 'report.docx', 'docx');
    expect(result).toEqual({ ok: false, code: 'invalid', message: expect.any(String) });
  });

  it('refuses a missing file', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const result = await daemon.exportDoc(chatId, 'missing.md', 'docx');
    expect(result).toEqual({ ok: false, code: 'not_found', message: expect.any(String) });
  });
});
