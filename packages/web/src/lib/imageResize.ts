// Client-side image downscale before upload (spec/14 & spec/15 § Composer —
// "images are resized/compressed before sending"). Claude's vision input caps
// the image edge; an oversized attachment comes back as "image was too large to
// process". We cap the LONGEST edge and re-encode to a reasonable JPEG quality
// so the bytes that reach the server (and the host copy Claude reads) are
// within limits.
//
// A small image (already within the cap) is returned UNCHANGED — no needless
// re-encode, and PNG transparency / original quality is preserved (spec — "keep
// originals only if small").
//
// NO FALLBACK: a decode failure throws so the composer surfaces it and keeps the
// attachment, rather than silently uploading an over-limit or corrupt file.

/** Cap the longest edge to Claude's recommended max (spec § Composer). */
export const MAX_IMAGE_EDGE = 1568;
/** JPEG quality for the re-encode of a downscaled image. */
const JPEG_QUALITY = 0.85;

/**
 * Downscale `file` if its longest edge exceeds {@link MAX_IMAGE_EDGE}, returning
 * a new JPEG `File`. Returns the original untouched when it's already small.
 * Only images are resized; the caller passes image files only.
 */
export async function downscaleImageFile(file: File): Promise<File> {
  const bitmap = await loadBitmap(file);
  try {
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    if (longest <= MAX_IMAGE_EDGE) return file; // already small — keep the original

    const scale = MAX_IMAGE_EDGE / longest;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('canvas toBlob returned null');

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
  } finally {
    // Free the decoded bitmap (createImageBitmap path).
    if ('close' in bitmap && typeof (bitmap as ImageBitmap).close === 'function') {
      (bitmap as ImageBitmap).close();
    }
  }
}

/** Decode a file to something drawable, preferring the fast createImageBitmap path. */
async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  // Fallback decode path for environments without createImageBitmap. This is a
  // capability shim (not a silent error-swallowing fallback): it still throws on
  // a genuine decode failure.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`could not decode image ${file.name}`));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
