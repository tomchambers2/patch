// base64url helpers — RFC 4648 §5 (no padding). Used for keys and nonces.
//
// NOTE: we deliberately roundtrip through Buffer for portability — Node and
// undici both expose it. If we later need browser support inside auth code,
// swap for a manual implementation or `jose`'s base64url.

export function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function base64UrlToBytes(s: string): Uint8Array {
  const buf = Buffer.from(s, 'base64url');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
