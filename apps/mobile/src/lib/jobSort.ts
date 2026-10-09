// How the Jobs tab is ordered within a section (spec/15 § Jobs screen).
// Verbatim port of packages/web/src/lib/jobSort.ts — RN-free, so it stays
// diffable against the web copy.

export type JobSort = 'last-fired' | 'name' | 'created';

/** The sort control's options, in the order it offers them. */
export const JOB_SORTS: ReadonlyArray<{ value: JobSort; label: string }> = [
  { value: 'last-fired', label: 'Last fired' },
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Created' },
];

export const DEFAULT_JOB_SORT: JobSort = 'last-fired';

/** The only fields the ordering looks at — anything Job-shaped will do. */
export interface SortableJob {
  name: string;
  createdAt: number;
  latestRun?: { ts: number } | null;
}

/**
 * Order jobs for display.
 *
 * `last-fired` is newest fire first, with jobs that have never fired last:
 * "never" is the far end of that scale, not the near one. `name` is
 * case-insensitive locale order. `created` is newest first.
 *
 * The sort is stable, so jobs that tie keep the order they arrived in.
 */
export function sortJobs<T extends SortableJob>(jobs: readonly T[], sort: JobSort): T[] {
  const out = [...jobs];
  switch (sort) {
    case 'last-fired':
      return out.sort(byLastFired);
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'created':
      return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}

/**
 * Newest fire first, never-fired last. Written as explicit comparisons rather
 * than a subtraction of ranks: a sentinel two never-fired jobs both carry would
 * subtract to NaN, and a NaN comparator orders nothing at all.
 */
function byLastFired(a: SortableJob, b: SortableJob): number {
  const at = a.latestRun?.ts;
  const bt = b.latestRun?.ts;
  if (at === undefined && bt === undefined) return 0;
  if (at === undefined) return 1;
  if (bt === undefined) return -1;
  return bt - at;
}
