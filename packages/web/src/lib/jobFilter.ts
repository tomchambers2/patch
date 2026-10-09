// Structured narrowing for the Jobs list (spec/14 § Jobs view).
//
// A filter: criteria in, list out. It answers what the free-text field cannot
// — "which of these are switched off", "which of these are webhooks" — and
// composes with it by AND. Kept out of the JSX so the rule is one testable
// function, the way jobGroups.ts holds the grouping rule.

export type JobStatusFilter = 'all' | 'enabled' | 'disabled';
export type JobTriggerFilter = 'all' | 'cron' | 'recurrence' | 'webhook' | 'todoist';

export interface JobFilter {
  status: JobStatusFilter;
  trigger: JobTriggerFilter;
}

/** The status control's options, in the order it offers them. */
export const JOB_STATUS_FILTERS: ReadonlyArray<{ value: JobStatusFilter; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

/** The trigger-type control's options, in the order it offers them. */
export const JOB_TRIGGER_FILTERS: ReadonlyArray<{ value: JobTriggerFilter; label: string }> = [
  { value: 'all', label: 'Any trigger' },
  { value: 'cron', label: 'Cron' },
  { value: 'recurrence', label: 'Recurrence' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'todoist', label: 'Todoist' },
];

/** Narrows nothing. */
export const NO_JOB_FILTER: JobFilter = { status: 'all', trigger: 'all' };

/** The only fields the filter looks at — anything Job-shaped will do. */
export interface FilterableJob {
  enabled: boolean;
  trigger: { type: string };
}

/** True when the filter is narrowing on at least one axis. */
export function isJobFilterActive(filter: JobFilter): boolean {
  return filter.status !== 'all' || filter.trigger !== 'all';
}

/** Keep the jobs that satisfy every axis of the filter. */
export function filterJobs<T extends FilterableJob>(jobs: readonly T[], filter: JobFilter): T[] {
  return jobs.filter(
    (job) => matchesStatus(job, filter.status) && matchesTrigger(job, filter.trigger),
  );
}

function matchesStatus(job: FilterableJob, status: JobStatusFilter): boolean {
  if (status === 'all') return true;
  return job.enabled === (status === 'enabled');
}

function matchesTrigger(job: FilterableJob, trigger: JobTriggerFilter): boolean {
  if (trigger === 'all') return true;
  return job.trigger.type === trigger;
}
