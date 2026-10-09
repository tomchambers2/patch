// Settings → Goals (spec/14 § `/settings` details — Goals, spec/04 § Goals):
// how a chat's goal is judged and when it gives up on an agent that will not do
// the work. Account-wide: the judge runs on each chat's own host, which takes
// these from the shared settings.

import type { JSX } from 'react';
import { DEFAULT_GOAL_EVAL_PROMPT } from '@patch/wire';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { failed } from '../../lib/errorCopy.js';
import { useModelOptions } from './modelOptions.js';
import { Group, Row, SettingsPage } from './ui.js';
import { LayerEditor } from './AgentPage.js';
import { patchShared } from './sharedWrite.js';

export function GoalsPage(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const judgeModel = useModelOptions(preferences.goalModel);

  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };

  return (
    <SettingsPage title="Goals" testid="settings-goals-page">
      <Group label="Goals" testid="settings-goals-group">
        <Row title="Judge model">
          <select
            aria-label="Goal judge model"
            value={preferences.goalModel}
            disabled={!loaded}
            data-testid="goal-model"
            onChange={(e) => write({ goalModel: e.target.value })}
          >
            {judgeModel.options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="set-unit">judges every chat, whatever model the chat runs</span>
        </Row>
        <Row title="Stop after">
          <input
            type="number"
            min={1}
            aria-label="Refusals in a row before a goal stops pushing"
            value={preferences.goalRefusalLimit}
            disabled={!loaded}
            data-testid="goal-refusal-limit"
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isInteger(next) && next > 0) write({ goalRefusalLimit: next });
            }}
          />
          <span className="set-unit">refusals in a row</span>
        </Row>
        <LayerEditor
          title="Judge prompt"
          sub={preferences.goalEvalPrompt.split('\n')[0] ?? ''}
          initial={preferences.goalEvalPrompt}
          testid="goal-eval-prompt"
          placeholder={DEFAULT_GOAL_EVAL_PROMPT}
          onSave={(text) => patchShared('goal judge prompt', { goalEvalPrompt: text })}
          onReset={
            preferences.goalEvalPrompt === DEFAULT_GOAL_EVAL_PROMPT
              ? undefined
              : () => patchShared('goal judge prompt', { goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT })
          }
        />
      </Group>
    </SettingsPage>
  );
}
