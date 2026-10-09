// Client-side image downscale before upload (spec/14 & spec/15 § Composer —
// "images are resized/compressed before sending"). Claude's vision input caps
// the longest edge; an over-cap attachment comes back as "image was too large
// to process". These pin: the longest edge is capped and re-encoded to a JPEG
// File, while a small image is returned UNCHANGED (same File, no re-encode, so
// PNG transparency / original quality is preserved). NO FALLBACK.
//
// jsdom has no image decoder or canvas backend, so we stub `createImageBitmap`
// (to report a decoded size) and the canvas 2d/toBlob surface (to capture the
// resize target and hand back a blob) — the real pixel work is exercised
// against a browser, not here; this locks the SIZING LOGIC.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { downscaleImageFile, MAX_IMAGE_EDGE } from '../lib/imageResize.js';

let drawImage: ReturnType<typeof vi.fn>;
let toBlobSpy: ReturnType<typeof vi.spyOn>;
let getContextSpy: ReturnType<typeof vi.spyOn>;

function stubDecode(width: number, height: number): void {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn(async () => ({
    width,
    height,
    close: vi.fn(),
  }));
}

beforeEach(() => {
  drawImage = vi.fn();
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext' as never)
    .mockReturnValue({ drawImage } as never);
  toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback,
  ) {
    cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
  });
});

afterEach(() => {
  getContextSpy.mockRestore();
  toBlobSpy.mockRestore();
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
});

describe('downscaleImageFile', () => {
  it('caps the longest edge and returns a re-encoded JPEG File when too large', async () => {
    stubDecode(4000, 3000);
    const input = new File(['png-bytes'], 'huge.png', { type: 'image/png' });
    const out = await downscaleImageFile(input);

    // Aspect-preserving downscale: the longest edge lands exactly on the cap.
    expect(drawImage).toHaveBeenCalledTimes(1);
    const [, , , w, h] = drawImage.mock.calls[0] as [unknown, number, number, number, number];
    expect(Math.max(w, h)).toBe(MAX_IMAGE_EDGE);
    expect(w).toBe(MAX_IMAGE_EDGE);
    expect(h).toBe(Math.round(3000 * (MAX_IMAGE_EDGE / 4000)));

    // A fresh JPEG File with a .jpg name — not the original.
    expect(out).not.toBe(input);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('huge.jpg');
  });

  it('leaves a small image UNCHANGED (same File, no re-encode)', async () => {
    stubDecode(800, 600);
    const input = new File(['png-bytes'], 'small.png', { type: 'image/png' });
    const out = await downscaleImageFile(input);
    // Returned as-is: preserves PNG transparency / original quality.
    expect(out).toBe(input);
    expect(drawImage).not.toHaveBeenCalled();
    expect(toBlobSpy).not.toHaveBeenCalled();
  });

  it('treats an image exactly at the cap as small (boundary — no resize)', async () => {
    stubDecode(MAX_IMAGE_EDGE, 900);
    const input = new File(['x'], 'edge.jpg', { type: 'image/jpeg' });
    const out = await downscaleImageFile(input);
    expect(out).toBe(input);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('names the output "image.jpg" when the base name would otherwise be empty', async () => {
    stubDecode(4000, 3000);
    // A dotfile with only an extension (e.g. ".png") strips to an empty base name.
    const input = new File(['png-bytes'], '.png', { type: 'image/png' });
    const out = await downscaleImageFile(input);
    expect(out.name).toBe('image.jpg');
  });

  it('throws when the 2d canvas context is unavailable', async () => {
    stubDecode(4000, 3000);
    getContextSpy.mockReturnValue(null as never);
    const input = new File(['png-bytes'], 'huge.png', { type: 'image/png' });
    await expect(downscaleImageFile(input)).rejects.toThrow('2d canvas context unavailable');
  });

  it('throws when canvas.toBlob yields no blob', async () => {
    stubDecode(4000, 3000);
    toBlobSpy.mockImplementation(function (...args: unknown[]) {
      const cb = args[0] as BlobCallback;
      cb(null);
    });
    const input = new File(['png-bytes'], 'huge.png', { type: 'image/png' });
    await expect(downscaleImageFile(input)).rejects.toThrow('canvas toBlob returned null');
  });

  it('closes an ImageBitmap after use (bitmap decode path)', async () => {
    const close = vi.fn();
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn(async () => ({
      width: 4000,
      height: 3000,
      close,
    }));
    const input = new File(['png-bytes'], 'huge.png', { type: 'image/png' });
    await downscaleImageFile(input);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('falls back to an HTMLImageElement decode when createImageBitmap is unavailable', async () => {
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    const createObjectURLSpy = vi.fn(() => 'blob:mock-url');
    const revokeObjectURLSpy = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectURLSpy,
      revokeObjectURL: revokeObjectURLSpy,
    });
    // jsdom's Image fires neither onload nor onerror automatically; trigger
    // onload manually once `src` is assigned, simulating a successful decode.
    let capturedImg: HTMLImageElement | undefined;
    const originalImage = globalThis.Image;
    class FakeImage {
      width = 1200;
      height = 900;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        capturedImg = this as unknown as HTMLImageElement;
        queueMicrotask(() => this.onload?.());
      }
    }
    (globalThis as { Image: unknown }).Image = FakeImage;

    const input = new File(['png-bytes'], 'small.png', { type: 'image/png' });
    const out = await downscaleImageFile(input);
    expect(out).toBe(input); // 1200x900 is under the cap — unchanged.
    expect(createObjectURLSpy).toHaveBeenCalledWith(input);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url');
    expect(capturedImg).toBeTruthy();

    (globalThis as { Image: unknown }).Image = originalImage;
    vi.unstubAllGlobals();
  });

  it('the HTMLImageElement decode path rejects on a decode error', async () => {
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
    const originalImage = globalThis.Image;
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    (globalThis as { Image: unknown }).Image = FailingImage;

    const input = new File(['png-bytes'], 'bad.png', { type: 'image/png' });
    await expect(downscaleImageFile(input)).rejects.toThrow('could not decode image bad.png');

    (globalThis as { Image: unknown }).Image = originalImage;
    vi.unstubAllGlobals();
  });
});
