import { defaultDaemonId, usePresenceStore } from '../../src/stores/presenceStore';
// Full mobile job editor (spec/15 § Job editor). Parity with the
// web editor (packages/web/src/routes/JobEditorRoute.tsx): name + enable,
// trigger type + natural-language cron config, JSONata filter for payload
// triggers, and the two-axis action picker (where: spawn/ensure/message · what:
// skill/prompt). Saves via the same job REST endpoints the web editor uses.
//
// The pure form logic (validation, payload shaping, load-existing) lives in
// src/lib/jobEditor.ts so it is unit-tested independently of RN.

import { useSettingsStore } from '../../src/stores/settingsStore';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronLeft, Trash2 } from 'lucide-react-native';
import { JobWithCounts } from '@patch/wire/jobs';
import type { JobAction, JobTrigger, WebhookScheme } from '@patch/wire/jobs';
import { api } from '../../src/api/rest';
import { useChatStore } from '../../src/stores/chatStore';
import { useFolderStore } from '../../src/stores/folderStore';
import { useUiStore } from '../../src/stores/uiStore';
import { buildRecentFolders } from '../../src/lib/folderPicker';
import { FolderPickerSheet } from '../../src/components/FolderPickerSheet';
import { OptionPicker } from '../../src/components/OptionPicker';
import {
  DEFAULT_FORM,
  type FormState,
  buildGroupOptions,
  formToBody,
  jobToForm,
  resolveSkillEditTarget,
  validateForm,
  RECURRENCE_MONTHS,
  RECURRENCE_NTH,
  RECURRENCE_WEEKDAYS,
  formatTimeHHMM,
  parseTimeHHMM,
  recurrenceFieldsToRule,
  toggleRecurrenceDay,
  toggleRecurrenceMonth,
  withRecurrenceFrequency,
} from '../../src/lib/jobEditor';
import { editRoute } from '../../src/lib/hostFiles';
import { describeCron, parseNaturalSchedule } from '../../src/lib/naturalCron';
import {
  PERMISSION_MODE_ORDER,
  offeredPermissionModes,
  permissionModeLabel,
} from '../../src/lib/permissionModes';
import {
  describeRecurrence,
  folderName,
  parseRecurrenceFields,
  type PermissionMode,
  type RecurrenceFields,
} from '@patch/wire';
import { fonts, radii, space, textMin, typography, useTheme } from '../../src/lib/theme';
import { useGoBack } from '../../src/lib/goBack';

// ── small building blocks ───────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={{ ...typography.meta, color: colors.ink3, marginBottom: space.xs }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function Input(props: React.ComponentProps<typeof TextInput>): React.ReactElement {
  const colors = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors.inkFaint}
      {...props}
      style={[
        {
          backgroundColor: colors.paperRaised,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.divider,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          color: colors.ink,
          fontFamily: fonts.body,
        },
        props.style,
      ]}
    />
  );
}

interface PillOption<T extends string> {
  value: T;
  label: string;
}

function Pills<T extends string>({
  options,
  value,
  onChange,
  testID,
  multi,
}: {
  options: Array<PillOption<T>>;
  value: T;
  /** Multi-select: every value in this list reads as active (overrides `value`). */
  multi?: readonly string[];
  onChange: (v: T) => void;
  testID?: string;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} testID={testID}>
      {options.map((o) => {
        const active = multi ? multi.includes(o.value) : o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              borderRadius: radii.pill,
              borderWidth: 1,
              borderColor: active ? colors.leaf : colors.divider,
              backgroundColor: active ? colors.accentTint : colors.paperRaised,
            }}
          >
            <Text
              style={{
                ...typography.meta,
                color: active ? colors.leafSoft : colors.ink2,
                fontFamily: active ? fonts.bodyMedium : fonts.body,
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── screen ────────────────────────────────────────────────────────────────

export default function JobEditor(): React.ReactElement {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/jobs');
  const colors = useTheme();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id;
  const isNew = !id || id === 'new';

  const [form, setForm] = React.useState<FormState>(DEFAULT_FORM);
  // The loaded job's END CONDITION (spec/08 § One-off jobs), kept separately
  // from `form` — `oneOff`/`expiredAt` have no editable control on this page
  // (set instead through the agent tools, same as `concurrency`), so there is
  // nothing for a form field to hold. This is read-only display state only,
  // the mobile side of the same gap the web editor had: neither surface said
  // whether a job was one-off or had already retired.
  const [loadedJob, setLoadedJob] = React.useState<{
    oneOff?: boolean;
    expiredAt?: number;
  } | null>(null);
  const [loading, setLoading] = React.useState(!isNew);
  const [saving, setSaving] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [showRawCron, setShowRawCron] = React.useState(false);
  const [folderSheetOpen, setFolderSheetOpen] = React.useState(false);
  const [groupCustom, setGroupCustom] = React.useState(false);
  // Group picker source: the same live jobs list the Jobs tab reads (spec/15
  // § Job editor), so a group typed on one job shows up as a pickable option
  // on the next.
  const [existingGroups, setExistingGroups] = React.useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = React.useState<string[]>([]);
  // Absolute host-side file per skill name, for the Skill picker's Edit
  // link (spec/15 § Job editor). Undefined until a fetch answers, absent from
  // an older host's answer — either way `resolveSkillEditTarget` reads it as
  // "no link to offer" rather than guessing a path.
  const [skillPaths, setSkillPaths] = React.useState<Record<string, string> | undefined>(undefined);
  // The chosen host's model catalogue (spec/15 § Job editor). Live and per
  // machine, so it is refetched whenever the job moves to a different host —
  // offering host-a's models for a job that fires on host-b is how an
  // unrunnable model id gets stored.
  const [availableModels, setAvailableModels] = React.useState<
    Array<{ id: string; label: string }>
  >([]);

  const chats = useChatStore((s) => s.chats);
  const chatList = React.useMemo(() => Object.values(chats), [chats]);
  // The host the job's chat runs on, and whose folder registry the picker
  // shows (spec/08 § Action — the action is dispatched to the host it names).
  const jobDaemonId = usePresenceStore((s) => defaultDaemonId(s.hosts));
  // Every folder the picker sheet offers, across hosts (spec/15 § Folder
  // picker sheet). The selector returns the stored map (stable); the list is
  // derived — building it inside the selector would loop.
  const hostFolders = useFolderStore((s) => s.byHost);
  const hosts = usePresenceStore((s) => s.hosts);
  const recents = React.useMemo(() => buildRecentFolders(chats, hostFolders), [chats, hostFolders]);
  const pickerHosts = React.useMemo(
    () =>
      Object.values(hosts)
        .map((h) => ({
          daemonId: h.daemonId,
          name: h.host?.hostName ?? h.daemonId,
          online: h.online,
        }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    [hosts],
  );
  const hostName = (id: string): string => hosts[id]?.host?.hostName ?? id;

  // When the stored group isn't one of the known options it's ad-hoc: the
  // picker drops into "New group…" free-text mode, same rule as Folder above.
  const groupIsAdHoc = groupCustom || (form.group !== '' && !existingGroups.includes(form.group));

  // The skill picker targets the action's folder (spawn/ensure) or the
  // recipient chat's folder (message); the Edit link resolves against
  // whichever host that folder is on.
  const messageChat = chatList.find((c) => c.chatId === form.messageChatId);
  const messageChatFolder = messageChat?.folder ?? '';
  const skillFolder = form.actionType === 'message' ? messageChatFolder : form.spawnFolder;
  const skillDaemonId =
    form.actionType === 'message' ? (messageChat?.daemonId ?? '') : form.spawnDaemonId;

  // Load the jobs list for the Group picker's options.
  React.useEffect(() => {
    let live = true;
    void api
      .listJobs()
      .then((r) => {
        if (live) setExistingGroups(buildGroupOptions(r.jobs as { group?: string }[]));
      })
      .catch(() => {
        if (live) setExistingGroups([]);
      });
    return () => {
      live = false;
    };
  }, []);

  // Load the existing job.
  React.useEffect(() => {
    if (isNew) return;
    let live = true;
    void api
      // `isNew = !id || id === 'new'`, so `!isNew` here already guarantees
      // `id` is a truthy string — `?? ''` only satisfies the `string |
      // undefined` param type, never a real path.
      /* v8 ignore next */
      .getJob(id ?? '')
      .then((raw) => {
        if (!live) return;
        // The server attaches live concurrency counts to a job it hands out,
        // so parse the RESPONSE shape — the stored `Job` is strict and would
        // reject every job (spec/08 ## Concurrency).
        const job = JobWithCounts.parse(raw);
        const f = jobToForm(job);
        // Prefill the natural-language field with a readable rendering of the
        // cron so an edited job shows a phrase rather than blank.
        if (job.trigger.type === 'cron') {
          f.scheduleText = describeCron(job.trigger.expression);
        }
        setForm(f);
        setLoadedJob({ oneOff: job.oneOff, expiredAt: job.expiredAt });
      })
      .catch((e: Error) => Alert.alert('Failed to load job', e.message))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id, isNew]);

  // Seed a new job's folder to the first known folder once options load. The
  // host-owned list arrives via the WS (`folders.list` / `folders.updated`)
  // and the cold-start fetch in bootstrap — no per-screen fetch needed.
  React.useEffect(() => {
    const first = recents.find((r) => r.daemonId === jobDaemonId)?.folder;
    if (isNew && form.spawnFolder === '' && first) {
      // Belt-and-braces re-check inside the functional updater against a
      // stale closure: this component is single-threaded, synchronous
      // React (no concurrent mode), and the effect's own guard above reads
      // the identical `form.spawnFolder === ''` predicate in the same
      // render/commit — nothing can flip it between here and the updater
      // running, so the `f.spawnFolder !== ''` arm is unreachable today.
      /* v8 ignore next */
      setForm((f) => (f.spawnFolder === '' ? { ...f, spawnFolder: first } : f));
    }
  }, [isNew, recents, jobDaemonId, form.spawnFolder]);

  // Seed the host the same way the web editor does: the account's default host
  // (its home host, or the only one) when there is an unambiguous answer. With
  // several hosts and no home marked there is none, the field stays empty and
  // save refuses — better than silently scheduling work onto the wrong machine
  // (spec/08 § Action).
  React.useEffect(() => {
    if (!isNew || form.spawnDaemonId !== '' || jobDaemonId === null) return;
    setForm((f) => (f.spawnDaemonId === '' ? { ...f, spawnDaemonId: jobDaemonId } : f));
  }, [isNew, jobDaemonId, form.spawnDaemonId]);

  // Fetch the target folder's skills for the Skill picker.
  React.useEffect(() => {
    const folder = skillFolder.trim();
    const daemonId = skillDaemonId.trim();
    if (folder === '' || daemonId === '') {
      setAvailableSkills([]);
      setSkillPaths(undefined);
      return;
    }
    let live = true;
    void api
      .skills(folder, daemonId)
      .then((r) => {
        if (!live) return;
        setAvailableSkills(r.skills ?? []);
        setSkillPaths(r.paths);
      })
      .catch(() => {
        if (!live) return;
        setAvailableSkills([]);
        setSkillPaths(undefined);
      });
    return () => {
      live = false;
    };
  }, [skillFolder, skillDaemonId]);

  // Fetch the chosen host's models for the Model picker. NO FALLBACK: a failed
  // load leaves the list empty rather than showing a plausible hard-coded set
  // that this host may not actually serve.
  React.useEffect(() => {
    // Inlined rather than using `usesSpawnFields` below: that is declared later
    // in the component body, so reading it here would hit its TDZ on render.
    const spawns = form.actionType === 'spawn' || form.actionType === 'continue';
    const daemonId = form.spawnDaemonId.trim();
    if (daemonId === '' || !spawns) {
      setAvailableModels([]);
      return;
    }
    let live = true;
    void api
      .models(daemonId)
      .then((r) => {
        if (live) setAvailableModels(r.models ?? []);
      })
      .catch(() => {
        if (live) setAvailableModels([]);
      });
    return () => {
      live = false;
    };
  }, [form.spawnDaemonId, form.actionType]);

  const scheduleUnparsed =
    form.scheduleText.trim() !== '' && parseNaturalSchedule(form.scheduleText) === null;
  const cronPreview = describeCron(form.cronExpression);
  const recurrencePreview = describeRecurrence(form.recurrenceRule);
  const recurrenceFields = parseRecurrenceFields(form.recurrenceRule);
  const [showRawRecurrence, setShowRawRecurrence] = React.useState(false);
  const [recurrenceTimeText, setRecurrenceTimeText] = React.useState<string | null>(null);
  const setRecurrenceFields = (f: RecurrenceFields): void =>
    setForm({ ...form, recurrenceRule: recurrenceFieldsToRule(f) });

  const save = async (): Promise<void> => {
    const error = validateForm(form);
    if (error) {
      Alert.alert('Check the form', error);
      return;
    }
    setSaving(true);
    try {
      const body = formToBody(form);
      if (isNew) await api.createJob(body);
      // `!isNew` here again guarantees `id` is a truthy string (see the
      // getJob() effect above) — `?? ''` only satisfies the param type.
      /* v8 ignore next */ else await api.patchJob(id ?? '', body);
      router.back();
    } catch (e) {
      Alert.alert(isNew ? 'Create failed' : 'Save failed', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Run now (spec/08 ## Manual run, spec/15 § Job editor): fires the
  // action once, immediately, for trying it out without waiting for the real
  // trigger or enabling the job first. Mobile has no persistent runs panel
  // (unlike web), so the outcome is a plain Alert.
  const runNow = async (): Promise<void> => {
    setRunning(true);
    try {
      // Only rendered inside `!isNew ? ... : null` below, which guarantees
      // `id` is a truthy string — `?? ''` only satisfies the param type.
      /* v8 ignore next */
      const result = await api.runJob(id ?? '');
      Alert.alert('Run now', `Status: ${result.status}`);
    } catch (e) {
      Alert.alert('Run now failed', (e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const remove = (): void => {
    Alert.alert('Delete this job?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void api
            // `remove` is only wired to the Delete button rendered inside
            // `!isNew ? ... : null` below, which again guarantees `id` is a
            // truthy string — `?? ''` only satisfies the param type.
            /* v8 ignore next */
            .deleteJob(id ?? '')
            .then(() => router.back())
            .catch((e: Error) => Alert.alert('Delete failed', e.message));
        },
      },
    ]);
  };

  // Skill options always keep the current value so a saved skill is never
  // silently dropped when the folder's list hasn't loaded.
  const skillValue = form.actionType === 'message' ? form.messageSkill : form.spawnSkill;
  const skillOptions = Array.from(
    new Set([...(skillValue ? [skillValue] : []), ...availableSkills]),
  );
  // Same rule for models, plus a leading `Host default` chip: '' is a choice
  // the user has to be able to return to, not just the initial state.
  // The shared accounts the job's chat could start on, for its model's backend.
  const sharedSecrets = useSettingsStore((st) => st.data?.shared?.secrets);
  const accountOptions = React.useMemo(() => {
    const list =
      (form.spawnModel.startsWith('openai/') ? sharedSecrets?.codex : sharedSecrets?.claude) ?? [];
    const held = list.map((a) => ({ id: a.id, label: a.label }));
    const extra =
      form.spawnAccount && !held.some((a) => a.id === form.spawnAccount)
        ? [{ id: form.spawnAccount, label: `${form.spawnAccount} (not held)` }]
        : [];
    return [{ id: '', label: 'By strategy' }, ...extra, ...held];
  }, [sharedSecrets, form.spawnModel, form.spawnAccount]);
  const modelOptions: Array<{ id: string; label: string }> = [
    { id: '', label: 'Host default' },
    ...(form.spawnModel && !availableModels.some((m) => m.id === form.spawnModel)
      ? [{ id: form.spawnModel, label: form.spawnModel }]
      : []),
    ...availableModels,
  ];
  const setSkill = (v: string): void =>
    setForm((f) =>
      f.actionType === 'message' ? { ...f, messageSkill: v } : { ...f, spawnSkill: v },
    );

  // The Edit link beside a chosen skill — what the job DOES, one click from
  // the job that does it (spec/15 § Job editor).
  function skillEditLink(): React.ReactElement | null {
    const target = resolveSkillEditTarget({
      skill: skillValue,
      paths: skillPaths,
      daemonId: skillDaemonId,
    });
    if (target === null) return null;
    if ('reason' in target) {
      return (
        <Text
          testID="job-skill-edit-unavailable"
          style={{ color: colors.ink3, fontSize: textMin, marginTop: space.xs }}
        >
          {target.reason}
        </Text>
      );
    }
    const to = target;
    return (
      <Pressable
        onPress={() => router.push(editRoute(to.daemonId, to.path))}
        style={{ marginTop: space.xs }}
      >
        <Text
          testID="job-skill-edit"
          style={{ color: colors.leaf, fontSize: textMin, fontFamily: fonts.bodyBold }}
        >
          Edit
        </Text>
      </Pressable>
    );
  }

  const usesSpawnFields = form.actionType === 'spawn' || form.actionType === 'continue';
  /**
   * Who gets the Folder picker. A `script` action stores the same (host,
   * folder) pair as spawn/continue — it just runs a command there instead of a
   * chat — so it shares the picker. Only `message` has no folder of its own; it
   * inherits one from the chat it delivers into.
   */
  const usesFolderFields = usesSpawnFields || form.actionType === 'script';

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingTop: space.sm,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
          backgroundColor: colors.paperRaised,
          borderBottomWidth: 1,
          borderColor: colors.lineSoft,
        }}
      >
        <Pressable onPress={goBack} style={{ padding: space.sm }} accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Text
          style={{
            ...typography.title,
            color: colors.ink,
            marginLeft: space.sm,
            flex: 1,
          }}
        >
          {isNew ? 'New job' : 'Edit job'}
        </Text>
        {/* The job's end condition (spec/08 § One-off jobs) — read-only, same
            reasoning as the web editor's chips next to this title. */}
        {loadedJob?.oneOff ? (
          <Text
            style={{ ...typography.meta, color: colors.amber, marginRight: space.sm }}
            testID="job-editor-oneoff"
          >
            ONE-OFF
          </Text>
        ) : null}
        {loadedJob?.expiredAt !== undefined ? (
          <Text
            style={{ ...typography.meta, color: colors.red, marginRight: space.sm }}
            testID="job-editor-expired"
          >
            EXPIRED
          </Text>
        ) : null}
        {!isNew ? (
          <Pressable onPress={remove} style={{ padding: space.sm }} accessibilityLabel="Delete">
            <Trash2 size={20} color={colors.red} />
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.leaf} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxxl }}>
          {/* Name + enable */}
          <Field label="Name">
            <Input
              value={form.name}
              onChangeText={(v) => setForm({ ...form, name: v })}
              placeholder="e.g. Morning brief"
              testID="job-name"
            />
          </Field>
          <Field label="Group · optional">
            <OptionPicker
              testID="job-group"
              selectedId={groupIsAdHoc ? '__new_group__' : form.group}
              selectedLabel={groupIsAdHoc ? 'New group…' : form.group || 'Ungrouped'}
              emptyText="No groups yet."
              options={[
                { id: '', label: 'Ungrouped' },
                ...existingGroups.map((g) => ({ id: g, label: g })),
                { id: '__new_group__', label: 'New group…' },
              ]}
              onSelect={(id) => {
                if (id === '__new_group__') {
                  setGroupCustom(true);
                  setForm({ ...form, group: '' });
                  return;
                }
                setGroupCustom(false);
                setForm({ ...form, group: id });
              }}
            />
            {groupIsAdHoc ? (
              <Input
                value={form.group}
                onChangeText={(v) => setForm({ ...form, group: v })}
                placeholder="e.g. Home, Finance, Watchers"
                testID="job-group-custom"
                style={{ marginTop: space.sm }}
              />
            ) : null}
          </Field>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: space.lg,
            }}
          >
            <Text style={{ color: colors.ink2, fontFamily: fonts.bodyBold }}>Enabled</Text>
            <Switch
              value={form.enabled}
              onValueChange={(v) => setForm({ ...form, enabled: v })}
              testID="job-enabled"
            />
          </View>

          {/* Trigger */}
          <Text style={{ color: colors.ink, fontFamily: fonts.bodyBold, marginBottom: space.sm }}>
            Trigger
          </Text>
          <Field label="Trigger type">
            <Pills<JobTrigger['type']>
              testID="job-trigger-type"
              value={form.triggerType}
              onChange={(v) => setForm({ ...form, triggerType: v })}
              options={[
                { value: 'cron', label: 'cron' },
                { value: 'recurrence', label: 'recurrence' },
                { value: 'webhook', label: 'webhook' },
                { value: 'todoist', label: 'todoist' },
              ]}
            />
          </Field>

          {form.triggerType === 'cron' ? (
            <>
              <Field label="Schedule">
                <Input
                  value={form.scheduleText}
                  placeholder="e.g. every weekday at 9am"
                  testID="job-schedule-nl"
                  autoCapitalize="none"
                  onChangeText={(v) => {
                    const cron = parseNaturalSchedule(v);
                    setForm({
                      ...form,
                      scheduleText: v,
                      ...(cron ? { cronExpression: cron } : {}),
                    });
                  }}
                />
              </Field>
              {/* The zone the expression is evaluated in. The expression is
                  stored exactly as typed — nothing is rewritten into UTC — so
                  DST moves the fire time with the user, not past it. */}
              <Field label="Timezone">
                <Input
                  value={form.cronTimezone}
                  placeholder="Europe/London"
                  onChangeText={(v) => setForm({ ...form, cronTimezone: v })}
                  autoCapitalize="none"
                  testID="job-cron-timezone"
                />
              </Field>
              <View style={{ marginBottom: space.md }}>
                {scheduleUnparsed ? (
                  <Text style={{ color: colors.amber, fontSize: textMin }}>
                    Couldn’t read “{form.scheduleText.trim()}” — set the cron directly below.
                  </Text>
                ) : (
                  <Text style={{ color: colors.ink3, fontSize: textMin }}>
                    Runs {cronPreview || form.cronExpression} ·{' '}
                    <Text testID="job-cron-value">{form.cronExpression}</Text> ·{' '}
                    <Text testID="job-cron-timezone-value">{form.cronTimezone}</Text>
                  </Text>
                )}
                <Pressable
                  onPress={() => setShowRawCron((v) => !v)}
                  style={{ marginTop: space.xs }}
                >
                  <Text
                    style={{ color: colors.leaf, fontSize: textMin, fontFamily: fonts.bodyBold }}
                  >
                    {showRawCron ? 'hide cron' : 'edit cron directly'}
                  </Text>
                </Pressable>
              </View>
              {showRawCron || scheduleUnparsed ? (
                <Field label="Cron expression">
                  <Input
                    value={form.cronExpression}
                    onChangeText={(v) => setForm({ ...form, cronExpression: v })}
                    autoCapitalize="none"
                    testID="job-cron"
                  />
                </Field>
              ) : null}
            </>
          ) : null}

          {form.triggerType === 'recurrence' ? (
            <>
              {recurrenceFields ? (
                <>
                  <Field label="Repeats">
                    <Pills<RecurrenceFields['freq']>
                      testID="job-recurrence-freq"
                      value={recurrenceFields.freq}
                      onChange={(v) =>
                        setRecurrenceFields(withRecurrenceFrequency(recurrenceFields, v))
                      }
                      options={[
                        { value: 'WEEKLY', label: 'Weekly' },
                        { value: 'MONTHLY', label: 'Monthly' },
                        { value: 'YEARLY', label: 'Yearly' },
                      ]}
                    />
                  </Field>
                  {recurrenceFields.freq !== 'WEEKLY' ? (
                    <Field label="Which">
                      <Pills<string>
                        testID="job-recurrence-nth"
                        value={String(recurrenceFields.setPos)}
                        onChange={(v) =>
                          setRecurrenceFields({ ...recurrenceFields, setPos: Number(v) })
                        }
                        options={RECURRENCE_NTH.map((o) => ({ ...o }))}
                      />
                    </Field>
                  ) : null}
                  <Field label={recurrenceFields.freq === 'WEEKLY' ? 'Days' : 'Day'}>
                    <Pills<string>
                      testID="job-recurrence-days"
                      value={recurrenceFields.days[0] ?? ''}
                      multi={recurrenceFields.days}
                      onChange={(v) =>
                        setRecurrenceFields(toggleRecurrenceDay(recurrenceFields, v))
                      }
                      options={RECURRENCE_WEEKDAYS.map((d) => ({ value: d.code, label: d.label }))}
                    />
                  </Field>
                  {recurrenceFields.freq !== 'WEEKLY' ? (
                    <Field
                      label={recurrenceFields.freq === 'YEARLY' ? 'Months' : 'Months (all if none)'}
                    >
                      <Pills<string>
                        testID="job-recurrence-months"
                        value=""
                        multi={(recurrenceFields.months ?? []).map(String)}
                        onChange={(v) =>
                          setRecurrenceFields(toggleRecurrenceMonth(recurrenceFields, Number(v)))
                        }
                        options={RECURRENCE_MONTHS.map((m) => ({
                          value: String(m.n),
                          label: m.label,
                        }))}
                      />
                    </Field>
                  ) : null}
                  <Field label="Time (24h)">
                    <Input
                      value={
                        recurrenceTimeText ??
                        formatTimeHHMM(recurrenceFields.hour, recurrenceFields.minute)
                      }
                      placeholder="09:00"
                      keyboardType="numbers-and-punctuation"
                      onChangeText={(v) => {
                        setRecurrenceTimeText(v);
                        const t = parseTimeHHMM(v);
                        if (t) setRecurrenceFields({ ...recurrenceFields, ...t });
                      }}
                      onBlur={() => setRecurrenceTimeText(null)}
                      testID="job-recurrence-time"
                    />
                  </Field>
                </>
              ) : null}
              <Pressable
                onPress={() => setShowRawRecurrence((v) => !v)}
                testID="job-recurrence-raw-toggle"
                style={{ marginBottom: space.md }}
              >
                <Text style={{ color: colors.ink3, fontSize: textMin }}>
                  {showRawRecurrence || !recurrenceFields ? 'hide RRULE' : 'edit RRULE directly'}
                </Text>
              </Pressable>
              {showRawRecurrence || !recurrenceFields ? (
                <Field label="RRULE">
                  <Input
                    value={form.recurrenceRule}
                    onChangeText={(v) => setForm({ ...form, recurrenceRule: v })}
                    autoCapitalize="none"
                    testID="job-recurrence-rule"
                  />
                </Field>
              ) : null}
              <Field label="Timezone">
                <Input
                  value={form.recurrenceTimezone}
                  placeholder="Europe/London"
                  onChangeText={(v) => setForm({ ...form, recurrenceTimezone: v })}
                  autoCapitalize="none"
                  testID="job-recurrence-timezone"
                />
              </Field>
              <View style={{ marginBottom: space.md }}>
                <Text
                  style={{ color: colors.ink3, fontSize: textMin }}
                  testID="job-recurrence-preview"
                >
                  {recurrencePreview
                    ? `Runs ${recurrencePreview} · ${form.recurrenceTimezone}`
                    : `Raw RRULE — couldn’t phrase this one in English`}
                </Text>
              </View>
            </>
          ) : null}

          {form.triggerType === 'webhook' ? (
            <>
              <Field label="Scheme">
                <Pills<WebhookScheme>
                  value={form.webhookScheme}
                  onChange={(v) => setForm({ ...form, webhookScheme: v })}
                  options={[
                    { value: 'none', label: 'none' },
                    { value: 'hmac-sha256', label: 'hmac-sha256' },
                    { value: 'github', label: 'github' },
                    { value: 'stripe', label: 'stripe' },
                  ]}
                />
              </Field>
              <Field label="Secret">
                <Input
                  value={form.webhookSecret}
                  onChangeText={(v) => setForm({ ...form, webhookSecret: v })}
                  autoCapitalize="none"
                />
              </Field>
            </>
          ) : null}

          {/* Filter — only for payload-bearing triggers (never cron/recurrence). */}
          {form.triggerType !== 'cron' && form.triggerType !== 'recurrence' ? (
            <Field label="Filter · JSONata on the trigger payload (optional)">
              <Input
                value={form.filter}
                onChangeText={(v) => setForm({ ...form, filter: v })}
                autoCapitalize="none"
                multiline
                testID="job-filter"
                style={{ minHeight: 64, textAlignVertical: 'top' }}
              />
            </Field>
          ) : null}

          {/* The GATE (spec/08 § Gate) — a command asked before each fire, which
            decides whether the action runs at all. Beside Filter because it is the
            same kind of thing: a precondition. Filter asks about the trigger's
            payload (so it is hidden for cron); a gate asks about the WORLD, which
            is most useful on exactly the cron jobs Filter cannot help. */}
          <Text
            style={{
              color: colors.ink,
              fontFamily: fonts.bodyBold,
              marginTop: space.md,
              marginBottom: space.sm,
            }}
          >
            Gate · optional
          </Text>
          <Pressable
            testID="job-gate-on"
            onPress={() =>
              setForm((f) => ({
                ...f,
                gateOn: !f.gateOn,
                // Seed from the action: the work's host and folder is almost
                // always where the question belongs too.
                ...(!f.gateOn && f.gateDaemonId === '' ? { gateDaemonId: f.spawnDaemonId } : {}),
                ...(!f.gateOn && f.gateFolder === '' ? { gateFolder: f.spawnFolder } : {}),
              }))
            }
            style={{
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              borderRadius: radii.md,
              borderWidth: 1,
              borderColor: form.gateOn ? colors.leaf : colors.divider,
              backgroundColor: form.gateOn ? colors.accentTint : colors.paperRaised,
              marginBottom: space.sm,
            }}
          >
            <Text style={{ color: form.gateOn ? colors.leaf : colors.ink2, fontSize: textMin }}>
              Ask a command first, and only run the action if it says to
            </Text>
          </Pressable>
          {form.gateOn ? (
            <>
              <Field label="Gate host">
                <Input
                  value={form.gateDaemonId}
                  onChangeText={(v) => setForm({ ...form, gateDaemonId: v })}
                  autoCapitalize="none"
                  testID="job-gate-daemon"
                />
              </Field>
              <Field label="Gate folder">
                <Input
                  value={form.gateFolder}
                  onChangeText={(v) => setForm({ ...form, gateFolder: v })}
                  autoCapitalize="none"
                  testID="job-gate-folder"
                />
              </Field>
              <Field label="Gate command · run by `bash -lc` in the folder above">
                <Input
                  value={form.gateCommand}
                  onChangeText={(v) => setForm({ ...form, gateCommand: v })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  placeholder="#!/usr/bin/env bash"
                  testID="job-gate-command"
                  style={{ ...typography.code, minHeight: 200, textAlignVertical: 'top' }}
                />
              </Field>
              <Field label="Gate timeout (ms) · empty means 60000">
                <Input
                  value={form.gateTimeoutMs}
                  onChangeText={(v) => setForm({ ...form, gateTimeoutMs: v })}
                  keyboardType="number-pad"
                  placeholder="60000"
                  testID="job-gate-timeout"
                />
              </Field>
              <Text style={{ color: colors.ink3, fontSize: textMin, marginBottom: space.md }}>
                exit 0 runs the action. exit 1 holds it — and must print why on stdout, which
                becomes the run’s headline. Any other exit, no reason, or a timeout is a fault.
              </Text>
            </>
          ) : null}

          {/* Action */}
          <Text
            style={{
              color: colors.ink,
              fontFamily: fonts.bodyBold,
              marginTop: space.md,
              marginBottom: space.sm,
            }}
          >
            Action
          </Text>
          <Field label="Where">
            <Pills<JobAction['type']>
              testID="job-action-type"
              value={form.actionType}
              onChange={(v) => setForm({ ...form, actionType: v })}
              options={[
                { value: 'spawn', label: 'spawn new chat' },
                { value: 'continue', label: 'persistent chat' },
                { value: 'message', label: 'message a chat' },
                { value: 'script', label: 'run a command' },
              ]}
            />
          </Field>
          {form.actionType === 'continue' ? (
            <Text style={{ color: colors.ink3, fontSize: textMin, marginBottom: space.md }}>
              The first fire creates one chat in this folder; every later fire messages the SAME
              chat, so context builds up over time. You don’t pre-create it.
            </Text>
          ) : null}

          {usesFolderFields ? (
            <>
              <Field label="Folder">
                <Pressable
                  testID="job-spawn-folder"
                  onPress={() => setFolderSheetOpen(true)}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.xs,
                    alignSelf: 'flex-start',
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                    borderRadius: radii.md,
                    borderWidth: 1,
                    borderColor: colors.divider,
                    backgroundColor: pressed ? colors.accentTint : colors.paperRaised,
                  })}
                >
                  <Text
                    numberOfLines={1}
                    style={{ color: colors.ink, fontFamily: fonts.body, fontSize: textMin }}
                  >
                    {form.spawnFolder === ''
                      ? 'Choose a folder…'
                      : `${folderName(form.spawnFolder)}${
                          form.spawnDaemonId ? ` · ${hostName(form.spawnDaemonId)}` : ''
                        }`}
                  </Text>
                  <ChevronDown size={14} color={colors.ink3} />
                </Pressable>
                <FolderPickerSheet
                  visible={folderSheetOpen}
                  recents={recents}
                  hosts={pickerHosts}
                  currentDaemonId={form.spawnDaemonId || null}
                  onPick={(daemonId, folder) => {
                    const h = hosts[daemonId];
                    if (h && !h.online) {
                      useUiStore
                        .getState()
                        .pushError(
                          `${hostName(daemonId)} is offline — pick a folder on another host`,
                        );
                      return;
                    }
                    setForm({ ...form, spawnDaemonId: daemonId, spawnFolder: folder });
                    setFolderSheetOpen(false);
                  }}
                  onDismiss={() => setFolderSheetOpen(false)}
                />
              </Field>
              {/* A script fire runs no agent, so it has no model to pick — the
                whole point of the action (@patch/wire `ScriptAction`). */}
              {usesSpawnFields ? (
                <>
                  {/* Model (spec/15 § Job editor). Leads with `Host default`, which is
                a real setting rather than the lack of one: no stored model means
                each fire takes whatever that host was last used on, so the job
                tracks the machine instead of pinning an id that will be retired.
                A saved model is always kept as a chip even when the catalogue
                is empty, so editing another field can't silently unpin it. */}
                  <Field label="Model">
                    {form.spawnDaemonId.trim() === '' ? (
                      <Text style={{ color: colors.ink3, fontSize: textMin }}>
                        Pick a folder first — models are per host.
                      </Text>
                    ) : (
                      <OptionPicker
                        testID="job-spawn-model"
                        selectedId={form.spawnModel}
                        selectedLabel={
                          modelOptions.find((m) => m.id === form.spawnModel)?.label ??
                          form.spawnModel
                        }
                        emptyText="No models on this host."
                        options={modelOptions}
                        onSelect={(id) =>
                          setForm({
                            ...form,
                            spawnModel: id,
                            // A mode the new model cannot run is reset in view
                            // rather than degraded silently at fire time.
                            spawnPermissionMode:
                              id === '' ||
                              offeredPermissionModes(id).includes(form.spawnPermissionMode)
                                ? form.spawnPermissionMode
                                : 'default',
                          })
                        }
                      />
                    )}
                  </Field>
                  {/* The account the job's chat starts on (spec/08 § Action,
                  spec/10 — preferred account). A preference, not a pin. */}
                  {accountOptions.length > 2 ? (
                    <Field label="Start on account">
                      <OptionPicker
                        testID="job-spawn-account"
                        selectedId={form.spawnAccount}
                        selectedLabel={
                          accountOptions.find((a) => a.id === form.spawnAccount)?.label ??
                          form.spawnAccount
                        }
                        emptyText="No accounts."
                        options={accountOptions}
                        onSelect={(id) => setForm({ ...form, spawnAccount: id })}
                      />
                    </Field>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <Field label="Recipient chat">
              <View style={{ gap: space.sm }}>
                {chatList.length === 0 ? (
                  <Text style={{ color: colors.ink3, fontSize: textMin }}>
                    No chats yet — start one first.
                  </Text>
                ) : null}
                {chatList.map((c) => {
                  const active = form.messageChatId === c.chatId;
                  return (
                    <Pressable
                      key={c.chatId}
                      onPress={() => setForm({ ...form, messageChatId: c.chatId })}
                      style={{
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        borderRadius: radii.md,
                        borderWidth: 1,
                        borderColor: active ? colors.leaf : colors.divider,
                        backgroundColor: active ? colors.accentTint : colors.paperRaised,
                      }}
                    >
                      <Text style={{ color: active ? colors.leaf : colors.ink }}>
                        {c.name ?? c.chatId}
                      </Text>
                      <Text style={{ ...typography.meta, color: colors.ink3 }}>{c.folder}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Field>
          )}

          {/* A `script` action's payload: the command itself. `command` is handed
            to `bash -lc` whole, so a whole gate lives in this field rather than
            in a file on the host where no surface can show it (@patch/wire
            `ScriptAction`). Mono and tall for that reason — it is a script, not
            a one-liner. */}
          {form.actionType === 'script' ? (
            <>
              <Field label="Command · run by `bash -lc` in the folder above">
                <Input
                  value={form.scriptCommand}
                  onChangeText={(v) => setForm({ ...form, scriptCommand: v })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  placeholder="#!/usr/bin/env bash"
                  testID="job-script-command"
                  style={{ ...typography.code, minHeight: 200, textAlignVertical: 'top' }}
                />
              </Field>
              <Field label="Timeout (ms) · empty means 60000">
                <Input
                  value={form.scriptTimeoutMs}
                  onChangeText={(v) => setForm({ ...form, scriptTimeoutMs: v })}
                  keyboardType="number-pad"
                  placeholder="60000"
                  testID="job-script-timeout"
                />
              </Field>
              {/* The contract that makes a gate's history readable. Stated here
                because this is where a gate gets written. */}
              <Text style={{ color: colors.ink3, fontSize: textMin, marginBottom: space.md }}>
                Print a verdict on every fire, last line — it becomes the run’s headline. Announce a
                chat you start with `patch:chat &lt;chatId&gt;`. Exit non-zero only for a fault.
              </Text>
            </>
          ) : null}

          {/* Skill and Prompt are the agent's first turn; a script fire has no
            chat to deliver one into, so neither field applies to it. */}
          {form.actionType !== 'script' ? (
            <>
              <Text style={{ color: colors.ink3, fontSize: textMin, marginBottom: space.sm }}>
                Provide a Skill, a Prompt, or both (the Skill runs with the Prompt as its input).
              </Text>

              <Field label="Skill">
                {skillFolder.trim() === '' ? (
                  <Text style={{ color: colors.ink3, fontSize: textMin }}>
                    {form.actionType === 'message'
                      ? 'Pick a recipient chat first.'
                      : 'Pick a folder first.'}
                  </Text>
                ) : skillOptions.length === 0 ? (
                  <Text style={{ color: colors.ink3, fontSize: textMin }}>
                    No skills in this folder.
                  </Text>
                ) : (
                  <OptionPicker
                    testID="job-skill"
                    selectedId={skillValue}
                    selectedLabel={skillValue === '' ? 'none' : skillValue}
                    emptyText="No skills in this folder."
                    options={[
                      { id: '', label: 'none' },
                      ...skillOptions.map((s) => ({ id: s, label: s })),
                    ]}
                    onSelect={setSkill}
                  />
                )}
                {skillFolder.trim() !== '' && skillOptions.length > 0 ? skillEditLink() : null}
              </Field>

              <Field label="Prompt">
                <Input
                  value={usesSpawnFields ? form.spawnPrompt : form.messagePrompt}
                  onChangeText={(v) =>
                    setForm(
                      usesSpawnFields ? { ...form, spawnPrompt: v } : { ...form, messagePrompt: v },
                    )
                  }
                  multiline
                  placeholder="What should the agent do?"
                  testID="job-prompt"
                  style={{ minHeight: 88, textAlignVertical: 'top' }}
                />
              </Field>

              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: space.sm,
                }}
              >
                <Text style={{ color: colors.ink2, fontFamily: fonts.body }}>
                  Include trigger event
                </Text>
                <Switch
                  value={form.includePayload}
                  onValueChange={(v) => setForm({ ...form, includePayload: v })}
                  testID="job-include-payload"
                />
              </View>

              {form.actionType === 'continue' ? (
                <Field label="Deduplication key · optional">
                  <Input
                    value={form.ensureKey}
                    onChangeText={(v) => setForm({ ...form, ensureKey: v })}
                    placeholder="{{payload.event_data.id}}"
                    autoCapitalize="none"
                    testID="job-ensure-key"
                  />
                  <Text style={{ color: colors.ink3, fontSize: textMin, marginTop: space.xs }}>
                    Mustache template evaluated against each fire's payload. Fires that render the
                    same key resume one chat instead of starting a new one — leave empty for a
                    single chat shared by every fire of this job.
                  </Text>
                </Field>
              ) : null}

              {form.actionType === 'spawn' ? (
                <Field label="Permission mode">
                  <Pills<PermissionMode>
                    testID="job-spawn-permission-mode"
                    value={form.spawnPermissionMode}
                    onChange={(v) => setForm({ ...form, spawnPermissionMode: v })}
                    options={PERMISSION_MODE_ORDER.filter(
                      (m) =>
                        form.spawnModel === '' ||
                        offeredPermissionModes(form.spawnModel).includes(m),
                    ).map((m) => ({
                      value: m,
                      label: permissionModeLabel(m),
                    }))}
                  />
                </Field>
              ) : null}

              {usesSpawnFields ? (
                <>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: space.sm,
                    }}
                  >
                    <Text style={{ color: colors.ink2, fontFamily: fonts.body }}>
                      Hide chat from sidebar
                    </Text>
                    <Switch
                      value={form.spawnHidden}
                      onValueChange={(v) => setForm({ ...form, spawnHidden: v })}
                      testID="job-spawn-hidden"
                    />
                  </View>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: space.md,
                    }}
                  >
                    <Text style={{ color: colors.ink2, fontFamily: fonts.body }}>
                      Notify when job complete
                    </Text>
                    <Switch
                      value={form.spawnNotifyOnComplete}
                      onValueChange={(v) => setForm({ ...form, spawnNotifyOnComplete: v })}
                      testID="job-spawn-notify-on-complete"
                    />
                  </View>
                </>
              ) : null}
            </>
          ) : null}

          <Pressable
            onPress={() => {
              void save();
            }}
            disabled={saving}
            testID="job-save"
            style={{
              marginTop: space.md,
              paddingVertical: space.md,
              borderRadius: radii.md,
              backgroundColor: colors.leaf,
              alignItems: 'center',
              opacity: saving ? 0.6 : 1,
            }}
          >
            <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyBold }}>
              {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </Text>
          </Pressable>

          {!isNew ? (
            <Pressable
              onPress={() => {
                void runNow();
              }}
              disabled={running}
              testID="job-run-now"
              style={{
                marginTop: space.sm,
                paddingVertical: space.md,
                borderRadius: radii.md,
                borderWidth: 1,
                borderColor: colors.leaf,
                alignItems: 'center',
                opacity: running ? 0.6 : 1,
              }}
            >
              <Text style={{ color: colors.leaf, fontFamily: fonts.bodyBold }}>
                {running ? 'Running…' : 'Run now'}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
