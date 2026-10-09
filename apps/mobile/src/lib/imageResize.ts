// Client-side image downscale before upload (spec/15 § Composer — "images are
// resized/compressed before sending"). Claude's vision input caps the image
// edge; an oversized attachment comes back as "image was too large to process".
// We cap the LONGEST edge and re-encode to a reasonable JPEG quality via
// expo-image-manipulator so the bytes that reach the host (which Claude reads
// by path) are within limits.
//
// An image already within the cap is returned UNCHANGED (spec — "keep originals
// only if small"). NO FALLBACK: a manipulate failure propagates so the composer
// surfaces it and keeps the attachment rather than uploading an over-limit file.

import * as ImageManipulator from 'expo-image-manipulator';

/** Cap the longest edge to Claude's recommended max (spec § Composer). */
export const MAX_IMAGE_EDGE = 1568;
/** JPEG quality (0..1) for the re-encode of a downscaled image. */
const JPEG_QUALITY = 0.85;

export interface ResizedImage {
  uri: string;
  /** The mime type to upload with (jpeg after a re-encode). */
  mimeType: string;
  /** The filename to upload with (forced to .jpg after a re-encode). */
  name: string;
}

/**
 * Downscale an image if its longest edge exceeds {@link MAX_IMAGE_EDGE}. When
 * `width`/`height` are known (the picker hands them over) and already small, the
 * original is kept as-is. When dimensions are unknown we read them off a no-op
 * manipulate first, then decide.
 */
export async function downscaleImage(opts: {
  uri: string;
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
}): Promise<ResizedImage> {
  let width = opts.width;
  let height = opts.height;

  // Dimensions unknown (pasted / document-picked image) — read them cheaply.
  if (!width || !height) {
    const probe = await ImageManipulator.manipulateAsync(opts.uri, []);
    width = probe.width;
    height = probe.height;
  }

  const longest = Math.max(width, height);
  if (longest <= MAX_IMAGE_EDGE) {
    // Already small — keep the original untouched.
    return { uri: opts.uri, mimeType: opts.mimeType, name: opts.name };
  }

  const scale = MAX_IMAGE_EDGE / longest;
  const result = await ImageManipulator.manipulateAsync(
    opts.uri,
    [{ resize: { width: Math.round(width * scale), height: Math.round(height * scale) } }],
    { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
  );
  const baseName = opts.name.replace(/\.[^.]+$/, '') || 'image';
  return { uri: result.uri, mimeType: 'image/jpeg', name: `${baseName}.jpg` };
}
