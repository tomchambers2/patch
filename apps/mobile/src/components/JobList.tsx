// Reusable job list — the job rows + enable toggles, shared between the
// inline Settings → Jobs section (spec/15 § Settings tab: the list shows
// inline on the Settings page) and any standalone jobs screen. Tapping a
// row calls onOpen(jobId) — the caller routes to the full editor, so it is one
// tap from Settings to a job's editor. Enable/disable persists via the job
// REST endpoints. Re-fetches on focus so returning from the editor is fresh.

import React from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Clock } from 'lucide-react-native';
import { api } from '../api/rest';
import { EmptyState } from './EmptyState';
import { EMPTY_STATES } from '../lib/emptyStates';
import { cronRowSubtitle, recurrenceRowSubtitle } from '../lib/jobRow';
import { fonts, radii, space, typography, useTheme } from '../lib/theme';

interface JobShape {
  id: string;
  name?: string;
  triggerType?: string;
  cron?: string;
  /** The trigger's IANA zone; absent means UTC (spec/08 § Cron). */
  timezone?: string;
  /** Bare RRULE value string, `recurrence` triggers only (spec/08 § Recurrence). */
  rrule?: string;
  enabled: boolean;
}

function normalise(raw: Array<Record<string, unknown>>): JobShape[] {
  return raw.map((j) => {
    const trigger =
      j['trigger'] && typeof j['trigger'] === 'object'
        ? (j['trigger'] as Record<string, unknown>)
        : undefined;
    return {
      id: String(j['id'] ?? j['jobId'] ?? ''),
      name: typeof j['name'] === 'string' ? (j['name'] as string) : undefined,
      triggerType: typeof trigger?.['type'] === 'string' ? (trigger['type'] as string) : undefined,
      cron:
        typeof trigger?.['expression'] === 'string' ? (trigger['expression'] as string) : undefined,
      timezone:
        typeof trigger?.['timezone'] === 'string' ? (trigger['timezone'] as string) : undefined,
      rrule: typeof trigger?.['rrule'] === 'string' ? (trigger['rrule'] as string) : undefined,
      enabled: Boolean(j['enabled']),
    };
  });
}

export function JobList({ onOpen }: { onOpen: (jobId?: string) => void }): React.ReactElement {
  const colors = useTheme();
  const [jobs, setJobs] = React.useState<JobShape[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback((): void => {
    void api
      .listJobs()
      .then((r) => setJobs(normalise(r.jobs as Array<Record<string, unknown>>)))
      .catch((e: Error) => Alert.alert('Failed to load jobs', e.message))
      .finally(() => setLoading(false));
  }, []);

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

  // The add affordance is ALWAYS present — even with zero jobs (spec/15 §
  // Settings → Jobs: "an add job affordance sits with the inline
  // list"). Without it the empty list is a dead end.
  const addButton = (
    <Pressable
      onPress={() => onOpen()}
      testID="job-new"
      accessibilityLabel="Add job"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        marginTop: space.md,
        paddingVertical: space.xs,
        paddingHorizontal: space.sm,
        borderRadius: radii.md,
        backgroundColor: colors.leaf,
      }}
    >
      <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyBold, fontSize: 13 }}>
        + Add job
      </Text>
    </Pressable>
  );

  if (loading) return <Text style={{ color: colors.ink3 }}>Loading…</Text>;
  if (jobs.length === 0) {
    return (
      <>
        <EmptyState icon={Clock} title={EMPTY_STATES.jobs.title} body={EMPTY_STATES.jobs.body} />
        {addButton}
      </>
    );
  }
  return (
    <>
      {jobs.map((j) => {
        const subtitle =
          j.triggerType === 'cron' && j.cron
            ? cronRowSubtitle(j.cron, j.timezone)
            : j.triggerType === 'recurrence' && j.rrule
              ? recurrenceRowSubtitle(j.rrule, j.timezone ?? 'UTC')
              : (j.triggerType ?? 'trigger');
        return (
          <Pressable
            key={j.id}
            onPress={() => onOpen(j.id)}
            testID={`job-row-${j.id}`}
            style={{
              paddingVertical: space.sm,
              flexDirection: 'row',
              alignItems: 'center',
              borderBottomWidth: 1,
              borderColor: colors.lineSoft,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ ...typography.rowTitle, color: colors.ink }}>{j.name ?? j.id}</Text>
              <Text style={{ ...typography.meta, color: colors.ink3 }}>{subtitle}</Text>
              {j.triggerType === 'cron' && j.cron ? (
                <Text style={{ color: colors.inkFaint, ...typography.meta }}>{j.cron}</Text>
              ) : null}
            </View>
            <Switch value={j.enabled} onValueChange={(v) => toggle(j, v)} />
          </Pressable>
        );
      })}
      {addButton}
    </>
  );
}
