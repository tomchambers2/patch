import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../src/utf8.js';

describe('utf8', () => {
  it.each(['', 'plain', 'é ñ ü', '✓ → €', '日本語', '😀 emoji 🎉', 'mixed ascii é ✓ 😀'])(
    'matches the platform for %s',
    (s) => {
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(new TextEncoder().encode(s)));
      expect(utf8Decode(new TextEncoder().encode(s))).toBe(s);
    },
  );

  it('replaces bytes that are not UTF-8 rather than throwing', () => {
    expect(utf8Decode(Uint8Array.of(0x61, 0xff, 0x62))).toBe('a�b');
    expect(utf8Decode(Uint8Array.of(0xe2, 0x82))).toBe('��');
    expect(utf8Decode(Uint8Array.of(0xc3, 0x28))).toBe('�(');
  });
});
