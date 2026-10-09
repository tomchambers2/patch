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
    const images = await hookImages([
      out('a.png', 'image/png'),
      out('n.txt', 'text/plain', 'file'),
    ]);
    expect(images).toEqual([{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
  });

  it('no attachments is no images', async () => {
    expect(await hookImages([])).toEqual([]);
  });

  it('an unsupported image type fails rather than being dropped', async () => {
    await expect(hookImages([out('a.bmp', 'image/bmp')])).rejects.toThrow(/unsupported image type/);
  });

  it('more than the cap fails', async () => {
    const six = Array.from({ length: 6 }, (_, i) => out(`${i}.png`, 'image/png'));
    await expect(hookImages(six)).rejects.toThrow(/at most 5/);
  });
});
