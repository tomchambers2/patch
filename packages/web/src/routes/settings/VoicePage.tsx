// Settings → Voice: which engine each voice surface uses (account-wide), how
// one host speaks, the voice devices paired to the account, and this machine's
// dictate shortcut.

import type { JSX } from 'react';
import { Fragment, useEffect, useState } from 'react';
import { voiceKeyHostStatus } from '@patch/wire/audio';
import { type VoiceBackend, type VoiceHandoff, type VoiceLayer } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { chordFromEvent, chordGlyphs } from '../../lib/dictateChord.js';
import { shortcutLabel } from '../../lib/shortcuts.js';
import { PairVoiceDevice } from '../../components/PairVoiceDevice.js';
import { patchShared } from './sharedWrite.js';
import { DeviceRow, useDevices } from './DevicesPage.js';
import { Group, Note, Pills, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';

/**
 * spec/07 § Voice is a config matrix — each cell is presented as ONE choice of
 * engine; the backend and layer it stands for are not shown.
 */
type ConversationEngine = 'local' | 'gemini-flash' | 'gemini-thinking' | 'openai-mini' | 'openai';
const CONVERSATION_ENGINES: readonly ConversationEngine[] = [
  'local',
  'gemini-flash',
  'gemini-thinking',
  'openai-mini',
  'openai',
];
const ENGINE_LABELS: Record<ConversationEngine, string> = {
  local: 'Local',
  'gemini-flash': 'Gemini Flash',
  'gemini-thinking': 'Gemini Thinking',
  'openai-mini': 'OpenAI mini',
  openai: 'OpenAI',
};
const ENGINE_CELL: Record<ConversationEngine, { backend: VoiceBackend; layer: VoiceLayer }> = {
  local: { backend: 'local', layer: 'direct' },
  'gemini-flash': { backend: 'gemini', layer: 'light' },
  'gemini-thinking': { backend: 'gemini', layer: 'heavy' },
  'openai-mini': { backend: 'openai', layer: 'light' },
  openai: { backend: 'openai', layer: 'heavy' },
};
/** The engine a stored cell runs. A hosted `direct` runs as `light`. */
function engineOf(backend: VoiceBackend, layer: VoiceLayer): ConversationEngine {
  if (backend === 'local') return 'local';
  if (backend === 'gemini') return layer === 'heavy' ? 'gemini-thinking' : 'gemini-flash';
  return layer === 'heavy' ? 'openai' : 'openai-mini';
}
const HANDOFFS: readonly VoiceHandoff[] = ['auto', 'always', 'never'];
const HANDOFF_LABELS: Record<VoiceHandoff, string> = {
  auto: 'When needed',
  always: 'Always',
  never: 'Never',
};
const DICTATION_ENGINES: readonly VoiceBackend[] = ['local', 'gemini', 'openai'];
const DICTATION_LABELS: Record<VoiceBackend, string> = {
  local: 'Local',
  gemini: 'Gemini',
  openai: 'OpenAI',
};

/** Dollars, to the penny that matters: two significant figures under 10 cents. */
function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.1) return `$${Number(usd.toPrecision(2))}`;
  return `$${usd.toFixed(2)}`;
}
const calls = (n: number): string => `${n} ${n === 1 ? 'call' : 'calls'}`;

type VoiceSurfaceKey = 'dictation' | 'device' | 'handsFree' | 'call';
const SURFACES: { key: VoiceSurfaceKey; label: string }[] = [
  { key: 'dictation', label: 'Dictation' },
  { key: 'handsFree', label: 'Hands-free' },
  { key: 'call', label: 'Call' },
  { key: 'device', label: 'Voice device' },
];

/**
 * What actually happens for a given cell, right now (spec/07 § Voice — a
 * config matrix — "Implemented today" / "Not implemented"). Mirrors
 * `packages/daemon/src/audio/server.ts`'s branching exactly, so this can
 * never claim a cell works when the host would refuse it — the UI accepts
 * every combination the schema does (nothing here blocks a selection), it
 * only tells you honestly what picking it will do.
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
  if (backend === 'gemini' && surface === 'handsFree') {
    return 'Gemini answers everything it hears — the address word is not enforced.';
  }
  return null;
}

export function VoicePage(): JSX.Element {
  return (
    <SettingsPage title="Voice" testid="settings-voice">
      <EngineGroup />
      <ShortcutGroup />
      <SpeakingGroup />
      <VoiceDevicesGroup />
    </SettingsPage>
  );
}

/**
 * The dictate chord, per machine (lib/dictateChord.ts). "Change" listens for
 * the next chord with ⌘/Ctrl in it; Esc leaves the old one. The listener runs
 * in the capture phase and stops the event there, so the chord being recorded
 * doesn't also fire whatever it is bound to.
 */
function ShortcutGroup(): JSX.Element {
  const chord = useUiStore((s) => s.dictateChord);
  const setChord = useUiStore((s) => s.setDictateChord);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const next = chordFromEvent(e);
      if (!next) return;
      setChord(next);
      setRecording(false);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, setChord]);

  return (
    <Group label="Shortcut" testid="settings-voice-shortcut">
      <Row title="Dictate">
        <kbd className="set-chord" data-testid="dictate-chord">
          {recording ? 'Press keys…' : shortcutLabel(chordGlyphs(chord))}
        </kbd>
        <button
          type="button"
          className="set-btn"
          data-testid="dictate-chord-change"
          aria-pressed={recording}
          onClick={() => setRecording(!recording)}
        >
          {recording ? 'Cancel' : 'Change'}
        </button>
      </Row>
    </Group>
  );
}

/**
 * Per-surface voice config (spec/07 § Voice — a config matrix). Four surfaces,
 * each independently choosing an engine and (for the three conversational ones)
 * a front layer — deliberately a matrix to test against, not a fixed
 * architecture, so every combination is selectable and the row just says
 * honestly which ones already do something.
 */
function EngineGroup(): JSX.Element {
  const voiceConfig = usePreferencesStore((s) => s.preferences.voiceConfig);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  // Per-host key status (`daemon.host.voiceKeys`): a hosted cell names each
  // host that cannot run it — the host refuses its sessions there.
  const hosts = usePresenceStore((s) => s.hosts);
  const hostReports = Object.values(hosts).flatMap((h) =>
    h.host ? [{ hostName: h.host.hostName, voiceKeys: h.host.voiceKeys }] : [],
  );
  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };

  return (
    <Group label="Engine" testid="settings-voice-config">
      {SURFACES.map(({ key: surface, label }) => {
        const cell = voiceConfig[surface];
        const backend = cell.backend;
        const layer = 'layer' in cell ? cell.layer : undefined;
        const handoff = 'handoff' in cell ? cell.handoff : undefined;
        const status = voiceCellStatus(surface, backend, layer);
        const keyStatus = voiceKeyHostStatus(backend, hostReports);
        const sub =
          status || keyStatus ? (
            <>
              {status ? (
                <span className="set-sub-line" data-testid={`voice-${surface}-status`}>
                  {status}
                </span>
              ) : null}
              {keyStatus ? (
                <span className="set-sub-line set-sub-error" data-testid={`voice-${surface}-keys`}>
                  {keyStatus}
                </span>
              ) : null}
            </>
          ) : undefined;
        return (
          <Fragment key={surface}>
            <Row title={label} sub={sub} testid={`voice-${surface}`}>
              {layer === undefined ? (
                <Pills
                  label={`${label} engine`}
                  options={DICTATION_ENGINES}
                  labels={DICTATION_LABELS}
                  value={backend}
                  disabled={!loaded}
                  testid={`voice-${surface}-engine`}
                  onChange={(next) =>
                    write({ voiceConfig: { ...voiceConfig, [surface]: { backend: next } } })
                  }
                />
              ) : (
                <Pills
                  label={`${label} engine`}
                  options={CONVERSATION_ENGINES}
                  labels={ENGINE_LABELS}
                  value={engineOf(backend, layer)}
                  disabled={!loaded}
                  testid={`voice-${surface}-engine`}
                  onChange={(next) =>
                    write({
                      voiceConfig: {
                        ...voiceConfig,
                        [surface]: { ...ENGINE_CELL[next], handoff: handoff ?? 'auto' },
                      },
                    })
                  }
                />
              )}
            </Row>
            {layer !== undefined && backend !== 'local' && handoff !== undefined ? (
              <Row title={`${label} hand-off`} testid={`voice-${surface}-handoff-row`}>
                <Pills
                  label={`${label} hand-off`}
                  options={HANDOFFS}
                  labels={HANDOFF_LABELS}
                  value={handoff}
                  disabled={!loaded}
                  testid={`voice-${surface}-handoff`}
                  onChange={(next) =>
                    write({
                      voiceConfig: { ...voiceConfig, [surface]: { ...cell, handoff: next } },
                    })
                  }
                />
              </Row>
            ) : null}
          </Fragment>
        );
      })}
      {/* spec/07 § Call cost — what each host's voice calls have cost. */}
      {Object.entries(hosts).flatMap(([daemonId, h]) => {
        const usage = h.host?.voiceUsage;
        if (!h.host || !usage) return [];
        return [
          <Note key={daemonId} testid={`voice-usage-${daemonId}`}>
            {`${h.host.hostName}: this month ${formatUsd(usage.monthUsd)} across ${calls(
              usage.monthCalls,
            )} · in all ${formatUsd(usage.allUsd)} across ${calls(usage.allCalls)}`}
          </Note>,
        ];
      })}
    </Group>
  );
}

/**
 * Standard Kokoro v1 voice options. Names match the `.pt` files in the
 * kokoro model's `voices/` directory — the sidecar loads the pack by name.
 * af_ = American Female, am_ = American Male, bf_ = British Female,
 * bm_ = British Male.
 */
const KOKORO_VOICES: { id: string; label: string }[] = [
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

/** How Patch speaks on every host: the Kokoro voice, and how often it says the chat's name. */
function SpeakingGroup(): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const kokoroVoice = usePreferencesStore((s) => s.preferences.kokoroVoice);
  const chatNameInterval = usePreferencesStore((s) => s.preferences.chatNameInterval);
  const loaded = usePreferencesStore((s) => s.loaded);

  function setNameInterval(raw: string): void {
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) {
      pushError('Chat name interval must be a non-negative integer');
      return;
    }
    if (n === chatNameInterval) return;
    void patchShared('chat name interval', { chatNameInterval: n });
  }

  return (
    <Group label="Speaking" testid="voice-speaking">
      <Row title="Voice" sub={kokoroVoice === undefined ? 'Each host’s Kokoro default' : undefined}>
        <select
          aria-label="Voice"
          data-testid="kokoro-voice"
          value={kokoroVoice ?? ''}
          disabled={!loaded}
          onChange={(e) => void patchShared('voice', { kokoroVoice: e.target.value })}
        >
          {kokoroVoice === undefined ? <option value="">—</option> : null}
          {KOKORO_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Say the chat name every">
        <input
          type="number"
          min={0}
          className="set-num"
          aria-label="Say the chat name every (replies)"
          data-testid="chat-name-interval"
          key={chatNameInterval}
          defaultValue={chatNameInterval}
          disabled={!loaded}
          onBlur={(e) => setNameInterval(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setNameInterval((e.target as HTMLInputElement).value);
          }}
        />
        <span className="set-unit">replies</span>
      </Row>
    </Group>
  );
}

/**
 * Voice devices paired to the account (spec/16). A voice device is a surface:
 * it pairs through the same single-use code as a phone (PairVoiceDevice) and is
 * revoked like one.
 */
function VoiceDevicesGroup(): JSX.Element {
  const { devices, revoke } = useDevices();
  const [pairing, setPairing] = useState(false);
  const voice = devices?.filter((d) => d.surfaceKind === 'voice-device') ?? null;
  const pairButton = pairing ? null : (
    <button
      type="button"
      className="set-btn"
      data-testid="pair-voice-device-open"
      onClick={() => setPairing(true)}
    >
      Pair a device
    </button>
  );
  return (
    <Group label="Voice devices" testid="settings-voice-devices">
      {voice === null ? (
        <Note>Loading…</Note>
      ) : voice.length === 0 ? (
        <Row title="None paired" testid="voice-devices-empty">
          {pairButton}
        </Row>
      ) : (
        <>
          {voice.map((d) => (
            <DeviceRow key={d.surfaceId} device={d} onRevoke={revoke} />
          ))}
          {pairButton ? <Row title="Pair another">{pairButton}</Row> : null}
        </>
      )}
      {pairing ? (
        <div className="set-row stack">
          <PairVoiceDevice onClose={() => setPairing(false)} />
        </div>
      ) : null}
    </Group>
  );
}
