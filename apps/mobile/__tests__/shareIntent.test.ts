// lib/shareIntent.ts — pure resolver for what the native PatchShare module
// hands over (plugins/withShareIntent.js): text, files, or both, plus the
// streams it could not copy. Kept unit-testable without a native module.

import { describe, it, expect } from 'vitest';
import { resolveShare } from '../src/lib/shareIntent';

describe('resolveShare', () => {
  it('shared text, trimmed', () => {
    expect(resolveShare({ text: '  https://example.com/article \n' })).toEqual({
      payload: { text: 'https://example.com/article', files: [] },
      errors: [],
    });
  });

  it('an old APK payload (text only, no files key) still resolves', () => {
    expect(resolveShare({ text: 'hello' }).payload).toEqual({ text: 'hello', files: [] });
  });

  it('nothing at all is no share', () => {
    expect(resolveShare(null)).toEqual({ payload: null, errors: [] });
    expect(resolveShare(undefined)).toEqual({ payload: null, errors: [] });
    expect(resolveShare({})).toEqual({ payload: null, errors: [] });
  });

  it('blank text with no files is no share', () => {
    expect(resolveShare({ text: '   \n\t ' }).payload).toBeNull();
    expect(resolveShare({ text: '', files: [] }).payload).toBeNull();
  });

  it('files alone are a share, each typed image or file by MIME', () => {
    const r = resolveShare({
      files: [
        { uri: 'file:///c/1.png', name: 'shot.png', mimeType: 'image/png' },
        { uri: 'file:///c/2.zip', name: 'code.zip', mimeType: 'application/zip' },
      ],
    });
    expect(r.payload).toEqual({
      text: null,
      files: [
        { uri: 'file:///c/1.png', name: 'shot.png', mimeType: 'image/png', kind: 'image' },
        { uri: 'file:///c/2.zip', name: 'code.zip', mimeType: 'application/zip', kind: 'file' },
      ],
    });
  });

  it('an image with a caption keeps both', () => {
    const r = resolveShare({
      text: 'look at this',
      files: [{ uri: 'file:///c/1.jpg', name: '1.jpg', mimeType: 'image/jpeg' }],
    });
    expect(r.payload?.text).toBe('look at this');
    expect(r.payload?.files).toHaveLength(1);
  });

  it('an entry with no uri is reported, never silently dropped', () => {
    const r = resolveShare({ files: [{ name: 'lost.pdf', mimeType: 'application/pdf' }, {}] });
    expect(r.payload).toBeNull();
    expect(r.errors).toEqual([
      'lost.pdf: no file was handed over',
      'a shared file: no file was handed over',
    ]);
  });

  it('native copy failures pass through alongside the files that made it', () => {
    const r = resolveShare({
      files: [{ uri: 'file:///c/ok', name: 'ok.txt', mimeType: '' }],
      errors: ['big.mov: no space left'],
    });
    expect(r.errors).toEqual(['big.mov: no space left']);
    // An unnamed type is labelled as unknown binary, not guessed.
    expect(r.payload?.files[0]).toMatchObject({
      mimeType: 'application/octet-stream',
      kind: 'file',
    });
  });

  it('a file with no name still gets a label', () => {
    const r = resolveShare({ files: [{ uri: 'file:///c/x', mimeType: 'text/plain' }] });
    expect(r.payload?.files[0]?.name).toBe('shared file');
  });
});
