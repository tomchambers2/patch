// Settings → Manager and Settings → Voice (design/settings-redesign).
//
// Manager — the Manager's own switches (Enabled, Quiet hours, Address word),
// then the model the Manager and Speakers threads run on and their daily
// fresh session. Account-wide (`GET`/`PATCH /api/settings`): the loops that
// act on them run on the server. Each write settles on the server's answer; a
// failed write is said out loud and the control keeps showing what the server
// holds.
//
// Voice — the engine matrix (account-wide), how the host picked in the switcher
// speaks (its Kokoro voice and how often it says the chat's name, per machine
// over `host.settings`), and voice devices.

import React from 'react';
import { Alert, Text, View } from 'react-native';
import type { AccountPreferences, VoiceBackend, VoiceHandoff, VoiceLayer } from '../../api/rest';
import { space, typography, useTheme } from '../../lib/theme';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { voiceKeyHostStatus } from '@patch/wire/audio';
import { OptionPicker } from '../OptionPicker';
import { SettingsSection } from '../SettingsSection';
import { VoiceDevicesSection } from './DevicesSections';
import { patchShared } from './sharedWrite';
import { ModelChoice } from './ModelChoice';
import { SettingsPage } from './SettingsPage';
import { Chips, Field, Muted, Row, ToggleRow, WithSettings } from './ui';

/** Write a preferences patch; a failure is reported, never swallowed. */
export function writePreferences(patch: Partial<AccountPreferences>): void {
  void useSettingsStore
    .getState()
    .updatePreferences(patch)
    .catch((e: Error) => Alert.alert('Settings failed', e.message));
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * An `HH:MM` field that commits on blur. A value that is not a time is refused
 * with a message and the field returns to what the server holds.
 */
function TimeField({
  value,
  testID,
  label,
  onCommit,
}: {
  value: string;
  testID: string;
  label: string;
  onCommit: (next: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <Field
      testID={testID}
      accessibilityLabel={label}
      value={draft}
      onChangeText={setDraft}
      keyboardType="numbers-and-punctuation"
      placeholder="HH:MM"
      style={{ width: 72, textAlign: 'center' }}
      onBlur={() => {
        const next = draft.trim();
        if (next === value) return;
        if (!HHMM.test(next)) {
          Alert.alert('Invalid time', `${label} must be a 24-hour time like 07:30.`);
          setDraft(value);
          return;
        }
        onCommit(next);
      }}
    />
  );
}

// ── Manager ──────────────────────────────────────────────────────────────────

export function ManagerPage(): React.ReactElement {
  return (
    <SettingsPage title="Manager" testID="settings-page-manager">
      <WithSettings testID="manager">
        {(data) => (
          <>
            <SettingsSection title="Manager" testID="settings-manager">
              <ManagerControls preferences={data.preferences} />
            </SettingsSection>
            <SettingsSection title="Manager and Speakers threads" testID="settings-special-threads">
              <ModelChoice
                label="Model"
                testID="special-thread-model"
                value={data.preferences.specialThreadModel}
                onSelect={(id) => writePreferences({ specialThreadModel: id })}
              />
              <ToggleRow
                label="Start a fresh session daily"
                testID="rotation-enabled"
                value={data.preferences.rotationEnabled}
                onChange={(next) => writePreferences({ rotationEnabled: next })}
              />
              <Row
                title="At"
                right={
                  <TimeField
                    testID="rotation-time"
                    label="Fresh session at"
                    value={data.preferences.rotationTime}
                    onCommit={(v) => writePreferences({ rotationTime: v })}
                  />
                }
              />
            </SettingsSection>
          </>
        )}
      </WithSettings>
    </SettingsPage>
  );
}

function ManagerControls({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const [addressWord, setAddressWord] = React.useState(preferences.addressWord);
  // Track the server's value until the field is edited, so a later load is not
  // left showing a stale word.
  React.useEffect(() => setAddressWord(preferences.addressWord), [preferences.addressWord]);
  return (
    <>
      <ToggleRow
        label="Enabled"
        testID="manager-watching"
        value={preferences.sweepEnabled}
        onChange={(next) => writePreferences({ sweepEnabled: next })}
      />
      <Row
        title="Quiet hours"
        right={
          <>
            <TimeField
              testID="manager-quiet-start"
              label="Quiet hours start"
              value={preferences.quietHoursStart}
              onCommit={(v) => writePreferences({ quietHoursStart: v })}
            />
            <Muted>–</Muted>
            <TimeField
              testID="manager-quiet-end"
              label="Quiet hours end"
              value={preferences.quietHoursEnd}
              onCommit={(v) => writePreferences({ quietHoursEnd: v })}
            />
          </>
        }
      />
      <Row
        title="Address word"
        right={
          <Field
            testID="manager-address-word"
            accessibilityLabel="Address word"
            value={addressWord}
            onChangeText={setAddressWord}
            style={{ width: 120 }}
            onBlur={() => {
              const next = addressWord.trim();
              if (next === '' || next === preferences.addressWord) {
                setAddressWord(preferences.addressWord);
                return;
              }
              writePreferences({ addressWord: next });
            }}
          />
        }
      />
    </>
  );
}

// ── Voice ────────────────────────────────────────────────────────────────────

const VOICE_BACKENDS: readonly VoiceBackend[] = ['local', 'gemini', 'openai'];
const VOICE_LAYERS: readonly VoiceLayer[] = ['direct', 'light', 'heavy'];
const VOICE_HANDOFFS: readonly VoiceHandoff[] = ['auto', 'always', 'never'];
type VoiceSurfaceKey = 'dictation' | 'device' | 'handsFree' | 'call';
/** The design's order: Dictation, Hands-free, Call, Voice device. */
const VOICE_SURFACES: readonly VoiceSurfaceKey[] = ['dictation', 'handsFree', 'call', 'device'];
const VOICE_SURFACE_LABELS: Record<VoiceSurfaceKey, string> = {
  dictation: 'Dictation',
  device: 'Voice device',
  handsFree: 'Hands-free',
  call: 'Call',
};

/**
 * What actually happens for a given cell, right now (spec/07 § Voice — a config
 * matrix). Mirrors the host's audio server branching and web's
 * `voiceCellStatus` word for word, so neither surface claims a cell works when
 * the host would refuse it.
 */
export function voiceCellStatus(
  surface: VoiceSurfaceKey,
  backend: VoiceBackend,
  layer?: VoiceLayer,
): string | null {
  if (backend !== 'local' && surface === 'device') {
    return 'Not implemented yet for this surface. Refused at connect time.';
  }
  if (backend === 'local' && layer !== undefined && layer !== 'direct') {
    return 'Not implemented yet — no front model built for local. Refused at connect time.';
  }
  if (backend !== 'local' && layer === 'direct') {
    return 'A hosted backend always fronts Manager — "direct" runs as "light".';
  }
  if (backend === 'gemini' && surface === 'handsFree') {
    return 'Gemini answers everything it hears — the address word is not enforced.';
  }
  return null;
}

export function VoicePage(): React.ReactElement {
  return (
    <SettingsPage title="Voice" testID="settings-page-voice">
      <SettingsSection title="Engine" testID="settings-voice-config">
        <VoiceEngine />
      </SettingsSection>
      <SettingsSection title="Speaking" testID="settings-voice-speaking">
        <WithSettings testID="voice-speaking">
          {(data) => <Speaking preferences={data.preferences} />}
        </WithSettings>
      </SettingsSection>
      <VoiceDevicesSection />
    </SettingsPage>
  );
}

/**
 * Per-surface voice engine and layer (spec/07 § Voice — a config matrix).
 * Every combination is selectable; a cell that does not yet do anything, or
 * whose key is missing on a host, says so under its name.
 */
function VoiceEngine(): React.ReactElement {
  const colors = useTheme();
  const [busy, setBusy] = React.useState(false);
  // Per-host key status (`daemon.host.voiceKeys`): a hosted cell names each
  // host that cannot run it.
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  return (
    <WithSettings testID="voice-config">
      {(data) => {
        const voiceConfig = data.preferences.voiceConfig;
        const write = (
          surface: VoiceSurfaceKey,
          backend: VoiceBackend,
          layer: VoiceLayer | undefined,
          handoff: VoiceHandoff | undefined,
        ): void => {
          const cell =
            layer === undefined || handoff === undefined
              ? { backend }
              : { backend, layer, handoff };
          setBusy(true);
          void useSettingsStore
            .getState()
            .updatePreferences({
              voiceConfig: {
                ...voiceConfig,
                [surface]: cell,
              } as AccountPreferences['voiceConfig'],
            })
            .catch((e: Error) => Alert.alert('Settings failed', e.message))
            .finally(() => setBusy(false));
        };
        return VOICE_SURFACES.map((surface) => {
          const cell = voiceConfig[surface];
          const backend = cell.backend;
          const layer = 'layer' in cell ? cell.layer : undefined;
          const handoff = 'handoff' in cell ? cell.handoff : undefined;
          const status = voiceCellStatus(surface, backend, layer);
          const keyStatus = voiceKeyHostStatus(backend, hostReports);
          return (
            <Row
              key={surface}
              testID={`voice-${surface}`}
              title={VOICE_SURFACE_LABELS[surface]}
              stack
            >
              <View style={{ gap: space.xs }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
                  <Chips
                    options={VOICE_BACKENDS}
                    selected={backend}
                    disabled={busy}
                    testIDPrefix={`voice-${surface}-backend`}
                    labelPrefix={`${VOICE_SURFACE_LABELS[surface]} backend`}
                    onSelect={(b) => write(surface, b, layer, handoff)}
                  />
                  {layer !== undefined ? (
                    <Chips
                      options={VOICE_LAYERS}
                      selected={layer}
                      disabled={busy}
                      testIDPrefix={`voice-${surface}-layer`}
                      labelPrefix={`${VOICE_SURFACE_LABELS[surface]} layer`}
                      onSelect={(l) => write(surface, backend, l, handoff)}
                    />
                  ) : null}
                  {layer !== undefined && backend !== 'local' && handoff !== undefined ? (
                    <Chips
                      options={VOICE_HANDOFFS}
                      selected={handoff}
                      disabled={busy}
                      testIDPrefix={`voice-${surface}-handoff`}
                      labelPrefix={`${VOICE_SURFACE_LABELS[surface]} hand-off`}
                      onSelect={(h) => write(surface, backend, layer, h)}
                    />
                  ) : null}
                </View>
                {status ? <Muted testID={`voice-${surface}-status`}>{status}</Muted> : null}
                {keyStatus ? (
                  <Text
                    testID={`voice-${surface}-keys`}
                    style={{ ...typography.meta, color: colors.red }}
                  >
                    {keyStatus}
                  </Text>
                ) : null}
              </View>
            </Row>
          );
        });
      }}
    </WithSettings>
  );
}

/**
 * Standard Kokoro v1 voices — the same list web offers. Names match the `.pt`
 * files the sidecar loads by name.
 */
export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart (American F)' },
  { id: 'af_bella', label: 'Bella (American F)' },
  { id: 'af_sky', label: 'Sky (American F)' },
  { id: 'af_sarah', label: 'Sarah (American F)' },
  { id: 'af_nicole', label: 'Nicole (American F)' },
  { id: 'am_adam', label: 'Adam (American M)' },
  { id: 'am_michael', label: 'Michael (American M)' },
  { id: 'bf_emma', label: 'Emma (British F)' },
  { id: 'bf_isabella', label: 'Isabella (British F)' },
  { id: 'bm_george', label: 'George (British M)' },
  { id: 'bm_lewis', label: 'Lewis (British M)' },
];

/**
 * How Patch speaks on every host (spec/01 § Settings): the Kokoro voice, and
 * every how many replies it says the chat's name (0 = never). A voice never
 * chosen is each host's own Kokoro default.
 */
function Speaking({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const currentInterval = preferences.chatNameInterval;
  const [interval, setIntervalDraft] = React.useState(String(currentInterval));
  React.useEffect(() => setIntervalDraft(String(currentInterval)), [currentInterval]);
  const currentVoice = preferences.kokoroVoice;
  const commitInterval = (): void => {
    const n = Number(interval.trim());
    const was = String(currentInterval);
    if (!Number.isInteger(n) || n < 0 || interval.trim() === '') {
      Alert.alert('Invalid value', 'Chat name interval must be a non-negative integer.');
      setIntervalDraft(was);
      return;
    }
    if (n === currentInterval) return;
    void patchShared('Chat name interval', { chatNameInterval: n }).then((ok) => {
      if (!ok) setIntervalDraft(was);
    });
  };
  return (
    <>
      <Row
        title="Voice"
        testID="voice-settings"
        subtitle={currentVoice === undefined ? 'Each host’s Kokoro default' : undefined}
        right={
          <OptionPicker
            testID="kokoro-voice"
            selectedId={currentVoice ?? ''}
            selectedLabel={
              currentVoice === undefined
                ? '—'
                : (KOKORO_VOICES.find((v) => v.id === currentVoice)?.label ?? currentVoice)
            }
            options={KOKORO_VOICES}
            onSelect={(id) => void patchShared('Voice', { kokoroVoice: id })}
            emptyText="No voices"
          />
        }
      />
      <Row
        title="Say the chat name every"
        right={
          <>
            <Field
              testID="chat-name-interval"
              accessibilityLabel="Chat name interval"
              keyboardType="number-pad"
              value={interval}
              onChangeText={setIntervalDraft}
              onBlur={commitInterval}
              onSubmitEditing={commitInterval}
              style={{ width: 52, textAlign: 'center' }}
            />
            <Muted>replies</Muted>
          </>
        }
      />
    </>
  );
}
