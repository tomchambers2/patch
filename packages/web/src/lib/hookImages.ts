// The composer's image attachments, in the shape `POST /api/hooks/check` takes
// (spec/20-hooks.md § Hook context) — so a prompt hook judges what the agent
// will actually be shown, not just the words. A hook check must never stop a
// send, so an image that can't be made to fit (or can't be re-encoded) is left
// out of the check and reported in `skipped`, which the caller shows on the
// sent message — never thrown, never silent.

import { HOOK_IMAGES_MAX, HOOK_IMAGE_MAX_BASE64, type HookImage } from '@patch/wire/hooks';
import type { OutgoingFile } from './sendQueue.js';

const MEDIA_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Longest edge and JPEG quality tried in turn when an image is over the cap or
// of a type hooks can't take.
const SHRINK_STEPS: ReadonlyArray<{ edge: number; quality: number }> = [
  { edge: 2048, quality: 0.85 },
  { edge: 1600, quality: 0.75 },
  { edge: 1024, quality: 0.6 },
  { edge: 640, quality: 0.5 },
];

export interface HookImagesResult {
  images: HookImage[];
  /** One human-readable reason per image left out of the check. */
  skipped: string[];
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(toBase64);
}

/** Re-encode as a JPEG small enough for a hook; throws if the browser can't. */
async function shrink(file: File): Promise<HookImage> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('this browser cannot resize images');
  }
  const bitmap = await createImageBitmap(file);
  try {
    for (const { edge, quality } of SHRINK_STEPS) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2d canvas');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob) throw new Error('could not encode');
      const data = await blobToBase64(blob);
      if (data.length <= HOOK_IMAGE_MAX_BASE64) return { mediaType: 'image/jpeg', data };
    }
    throw new Error('still too large after resizing');
  } finally {
    bitmap.close();
  }
}

export async function hookImages(files: OutgoingFile[]): Promise<HookImagesResult> {
  const all = files.filter((f) => f.kind === 'image');
  const skipped = all
    .slice(HOOK_IMAGES_MAX)
    .map((f) => `${f.name} not checked: hooks see at most ${HOOK_IMAGES_MAX} images`);
  const images: HookImage[] = [];
  for (const f of all.slice(0, HOOK_IMAGES_MAX)) {
    try {
      if (MEDIA_TYPES.has(f.file.type)) {
        const data = toBase64(await f.file.arrayBuffer());
        if (data.length <= HOOK_IMAGE_MAX_BASE64) {
          images.push({ mediaType: f.file.type as HookImage['mediaType'], data });
          continue;
        }
      }
      images.push(await shrink(f.file));
    } catch (err) {
      skipped.push(`${f.name} not checked: ${(err as Error).message}`);
    }
  }
  return { images, skipped };
}
