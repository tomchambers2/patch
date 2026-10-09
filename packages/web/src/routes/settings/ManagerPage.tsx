// Settings → Manager: account-wide preferences for the Manager and the
// Manager/Speakers threads (spec/14 § `/settings` details — Manager,
// spec/06 § Session rotation). Account-wide, not per host or surface: the loops
// that act on them run on the server, so they are read from and written back
// to it.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { DEFAULT_SWEEP_PROMPT } from '@patch/wire';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import { useModelOptions } from './modelOptions.js';
import { Group, Row, SettingsPage } from './ui.js';
import { LayerEditor } from './AgentPage.js';
import { patchShared } from './sharedWrite.js';
import { failed } from '../../lib/errorCopy.js';

export function ManagerPage(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const [addressWord, setAddressWord] = useState(preferences.addressWord);
  const model = useModelOptions(preferences.specialThreadModel);
  const sweepModel = useModelOptions(preferences.sweepModel);

  // Track the server's value until the field is actually edited, so a load
  // arriving after mount is not left showing a stale word.
  useEffect(() => {
    setAddressWord(preferences.addressWord);
  }, [preferences.addressWord]);

  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };

  return (
    <SettingsPage title="Manager" testid="settings-manager-page">
      <Group label="Sweep" testid="settings-sweep">
        <Row title="Enabled">
          <Toggle
            checked={preferences.sweepEnabled}
            disabled={!loaded}
            onChange={(next) => write({ sweepEnabled: next })}
            testid="sweep-enabled"
          />
        </Row>
        <Row title="Interval">
          <input
            type="number"
            min={1}
            aria-label="Sweep interval (minutes)"
            value={preferences.sweepIntervalMinutes}
            disabled={!loaded}
            data-testid="sweep-interval-minutes"
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next > 0) write({ sweepIntervalMinutes: next });
            }}
          />
          <span className="set-unit">min</span>
        </Row>
        <Row title="Stalled after">
          <input
            type="number"
            min={1}
            aria-label="Stalled threshold (minutes)"
            value={preferences.stalledThresholdMinutes}
            disabled={!loaded}
            data-testid="sweep-stalled-threshold"
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next > 0) write({ stalledThresholdMinutes: next });
            }}
          />
          <span className="set-unit">min with no new output</span>
        </Row>
        <Row title="Messages per chat">
          <input
            type="number"
            min={1}
            aria-label="Messages per chat in the digest"
            value={preferences.sweepMessagesPerChat}
            disabled={!loaded}
            data-testid="sweep-messages-per-chat"
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next > 0) write({ sweepMessagesPerChat: next });
            }}
          />
        </Row>
        <Row title="Model">
          <select
            aria-label="Sweep model"
            value={preferences.sweepModel}
            disabled={!loaded}
            data-testid="sweep-model"
            onChange={(e) => write({ sweepModel: e.target.value })}
          >
            {sweepModel.options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
        <LayerEditor
          title="Sweep prompt"
          sub={preferences.sweepPrompt.split('\n')[0] ?? ''}
          initial={preferences.sweepPrompt}
          testid="sweep-prompt"
          placeholder={DEFAULT_SWEEP_PROMPT}
          onSave={(text) => patchShared('sweep prompt', { sweepPrompt: text })}
          onReset={() => patchShared('sweep prompt', { sweepPrompt: DEFAULT_SWEEP_PROMPT })}
        />
      </Group>

      <Group label="Manager" testid="settings-manager">
        <Row title="Context window">
          <input
            type="number"
            min={1}
            aria-label="Manager context window (messages)"
            value={preferences.managerContextWindow}
            disabled={!loaded}
            data-testid="manager-context-window"
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next > 0) write({ managerContextWindow: next });
            }}
          />
          <span className="set-unit">messages</span>
        </Row>
        <Row title="Quiet hours">
          <input
            id="quiet-start"
            type="time"
            aria-label="Quiet hours start"
            value={preferences.quietHoursStart}
            disabled={!loaded}
            data-testid="manager-quiet-start"
            onChange={(e) => write({ quietHoursStart: e.target.value })}
          />
          <span className="set-unit">–</span>
          <input
            type="time"
            aria-label="Quiet hours end"
            value={preferences.quietHoursEnd}
            disabled={!loaded}
            data-testid="manager-quiet-end"
            onChange={(e) => write({ quietHoursEnd: e.target.value })}
          />
        </Row>
        <Row title="Address word">
          <input
            id="address-word"
            type="text"
            aria-label="Address word"
            className="set-word"
            value={addressWord}
            disabled={!loaded}
            data-testid="manager-address-word"
            onChange={(e) => setAddressWord(e.target.value)}
            onBlur={() => {
              const next = addressWord.trim();
              if (next === '' || next === preferences.addressWord) {
                setAddressWord(preferences.addressWord);
                return;
              }
              write({ addressWord: next });
            }}
          />
        </Row>
      </Group>

      {/* The special threads' model + scheduled session rotation. Separate from
          "Model for new chats" because it governs a different thing — the
          always-on threads, not ad-hoc spawns — and grew out of a real
          incident: Manager sat on `claude-opus-5` for 18 days without a single
          auto-compaction, running ~750k cached tokens a turn. */}
      <Group label="Manager and Speakers threads" testid="settings-special-threads">
        <Row
          title="Model"
          sub={
            model.problem ? (
              <span
                data-testid={
                  model.problem.kind === 'no-host'
                    ? 'special-thread-model-no-host'
                    : 'special-thread-model-error'
                }
              >
                {model.problem.text}
              </span>
            ) : undefined
          }
        >
          <select
            id="special-thread-model"
            aria-label="Manager and Speakers model"
            value={preferences.specialThreadModel}
            disabled={!loaded}
            data-testid="special-thread-model"
            onChange={(e) => write({ specialThreadModel: e.target.value })}
          >
            {model.options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Start a fresh session daily">
          <Toggle
            checked={preferences.rotationEnabled}
            disabled={!loaded}
            onChange={(next) => write({ rotationEnabled: next })}
            testid="rotation-enabled"
          />
        </Row>
        <Row title="At">
          <input
            id="rotation-time"
            type="time"
            aria-label="Fresh session at"
            value={preferences.rotationTime}
            disabled={!loaded}
            data-testid="rotation-time"
            onChange={(e) => write({ rotationTime: e.target.value })}
          />
        </Row>
      </Group>
    </SettingsPage>
  );
}
