// The composer's image attachments, in the shape `POST /api/hooks/check` takes
// (spec/20-hooks.md § Hook context) — so a prompt hook judges what the agent
// will actually be shown, not just the words. No fallback: an image a hook
// can't be given fails the check rather than being silently left out.

import { HOOK_IMAGES_MAX, HOOK_IMAGE_MAX_BASE64, type HookImage } from '@patch/wire/hooks';
import type { OutgoingFile } from './sendQueue.js';

const MEDIA_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export async function hookImages(files: OutgoingFile[]): Promise<HookImage[]> {
  const images = files.filter((f) => f.kind === 'image');
  if (images.length > HOOK_IMAGES_MAX) {
    throw new Error(`hook check takes at most ${HOOK_IMAGES_MAX} images, got ${images.length}`);
  }
  return Promise.all(
    images.map(async (f) => {
      if (!MEDIA_TYPES.has(f.file.type)) {
        throw new Error(`hook check can't take ${f.name}: unsupported image type "${f.file.type}"`);
      }
      const data = toBase64(await f.file.arrayBuffer());
      if (data.length > HOOK_IMAGE_MAX_BASE64) {
        throw new Error(`hook check can't take ${f.name}: image too large`);
      }
      return { mediaType: f.file.type as HookImage['mediaType'], data };
    }),
  );
}
