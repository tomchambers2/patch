import { describe, it, expect } from 'vitest';
import { hookImages } from '../lib/hookImages.js';
import type { OutgoingFile } from '../lib/sendQueue.js';

function out(name: string, type: string, kind: 'image' | 'file' = 'image'): OutgoingFile {
  return {
    file: new File([new Uint8Array([104, 101, 108, 108, 111])], name, { type }),
    name,
    kind,
  };
}

describe('hookImages', () => {
  it('encodes image attachments as base64 with their media type, skipping other files', async () => {
    const { images, skipped } = await hookImages([
      out('a.png', 'image/png'),
      out('n.txt', 'text/plain', 'file'),
    ]);
    expect(images).toEqual([{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
    expect(skipped).toEqual([]);
  });

  it('no attachments is no images', async () => {
    expect(await hookImages([])).toEqual({ images: [], skipped: [] });
  });

  it('an image that cannot be re-encoded is skipped with a reason, not thrown', async () => {
    const { images, skipped } = await hookImages([out('a.bmp', 'image/bmp')]);
    expect(images).toEqual([]);
    expect(skipped[0]).toMatch(/a\.bmp not checked/);
  });

  it('an oversize image is skipped with a reason when it cannot be resized', async () => {
    const big = new File([new Uint8Array(5_000_000)], 'big.png', { type: 'image/png' });
    const { images, skipped } = await hookImages([{ file: big, name: 'big.png', kind: 'image' }]);
    expect(images).toEqual([]);
    expect(skipped[0]).toMatch(/big\.png not checked/);
  });

  it('more than the cap keeps the first five and reports the rest', async () => {
    const six = Array.from({ length: 6 }, (_, i) => out(`${i}.png`, 'image/png'));
    const { images, skipped } = await hookImages(six);
    expect(images).toHaveLength(5);
    expect(skipped).toEqual(['5.png not checked: hooks see at most 5 images']);
  });
});
