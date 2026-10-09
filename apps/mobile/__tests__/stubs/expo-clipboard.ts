// expo-clipboard stand-in for unit tests. The diagnostics screen copies its
// report here; tests assert on what was written and can force a rejection to
// exercise the loud copy-failed path.

let _last: string | null = null;
let _fail = false;

export async function setStringAsync(text: string): Promise<boolean> {
  if (_fail) throw new Error('clipboard unavailable');
  _last = text;
  return true;
}

export function __lastCopied(): string | null {
  return _last;
}

export function __setFail(v: boolean): void {
  _fail = v;
}

export function __resetClipboard(): void {
  _last = null;
  _fail = false;
}
