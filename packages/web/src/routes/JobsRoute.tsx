// JobsRoute — list view at /jobs.
//
// Per spec/14 ## Jobs view + design/web-lo-fi-schedules.html: data-forward
// list. Each row shows the trigger as natural language ("weekdays at 8:57am",
// "Todoist task tagged @claude"), the action as a two-axis verb ("spawn ·
// skill") plus its target, the last-fired time, and an enable toggle. An
// inline runs panel per job expands to show recent fires. A search field in
// the head narrows the list client-side over what the rows show, and a sort
// control plus two filter controls sit beside it: sort orders each section,
// the filters narrow on status and trigger type, and all three compose with
// the search. Each row also carries the two ways to get rid of a job: archive
// (reversible — it stops firing and folds into the archived section) and
// delete (permanent, behind a confirmation).

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { Job, JobAction, JobLatestRun } from '@patch/wire/jobs';
import { api } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { Toggle } from '../components/Toggle.js';
import { NavHistoryControls } from '../components/NavHistoryControls.js';
import { jobTriggerLabel, actionVerb, actionTarget, jobChatId } from '../lib/jobDescribe.js';
import { relativeTime } from '../lib/relativeTime.js';
import { groupJobs, isArchivedJob, isExpiredJob, type JobGroups } from '../lib/jobGroups.js';
import { groupByUserGroup } from '../lib/jobUserGroups.js';
import { JOB_SORTS, sortJobs, type JobSort } from '../lib/jobSort.js';
import { shortcutTitle } from '../lib/shortcuts.js';
import {
  JOB_STATUS_FILTERS,
  JOB_TRIGGER_FILTERS,
  filterJobs,
  isJobFilterActive,
  type JobFilter,
  type JobStatusFilter,
  type JobTriggerFilter,
} from '../lib/jobFilter.js';
import { failed } from '../lib/errorCopy.js';

/**
 * The list route reports each job's live gate counts and its most recent fire
 * alongside the stored job (spec/08 § Concurrency, § Logs). Both are runtime
 * state, not part of the job, so the editor never sends them back. `latestRun`
 * is what the last-fired cell, the spawn row's chat link and the last-fired
 * ordering all read; `null` is a job that has never fired.
 */
type JobWithGates = Job & {
  queued?: number;
  inFlight?: number;
  latestRun?: JobLatestRun | null;
};

/**
 * The host a folder-addressed action runs on, resolved against live presence
 * state — the `JobEditorRoute` `hostNames` pattern (`h.host?.hostName ?? id`),
 * reused here so the Jobs list and the job editor name the same host the same
 * way. `undefined` for a `message` action, which has no host of its own.
 */
function actionHostName(action: JobAction, hostNames: Record<string, string>): string | undefined {
  if (action.type !== 'spawn' && action.type !== 'continue') return undefined;
  return hostNames[action.daemonId];
}

/**
 * The haystack a search query is matched against: everything the row actually
 * shows. Matching the rendered labels rather than the raw job is what lets one
 * field stand in for separate filters — "webhook" and "todoist" are the trigger
 * labels, so typing a trigger type narrows to it (spec/14 § Jobs view).
 *
 * `actionTarget` now takes the resolved host name too (spec/14: "a
 * folder-addressed target reads as its host name and folder together"), so a
 * query for the host a job runs on finds it exactly as a query for its folder
 * already did — previously the row showed the folder but not the host, and
 * search (matching only what the row shows) couldn't find either the ones the
 * row didn't show.
 */
function searchHaystack(job: JobWithGates, hostNames: Record<string, string>): string {
  return [
    job.name,
    jobTriggerLabel(job),
    actionVerb(job.action),
    actionTarget(job.action, actionHostName(job.action, hostNames)),
  ]
    .join(' ')
    .toLowerCase();
}

export function JobsRoute(): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const expiredOpen = useUiStore((s) => s.expiredJobsOpen);
  const setExpiredOpen = useUiStore((s) => s.setExpiredJobsOpen);
  const archivedOpen = useUiStore((s) => s.archivedJobsOpen);
  const setArchivedOpen = useUiStore((s) => s.setArchivedJobsOpen);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sort = useUiStore((s) => s.jobsSort);
  const setSort = useUiStore((s) => s.setJobsSort);
  const filter = useUiStore((s) => s.jobsFilter);
  const setFilter = useUiStore((s) => s.setJobsFilter);
  const [query, setQuery] = useState('');
  // Same source and shape as `JobEditorRoute`'s `hostNames` — every registered
  // host's live self-reported name, falling back to its daemonId until it has
  // reported one (spec/14 § Jobs view).
  const hosts = usePresenceStore((s) => s.hosts);
  const hostNames = useMemo(
    () => Object.fromEntries(Object.entries(hosts).map(([id, h]) => [id, h.host?.hostName ?? id])),
    [hosts],
  );
  // The list carries each job's latest run, so the poll that keeps "last
  // fired" current is this one request rather than one per row.
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.listJobs() as Promise<{ jobs: JobWithGates[] }>,
    refetchInterval: 60_000,
  });

  const enableMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? api.enableJob(id) : api.disableJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e) => pushError(failed('toggle'), undefined, (e as Error).message),
  });

  // Archive / un-archive is one PATCH of one field (spec/08 § Archived jobs).
  // No confirmation: it is the reversible action, undone by the same control.
  const archiveMut = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.patchJob(id, { archived }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e) => pushError(failed('archive'), undefined, (e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e) => pushError(failed('delete'), undefined, (e as Error).message),
  });

  // Run now (spec/08 § Manual run): no success toast — landing on the job is
  // the confirmation.
  const runMut = useMutation({
    mutationFn: (id: string) => api.runJob(id),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      navigate(`/jobs/${id}`);
    },
    onError: (e) => pushError(failed('run now'), undefined, (e as Error).message),
  });

  const actions: RowActions = {
    onToggle: (id, enabled) => enableMut.mutate({ id, enabled }),
    onRun: (id) => runMut.mutate(id),
    runningId: runMut.isPending ? runMut.variables : undefined,
    onArchive: (id, archived) => archiveMut.mutate({ id, archived }),
    onDelete: (id) => {
      void useUiStore
        .getState()
        .confirm({
          title: 'Delete job',
          message: 'Delete this job?',
          confirmLabel: 'Delete',
          danger: true,
        })
        .then((ok) => {
          if (ok) deleteMut.mutate(id);
        });
    },
  };

  const jobs = data?.jobs ?? [];
  const needle = query.trim().toLowerCase();
  // Search and filter compose by AND, then the survivors are ordered, then
  // grouped: sorting inside the pipeline means each section is ordered without
  // the sections themselves moving (spec/14 § Jobs view).
  const matches = useMemo(() => {
    const searched = needle
      ? jobs.filter((job) => searchHaystack(job, hostNames).includes(needle))
      : jobs;
    return sortJobs(filterJobs(searched, filter), sort);
  }, [jobs, needle, filter, sort, hostNames]);
  // Grouping applies to what the search MATCHED, so a query that hits only
  // expired jobs draws that section alone (spec/14 § Jobs view).
  const groups = useMemo(() => groupJobs(matches), [matches]);

  if (error) {
    return (
      <div className="route-error" data-testid="jobs-error">
        Failed to load jobs: {(error as Error).message}
        <button type="button" className="secondary-btn" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <main className="jobs-route" data-testid="jobs-route">
      <header className="route-head">
        <div className="route-head-title">
          <NavHistoryControls />
          <h1 className="display">Jobs</h1>
        </div>
        {!isLoading && jobs.length > 0 ? (
          <>
            <input
              type="search"
              className="jobs-search"
              data-testid="jobs-search"
              data-search-input
              placeholder="Search jobs"
              aria-label="Search jobs"
              title={shortcutTitle('Search jobs', '⌘K')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <JobsControls sort={sort} setSort={setSort} filter={filter} setFilter={setFilter} />
          </>
        ) : null}
        <Link to="/jobs/new" className="primary-btn" data-testid="jobs-new">
          + New job
        </Link>
      </header>
      {isLoading ? (
        <p>Loading…</p>
      ) : jobs.length === 0 ? (
        <JobsEmpty />
      ) : matches.length === 0 ? (
        <p className="jobs-no-matches" data-testid="jobs-no-matches">
          {noMatchesMessage(query.trim(), filter)}
        </p>
      ) : (
        <JobSections
          groups={groups}
          actions={actions}
          hostNames={hostNames}
          expiredOpen={expiredOpen}
          setExpiredOpen={setExpiredOpen}
          archivedOpen={archivedOpen}
          setArchivedOpen={setArchivedOpen}
        />
      )}
    </main>
  );
}

/**
 * Why the list is empty when there are jobs to show. The row is only drawn when
 * something narrowed the list, so it names whichever of the two did it — a
 * query quotes itself so it can be corrected, a filter has no text to quote
 * (spec/14 § Jobs view).
 */
function noMatchesMessage(query: string, filter: JobFilter): string {
  if (query.length === 0) return 'No jobs match the filter';
  if (isJobFilterActive(filter)) return `No jobs match “${query}” and the filter`;
  return `No jobs match “${query}”`;
}

/**
 * The head's sort and filter controls (spec/14 § Jobs view). Three bare
 * selects, each labelled by its own default option, so the head carries no
 * captions.
 */
function JobsControls({
  sort,
  setSort,
  filter,
  setFilter,
}: {
  sort: JobSort;
  setSort: (v: JobSort) => void;
  filter: JobFilter;
  setFilter: (v: JobFilter) => void;
}): JSX.Element {
  return (
    <>
      <select
        className="jobs-control"
        data-testid="jobs-sort"
        aria-label="Sort jobs"
        value={sort}
        onChange={(e) => setSort(e.target.value as JobSort)}
      >
        {JOB_SORTS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="jobs-control"
        data-testid="jobs-filter-status"
        aria-label="Filter jobs by status"
        value={filter.status}
        onChange={(e) => setFilter({ ...filter, status: e.target.value as JobStatusFilter })}
      >
        {JOB_STATUS_FILTERS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="jobs-control"
        data-testid="jobs-filter-trigger"
        aria-label="Filter jobs by trigger type"
        value={filter.trigger}
        onChange={(e) => setFilter({ ...filter, trigger: e.target.value as JobTriggerFilter })}
      >
        {JOB_TRIGGER_FILTERS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
}

/**
 * What a row can do to its job, in one object — the list route owns the
 * mutations, the row only reports the click.
 */
interface RowActions {
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  /** The job whose manual run is in flight, if any. */
  runningId: string | undefined;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
}

/**
 * The four sections (spec/14 § Jobs view). Each is omitted entirely when it
 * has nothing in it, so an installation with no one-off and no archived jobs
 * renders exactly the single ungrouped list it always did — no stray headers
 * over one list.
 */
function JobSections({
  groups,
  actions,
  hostNames,
  expiredOpen,
  setExpiredOpen,
  archivedOpen,
  setArchivedOpen,
}: {
  groups: JobGroups<JobWithGates>;
  actions: RowActions;
  hostNames: Record<string, string>;
  expiredOpen: boolean;
  setExpiredOpen: (v: boolean) => void;
  archivedOpen: boolean;
  setArchivedOpen: (v: boolean) => void;
}): JSX.Element {
  // With nothing folded away anywhere there is only one group to draw, so the
  // header would label the whole page "Recurring" for no reason.
  const grouped =
    groups.oneOff.length > 0 || groups.expired.length > 0 || groups.archived.length > 0;

  return (
    <>
      {groups.recurring.length > 0 ? (
        <section className="jobs-section" data-testid="jobs-section-recurring">
          {grouped ? <h2 className="jobs-section-head">Recurring</h2> : null}
          <JobList
            jobs={groups.recurring}
            actions={actions}
            hostNames={hostNames}
            testid="jobs-list"
          />
        </section>
      ) : null}

      {groups.oneOff.length > 0 ? (
        <section className="jobs-section" data-testid="jobs-section-one-off">
          <h2 className="jobs-section-head">One-off</h2>
          <JobList
            jobs={groups.oneOff}
            actions={actions}
            hostNames={hostNames}
            testid="jobs-list-one-off"
          />
        </section>
      ) : null}

      <FoldedSection
        kind="expired"
        label="Expired"
        jobs={groups.expired}
        actions={actions}
        hostNames={hostNames}
        open={expiredOpen}
        setOpen={setExpiredOpen}
      />
      <FoldedSection
        kind="archived"
        label="Archived"
        jobs={groups.archived}
        actions={actions}
        hostNames={hostNames}
        open={archivedOpen}
        setOpen={setArchivedOpen}
      />
    </>
  );
}

/**
 * A section that is collapsed by default and counted on its header — both the
 * expired and the archived group (spec/14 § Jobs view). One component because
 * they are the same thing: jobs kept for what they hold, which would otherwise
 * crowd out the jobs that still run. The count is the collapsed section's
 * entire content, and the whole answer to "anything in there?" without paying
 * list height for it.
 */
function FoldedSection({
  kind,
  label,
  jobs,
  actions,
  hostNames,
  open,
  setOpen,
}: {
  kind: 'expired' | 'archived';
  label: string;
  jobs: JobWithGates[];
  actions: RowActions;
  hostNames: Record<string, string>;
  open: boolean;
  setOpen: (v: boolean) => void;
}): JSX.Element | null {
  if (jobs.length === 0) return null;
  return (
    <section className="jobs-section" data-testid={`jobs-section-${kind}`}>
      <button
        type="button"
        className="jobs-section-head jobs-fold-toggle"
        data-testid={`jobs-${kind}-toggle`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
        <span className="jobs-fold-count" data-testid={`jobs-${kind}-count`}>
          {jobs.length}
        </span>
      </button>
      {open ? (
        <JobList jobs={jobs} actions={actions} hostNames={hostNames} testid={`jobs-list-${kind}`} />
      ) : null}
    </section>
  );
}

/**
 * A status section's job list, sub-divided by the user's free-text `group`
 * (spec/08 § Groups, spec/14 § Jobs view). The sub-headers only draw when
 * there is more than one bucket to tell apart — a section that is entirely
 * one group, or entirely ungrouped, renders exactly the plain list it always
 * did.
 */
function JobList({
  jobs,
  actions,
  hostNames,
  testid,
}: {
  jobs: JobWithGates[];
  actions: RowActions;
  hostNames: Record<string, string>;
  testid: string;
}): JSX.Element {
  const buckets = useMemo(() => groupByUserGroup(jobs), [jobs]);
  const showGroupHeads = buckets.length > 1;
  return (
    <ul className="jobs-list" data-testid={testid}>
      {buckets.map((bucket) => (
        <li key={bucket.group ?? '\u0000ungrouped'} className="jobs-user-group">
          {showGroupHeads ? (
            <h3
              className="jobs-user-group-head"
              data-testid={`jobs-user-group-${testid}-${bucket.group ?? 'ungrouped'}`}
            >
              {bucket.group ?? 'Ungrouped'}
            </h3>
          ) : null}
          <ul className="jobs-user-group-list">
            {bucket.jobs.map((job) => (
              <JobRow key={job.id} job={job} actions={actions} hostNames={hostNames} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// G1: empty-jobs state — an on-brand calendar graphic + a short line,
// centred both axes (it reuses the shared `.empty-chat` layout primitive, the
// same centring the empty-chat state uses). Replaces the old bare top-left
// "No jobs yet…" list placeholder.
function JobsEmpty(): JSX.Element {
  return (
    <div className="empty-chat" data-testid="jobs-empty">
      <svg
        className="empty-chat-art"
        viewBox="0 0 240 180"
        fill="none"
        role="img"
        aria-label="No jobs yet"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* calendar body */}
        <rect
          x="48"
          y="46"
          width="144"
          height="102"
          rx="16"
          className="empty-chat-bubble"
          strokeWidth="3"
        />
        {/* header divider */}
        <path d="M48 78 h144" className="empty-chat-stem" strokeWidth="3" strokeLinecap="round" />
        {/* two binder rings poking out of the top */}
        <path d="M84 34 v20" className="empty-chat-stem" strokeWidth="3" strokeLinecap="round" />
        <path d="M156 34 v20" className="empty-chat-stem" strokeWidth="3" strokeLinecap="round" />
        {/* job entry dots (the patch mark, arranged as calendar days) */}
        <circle cx="80" cy="104" r="7" className="empty-chat-dot" />
        <circle cx="120" cy="104" r="7" className="empty-chat-dot" />
        <circle cx="160" cy="104" r="7" className="empty-chat-dot" />
        <circle cx="80" cy="130" r="7" className="empty-chat-dot" />
        {/* a small leaf sprout so it matches the empty-chat family */}
        <path d="M172 46 c0 -18 8 -30 26 -34 c-2 18 -10 30 -26 34 z" className="empty-chat-leaf" />
      </svg>
      <h2 className="empty-chat-title">No jobs yet</h2>
    </div>
  );
}

function JobRow({
  job,
  actions,
  hostNames,
}: {
  job: JobWithGates;
  actions: RowActions;
  hostNames: Record<string, string>;
}): JSX.Element {
  const [runsOpen, setRunsOpen] = useState(false);
  // The most-recent run rides on the list response (spec/14 § Jobs view), so
  // the row reads it rather than fetching its own history per poll.
  const latest = job.latestRun ?? null;
  const chatId = jobChatId(job, latest?.chatId);
  const expired = isExpiredJob(job);
  const archived = isArchivedJob(job);

  return (
    <li
      className={`job-row ${job.enabled ? '' : 'disabled'}${expired ? ' expired' : ''}${
        archived ? ' archived' : ''
      }`}
      data-testid={`job-${job.id}`}
    >
      <div className="job-row-main">
        <Link to={`/jobs/${job.id}`} className="job-link">
          <span className="job-name display">{job.name}</span>
          <span className="job-trigger" data-testid={`job-trigger-${job.id}`}>
            {jobTriggerLabel(job)}
          </span>
          <span className="job-action" data-testid={`job-action-${job.id}`}>
            {/* A gated job mostly does NOTHING, which is the single most useful
                thing to know about it from a list (spec/08 § Gate): it explains
                a row that says "fired 4 hours ago" on a job that ticks every
                five minutes. The verb reads "if gated · spawn · skill". */}
            {job.gate ? <span className="verb job-gated">if gated ·</span> : null}
            <span className="verb">{actionVerb(job.action)}</span>
            <span className="target">
              {actionTarget(job.action, actionHostName(job.action, hostNames))}
            </span>
          </span>
        </Link>
        <span className="job-last-fired" data-testid={`job-last-fired-${job.id}`}>
          {latest ? relativeTime(latest.ts) : 'never'}
        </span>
        {job.queued ? (
          <span className="job-queued" data-testid={`job-queued-${job.id}`}>
            {job.queued} queued
          </span>
        ) : null}
        {chatId ? (
          <Link
            to={`/chats/${chatId}`}
            className="job-chat-link"
            data-testid={`job-chat-${job.id}`}
            title="Open chat"
          >
            open chat
          </Link>
        ) : null}
        <button
          type="button"
          className="runs-toggle"
          data-testid={`job-runs-toggle-${job.id}`}
          aria-expanded={runsOpen}
          onClick={() => setRunsOpen((v) => !v)}
        >
          {runsOpen ? 'hide runs' : 'runs'}
        </button>
        <button
          type="button"
          className="job-run-now"
          data-testid={`job-run-now-${job.id}`}
          title="Run now"
          disabled={actions.runningId === job.id}
          onClick={() => actions.onRun(job.id)}
        >
          run now
        </button>
        {/* The two ways to get a job off the list (spec/14 § Jobs view).
            Archive is reversible and undone by this same control, so it asks
            nothing; delete is permanent and goes through the app's confirm
            modal, the same one the editor's Delete uses. */}
        <button
          type="button"
          className="job-archive"
          data-testid={`job-archive-${job.id}`}
          title={archived ? 'Unarchive' : 'Archive'}
          onClick={() => actions.onArchive(job.id, !archived)}
        >
          {archived ? 'unarchive' : 'archive'}
        </button>
        <button
          type="button"
          className="job-delete"
          data-testid={`job-delete-${job.id}`}
          title="Delete"
          onClick={() => actions.onDelete(job.id)}
        >
          delete
        </button>
        {/* An expired or archived job does not fire, so its switch is dead
            rather than gone: the row keeps the same shape as every other one,
            and a switch offering to run it would lie about what it does
            (spec/08 § One-off jobs, § Archived jobs). */}
        <Toggle
          checked={job.enabled}
          onChange={(enabled) => actions.onToggle(job.id, enabled)}
          disabled={expired || archived}
          label="Enabled"
          testid={`job-toggle-${job.id}`}
          title={archived ? 'Archived' : expired ? 'Expired' : job.enabled ? 'Enabled' : 'Disabled'}
        />
      </div>
      {runsOpen ? <InlineRuns jobId={job.id} /> : null}
    </li>
  );
}

function InlineRuns({ jobId }: { jobId: string }): JSX.Element {
  const { data, error } = useQuery({
    queryKey: ['job-runs', jobId, 'panel'],
    queryFn: () => api.jobRuns(jobId, 8),
    refetchInterval: 30_000,
  });
  return (
    <div className="inline-runs" data-testid={`inline-runs-${jobId}`}>
      {error ? (
        <p className="error">failed to load runs: {(error as Error).message}</p>
      ) : !data || data.runs.length === 0 ? (
        <p className="empty">No runs yet.</p>
      ) : (
        <ul>
          {data.runs.map((r, i) => (
            <li key={`${r.ts}-${i}`} className="run-entry">
              <span className="run-when">{new Date(r.ts).toLocaleString()}</span>
              <span className={`run-status status-${r.status}`}>{r.status}</span>
              {r.action?.chatId ? (
                <Link className="run-chat-link" to={`/chats/${r.action.chatId}`}>
                  open chat
                </Link>
              ) : null}
              {r.error ? <span className="run-error">{r.error}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// G2-d8: the jobs "last fired" column must use ONE consistent format for
// every row — the brief flagged a list that mixed relative ("22h ago"),
// absolute ("06/06/2026"), and "never". Now shared with the version panel via
// lib/relativeTime.ts; unrun jobs show the "never" sentinel (which the brief
// explicitly permits as the unrun case), handled by the caller.
