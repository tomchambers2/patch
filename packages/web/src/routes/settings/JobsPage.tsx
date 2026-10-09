// Settings → Jobs (spec/14 § `/settings` details — Jobs, spec/08 § Autonomy
// prompt): the one autonomy prompt every job's first user-turn is prefaced
// with, unless that job overrides it in its own editor. Account-wide: the
// dispatcher that reads it runs on the server.

import type { JSX } from 'react';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '@patch/wire/jobs';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { Group, SettingsPage } from './ui.js';
import { LayerEditor } from './AgentPage.js';
import { patchShared } from './sharedWrite.js';

export function JobsPage(): JSX.Element {
  const prompt = usePreferencesStore((s) => s.preferences.jobAutonomyPrompt);
  return (
    <SettingsPage title="Jobs" testid="settings-jobs-page">
      <Group label="Jobs" testid="settings-jobs-group">
        <LayerEditor
          title="Autonomy prompt"
          sub={prompt.split('\n')[0] ?? ''}
          initial={prompt}
          testid="job-autonomy-prompt-default"
          placeholder={DEFAULT_JOB_AUTONOMY_PROMPT}
          onSave={(text) => patchShared('autonomy prompt', { jobAutonomyPrompt: text })}
          onReset={
            prompt === DEFAULT_JOB_AUTONOMY_PROMPT
              ? undefined
              : () =>
                  patchShared('autonomy prompt', { jobAutonomyPrompt: DEFAULT_JOB_AUTONOMY_PROMPT })
          }
        />
      </Group>
    </SettingsPage>
  );
}
