// expo-crypto stand-in for unit tests. Mirrors the getRandomBytes signature
// the device-key module uses, backed by Node's CSPRNG.
import { randomBytes } from 'node:crypto';

export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount));
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return getRandomBytes(byteCount);
}

export function getRandomValues<T extends ArrayBufferView>(typedArray: T): T {
  const bytes = randomBytes(typedArray.byteLength);
  new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).set(bytes);
  return typedArray;
}
