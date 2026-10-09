// Settings → MCP (design/settings-redesign): the MCP servers the picked host
// wires into every chat. Patch's own tools server is built in and always on;
// then each of the host's `harnessMcpServers` with its command line and an
// enabled switch. Tapping one opens it to edit (McpServerEditor,
// app/settings/mcp-server.tsx): name, command line, environment as KEY=VALUE
// lines, and Remove. Add server opens the same screen empty.
//
// Every change sends the host's WHOLE list (`host.settings` harnessMcpServers),
// validated with the wire's McpServerList first; nothing is patched locally —
// the list settles on the host's fresh `daemon.host`.

import React from 'react';
import { Alert, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { McpServerConfig } from '@patch/wire';
import { applyMcpDraft, commandLine, envText } from '../../lib/mcpServers';
import { space, useTheme } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { sendHostSettings } from './hostSend';
import {
  NoticeRow,
  hostName,
  unreportedText,
  updateToManageText,
  useSettingsHost,
} from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { ButtonRow, ErrorLine, Field, FieldLabel, Row, RowValue, SettingsButton } from './ui';

export function McpPage(): React.ReactElement {
  const router = useRouter();
  const host = useSettingsHost();
  const gap = unreportedText(host);
  const servers = host?.host?.harnessMcpServers;
  return (
    <SettingsPage
      title="MCP"
      testID="settings-page-mcp"
      hostSwitcher
      right={
        host !== null && gap === null && servers !== undefined ? (
          <SettingsButton
            testID="mcp-add"
            label="Add server"
            onPress={() =>
              router.push({ pathname: '/settings/mcp-server', params: { daemonId: host.daemonId } })
            }
          />
        ) : null
      }
    >
      <SettingsSection title="Servers chats get" testID="mcp-servers">
        <Row
          testID="mcp-server-patch"
          title="Patch"
          subtitle="Built in"
          right={<RowValue>Always on</RowValue>}
        />
        {host === null || gap !== null ? (
          <NoticeRow text={gap ?? ''} />
        ) : servers === undefined ? (
          <NoticeRow testID="mcp-update" text={updateToManageText(host)} />
        ) : (
          servers.map((s) => <ServerRow key={s.name} host={host} list={servers} server={s} />)
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

function ServerRow({
  host,
  list,
  server,
}: {
  host: HostPresence;
  list: McpServerConfig[];
  server: McpServerConfig;
}): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const conn = usePresenceStore((s) => s.connection);
  const reachable = conn === 'connected' && host.online;
  return (
    <Row
      testID={`mcp-server-${server.name}`}
      accessibilityLabel={`Edit ${server.name}`}
      title={server.name}
      subtitle={commandLine(server)}
      onPress={() =>
        router.push({
          pathname: '/settings/mcp-server',
          params: { daemonId: host.daemonId, name: server.name },
        })
      }
      right={
        <Switch
          testID={`mcp-server-${server.name}-enabled`}
          accessibilityLabel={`${server.name} enabled`}
          value={server.enabled}
          disabled={!reachable}
          onValueChange={(enabled) =>
            void sendHostSettings(
              host.daemonId,
              {
                harnessMcpServers: list.map((s) =>
                  s.name === server.name ? { ...s, enabled } : s,
                ),
              },
              'MCP servers',
            )
          }
          trackColor={{ false: colors.divider, true: colors.leafSoft }}
          thumbColor={server.enabled ? colors.leaf : colors.paper}
        />
      }
    />
  );
}

/**
 * One MCP server, to add (`name` absent) or edit: its name, its command line,
 * its environment as KEY=VALUE lines. Save validates the whole list before it
 * is sent and returns; Remove asks first.
 */
export function McpServerEditor({
  daemonId,
  name,
}: {
  daemonId: string;
  name: string | null;
}): React.ReactElement {
  const router = useRouter();
  const host = usePresenceStore((s) => s.hosts[daemonId] ?? null);
  const list = host?.host?.harnessMcpServers;
  const existing = name === null ? null : (list?.find((s) => s.name === name) ?? null);
  const [draftName, setDraftName] = React.useState(existing?.name ?? '');
  const [line, setLine] = React.useState(existing ? commandLine(existing) : '');
  const [env, setEnv] = React.useState(existing ? envText(existing.env) : '');
  const [problem, setProblem] = React.useState<string | null>(null);
  const title = name === null ? 'Add server' : name;

  const gap = unreportedText(host);
  if (host === null || gap !== null || list === undefined || (name !== null && !existing)) {
    return (
      <SettingsPage title={title} testID="settings-mcp-editor">
        <SettingsSection>
          <NoticeRow
            testID="mcp-editor-unavailable"
            text={
              gap ??
              (list === undefined && host
                ? updateToManageText(host)
                : `${name ?? ''} is no longer on ${host ? hostName(host) : daemonId}`)
            }
          />
        </SettingsSection>
      </SettingsPage>
    );
  }

  const save = (): void => {
    const result = applyMcpDraft(list, name, { name: draftName, commandLine: line, envText: env });
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setProblem(null);
    if (sendHostSettings(daemonId, { harnessMcpServers: result.list }, 'MCP servers')) {
      router.back();
    }
  };

  const remove = (): void =>
    Alert.alert(`Remove ${name ?? ''}?`, `Chats on ${hostName(host)} stop getting its tools.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          if (
            sendHostSettings(
              daemonId,
              { harnessMcpServers: list.filter((s) => s.name !== name) },
              'MCP servers',
            )
          ) {
            router.back();
          }
        },
      },
    ]);

  return (
    <SettingsPage
      title={title}
      testID="settings-mcp-editor"
      right={<SettingsButton testID="mcp-editor-save" label="Save" onPress={save} />}
    >
      <SettingsSection>
        <View style={{ padding: space.md }}>
          <FieldLabel>Name</FieldLabel>
          <Field
            testID="mcp-editor-name"
            accessibilityLabel="Name"
            value={draftName}
            onChangeText={setDraftName}
            placeholder="playwright"
          />
          <FieldLabel>Command</FieldLabel>
          <Field
            testID="mcp-editor-command"
            accessibilityLabel="Command"
            value={line}
            onChangeText={setLine}
            placeholder="npx @playwright/mcp --headless"
          />
          <FieldLabel>Environment</FieldLabel>
          <Field
            testID="mcp-editor-env"
            accessibilityLabel="Environment"
            multiline
            value={env}
            onChangeText={setEnv}
            placeholder="KEY=VALUE"
            style={{ minHeight: 96, textAlignVertical: 'top' }}
          />
          {problem ? <ErrorLine testID="mcp-editor-error" message={problem} /> : null}
        </View>
      </SettingsSection>
      <ButtonRow>
        <SettingsButton
          testID="mcp-editor-cancel"
          label="Cancel"
          variant="quiet"
          onPress={() => router.back()}
        />
        {name !== null ? (
          <SettingsButton
            testID="mcp-editor-remove"
            label="Remove"
            variant="danger"
            onPress={remove}
          />
        ) : null}
      </ButtonRow>
    </SettingsPage>
  );
}
