// Are two abbreviated git shas the same commit?
//
// `git rev-parse --short` picks its length from the REPOSITORY it runs in: the
// Mac that codesigns the desktop shell abbreviates to 7 where the box
// abbreviates to 8, because the two object stores collide differently. Every
// surface stamps itself with its own abbreviation, so an exact string compare
// read `FAIL desktop 64782ae` against `64782aef` and a deploy that had shipped
// every surface — desktop included, smoke green — ended `DEPLOY FAILED`.
//
// Prefix comparison, with a floor of 7 characters so a truncated or empty
// stamp can never pass as a match.

const MIN = 7;

/** True when `a` and `b` are abbreviations of the same commit. */
export function sameCommit(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  if (a.length < MIN || b.length < MIN) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.toLowerCase().startsWith(short.toLowerCase());
}
