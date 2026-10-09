// Resolving "the search box on this page" for the ⌘K / ⌘F chords
// (spec/14 ## Keyboard shortcuts, § Reserved OS chords).
//
// A search input opts in by carrying `data-search-input`. That is the whole
// contract: a new search field anywhere in the app gets both chords by adding
// the attribute, and nothing here has to know about routes.

/** Marker attribute an input carries to claim the page's search chords. */
export const SEARCH_INPUT_ATTR = 'data-search-input';

export const SEARCH_INPUT_SELECTOR = `input[${SEARCH_INPUT_ATTR}]`;

/** Carried, alongside the marker, by the sidebar's global chat search. It is on
 *  screen on nearly every view, so it answers ⌘K — but not ⌘F: find-in-page
 *  over a transcript belongs to the browser (spec/14 § Reserved OS chords), and
 *  a field that is always there would take that chord from every chat. */
export const SEARCH_GLOBAL_ATTR = 'data-search-global';

/** Which chord is asking: ⌘K takes any marked field, ⌘F skips the global one. */
export type SearchChord = 'k' | 'f';

/** Hidden by its own or an ancestor's `hidden` / `display:none` /
 *  `visibility:hidden`. Layout is deliberately NOT consulted: a zero-size
 *  rect means "collapsed" in a browser but "no layout engine at all" in
 *  jsdom, so a rect test would report every input hidden under unit tests. */
function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    if (node.hidden) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/** Tie-break when more than one marked input is on screen. Lower wins.
 *  A search box in the main content area is what the user means by "search
 *  this page"; the ones living in an `<aside>` (the sidebar's archived
 *  search, the editor rail's file filter) are page chrome and only win when
 *  the content area is offering nothing. Equal ranks keep DOM order, because
 *  `Array.prototype.sort` is stable. */
function rank(el: HTMLElement): number {
  // The global chat search is the last resort: any field the view offers for
  // itself is the more specific answer to "search this page".
  if (el.hasAttribute(SEARCH_GLOBAL_ATTR)) return 2;
  return el.closest('aside') === null ? 0 : 1;
}

/** The search input the page's search chords should land on, or null when the
 *  page has none on screen. */
export function findPageSearchInput(chord: SearchChord = 'k'): HTMLInputElement | null {
  const visible = Array.from(document.querySelectorAll<HTMLInputElement>(SEARCH_INPUT_SELECTOR))
    .filter((el) => chord === 'k' || !el.hasAttribute(SEARCH_GLOBAL_ATTR))
    .filter(isVisible);
  visible.sort((a, b) => rank(a) - rank(b));
  return visible[0] ?? null;
}

/** Focus and select the page's search input. Returns false when there is
 *  none — the caller must then leave the chord to the browser. */
export function focusPageSearch(chord: SearchChord = 'k'): boolean {
  const el = findPageSearchInput(chord);
  if (el === null) return false;
  el.focus();
  el.select();
  return true;
}
