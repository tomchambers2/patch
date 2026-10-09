// UTF-8 in plain JavaScript. The phone's JS engine ships `TextEncoder` but not
// always `TextDecoder`, and this package must load there without either, so the
// two directions are done by hand.

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] as number;
    let code: number;
    let extra: number;
    if (b < 0x80) [code, extra] = [b, 0];
    else if (b >= 0xc2 && b < 0xe0) [code, extra] = [b & 0x1f, 1];
    else if (b >= 0xe0 && b < 0xf0) [code, extra] = [b & 0x0f, 2];
    else if (b >= 0xf0 && b < 0xf5) [code, extra] = [b & 0x07, 3];
    else {
      out += '�';
      i += 1;
      continue;
    }
    let ok = i + extra < bytes.length + (extra === 0 ? 1 : 0);
    for (let k = 1; ok && k <= extra; k++) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) ok = false;
      else code = (code << 6) | (next & 0x3f);
    }
    if (!ok) {
      out += '�';
      i += 1;
      continue;
    }
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}
