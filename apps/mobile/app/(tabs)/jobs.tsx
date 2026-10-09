// Jobs tab (spec/15 § Navigation shell — Jobs, § Jobs screen). Full parity
// with web's dedicated `/jobs` page (`14-design-web.md` § Jobs view): the
// four status sections, sort + filter controls, last-fired/queued/chat-link
// per row, and per-row Archive/Delete — touch-native controls (pickers,
// Alert confirmation) rather than a port of web's `<select>`s.
//
// This is a tab ROOT, so its header carries no back control — there is
// nothing beneath it to go back to. It used to be pushed from a Settings
// row, which is where the chevron came from.
//
// Search (spec/15 § Jobs screen) is the same idiom as the archived-chats box
// on the Chats tab: one plain text field, filtering the already-loaded list on
// every keystroke (`lib/jobsFilter.ts`), no request and nothing to submit.

import React from 'react';
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Archive, ArchiveRestore, Clock, MessageCircle, Plus, Trash2 } from 'lucide-react-native';
import { api } from '../../src/api/rest';
import { EmptyState } from '../../src/components/EmptyState';
import { OptionPicker } from '../../src/components/OptionPicker';
import { EMPTY_STATES } from '../../src/lib/emptyStates';
import { agoLabel } from '../../src/lib/agoLabel';
import {
  actionTarget,
  actionVerb,
  jobChatId,
  queuedLabel,
  triggerLabel,
  type DescribableAction,
  type DescribableTrigger,
} from '../../src/lib/jobDescribe';
import { filterJobs } from '../../src/lib/jobsFilter';
import { groupJobs, isArchivedJob, isExpiredJob } from '../../src/lib/jobGroups';
import { groupByUserGroup } from '../../src/lib/jobUserGroups';
import { JOB_SORTS, sortJobs, type JobSort } from '../../src/lib/jobSort';
import {
  filterJobsByStatus,
  isJobFilterActive,
  JOB_STATUS_FILTERS,
  JOB_TRIGGER_FILTERS,
  NO_JOB_FILTER,
  type JobFilter,
} from '../../src/lib/jobStatusFilter';
import { JOBS_SEARCH_PLACEHOLDER } from '../../src/lib/labels';
import { getSectionOpen, setSectionOpen } from '../../src/lib/sectionCollapse';
import { usePresenceStore } from '../../src/stores/presenceStore';
import { fonts, radii, space, typography, useTheme } from '../../src/lib/theme';

/** A job as this screen needs it — tolerant of whatever shape the server (or
 * an older/newer host relaying one) actually sends, same convention the old
 * `normalise()` always followed here. */
interface JobShape {
  id: string;
  name?: string;
  enabled: boolean;
  createdAt: number;
  trigger: DescribableTrigger | undefined;
  triggerType?: string;
  cron?: string;
  action: (DescribableAction & { daemonId?: string; key?: string }) | undefined;
  archived?: boolean;
  oneOff?: boolean;
  expiredAt?: number;
  group?: string;
  latestRun?: { ts: number; status?: string; chatId?: string } | null;
  queued?: number;
}

function toDescribableTrigger(raw: unknown): DescribableTrigger | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof t[k] === 'string' ? (t[k] as string) : undefined;
  return {
    type: str('type'),
    expression: str('expression'),
    timezone: str('timezone'),
    rrule: str('rrule'),
    scheme: str('scheme'),
    filter: str('filter'),
  };
}

function toDescribableAction(
  raw: unknown,
): (DescribableAction & { daemonId?: string; key?: string }) | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof a[k] === 'string' ? (a[k] as string) : undefined;
  return {
    type: str('type'),
    skill: str('skill'),
    prompt: str('prompt'),
    folder: str('folder'),
    chatId: str('chatId'),
    command: str('command'),
    daemonId: str('daemonId'),
    key: str('key'),
  };
}

function normalise(raw: Array<Record<string, unknown>>): JobShape[] {
  return raw.map((j) => {
    const trigger = toDescribableTrigger(j['trigger']);
    const action = toDescribableAction(j['action']);
    const latestRunRaw = j['latestRun'];
    const latestRun =
      latestRunRaw && typeof latestRunRaw === 'object'
        ? {
            ts: Number((latestRunRaw as Record<string, unknown>)['ts'] ?? 0),
            status:
              typeof (latestRunRaw as Record<string, unknown>)['status'] === 'string'
                ? ((latestRunRaw as Record<string, unknown>)['status'] as string)
                : undefined,
            chatId:
              typeof (latestRunRaw as Record<string, unknown>)['chatId'] === 'string'
                ? ((latestRunRaw as Record<string, unknown>)['chatId'] as string)
                : undefined,
          }
        : null;
    return {
      id: String(j['id'] ?? j['jobId'] ?? ''),
      name: typeof j['name'] === 'string' ? (j['name'] as string) : undefined,
      enabled: Boolean(j['enabled']),
      createdAt: typeof j['createdAt'] === 'number' ? (j['createdAt'] as number) : 0,
      trigger,
      triggerType: trigger?.type,
      cron: trigger?.expression,
      action,
      archived: typeof j['archived'] === 'boolean' ? (j['archived'] as boolean) : undefined,
      oneOff: typeof j['oneOff'] === 'boolean' ? (j['oneOff'] as boolean) : undefined,
      expiredAt: typeof j['expiredAt'] === 'number' ? (j['expiredAt'] as number) : undefined,
      group: typeof j['group'] === 'string' ? (j['group'] as string) : undefined,
      latestRun,
      queued: typeof j['queued'] === 'number' ? (j['queued'] as number) : undefined,
    };
  });
}

export default function Jobs(): React.ReactElement {
  const router = useRouter();
  const colors = useTheme();
  const [jobs, setJobs] = React.useState<JobShape[]>([]);
  const [loading, setLoading] = React.useState(true);
  // The search box's raw text. The visible list is derived from it on every
  // render rather than stored, so the two can never disagree.
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<JobSort>('last-fired');
  const [filter, setFilter] = React.useState<JobFilter>(NO_JOB_FILTER);
  const [expiredOpen, setExpiredOpen] = React.useState(() => getSectionOpen('jobsExpired', false));
  const [archivedOpen, setArchivedOpen] = React.useState(() =>
    getSectionOpen('jobsArchived', false),
  );

  const hosts = usePresenceStore((s) => s.hosts);
  // Every registered host's live self-reported name, falling back to its
  // daemonId until it has reported one — same source and shape as the job
  // editor's own `hostNames` (spec/15 § Jobs screen).
  const hostNames = React.useMemo(
    () => Object.fromEntries(Object.entries(hosts).map(([id, h]) => [id, h.host?.hostName ?? id])),
    [hosts],
  );

  const load = React.useCallback((): void => {
    void api
      .listJobs()
      .then((r) => setJobs(normalise(r.jobs as Array<Record<string, unknown>>)))
      .catch((e: Error) => Alert.alert('Failed to load jobs', e.message))
      .finally(() => setLoading(false));
  }, []);

  // Re-fetch on focus so returning from the editor shows fresh state.
  useFocusEffect(
    React.useCallback(() => {
      load();
    }, [load]),
  );

  const toggle = (job: JobShape, on: boolean): void => {
    setJobs((curr) => curr.map((j) => (j.id === job.id ? { ...j, enabled: on } : j)));
    const p = on ? api.enableJob(job.id) : api.disableJob(job.id);
    void p.catch((e: Error) => {
      Alert.alert('Toggle failed', e.message);
      setJobs((curr) => curr.map((j) => (j.id === job.id ? { ...j, enabled: !on } : j)));
    });
  };

  // Archive/unarchive is reversible and asks nothing (spec/15 § Jobs screen) —
  // the same control flips it back.
  const archive = (job: JobShape, next: boolean): void => {
    setJobs((curr) => curr.map((j) => (j.id === job.id ? { ...j, archived: next } : j)));
    void api.patchJob(job.id, { archived: next }).catch((e: Error) => {
      Alert.alert('Archive failed', e.message);
      setJobs((curr) => curr.map((j) => (j.id === job.id ? { ...j, archived: !next } : j)));
    });
  };

  // Delete is permanent and asks first, the same confirmation the editor's
  // Delete asks for.
  const remove = (job: JobShape): void => {
    Alert.alert('Delete job?', 'Delete this job? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void api
            .deleteJob(job.id)
            .then(() => setJobs((curr) => curr.filter((j) => j.id !== job.id)))
            .catch((e: Error) => Alert.alert('Delete failed', e.message));
        },
      },
    ]);
  };

  // The row's rendered trigger/action summaries are computed once here and
  // handed to search, the row, AND kept for the empty-state message — search
  // matches exactly what the row shows (spec/14 § Jobs view).
  const rows = React.useMemo(
    () =>
      jobs.map((j) => {
        const subtitle = triggerLabel(j.trigger);
        const hostName = j.action?.daemonId ? hostNames[j.action.daemonId] : undefined;
        const actionLabel = j.action
          ? `${actionVerb(j.action)} ${actionTarget(j.action, hostName)}`
          : undefined;
        // `SortableJob.name` wants a concrete string, and the row falls back
        // to the id for its own title anyway, so the fallback is applied once
        // here rather than at every later reader.
        return { ...j, name: j.name ?? j.id, subtitle, actionLabel };
      }),
    [jobs, hostNames],
  );

  const searched = React.useMemo(() => filterJobs(rows, query), [rows, query]);
  const filtered = React.useMemo(
    () =>
      filterJobsByStatus(
        searched.map((j) => ({ ...j, triggerType: j.triggerType ?? '' })),
        filter,
      ),
    [searched, filter],
  );
  const visible = React.useMemo(() => sortJobs(filtered, sort), [filtered, sort]);
  const groups = React.useMemo(() => groupJobs(visible), [visible]);
  // Only draw section headers once there is more than one section to tell
  // apart (spec/15 § Jobs screen) — an installation with only recurring jobs
  // stays the plain list it always was.
  const grouped =
    groups.oneOff.length > 0 || groups.expired.length > 0 || groups.archived.length > 0;

  const openEditor = (jobId?: string): void => {
    router.push(
      (jobId
        ? `/settings/job-editor?id=${jobId}`
        : '/settings/job-editor') as `/settings/job-editor`,
    );
  };
  const openChat = (chatId: string): void => {
    router.push(`/chats/${chatId}`);
  };
  const rowActions: RowActions = { toggle, archive, remove, openEditor, openChat, colors };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingTop: space.sm,
          // space.lg, not space.md: with the back chevron gone the title is the
          // leftmost thing in the row, so it lines up with the job cards below.
          paddingHorizontal: space.lg,
          paddingBottom: space.sm,
          backgroundColor: colors.paperRaised,
          borderBottomWidth: 1,
          borderColor: colors.lineSoft,
        }}
      >
        <Text style={{ ...typography.title, color: colors.ink, flex: 1 }}>Jobs</Text>
        <Pressable
          onPress={() => openEditor()}
          testID="job-new"
          accessibilityLabel="New job"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: space.xs,
            paddingHorizontal: space.sm,
            borderRadius: radii.md,
            backgroundColor: colors.leaf,
          }}
        >
          <Plus size={16} color={colors.onAccent} />
          <Text
            style={{
              color: colors.onAccent,
              marginLeft: space.xs,
              fontFamily: fonts.bodyBold,
              fontSize: 13,
            }}
          >
            New
          </Text>
        </Pressable>
      </View>
      {/* Search + sort/filter — shown once there is a list to narrow. Same
          shape as the archived-chats box (spec/15 § Chats tab). */}
      {!loading && jobs.length > 0 ? (
        <View style={{ marginHorizontal: space.lg, marginTop: space.md }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colors.paperRaised,
              borderColor: colors.divider,
              borderWidth: 1,
              borderRadius: radii.md,
              paddingHorizontal: space.md,
            }}
          >
            <TextInput
              value={query}
              onChangeText={setQuery}
              returnKeyType="search"
              placeholder={JOBS_SEARCH_PLACEHOLDER}
              placeholderTextColor={colors.ink3}
              accessibilityLabel="jobs-search"
              testID="jobs-search"
              style={{ flex: 1, color: colors.ink, paddingVertical: space.sm, fontSize: 14 }}
            />
          </View>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.sm,
              marginTop: space.sm,
            }}
          >
            <OptionPicker
              testID="jobs-sort"
              selectedId={sort}
              selectedLabel={JOB_SORTS.find((o) => o.value === sort)!.label}
              emptyText="No sorts"
              options={JOB_SORTS.map((o) => ({ id: o.value, label: o.label }))}
              onSelect={(v) => setSort(v as JobSort)}
            />
            <OptionPicker
              testID="jobs-filter-status"
              selectedId={filter.status}
              selectedLabel={JOB_STATUS_FILTERS.find((o) => o.value === filter.status)!.label}
              emptyText="No filters"
              options={JOB_STATUS_FILTERS.map((o) => ({ id: o.value, label: o.label }))}
              onSelect={(v) => setFilter({ ...filter, status: v as JobFilter['status'] })}
            />
            <OptionPicker
              testID="jobs-filter-trigger"
              selectedId={filter.trigger}
              selectedLabel={JOB_TRIGGER_FILTERS.find((o) => o.value === filter.trigger)!.label}
              emptyText="No filters"
              options={JOB_TRIGGER_FILTERS.map((o) => ({ id: o.value, label: o.label }))}
              onSelect={(v) => setFilter({ ...filter, trigger: v as JobFilter['trigger'] })}
            />
          </View>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={{ padding: space.lg }}>
        {loading ? (
          <Text style={{ color: colors.ink3 }}>Loading…</Text>
        ) : jobs.length === 0 ? (
          <EmptyState icon={Clock} title={EMPTY_STATES.jobs.title} body={EMPTY_STATES.jobs.body} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Clock}
            title={EMPTY_STATES.jobSearch.title}
            body={
              query.trim().length === 0 && isJobFilterActive(filter)
                ? 'No jobs match the filter.'
                : EMPTY_STATES.jobSearch.body
            }
          />
        ) : (
          <>
            <JobSection
              jobs={groups.recurring}
              title={grouped ? 'Recurring' : undefined}
              actions={rowActions}
            />
            {groups.oneOff.length > 0 ? (
              <JobSection jobs={groups.oneOff} title="One-off" actions={rowActions} />
            ) : null}
            <FoldedSection
              kind="jobsExpired"
              label="Expired"
              jobs={groups.expired}
              open={expiredOpen}
              setOpen={(v) => {
                setExpiredOpen(v);
                setSectionOpen('jobsExpired', v);
              }}
              actions={rowActions}
            />
            <FoldedSection
              kind="jobsArchived"
              label="Archived"
              jobs={groups.archived}
              open={archivedOpen}
              setOpen={(v) => {
                setArchivedOpen(v);
                setSectionOpen('jobsArchived', v);
              }}
              actions={rowActions}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

type Row = Omit<JobShape, 'name'> & {
  name: string;
  subtitle: string;
  actionLabel: string | undefined;
};

interface RowActions {
  toggle: (job: JobShape, on: boolean) => void;
  archive: (job: JobShape, next: boolean) => void;
  remove: (job: JobShape) => void;
  openEditor: (jobId?: string) => void;
  openChat: (chatId: string) => void;
  colors: ReturnType<typeof useTheme>;
}

function JobSection({
  jobs,
  title,
  actions,
}: {
  jobs: Row[];
  title?: string;
  actions: RowActions;
}): React.ReactElement | null {
  // Hooks run before the length check, so this component never violates the
  // rules of hooks just because a section happens to be empty this render.
  const buckets = React.useMemo(() => groupByUserGroup(jobs), [jobs]);
  if (jobs.length === 0) return null;
  const showGroupHeads = buckets.length > 1;
  return (
    <View style={{ marginBottom: space.md }}>
      {title ? (
        <Text
          style={{
            ...typography.sectionHeader,
            color: actions.colors.ink3,
            marginBottom: space.sm,
          }}
        >
          {title}
        </Text>
      ) : null}
      {buckets.map((bucket) => (
        <View key={bucket.group ?? '\u0000ungrouped'} style={{ marginBottom: space.sm }}>
          {showGroupHeads ? (
            <Text
              style={{
                ...typography.meta,
                color: actions.colors.ink3,
                marginBottom: space.xs,
              }}
            >
              {bucket.group ?? 'Ungrouped'}
            </Text>
          ) : null}
          {bucket.jobs.map((j) => (
            <JobRow key={j.id} job={j} actions={actions} />
          ))}
        </View>
      ))}
    </View>
  );
}

function FoldedSection({
  kind,
  label,
  jobs,
  open,
  setOpen,
  actions,
}: {
  kind: string;
  label: string;
  jobs: Row[];
  open: boolean;
  setOpen: (v: boolean) => void;
  actions: RowActions;
}): React.ReactElement | null {
  if (jobs.length === 0) return null;
  return (
    <View style={{ marginBottom: space.md }}>
      <Pressable
        onPress={() => setOpen(!open)}
        testID={`jobs-${kind}-toggle`}
        accessibilityState={{ expanded: open }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: space.sm,
        }}
      >
        <Text style={{ ...typography.sectionHeader, color: actions.colors.ink2 }}>{label}</Text>
        <Text
          style={{ ...typography.meta, color: actions.colors.ink3 }}
          testID={`jobs-${kind}-count`}
        >
          {jobs.length}
        </Text>
      </Pressable>
      {open ? (
        <View>
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} actions={actions} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function JobRow({ job: j, actions }: { job: Row; actions: RowActions }): React.ReactElement {
  const colors = actions.colors;
  const expired = isExpiredJob(j);
  const archived = isArchivedJob(j);
  const dead = expired || archived;
  const chatId = jobChatId(
    {
      id: j.id,
      actionType: j.action?.type,
      ensureKey: j.action?.key,
      messageChatId: j.action?.chatId,
    },
    j.latestRun?.chatId ?? undefined,
  );
  const queued = queuedLabel(j.queued);

  // The tap target (opening the editor) and the row's own action buttons
  // (chat/archive/delete) are SIBLING Pressables under a plain View, never one
  // nested inside the other — same shape as ChatRowItem's row Pressable +
  // sibling ⋯ button, so a tap on an action button can never also open the
  // editor underneath it.
  return (
    <View
      style={{
        backgroundColor: colors.paperRaised,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        padding: space.md,
        borderRadius: radii.md,
        marginBottom: space.sm,
        opacity: dead ? 0.6 : 1,
      }}
    >
      <Pressable
        onPress={() => actions.openEditor(j.id)}
        testID={`job-row-${j.id}`}
        accessibilityRole="button"
        accessibilityLabel={`Open job ${j.name ?? j.id}`}
        style={{ flexDirection: 'row', alignItems: 'center' }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ ...typography.rowTitle, color: colors.ink }}>{j.name ?? j.id}</Text>
          <Text style={{ ...typography.meta, color: colors.ink3 }}>{j.subtitle}</Text>
          {j.triggerType === 'cron' && j.cron ? (
            <Text style={{ color: colors.inkFaint, ...typography.meta }}>{j.cron}</Text>
          ) : null}
          {j.actionLabel ? (
            <Text style={{ color: colors.inkFaint, ...typography.meta }}>{j.actionLabel}</Text>
          ) : null}
        </View>
        <Switch
          value={j.enabled}
          onValueChange={(v) => actions.toggle(j, v)}
          disabled={dead}
          testID={`job-toggle-${j.id}`}
        />
      </Pressable>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginTop: space.sm,
          gap: space.md,
        }}
      >
        <Text style={{ ...typography.meta, color: colors.ink3 }} testID={`job-last-fired-${j.id}`}>
          {agoLabel(j.latestRun?.ts ?? null)}
        </Text>
        {queued ? (
          <Text style={{ ...typography.meta, color: colors.amber }} testID={`job-queued-${j.id}`}>
            {queued}
          </Text>
        ) : null}
        {chatId ? (
          <Pressable
            onPress={() => actions.openChat(chatId)}
            testID={`job-chat-${j.id}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
          >
            <MessageCircle size={14} color={colors.leaf} />
            <Text style={{ ...typography.meta, color: colors.leaf }}>open chat</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => actions.archive(j, !archived)}
          testID={`job-archive-${j.id}`}
          accessibilityLabel={archived ? 'Unarchive' : 'Archive'}
          hitSlop={8}
        >
          {archived ? (
            <ArchiveRestore size={16} color={colors.ink2} />
          ) : (
            <Archive size={16} color={colors.ink2} />
          )}
        </Pressable>
        <Pressable
          onPress={() => actions.remove(j)}
          testID={`job-delete-${j.id}`}
          accessibilityLabel="Delete"
          hitSlop={8}
        >
          <Trash2 size={16} color={colors.red} />
        </Pressable>
      </View>
    </View>
  );
}
