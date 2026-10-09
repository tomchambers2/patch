// One Settings page, pushed over the tabs from the Settings list
// (/settings/usage, /settings/agent, …). The static routes beside this file
// (job-editor, layer, memory, mcp-server) outrank this dynamic one, so those
// ids are never page ids.

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SettingsSection } from '../../src/components/SettingsSection';
import { settingsPage } from '../../src/components/settings/pages';
import { NoticeRow } from '../../src/components/settings/HostSwitcher';
import { SettingsPage } from '../../src/components/settings/SettingsPage';

export default function SettingsPageScreen(): React.ReactElement {
  const { page } = useLocalSearchParams<{ page: string }>();
  const entry = settingsPage(page ?? '');
  if (!entry) {
    return (
      <SettingsPage title="Settings" testID="settings-page-unknown">
        <SettingsSection>
          <NoticeRow text={`There is no settings page called ${page ?? ''}`} />
        </SettingsSection>
      </SettingsPage>
    );
  }
  return <entry.Page />;
}
