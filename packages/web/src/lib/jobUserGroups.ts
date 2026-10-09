// User-defined grouping within a Jobs list section (spec/08 § Groups,
// spec/14 § Jobs view).
//
// This is a different axis from `jobGroups.ts`'s recurring/one-off/expired/
// archived split, which is status the app derives. This one is a free-text
// label the user typed onto a job to organise it — "Home", "Finance",
// "Watchers" — and it sub-divides each of those status sections rather than
// replacing them.

/** The only field this grouping looks at — anything Job-shaped will do. */
export interface UserGroupableJob {
  group?: string;
}

export interface UserGroupBucket<T> {
  /** `null` is the "Ungrouped" bucket — a job with no `group`, or `''`. */
  group: string | null;
  jobs: T[];
}

/**
 * Split a (already status-grouped, already sorted) list of jobs into buckets
 * by their user-set `group`, preserving each job's position within its
 * bucket. Buckets are ordered by the first appearance of their group name in
 * the incoming list, so the order tracks whatever sort the caller already
 * applied rather than re-sorting alphabetically. The ungrouped bucket, if
 * any, is always drawn last — organised jobs read before the leftovers.
 */
export function groupByUserGroup<T extends UserGroupableJob>(
  jobs: readonly T[],
): UserGroupBucket<T>[] {
  const order: (string | null)[] = [];
  const byGroup = new Map<string | null, T[]>();
  for (const job of jobs) {
    const key = job.group && job.group.length > 0 ? job.group : null;
    let bucket = byGroup.get(key);
    if (!bucket) {
      bucket = [];
      byGroup.set(key, bucket);
      order.push(key);
    }
    bucket.push(job);
  }
  // Ungrouped last, whatever position its jobs first appeared in.
  order.sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
  return order.map((group) => ({ group, jobs: byGroup.get(group) ?? [] }));
}
