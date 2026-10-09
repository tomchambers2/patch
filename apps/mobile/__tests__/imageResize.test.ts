// Client-side image downscale before upload (spec/15 § Composer — "images are
// resized/compressed before sending"). Claude's vision input caps the longest
// edge; an over-cap attachment comes back as "image was too large to process".
// These pin: the longest edge is capped, a re-encode produces a .jpg, and a
// small (or unknown-but-small) image is returned UNCHANGED. NO FALLBACK.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock expo-image-manipulator: `manipulateAsync` echoes back the resize target
// so we can assert the computed dimensions, and reports a probe size when
// called with an empty op list (the unknown-dimensions path).
const { manipulateSpy } = vi.hoisted(() => ({ manipulateSpy: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: manipulateSpy,
  SaveFormat: { JPEG: 'jpeg' },
}));

import { downscaleImage, MAX_IMAGE_EDGE } from '../src/lib/imageResize';

beforeEach(() => {
  manipulateSpy.mockReset();
});

describe('downscaleImage', () => {
  it('caps the longest edge and re-encodes to JPEG when the image is too large', async () => {
    manipulateSpy.mockResolvedValue({ uri: 'file:///out/resized.jpg', width: 0, height: 0 });
    const res = await downscaleImage({
      uri: 'file:///in/huge.png',
      name: 'huge.png',
      mimeType: 'image/png',
      width: 4000,
      height: 3000,
    });

    // Exactly one manipulate call — the resize (dimensions were known, so no
    // probe pass).
    expect(manipulateSpy).toHaveBeenCalledTimes(1);
    const [, ops, opts] = manipulateSpy.mock.calls[0] as [
      string,
      Array<{ resize: { width: number; height: number } }>,
      { format: unknown },
    ];
    // Longest edge (4000) is scaled down to exactly the cap; aspect preserved.
    const { width, height } = ops[0]!.resize;
    expect(Math.max(width, height)).toBe(MAX_IMAGE_EDGE);
    expect(width).toBe(MAX_IMAGE_EDGE);
    expect(height).toBe(Math.round(3000 * (MAX_IMAGE_EDGE / 4000)));
    expect(opts.format).toBe('jpeg');
    // Result adopts the re-encoded uri, jpeg mime and a .jpg name.
    expect(res.uri).toBe('file:///out/resized.jpg');
    expect(res.mimeType).toBe('image/jpeg');
    expect(res.name).toBe('huge.jpg');
  });

  it('leaves a small image UNCHANGED — no re-encode, original uri/mime/name kept', async () => {
    const res = await downscaleImage({
      uri: 'file:///in/small.png',
      name: 'small.png',
      mimeType: 'image/png',
      width: 800,
      height: 600,
    });
    // Both edges within the cap → no manipulate call at all.
    expect(manipulateSpy).not.toHaveBeenCalled();
    expect(res).toEqual({
      uri: 'file:///in/small.png',
      mimeType: 'image/png',
      name: 'small.png',
    });
  });

  it('treats an image exactly at the cap as small (boundary — no resize)', async () => {
    const res = await downscaleImage({
      uri: 'file:///in/edge.jpg',
      name: 'edge.jpg',
      mimeType: 'image/jpeg',
      width: MAX_IMAGE_EDGE,
      height: 900,
    });
    expect(manipulateSpy).not.toHaveBeenCalled();
    expect(res.uri).toBe('file:///in/edge.jpg');
  });

  it('probes dimensions first when they are unknown, then keeps a small original', async () => {
    // Unknown dims: the first manipulate([]) probes size; it comes back small
    // so the original is kept and no second (resize) call is made.
    manipulateSpy.mockResolvedValueOnce({ uri: 'file:///probe', width: 500, height: 400 });
    const res = await downscaleImage({
      uri: 'file:///in/pasted',
      name: 'pasted',
      mimeType: 'image/png',
    });
    expect(manipulateSpy).toHaveBeenCalledTimes(1);
    expect(manipulateSpy.mock.calls[0]![1]).toEqual([]); // empty op list = probe
    expect(res.uri).toBe('file:///in/pasted'); // original kept
    expect(res.mimeType).toBe('image/png');
  });

  it('probes then resizes when the unknown dimensions turn out to be large', async () => {
    manipulateSpy
      .mockResolvedValueOnce({ uri: 'file:///probe', width: 3200, height: 3200 })
      .mockResolvedValueOnce({ uri: 'file:///out/resized.jpg', width: 0, height: 0 });
    const res = await downscaleImage({
      uri: 'file:///in/pasted',
      name: 'pasted',
      mimeType: 'image/png',
    });
    expect(manipulateSpy).toHaveBeenCalledTimes(2);
    const resizeOps = manipulateSpy.mock.calls[1]![1] as Array<{
      resize: { width: number; height: number };
    }>;
    expect(Math.max(resizeOps[0]!.resize.width, resizeOps[0]!.resize.height)).toBe(MAX_IMAGE_EDGE);
    expect(res.mimeType).toBe('image/jpeg');
    expect(res.name).toBe('pasted.jpg');
  });

  it('falls back to "image.jpg" when stripping the extension leaves an empty basename', async () => {
    // ".png" strips entirely (the whole string is "extension"), leaving "" —
    // the `|| 'image'` fallback names the re-encoded file instead of producing
    // a bare ".jpg".
    manipulateSpy.mockResolvedValue({ uri: 'file:///out/resized.jpg', width: 0, height: 0 });
    const res = await downscaleImage({
      uri: 'file:///in/x',
      name: '.png',
      mimeType: 'image/png',
      width: 4000,
      height: 3000,
    });
    expect(res.name).toBe('image.jpg');
  });
});
