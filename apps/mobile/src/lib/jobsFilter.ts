/**
 * Jobs-list search (spec/15 § Jobs screen). Filtering is instant and local:
 * the caller re-runs this on every keystroke over the already-loaded jobs, so
 * there is no request and nothing to submit. A job matches when the trimmed
 * query appears, case-insensitively, in any of the things that identify it on
 * the row — its name, its id, its trigger type, its cron expression, the
 * human trigger summary the row shows, or the action's verb + target (spec/14
 * § Jobs view: "a skill name finds the jobs that run it"). Matches keep the
 * incoming order — no ranking.
 */
export interface SearchableJob {
  id: string;
  name?: string | undefined;
  triggerType?: string | undefined;
  cron?: string | undefined;
  /** The human trigger summary rendered on the row, e.g. "Every day at 09:00". */
  subtitle?: string | undefined;
  /** The action's rendered "verb · target", e.g. "spawn · skill life-coach · /p". */
  actionLabel?: string | undefined;
}

export function filterJobs<T extends SearchableJob>(jobs: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...jobs];
  return jobs.filter((j) =>
    [j.name, j.id, j.triggerType, j.cron, j.subtitle, j.actionLabel].some((field) =>
      (field ?? '').toLowerCase().includes(q),
    ),
  );
}
