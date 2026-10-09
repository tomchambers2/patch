// Settings → Goals (spec/14 § `/settings` details — Goals): the judge model, how
// many refusals in a row end a goal's pushing, and the judge prompt (full screen,
// with Reset to default, in the same editor as the other prompts). Account-wide
// shared settings; every host applies them on its next judgement.

import React from 'react';
import { useRouter } from 'expo-router';
import { SettingsSection } from '../SettingsSection';
import { ModelChoice } from './ModelChoice';
import { promptSummary } from './AgentBehaviorSection';
import { writePreferences } from './PreferenceSections';
import { SettingsPage } from './SettingsPage';
import { Field, Muted, Row, SettingsButton, WithSettings } from './ui';
import { DEFAULT_GOAL_EVAL_PROMPT } from '@patch/wire';
import type { AccountPreferences } from '../../api/rest';

export function GoalsPage(): React.ReactElement {
  return (
    <SettingsPage title="Goals" testID="settings-page-goals">
      <WithSettings testID="goals">
        {(data) => <GoalControls preferences={data.preferences} />}
      </WithSettings>
    </SettingsPage>
  );
}

function GoalControls({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const router = useRouter();
  const [limit, setLimit] = React.useState(String(preferences.goalRefusalLimit));
  // Track the server's value until the field is edited, so a later load is not
  // left showing a stale number.
  React.useEffect(
    () => setLimit(String(preferences.goalRefusalLimit)),
    [preferences.goalRefusalLimit],
  );
  return (
    <SettingsSection title="Goals" testID="settings-goals">
      <ModelChoice
        label="Judge model"
        testID="goal-model"
        value={preferences.goalModel}
        onSelect={(id) => writePreferences({ goalModel: id })}
      />
      <Row
        title="Stop after"
        right={
          <>
            <Field
              testID="goal-refusal-limit"
              accessibilityLabel="Refusals in a row before a goal stops pushing"
              value={limit}
              onChangeText={setLimit}
              keyboardType="number-pad"
              style={{ width: 56, textAlign: 'center' }}
              onBlur={() => {
                const next = Number(limit.trim());
                if (!Number.isInteger(next) || next < 1) {
                  setLimit(String(preferences.goalRefusalLimit));
                  return;
                }
                if (next !== preferences.goalRefusalLimit)
                  writePreferences({ goalRefusalLimit: next });
              }}
            />
            <Muted>refusals in a row</Muted>
          </>
        }
      />
      <Row
        title="Judge prompt"
        subtitle={
          preferences.goalEvalPrompt === DEFAULT_GOAL_EVAL_PROMPT
            ? 'Built-in default'
            : promptSummary(preferences.goalEvalPrompt)
        }
        subtitleTestID="goal-judge-summary"
        right={
          <SettingsButton
            testID="goal-judge-edit"
            label="Edit"
            variant="quiet"
            onPress={() =>
              router.push({ pathname: '/settings/layer', params: { layer: 'goal-judge' } })
            }
          />
        }
      />
    </SettingsSection>
  );
}
