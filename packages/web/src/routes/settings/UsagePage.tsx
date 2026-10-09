// Settings → Usage: the Claude and ChatGPT accounts every host draws from,
// ranked, with their limits and the strategy that picks among them, and
// whether a turn stopped by a limit resumes on its own. All shared settings
// (spec/01 § Settings): nothing here is about one machine.

import type { JSX } from 'react';
import { Toggle } from '../../components/Toggle.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { patchShared } from './sharedWrite.js';
import { Group, Row, SettingsPage } from './ui.js';
import { AddChatGPTAccount, AddClaudeAccount, SharedAccounts } from './SharedAccounts.js';

export function UsagePage(): JSX.Element {
  const autoResume = usePreferencesStore((s) => s.preferences.autoResumeRateLimit);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <SettingsPage title="Usage" testid="settings-usage">
      <Group label="Claude" testid="settings-claude" after={<AddClaudeAccount />}>
        <SharedAccounts backendId="claude-code" />
      </Group>
      <Group label="ChatGPT" testid="settings-chatgpt" after={<AddChatGPTAccount />}>
        <SharedAccounts backendId="codex" />
      </Group>
      <Group>
        <Row title="Resume automatically when a limit resets" testid="auto-resume-rate-limit">
          <Toggle
            checked={autoResume}
            disabled={!loaded}
            onChange={(next) => void patchShared('auto-resume', { autoResumeRateLimit: next })}
            testid="auto-resume-rate-limit-toggle"
          />
        </Row>
      </Group>
    </SettingsPage>
  );
}
