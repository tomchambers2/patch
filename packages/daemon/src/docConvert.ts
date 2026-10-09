// Word <-> Markdown conversion (spec/14 § Document editor, step 3 of 3).
//
// Pure functions: no daemon/chat state, filesystem access limited to the
// paths and directories callers pass in. `chatRunner.ts`'s `convertDocx` /
// `exportDoc` resolve a chatId + chat-relative path to an absolute one and
// call in here, the same split `docSidecar.ts` uses.
//
// No `pandoc` on this host (checked — `which pandoc` finds nothing), and a
// native binary would need installing separately per host type anyway, so
// this is built entirely on pure-JS libraries that pnpm already installs
// everywhere the host runs:
//   - Import: `mammoth` (.docx -> HTML — real `<table>` markup, and a
//     `messages` array naming anything it couldn't carry over) piped into
//     `turndown` + the GFM plugin (HTML -> Markdown, with table support —
//     mammoth's OWN built-in Markdown writer has no `<table>` handling at
//     all, so going through HTML is load-bearing, not a style choice).
//   - Export .docx: built directly from the parsed Markdown AST with the
//     `docx` library — real OOXML (a zip of WordML), not an HTML-wrapped
//     `.doc`, so it opens correctly in Word and round-trips through a parser
//     (mammoth itself, in the tests).
//   - Export .pdf: Markdown -> HTML (same AST, via remark-rehype) -> a real
//     page, rendered to PDF by the headless Chromium `playwright` already
//     installs for the agent-browser feature (`browser.ts`) — so there is no
//     extra component to install for this path specifically.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import turndownGfm from 'turndown-plugin-gfm';
import JSZip from 'jszip';
import { imageSize } from 'image-size';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { BrowserNotInstalledError } from './browser.js';

// ---------------------------------------------------------------------------
// Import: .docx -> Markdown
// ---------------------------------------------------------------------------

export interface DocxImportResult {
  markdown: string;
  warnings: string[];
}

const IMAGE_EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
};

/**
 * Raw-XML scan for the things mammoth converts silently but this feature's
 * own DONE WHEN requires surfacing: tracked changes (mammoth bakes the
 * post-accept text into its output with no trace left), embedded OLE
 * objects/controls (dropped outright — mammoth has nothing to convert them
 * to), and multi-column sections (flattened to one column). Cheap regex over
 * `word/document.xml`, not a full OOXML parse — these are presence checks,
 * not structural ones.
 */
/**
 * mammoth wraps every table cell's content in its own `<p>` (Word has no
 * concept of an inline cell) — turndown-plugin-gfm's `cell()` rule joins
 * cell content with a bare space and has no idea those paragraph boundaries
 * exist, so a cell survives as `<td><p>Name</p></td>` and turndown's own
 * paragraph rule then puts literal blank lines INSIDE the pipe row, breaking
 * it as a table row entirely. Flattened before turndown ever sees it —
 * a GFM table cell can hold `<br>`-separated lines but never a blank one.
 */
function stripParagraphsInTableCells(html: string): string {
  return html.replace(
    /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g,
    (_match, tag: string, attrs: string, inner: string) => {
      const cleaned = inner
        .replace(/<p[^>]*>/g, '')
        .replace(/<\/p>/g, '<br>')
        .replace(/(<br>)+$/, '');
      return `<${tag}${attrs}>${cleaned}</${tag}>`;
    },
  );
}

async function scanForUnsupportedParts(docxPath: string): Promise<string[]> {
  const warnings: string[] = [];
  const zip = await JSZip.loadAsync(readFileSync(docxPath));
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (documentXml === undefined) return warnings;
  if (/<w:ins\b|<w:del\b/.test(documentXml)) {
    warnings.push(
      'Tracked changes were present in the original document — the accepted text was kept, the change history was not.',
    );
  }
  if (/<w:object\b|<w:oleObject\b|<w:control\b/.test(documentXml)) {
    warnings.push(
      'One or more embedded objects (e.g. an embedded spreadsheet or OLE object) were skipped.',
    );
  }
  if (/<w:cols\b[^>]*w:num="(?:[2-9]|[1-9]\d)"/.test(documentXml)) {
    warnings.push('A multi-column layout was flattened to a single column.');
  }
  return warnings;
}

/**
 * `docxAbsPath` -> `{markdown, warnings}`. Images are extracted to real
 * files in `imagesDir` (named `image1.<ext>`, `image2.<ext>`, …) and
 * referenced from the Markdown by a path relative to `mdDir` — never
 * inlined as base64, which would make the `.md` unreadable as prose and
 * balloon every version `recordVersion` keeps.
 */
export async function importDocx(
  docxAbsPath: string,
  imagesDir: string,
  mdDir: string,
): Promise<DocxImportResult> {
  let imageCount = 0;
  const result = await mammoth.convertToHtml(
    { path: docxAbsPath },
    {
      convertImage: mammoth.images.imgElement(async (element) => {
        imageCount += 1;
        const ext = IMAGE_EXT_BY_CONTENT_TYPE[element.contentType] ?? 'png';
        const filename = `image${imageCount}.${ext}`;
        mkdirSync(imagesDir, { recursive: true });
        const base64 = await element.read('base64');
        writeFileSync(join(imagesDir, filename), Buffer.from(base64, 'base64'));
        const relPath = relative(mdDir, join(imagesDir, filename)).split(sep).join('/');
        return { src: relPath };
      }),
    },
  );

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  turndown.use(turndownGfm.gfm);
  const markdown = turndown.turndown(stripParagraphsInTableCells(result.value)).trim() + '\n';

  const warnings = [
    ...result.messages.filter((m) => m.type === 'warning').map((m) => m.message),
    ...(await scanForUnsupportedParts(docxAbsPath)),
  ];
  return { markdown, warnings };
}

// ---------------------------------------------------------------------------
// Shared: Markdown -> mdast (used by both export paths)
// ---------------------------------------------------------------------------

/** Minimal shape of the mdast nodes this file actually reads — see the note on why there's no `@types/mdast` dependency (none of these libraries ship one, and adding the old, unrelated `mdast` package pulled in a deprecated unmaintained one instead). */
interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  checked?: boolean | null;
  url?: string;
  alt?: string | null;
}

function parseMarkdown(markdown: string): MdNode {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
}

// ---------------------------------------------------------------------------
// Export: Markdown -> .docx
// ---------------------------------------------------------------------------

export interface DocExportResult {
  buffer: Buffer;
  warnings: string[];
}

const HEADING_BY_DEPTH: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

type RunStyle = { bold?: boolean; italics?: boolean; strike?: boolean };

function inlineRuns(nodes: MdNode[], style: RunStyle = {}): (TextRun | ExternalHyperlink)[] {
  const runs: (TextRun | ExternalHyperlink)[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(new TextRun({ text: node.value ?? '', ...style }));
    } else if (node.type === 'inlineCode') {
      runs.push(new TextRun({ text: node.value ?? '', font: 'Courier New' }));
    } else if (node.type === 'strong') {
      runs.push(...inlineRuns(node.children ?? [], { ...style, bold: true }));
    } else if (node.type === 'emphasis') {
      runs.push(...inlineRuns(node.children ?? [], { ...style, italics: true }));
    } else if (node.type === 'delete') {
      runs.push(...inlineRuns(node.children ?? [], { ...style, strike: true }));
    } else if (node.type === 'break') {
      runs.push(new TextRun({ text: '', break: 1 }));
    } else if (node.type === 'link') {
      const textRuns = inlineRuns(node.children ?? [], style).filter(
        (r): r is TextRun => r instanceof TextRun,
      );
      runs.push(
        new ExternalHyperlink({
          link: node.url ?? '',
          children: textRuns.length > 0 ? textRuns : [new TextRun({ text: node.url ?? '' })],
        }),
      );
    } else if (node.children) {
      runs.push(...inlineRuns(node.children, style));
    }
  }
  return runs;
}

type ImageBytes = { bytes: Buffer; ext: 'jpg' | 'png' | 'gif' | 'bmp' };

function normalizeImageExt(raw: string): ImageBytes['ext'] | null {
  const e = raw.toLowerCase();
  if (e === 'jpeg') return 'jpg';
  if (e === 'jpg' || e === 'png' || e === 'gif' || e === 'bmp') return e;
  return null;
}

function resolveImageBytes(url: string, baseDir: string): ImageBytes | null {
  const dataMatch = /^data:image\/(\w+);base64,(.+)$/.exec(url);
  if (dataMatch) {
    const ext = normalizeImageExt(dataMatch[1] ?? '');
    return ext ? { bytes: Buffer.from(dataMatch[2] ?? '', 'base64'), ext } : null;
  }
  if (/^https?:\/\//.test(url)) return null;
  const abs = url.startsWith('/') ? url : join(baseDir, url);
  if (!existsSync(abs)) return null;
  const ext = normalizeImageExt(extname(abs).slice(1));
  return ext ? { bytes: readFileSync(abs), ext } : null;
}

const MAX_IMAGE_WIDTH = 500;

function imageParagraph(img: MdNode, baseDir: string, warnings: string[]): Paragraph {
  const resolved = resolveImageBytes(img.url ?? '', baseDir);
  if (!resolved) {
    warnings.push(`image not embedded (unreadable or unsupported format): ${img.url ?? ''}`);
    return new Paragraph({
      children: [new TextRun({ text: `[image: ${img.alt ?? img.url ?? ''}]`, italics: true })],
    });
  }
  const dims = imageSize(resolved.bytes);
  const naturalWidth = dims.width ?? MAX_IMAGE_WIDTH;
  const naturalHeight = dims.height ?? MAX_IMAGE_WIDTH;
  const scale = naturalWidth > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH / naturalWidth : 1;
  return new Paragraph({
    children: [
      new ImageRun({
        type: resolved.ext,
        data: resolved.bytes,
        transformation: {
          width: Math.round(naturalWidth * scale),
          height: Math.round(naturalHeight * scale),
        },
      }),
    ],
  });
}

function blockToDocxElements(
  node: MdNode,
  baseDir: string,
  listLevel: number,
  warnings: string[],
): (Paragraph | Table)[] {
  switch (node.type) {
    case 'heading':
      return [
        new Paragraph({
          heading: HEADING_BY_DEPTH[node.depth ?? 1] ?? HeadingLevel.HEADING_6,
          children: inlineRuns(node.children ?? []),
        }),
      ];
    case 'paragraph': {
      const children = node.children ?? [];
      const onlyChild = children.length === 1 ? children[0] : undefined;
      if (onlyChild && onlyChild.type === 'image') {
        return [imageParagraph(onlyChild, baseDir, warnings)];
      }
      return [new Paragraph({ children: inlineRuns(children) })];
    }
    case 'blockquote': {
      const out: (Paragraph | Table)[] = [];
      for (const child of node.children ?? []) {
        if (child.type === 'paragraph') {
          out.push(
            new Paragraph({
              indent: { left: 720 },
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 8 } },
              children: inlineRuns(child.children ?? [], { italics: true }),
            }),
          );
        } else {
          out.push(...blockToDocxElements(child, baseDir, listLevel, warnings));
        }
      }
      return out;
    }
    case 'list': {
      const out: (Paragraph | Table)[] = [];
      for (const item of node.children ?? []) {
        const itemChildren = item.children ?? [];
        const paraChild = itemChildren.find((c) => c.type === 'paragraph');
        const inlineChildren = paraChild?.children ?? [];
        const prefix = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
        const runs: (TextRun | ExternalHyperlink)[] = [
          ...(prefix ? [new TextRun({ text: prefix })] : []),
          ...inlineRuns(inlineChildren),
        ];
        out.push(
          node.ordered
            ? new Paragraph({
                numbering: { reference: 'ordered-list', level: listLevel },
                children: runs,
              })
            : new Paragraph({ bullet: { level: listLevel }, children: runs }),
        );
        for (const nested of itemChildren.filter((c) => c.type === 'list')) {
          out.push(...blockToDocxElements(nested, baseDir, listLevel + 1, warnings));
        }
      }
      return out;
    }
    case 'table': {
      const rows = node.children ?? [];
      const tableRows = rows.map(
        (row, ri) =>
          new TableRow({
            children: (row.children ?? []).map(
              (cell) =>
                new TableCell({
                  shading:
                    ri === 0
                      ? { type: ShadingType.CLEAR, fill: 'E8E8E8', color: 'auto' }
                      : undefined,
                  children: [
                    new Paragraph({
                      children: inlineRuns(cell.children ?? [], ri === 0 ? { bold: true } : {}),
                    }),
                  ],
                }),
            ),
          }),
      );
      return [new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } })];
    }
    case 'code': {
      const lines = (node.value ?? '').split('\n');
      return [
        new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' },
          children: lines.flatMap((line, i) => [
            new TextRun({ text: line, font: 'Courier New', break: i === 0 ? undefined : 1 }),
          ]),
        }),
      ];
    }
    case 'thematicBreak':
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA', space: 1 } },
          children: [],
        }),
      ];
    default:
      return node.children
        ? node.children.flatMap((c) => blockToDocxElements(c, baseDir, listLevel, warnings))
        : [];
  }
}

/** Numbering config for ordered lists — up to 4 nesting levels. Unordered lists use docx's own built-in default bullet numbering via the `bullet: {level}` convenience and need no config of their own. */
function orderedListNumbering() {
  return {
    config: [
      {
        reference: 'ordered-list',
        levels: Array.from({ length: 4 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
        })),
      },
    ],
  };
}

/** `markdown` (read from `baseDir`'s own `.md` file, so relative image links resolve against it) -> a real .docx buffer. */
export async function exportMarkdownToDocx(
  markdown: string,
  baseDir: string,
): Promise<DocExportResult> {
  const warnings: string[] = [];
  const tree = parseMarkdown(markdown);
  const children = (tree.children ?? []).flatMap((n) =>
    blockToDocxElements(n, baseDir, 0, warnings),
  );
  const doc = new Document({
    numbering: orderedListNumbering(),
    sections: [{ children: children.length > 0 ? children : [new Paragraph({ children: [] })] }],
  });
  const buffer = Buffer.from(await Packer.toBuffer(doc));
  return { buffer, warnings };
}

// ---------------------------------------------------------------------------
// Export: Markdown -> .pdf
// ---------------------------------------------------------------------------

const PDF_STYLE = `
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.5; max-width: 760px; margin: 2.5cm auto; padding: 0 1cm; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin-top: 1.4em; }
  img { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: #eee; }
  blockquote { border-left: 3px solid #ccc; margin: 1em 0; padding: 0 1em; color: #555; }
  code { font-family: 'Courier New', monospace; background: #f2f2f2; padding: 0 4px; }
  pre { font-family: 'Courier New', monospace; background: #f2f2f2; padding: 10px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
`;

/** Rewrites every local (non-remote, non-data) `src=`/`href=` in `html` to an absolute `file://` URL under `baseDir`, so a headless page with no server behind it can still load the document's own images. */
function resolveLocalImageSrcs(html: string, baseDir: string): string {
  return html.replace(/<img([^>]*)\ssrc="([^"]+)"/g, (full, pre: string, src: string) => {
    if (/^(https?:|data:|file:)/.test(src)) return full;
    const abs = src.startsWith('/') ? src : join(baseDir, src);
    return `<img${pre} src="file://${abs}"`;
  });
}

async function markdownToHtmlFragment(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}

/**
 * `markdown` -> a real PDF, rendered by headless Chromium. Mirrors
 * `browser.ts`'s own `checkChromiumInstalled` — same error, same fix, so a
 * host missing the component gets one consistent message everywhere it
 * matters, not two slightly different ones.
 */
export async function exportMarkdownToPdf(
  markdown: string,
  baseDir: string,
  loadPlaywright: () => Promise<typeof import('playwright')> = () => import('playwright'),
): Promise<Buffer> {
  const { chromium } = await loadPlaywright();
  const execPath = chromium.executablePath();
  if (!existsSync(execPath)) {
    throw new BrowserNotInstalledError(
      `Playwright's Chromium is not installed on this host (expected ${execPath}). ` +
        'Run `npx playwright install chromium` on this host to enable PDF export.',
    );
  }
  const fragment = await markdownToHtmlFragment(markdown);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${PDF_STYLE}</style></head><body>${resolveLocalImageSrcs(fragment, baseDir)}</body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '1.5cm', bottom: '1.5cm', left: '1.5cm', right: '1.5cm' },
    });
    return buffer;
  } finally {
    await browser.close();
  }
}
