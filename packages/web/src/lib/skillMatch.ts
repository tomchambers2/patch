// skillMatch — how a typed `/query` picks skills and built-in commands.
//
// The menu used to be prefix-only, so `/timesheet` could not be reached by
// typing `time` when the skill is called `weekly-timesheet`, and nothing at all
// found `deploy-pending` from `pending` (Tom, Patch Updates — "should match
// skills fuzzy search and any part, not just start of skill name"). Skill names
// are kebab-cased compounds, so the distinguishing word is very often NOT the
// first one.
//
// Three tiers, best first, and the tier is the sort key:
//   0. the name starts with the query          (`dep` → `deploy`)
//   1. the name contains it anywhere           (`pending` → `deploy-pending`)
//   2. the query's letters appear in order     (`dpg` → `deploy-pending`)
// Within a tier the caller's original order is preserved, so the server's
// ordering (and, for skills, the last-used-first pass that runs afterwards)
// still decides between equals.

/** Lowest tier index the query matches at, or null when it doesn't match. */
export function matchTier(name: string, query: string): number | null {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  // An empty query matches everything, at the best tier — `/` alone lists the
  // whole menu rather than nothing.
  if (q === '') return 0;
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  return isSubsequence(n, q) ? 2 : null;
}

/** Do `q`'s characters appear in `n`, in order but not necessarily adjacent? */
function isSubsequence(n: string, q: string): boolean {
  let i = 0;
  for (const ch of n) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

/**
 * Filter `items` to those matching `query`, best tier first, stable within a
 * tier. `nameOf` reads the matchable text off an item so the same ranking
 * serves both the bare skill strings and the built-in command objects.
 */
export function rankByQuery<T>(items: T[], query: string, nameOf: (item: T) => string): T[] {
  const scored: { item: T; tier: number; at: number }[] = [];
  items.forEach((item, at) => {
    const tier = matchTier(nameOf(item), query);
    if (tier !== null) scored.push({ item, tier, at });
  });
  scored.sort((a, b) => (a.tier === b.tier ? a.at - b.at : a.tier - b.tier));
  return scored.map((s) => s.item);
}
