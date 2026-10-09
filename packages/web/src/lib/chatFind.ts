// Find-in-this-chat (spec/14 § Find in chat). Pure DOM helpers: collect the
// text-node ranges inside the transcript that match a query, and paint them
// with the CSS Custom Highlight API so the rendered markdown is never mutated.

/** Where the highlight registry lives; absent in jsdom and old engines. */
type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

export const FIND_ALL = 'chat-find';
export const FIND_CURRENT = 'chat-find-current';

/** Every case-insensitive occurrence of `query` in the text under `root`.
 *  A match never spans two text nodes: markdown splits text at inline marks,
 *  and a phrase broken by one is rare enough not to be worth stitching. */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (parent !== null && parent.closest('script,style,[data-find-skip]') !== null) continue;
    const text = (n.textContent ?? '').toLowerCase();
    for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + q.length);
      out.push(r);
    }
  }
  return out;
}

/** Index after stepping `delta` from `current`, wrapping. -1 when empty. */
export function stepIndex(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return (current + delta + count) % count;
}

/** Paint all matches, and the current one distinctly. Throws if the engine has
 *  no highlight API — there is no fallback, a missing API must be visible. */
export function paintFind(ranges: Range[], current: number): void {
  const reg = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Hl = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (reg === undefined || Hl === undefined) {
    throw new Error('CSS Custom Highlight API unavailable: cannot paint chat find');
  }
  reg.set(FIND_ALL, new Hl(...ranges));
  const cur = ranges[current];
  if (cur === undefined) reg.delete(FIND_CURRENT);
  else reg.set(FIND_CURRENT, new Hl(cur));
}

export function clearFind(): void {
  const reg = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  reg?.delete(FIND_ALL);
  reg?.delete(FIND_CURRENT);
}

/** Scroll `scroller` so the range sits near its vertical centre. */
export function revealRange(scroller: HTMLElement, range: Range): void {
  const box = range.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  scroller.scrollTop += box.top - view.top - view.height / 2;
}
