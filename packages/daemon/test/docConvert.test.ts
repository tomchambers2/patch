// Word <-> Markdown conversion (spec/14 § Document editor, step 3 of 3).
//
// Real fixtures, not mocks: the .docx import tests convert a .docx built
// with the SAME `docx` library the export path uses (there is no Word on
// this host to author one by hand), and the export tests parse their own
// output back with a real parser (mammoth for .docx, pdf-parse for .pdf) —
// "looks right" is not checked, "opens correctly" is.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import { importDocx, exportMarkdownToDocx, exportMarkdownToPdf } from '../src/docConvert.js';

// A real, valid 1x1 red PNG (smallest legal PNG, widely used as a test fixture).
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function buildFixtureDocx(imagePath: string): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun('Report Title')],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: 'Some ' }),
              new TextRun({ text: 'bold', bold: true }),
              new TextRun({ text: ' prose.' }),
            ],
          }),
          new Paragraph({ bullet: { level: 0 }, children: [new TextRun('First item')] }),
          new Paragraph({ bullet: { level: 0 }, children: [new TextRun('Second item')] }),
          new Table({
            rows: [
              new TableRow({
                // mammoth only emits a real `<th>` header row (and so only
                // then does turndown-plugin-gfm's `tables` rule recognise a
                // GFM table at all — see docConvert.ts's header comment)
                // for a row Word itself marked as a repeating header row.
                tableHeader: true,
                children: [
                  new TableCell({ children: [new Paragraph('Name')] }),
                  new TableCell({ children: [new Paragraph('Score')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Ada')] }),
                  new TableCell({ children: [new Paragraph('10')] }),
                ],
              }),
            ],
          }),
          new Paragraph({
            children: [
              new ImageRun({
                type: 'png',
                data: readFileSync(imagePath),
                transformation: { width: 1, height: 1 },
              }),
            ],
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('importDocx', () => {
  it('converts headings, bold text, lists, a table and an image, extracting the image to a real file', async () => {
    const dir = tmpDir('patch-docconvert-import-');
    const imgSrc = join(dir, 'fixture.png');
    writeFileSync(imgSrc, ONE_PX_PNG);
    const docxPath = join(dir, 'report.docx');
    writeFileSync(docxPath, await buildFixtureDocx(imgSrc));

    const imagesDir = join(dir, 'report.files');
    const { markdown, warnings } = await importDocx(docxPath, imagesDir, dir);

    expect(markdown).toContain('# Report Title');
    expect(markdown).toMatch(/\*\*bold\*\*|__bold__/);
    expect(markdown).toContain('First item');
    expect(markdown).toContain('Second item');
    // GFM table — mammoth's own markdown writer can't do this at all (see
    // docConvert.ts's header comment), so this is the load-bearing assertion
    // that going through HTML + turndown was necessary.
    expect(markdown).toContain('| Name');
    expect(markdown).toContain('| Ada');
    expect(markdown).toMatch(/!\[[^\]]*\]\(report\.files\/image1\.png\)/);
    expect(existsSync(join(imagesDir, 'image1.png'))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('reports tracked changes, embedded objects and multi-column layout instead of silently dropping them', async () => {
    // Real OOXML markers for each of the three unsupported features, spliced
    // into a genuinely valid docx's own `word/document.xml` (mammoth needs
    // the real namespace declarations a hand-written XML snippet wouldn't
    // carry) — a direct, deliberately narrow test of
    // `scanForUnsupportedParts`, not of mammoth's own conversion.
    const dir = tmpDir('patch-docconvert-warnings-');
    const imgSrc = join(dir, 'px.png');
    writeFileSync(imgSrc, ONE_PX_PNG);
    const zip = await JSZip.loadAsync(await buildFixtureDocx(imgSrc));
    const original = await zip.file('word/document.xml')!.async('string');
    const markers =
      '<w:p><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>' +
      '<w:p><w:r><w:object><w:oleObject/></w:object></w:r></w:p>' +
      '<w:sectPr><w:cols w:num="3"/></w:sectPr>';
    expect(original).toContain('</w:body>');
    zip.file('word/document.xml', original.replace('</w:body>', `${markers}</w:body>`));
    const mergedPath = join(dir, 'merged.docx');
    writeFileSync(mergedPath, await zip.generateAsync({ type: 'nodebuffer' }));

    const { warnings } = await importDocx(mergedPath, join(dir, 'images'), dir);
    expect(warnings.some((w) => /tracked changes/i.test(w))).toBe(true);
    expect(warnings.some((w) => /embedded object/i.test(w))).toBe(true);
    expect(warnings.some((w) => /multi-column/i.test(w))).toBe(true);
  });
});

describe('exportMarkdownToDocx', () => {
  it('produces a real .docx a parser can open, round-tripping headings, lists, a table and an image', async () => {
    const dir = tmpDir('patch-docconvert-export-docx-');
    writeFileSync(join(dir, 'pic.png'), ONE_PX_PNG);
    const markdown = [
      '# Export Test',
      '',
      'Some **bold** and *italic* text with a [link](https://example.com).',
      '',
      '- alpha',
      '- beta',
      '',
      '1. first',
      '2. second',
      '',
      '| Col A | Col B |',
      '| --- | --- |',
      '| x | y |',
      '',
      '![a picture](pic.png)',
      '',
    ].join('\n');

    const { buffer, warnings } = await exportMarkdownToDocx(markdown, dir);
    expect(warnings).toEqual([]);

    // Parse it back with mammoth — a real parser, distinct from the `docx`
    // library that built it, so this is a genuine round-trip check rather
    // than the same code agreeing with itself.
    const parsed = await mammoth.convertToHtml({ buffer });
    expect(parsed.value).toContain('Export Test');
    expect(parsed.value).toContain('<strong>bold</strong>');
    expect(parsed.value).toContain('<em>italic</em>');
    expect(parsed.value).toContain('alpha');
    expect(parsed.value).toContain('beta');
    expect(parsed.value).toContain('first');
    expect(parsed.value).toMatch(/<table>/);
    expect(parsed.value).toContain('x');
    expect(parsed.value).toMatch(/<img/);
    expect(parsed.value).toMatch(/href="https:\/\/example\.com"/);
  });

  it('names an image it could not embed instead of silently dropping it', async () => {
    const dir = tmpDir('patch-docconvert-export-missing-image-');
    const { warnings } = await exportMarkdownToDocx('![gone](does-not-exist.png)\n', dir);
    expect(warnings.some((w) => /does-not-exist\.png/.test(w))).toBe(true);
  });
});

describe('exportMarkdownToPdf', () => {
  it('produces a real PDF a parser can extract the document text from', async () => {
    const dir = tmpDir('patch-docconvert-export-pdf-');
    const markdown = '# PDF Export Test\n\nSome exported **prose** for the PDF path.\n';
    const buffer = await exportMarkdownToPdf(markdown, dir);
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    expect(parsed.text).toContain('PDF Export Test');
    expect(parsed.text).toContain('exported');
  }, 30_000);
});
