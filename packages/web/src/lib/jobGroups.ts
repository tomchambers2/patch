// How the Jobs list is divided (spec/14 § Jobs view, spec/08 § One-off jobs,
// spec/08 § Archived jobs).
//
// Four groups drawn in this order: the recurring automations, the one-off
// jobs still waiting to fire, the ones that have fired and retired, then the
// ones the user has put away. Kept out of the JSX so the rule is one testable
// function rather than four filters inlined into a render.

/** The only fields the grouping looks at — anything Job-shaped will do. */
export interface GroupableJob {
  oneOff?: boolean;
  expiredAt?: number;
  archived?: boolean;
}

export interface JobGroups<T> {
  /** Ordinary automations — fire for as long as they are enabled. */
  recurring: T[];
  /** One-off, not yet fired. Still live, so drawn open beside the recurring. */
  oneOff: T[];
  /** Fired and retired. Kept for their history, folded away by default. */
  expired: T[];
  /** Put away by the user. Fires for nothing, folded away by default. */
  archived: T[];
}

/**
 * Carrying an `expiredAt` is what expired MEANS (spec/08 § One-off jobs), so
 * it is the first question asked. A job whose `oneOff` was cleared after it
 * had already retired still reads as expired — the stamp is the record that it
 * ran, and re-arming it is `enabled`'s job, not this flag's.
 */
export function isExpiredJob(job: GroupableJob): boolean {
  return job.expiredAt !== undefined;
}

/** Put away by the user (spec/08 § Archived jobs). Absent means not archived. */
export function isArchivedJob(job: GroupableJob): boolean {
  return job.archived === true;
}

/**
 * Split jobs into the four list sections, preserving the incoming order.
 *
 * Archived is asked FIRST: a job can be both archived and expired, and
 * archived is the deliberate act where expired is only a job having run its
 * course (spec/08 § Archived jobs).
 */
export function groupJobs<T extends GroupableJob>(jobs: readonly T[]): JobGroups<T> {
  const groups: JobGroups<T> = { recurring: [], oneOff: [], expired: [], archived: [] };
  for (const job of jobs) {
    if (isArchivedJob(job)) groups.archived.push(job);
    else if (isExpiredJob(job)) groups.expired.push(job);
    else if (job.oneOff === true) groups.oneOff.push(job);
    else groups.recurring.push(job);
  }
  return groups;
}
