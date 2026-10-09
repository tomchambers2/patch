// Settings → Memories (design/settings-redesign): the picked host's Claude Code
// memory. Whether memory is on for its chats; then its entries — searchable,
// filtered by type, grouped by project with counts. Tapping an entry opens it
// (MemoryDetail, app/settings/memory.tsx): its name, type · project · date,
// its text to edit (`host.claude_memory_set`), and Delete
// (`host.claude_memory_delete`), asked first.
//
// The list is the host's `claude_settings.*` snapshot, sent whole on connect
// and after every edit, so it settles on what the machine actually holds. A
// refused edit comes back as the host's own sentence (hostRefusalStore).

import React from 'react';
import { Alert, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ClaudeMemoryEntry } from '@patch/wire';
import {
  filterMemories,
  groupMemories,
  memoryMeta,
  memoryTitle,
  MEMORY_TYPES,
  type MemoryTypeFilter,
} from '../../lib/memories';
import { radii, space, typography, useTheme } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { sendToHost } from './hostSend';
import { patchShared } from './sharedWrite';
import { useSettingsStore } from '../../stores/settingsStore';
import { NoticeRow, hostName, unreportedText, useSettingsHost } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { useSettledEdit } from './useSettledEdit';
import {
  ButtonRow,
  Chips,
  ErrorLine,
  Field,
  GroupLabel,
  Row,
  SettingsButton,
  ToggleRow,
} from './ui';

export function MemoriesPage(): React.ReactElement {
  const host = useSettingsHost();
  const gap = unreportedText(host);
  return (
    <SettingsPage title="Memories" testID="settings-page-memories" hostSwitcher>
      {host === null || gap !== null ? (
        <SettingsSection>
          <NoticeRow text={gap ?? ''} />
        </SettingsSection>
      ) : (
        <HostMemories host={host} />
      )}
    </SettingsPage>
  );
}

function HostMemories({ host }: { host: HostPresence }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [type, setType] = React.useState<MemoryTypeFilter>('all');
  const daemonId = host.daemonId;
  // Whether Claude Code keeps memory is shared (spec/01 § Settings); the
  // entries live on each machine.
  const enabled = useSettingsStore((st) => st.data?.preferences.harnessMemoryEnabled);
  const memories = host.claudeSettings?.memories ?? null;
  const groups = memories ? groupMemories(filterMemories(memories, query, type)) : [];

  return (
    <>
      <SettingsSection testID={`harness-memory-${daemonId}`}>
        {enabled === undefined ? (
          <NoticeRow text="Settings haven’t loaded yet" />
        ) : (
          <ToggleRow
            label="Memory"
            testID="harness-memory-enabled"
            value={enabled}
            onChange={(next) => void patchShared('Memory', { harnessMemoryEnabled: next })}
          />
        )}
      </SettingsSection>
      {memories === null ? (
        <SettingsSection>
          <NoticeRow
            testID="memories-unreported"
            text={`${hostName(host)} hasn’t sent its memories yet`}
          />
        </SettingsSection>
      ) : (
        <>
          <View style={{ gap: space.sm, marginBottom: space.md }}>
            <Field
              testID="memories-search"
              accessibilityLabel="Search memories"
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${memories.length} memories`}
              style={{ backgroundColor: colors.paperRaised, borderRadius: radii.md }}
            />
            <Chips
              options={MEMORY_TYPES}
              selected={type}
              labelOf={(t) => (t === 'all' ? 'All' : t)}
              testIDPrefix="memories-type"
              labelPrefix="Show"
              onSelect={setType}
            />
          </View>
          {groups.length === 0 ? (
            <SettingsSection>
              <NoticeRow
                testID="memories-empty"
                text={memories.length === 0 ? 'No memories' : 'No matches'}
              />
            </SettingsSection>
          ) : (
            groups.map((g) => (
              <View key={g.label} testID={`memories-group-${g.label}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <GroupLabel>{g.label}</GroupLabel>
                  <Text
                    testID={`memories-group-${g.label}-count`}
                    style={{
                      ...typography.meta,
                      color: colors.ink3,
                      backgroundColor: colors.bgSoft,
                      borderColor: colors.lineSoft,
                      borderWidth: 1,
                      borderRadius: radii.pill,
                      paddingHorizontal: space.sm,
                      marginBottom: space.sm,
                    }}
                  >
                    {g.entries.length}
                  </Text>
                </View>
                <SettingsSection>
                  {g.entries.map((m) => (
                    <Row
                      key={`${m.project}/${m.file}`}
                      testID={`memory-${m.project}-${m.file}`}
                      accessibilityLabel={memoryTitle(m)}
                      title={memoryTitle(m)}
                      subtitle={m.description}
                      onPress={() =>
                        router.push({
                          pathname: '/settings/memory',
                          params: { daemonId, project: m.project, file: m.file },
                        })
                      }
                    />
                  ))}
                </SettingsSection>
              </View>
            ))
          )}
        </>
      )}
    </>
  );
}

/**
 * One memory entry: name, type · project · date, its text to edit and Save,
 * and Delete. An entry from a host that predates sending the text shows its
 * description and says to update the host. Save and Delete wait for the host's
 * fresh snapshot — or its refusal, shown here.
 */
export function MemoryDetail({
  daemonId,
  project,
  file,
}: {
  daemonId: string;
  project: string;
  file: string;
}): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const host = usePresenceStore((s) => s.hosts[daemonId] ?? null);
  const settings = host?.claudeSettings ?? null;
  const entry: ClaudeMemoryEntry | null =
    settings?.memories.find((m) => m.project === project && m.file === file) ?? null;
  const [draft, setDraft] = React.useState(entry?.body ?? '');
  const name = host ? hostName(host) : daemonId;
  const { waiting, problem, start, clearProblem } = useSettledEdit<'save' | 'delete'>(
    settings,
    name,
    (action) => {
      if (action === 'delete') router.back();
    },
  );

  if (entry === null) {
    return (
      <SettingsPage title="Memory" testID="settings-memory-detail">
        <SettingsSection>
          <NoticeRow testID="memory-gone" text={`This memory is no longer on ${name}`} />
        </SettingsSection>
      </SettingsPage>
    );
  }

  const save = (): void => {
    clearProblem();
    if (
      sendToHost(
        daemonId,
        { type: 'host.claude_memory_set', daemonId, project, file, body: draft },
        'Save memory',
      )
    ) {
      start('save');
    }
  };
  const remove = (): void =>
    Alert.alert(`Delete ${memoryTitle(entry)}?`, `It is removed from ${name}.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          clearProblem();
          if (
            sendToHost(
              daemonId,
              { type: 'host.claude_memory_delete', daemonId, project, file },
              'Delete memory',
            )
          ) {
            start('delete');
          }
        },
      },
    ]);

  const hasBody = entry.body !== undefined;
  return (
    <SettingsPage
      title={memoryTitle(entry)}
      testID="settings-memory-detail"
      right={
        hasBody ? (
          <SettingsButton
            testID="memory-save"
            label={waiting === 'save' ? 'Saving…' : 'Save'}
            disabled={waiting !== null || draft === entry.body}
            onPress={save}
          />
        ) : null
      }
    >
      <Text
        testID="memory-meta"
        style={{ ...typography.secondary, color: colors.ink3, marginBottom: space.md }}
      >
        {memoryMeta(entry)}
      </Text>
      {hasBody ? (
        <Field
          testID="memory-body"
          accessibilityLabel="Memory text"
          multiline
          value={draft}
          onChangeText={setDraft}
          style={{
            minHeight: 240,
            textAlignVertical: 'top',
            backgroundColor: colors.paperRaised,
            borderColor: colors.lineSoft,
            borderRadius: radii.md,
            padding: space.md,
          }}
        />
      ) : (
        <SettingsSection>
          {entry.description ? <Row title={entry.description} /> : null}
          <NoticeRow testID="memory-update" text={`Update ${name} to read this memory`} />
        </SettingsSection>
      )}
      {problem ? <ErrorLine testID="memory-error" message={problem} /> : null}
      <ButtonRow>
        <SettingsButton
          testID="memory-delete"
          label={waiting === 'delete' ? 'Deleting…' : 'Delete'}
          variant="danger"
          disabled={waiting !== null}
          onPress={remove}
        />
      </ButtonRow>
    </SettingsPage>
  );
}
