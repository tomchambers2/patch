// End-to-end Word import/export suite — spec/14 § Document editor, step 3 of
// 3 — through the FULL real stack:
//
//   surface HTTP  POST /api/chats/:id/doc/convert | /doc/export
//       → server chat-routes → REAL InboundDaemonLink over the REAL serverLink
//         WebSocket
//       → host handleDocConvertRequest / handleDocExportRequest → Host
//         methods (chatRunner.ts), reading/writing real files on disk
//       → patch.doc_convert(.export).response back over the link
//       → server resolves the pending request → a typed HTTP status +
//         (for export) the real binary bytes.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mammoth from 'mammoth';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { startHarness, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

async function spawnChat(harness: E2EHarness, jwt: string, folder: string): Promise<string> {
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { daemonId: harness.daemonId, folder },
  });
  expect(res.statusCode).toBe(202);
  const chatId = (res.json() as { chatId: string }).chatId;
  await until(() => harness.built.chatRegistry.get(chatId) !== undefined, 5000);
  return chatId;
}

function convertDoc(harness: E2EHarness, jwt: string, chatId: string, path: string) {
  return harness.built.app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/doc/convert`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: { path },
  });
}

function exportDoc(harness: E2EHarness, jwt: string, chatId: string, path: string, format: string) {
  return harness.built.app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/doc/export`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: { path, format },
  });
}

async function fixtureDocxBuffer(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun('Quarterly Update')],
          }),
          new Paragraph({ children: [new TextRun('Revenue is up.')] }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('e2e Word import/export over the real server↔host path', () => {
  it('converts a .docx to a .md the chat folder now holds, leaving the original untouched', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('docword-1');
    const docxBytes = await fixtureDocxBuffer();
    writeFileSync(join(h.folder, 'update.docx'), docxBytes);
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await convertDoc(h, jwt, chatId, 'update.docx');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mdPath: string; warnings: string[]; reused: boolean };
    expect(body).toEqual({ mdPath: 'update.md', warnings: [], reused: false });

    const markdown = readFileSync(join(h.folder, 'update.md'), 'utf8');
    expect(markdown).toContain('# Quarterly Update');
    expect(markdown).toContain('Revenue is up.');
    expect(readFileSync(join(h.folder, 'update.docx'))).toEqual(docxBytes);
  });

  it('404s a convert request for an unknown chat', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('docword-2');
    const res = await convertDoc(h, jwt, 'no-such-chat', 'update.docx');
    expect(res.statusCode).toBe(404);
  });

  it('400s converting a non-.docx path', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('docword-3');
    writeFileSync(join(h.folder, 'notes.md'), '# Notes\n');
    const chatId = await spawnChat(h, jwt, h.folder);
    const res = await convertDoc(h, jwt, chatId, 'notes.md');
    expect(res.statusCode).toBe(400);
  });

  it('exports to .docx: writes the file beside the .md and streams back real, openable bytes', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('docword-4');
    writeFileSync(join(h.folder, 'notes.md'), '# Notes\n\nSome **bold** text.\n');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await exportDoc(h, jwt, chatId, 'notes.md', 'docx');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers['content-disposition']).toContain('notes.docx');
    expect(res.headers['x-patch-doc-path']).toBe('notes.docx');

    const bytes = res.rawPayload;
    expect(readFileSync(join(h.folder, 'notes.docx'))).toEqual(bytes);
    const parsed = await mammoth.convertToHtml({ buffer: bytes });
    expect(parsed.value).toContain('Notes');
    expect(parsed.value).toContain('<strong>bold</strong>');
  });

  it('exports to .md, streaming back the document’s own current bytes', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('docword-5');
    writeFileSync(join(h.folder, 'notes.md'), '# Notes\n');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await exportDoc(h, jwt, chatId, 'notes.md', 'md');
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString('utf8')).toBe('# Notes\n');
  });

  it('400s an export with an unknown format', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('docword-6');
    writeFileSync(join(h.folder, 'notes.md'), '# Notes\n');
    const chatId = await spawnChat(h, jwt, h.folder);
    const res = await exportDoc(h, jwt, chatId, 'notes.md', 'txt');
    expect(res.statusCode).toBe(400);
  });

  it('404s exporting a missing file', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('docword-7');
    const chatId = await spawnChat(h, jwt, h.folder);
    const res = await exportDoc(h, jwt, chatId, 'missing.md', 'docx');
    expect(res.statusCode).toBe(404);
  });
});
