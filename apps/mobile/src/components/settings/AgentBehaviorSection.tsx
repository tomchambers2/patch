// Settings → Agent (design/settings-redesign): how chats run.
//
//   Defaults — Model for new chats and the Permission mode new chats start in.
//   Questions — whether an unanswered question expires, and when.
//   Chats — Warn before switching provider, Provider-level context.
//   Layers added to Claude Code — the Patch tools prompt, the System prompt
//              override and Claude Code's settings.json (shared, and per OS),
//              each opened in a full-screen editor (LayerEditor,
//              app/settings/layer.tsx).
//
// Every row is a shared setting (spec/01 § Settings): written to the server,
// which sends it to every host, and settled on the server's answer.

import React from 'react';
import { Alert, View } from 'react-native';
import { DEFAULT_GOAL_EVAL_PROMPT } from '@patch/wire';
import { useRouter } from 'expo-router';
import {
  QUESTION_EXPIRY_SECONDS_MAX,
  QUESTION_EXPIRY_SECONDS_MIN,
  type PermissionMode,
} from '@patch/wire';
import type { AccountPreferences } from '../../api/rest';
import { permissionModeLabel } from '../../lib/labels';
import { space, useTheme } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { OptionPicker } from '../OptionPicker';
import { SettingsSection } from '../SettingsSection';
import { NoticeRow } from './HostSwitcher';
import { ModelChoice } from './ModelChoice';
import { writePreferences } from './PreferenceSections';
import { SettingsPage } from './SettingsPage';
import { patchShared } from './sharedWrite';
import {
  ButtonRow,
  Chips,
  ErrorLine,
  Field,
  Muted,
  Row,
  SettingsButton,
  ToggleRow,
  WithSettings,
} from './ui';

/** The modes spec/02 § Permission mode offers, in the order they are shown. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'auto',
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
];

const VERBOSITY = ['off', 'summary', 'full'] as const;
const VERBOSITY_LABEL: Record<(typeof VERBOSITY)[number], string> = {
  off: 'Off',
  summary: 'Summary',
  full: 'Full',
};

export type Layer =
  | 'tools'
  | 'system'
  | 'claude-shared'
  | 'claude-darwin'
  | 'claude-linux'
  | 'goal-judge';

export const LAYER_TITLE: Record<Layer, string> = {
  tools: 'Patch tools prompt',
  system: 'System prompt override',
  'claude-shared': 'Claude Code settings.json',
  'claude-darwin': 'settings.json on macOS',
  'claude-linux': 'settings.json on Linux',
  'goal-judge': 'Goal judge prompt',
};

/** What a layer's editor is titled: short enough to fit the header. */
const EDITOR_TITLE: Record<Layer, string> = {
  tools: 'Tools prompt',
  system: 'System prompt',
  'claude-shared': 'settings.json',
  'claude-darwin': 'macOS settings.json',
  'claude-linux': 'Linux settings.json',
  'goal-judge': 'Judge prompt',
};

const CLAUDE_PART = {
  'claude-shared': 'shared',
  'claude-darwin': 'darwin',
  'claude-linux': 'linux',
} as const;

export function AgentPage(): React.ReactElement {
  return (
    <SettingsPage title="Agent" testID="settings-page-agent">
      <WithSettings testID="agent-defaults">
        {(data) => (
          <>
            <SettingsSection title="Defaults" testID="settings-agent-defaults">
              <ModelChoice
                label="Model for new chats"
                testID="default-model"
                value={data.preferences.defaultModel}
                onSelect={(id) => writePreferences({ defaultModel: id })}
              />
              <PermissionDefaultRow value={data.preferences.permissionModeDefault} />
            </SettingsSection>
            <QuestionExpiry preferences={data.preferences} />
            <SettingsSection title="Chats" testID="settings-agent-chats">
              <ToggleRow
                label="Warn before switching provider"
                testID="provider-switch-warning"
                value={!data.preferences.suppressProviderSwitchWarning}
                onChange={(next) => writePreferences({ suppressProviderSwitchWarning: !next })}
              />
              {/* Default expand state of a chat's provider-level context bar
                  (spec/02 § Provider-level context). The per-turn
                  <system-reminder> rows stay collapsed regardless. */}
              <Row testID="provider-context-verbosity" title="Provider-level context" stack>
                <Chips
                  options={VERBOSITY}
                  selected={data.preferences.providerContextVerbosity}
                  labelOf={(v) => VERBOSITY_LABEL[v]}
                  testIDPrefix="provider-context-verbosity"
                  labelPrefix="Provider-level context"
                  onSelect={(v) => writePreferences({ providerContextVerbosity: v })}
                />
              </Row>
            </SettingsSection>
            <Layers preferences={data.preferences} />
          </>
        )}
      </WithSettings>
    </SettingsPage>
  );
}

/**
 * The mode new chats start in (spec/02 § Permission mode), named as the SDK
 * names them. A change never reaches back into a chat already running.
 */
function PermissionDefaultRow({ value }: { value: PermissionMode }): React.ReactElement {
  return (
    <Row
      testID="permission-row"
      title="Permission mode"
      right={
        <OptionPicker
          testID="permission-default"
          selectedId={value}
          selectedLabel={permissionModeLabel(value)}
          options={PERMISSION_MODES.map((m) => ({ id: m, label: permissionModeLabel(m) }))}
          onSelect={(m) =>
            void patchShared('Permission mode', { permissionModeDefault: m as PermissionMode })
          }
          emptyText="No modes"
        />
      }
    />
  );
}

/** Whether an unanswered question expires, and its window (spec/02 § Questions are not approvals). */
function QuestionExpiry({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const seconds = preferences.questionExpirySeconds;
  const [draft, setDraft] = React.useState(String(seconds));
  React.useEffect(() => setDraft(String(seconds)), [seconds]);
  const commit = (): void => {
    const n = Number(draft.trim());
    if (
      draft.trim() === '' ||
      !Number.isInteger(n) ||
      n < QUESTION_EXPIRY_SECONDS_MIN ||
      n > QUESTION_EXPIRY_SECONDS_MAX
    ) {
      Alert.alert(
        'Invalid value',
        `Question timeout must be between ${QUESTION_EXPIRY_SECONDS_MIN} and ${QUESTION_EXPIRY_SECONDS_MAX} seconds.`,
      );
      setDraft(String(seconds));
      return;
    }
    if (n === seconds) return;
    void patchShared('Question timeout', { questionExpirySeconds: n }).then((ok) => {
      if (!ok) setDraft(String(seconds));
    });
  };
  return (
    <SettingsSection title="Questions" testID="question-expiry">
      <ToggleRow
        label="Expire unanswered questions"
        testID="question-expiry-toggle"
        value={preferences.questionExpiry}
        onChange={(next) => void patchShared('Question expiry', { questionExpiry: next })}
      />
      <Row
        title="Expire after"
        right={
          <>
            <Field
              testID="question-expiry-seconds"
              accessibilityLabel="Question timeout in seconds"
              keyboardType="number-pad"
              value={draft}
              onChangeText={setDraft}
              onBlur={commit}
              onSubmitEditing={commit}
              style={{ width: 76, textAlign: 'right' }}
            />
            <Muted>s</Muted>
          </>
        }
      />
    </SettingsSection>
  );
}

/** First line of a prompt, clipped, for a row's subtitle. */
export function promptSummary(text: string | undefined): string {
  const first = (text ?? '').trim().split('\n')[0] ?? '';
  if (first === '') return 'None';
  return first.length > 48 ? `${first.slice(0, 47)}…` : first;
}

/** What the Patch tools prompt is: the default, turned off, or edited. */
export function toolsPromptSummary(value: string | null, fallback: string): string {
  if (value === null || (fallback !== '' && value === fallback)) return 'Built-in default';
  if (value === '') return 'Off';
  return 'Edited';
}

/** The built-in tools guidance: the host's own text, from any host that has reported it. */
function useToolsDefault(): string {
  return usePresenceStore(
    (s) =>
      Object.values(s.hosts).find((h) => h.host?.harnessToolsPromptDefault !== undefined)?.host
        ?.harnessToolsPromptDefault ?? '',
  );
}

/** The layers Patch adds on top of Claude Code, each with Edit. */
function Layers({ preferences }: { preferences: AccountPreferences }): React.ReactElement {
  const router = useRouter();
  const toolsDefault = useToolsDefault();
  const edit = (layer: Layer): void =>
    router.push({ pathname: '/settings/layer', params: { layer } });
  const row = (layer: Layer, subtitle: string): React.ReactElement => (
    <Row
      key={layer}
      title={LAYER_TITLE[layer]}
      subtitle={subtitle}
      subtitleTestID={`${layer}-summary`}
      right={
        <SettingsButton
          testID={`${layer}-edit`}
          label="Edit"
          variant="quiet"
          onPress={() => edit(layer)}
        />
      }
    />
  );
  const cs = preferences.claudeSettings;
  return (
    <SettingsSection title="Layers added to Claude Code" testID="harness-config">
      {row('tools', toolsPromptSummary(preferences.harnessToolsPrompt, toolsDefault))}
      {row('system', promptSummary(preferences.harnessSystemPrompt))}
      {row('claude-shared', cs.shared.trim() === '' ? 'None' : 'Set')}
      {row('claude-darwin', cs.darwin.trim() === '' ? 'None' : 'Set')}
      {row('claude-linux', cs.linux.trim() === '' ? 'None' : 'Set')}
    </SettingsSection>
  );
}

/**
 * One layer, full screen: the text, Save and Cancel (and Reset to default on
 * the tools prompt). Saving writes the shared setting and returns once the
 * server has committed it; a refusal is shown here in the server's own words.
 */
export function LayerEditor({ layer }: { layer: Layer }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const preferences = useSettingsStore((s) => s.data?.preferences ?? null);
  const toolsDefault = useToolsDefault();
  const initial =
    preferences === null
      ? ''
      : layer === 'tools'
        ? (preferences.harnessToolsPrompt ?? toolsDefault)
        : layer === 'system'
          ? preferences.harnessSystemPrompt
          : layer === 'goal-judge'
            ? preferences.goalEvalPrompt
            : preferences.claudeSettings[CLAUDE_PART[layer]];
  const [draft, setDraft] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  if (preferences === null) {
    return (
      <SettingsPage title={EDITOR_TITLE[layer]} testID="settings-layer-editor">
        <SettingsSection>
          <NoticeRow testID="layer-editor-unavailable" text="Settings haven’t loaded yet" />
        </SettingsSection>
      </SettingsPage>
    );
  }

  const write = async (patch: Partial<AccountPreferences>): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await useSettingsStore.getState().updatePreferences(patch);
      router.back();
    } catch (e) {
      const body = (e as { body?: { message?: string } }).body;
      setProblem(body?.message ?? (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const save = (): void => {
    if (layer === 'tools') void write({ harnessToolsPrompt: draft });
    // An empty string clears the override (the SDK default).
    else if (layer === 'system') void write({ harnessSystemPrompt: draft });
    else if (layer === 'goal-judge') void write({ goalEvalPrompt: draft });
    else
      void write({
        claudeSettings: { ...preferences.claudeSettings, [CLAUDE_PART[layer]]: draft },
      });
  };

  return (
    <SettingsPage
      title={EDITOR_TITLE[layer]}
      testID="settings-layer-editor"
      right={
        <SettingsButton
          testID="layer-editor-save"
          label={saving ? 'Saving…' : 'Save'}
          disabled={saving || draft === initial}
          onPress={save}
        />
      }
    >
      <Field
        testID="layer-editor-text"
        accessibilityLabel={LAYER_TITLE[layer]}
        multiline
        code={layer.startsWith('claude-')}
        value={draft}
        onChangeText={setDraft}
        placeholder={layer.startsWith('claude-') ? '{}' : ''}
        style={{
          minHeight: 360,
          textAlignVertical: 'top',
          backgroundColor: colors.paperRaised,
        }}
      />
      {problem ? <ErrorLine testID="layer-editor-error" message={problem} /> : null}
      <View style={{ marginTop: space.xs }}>
        <ButtonRow>
          <SettingsButton
            testID="layer-editor-cancel"
            label="Cancel"
            variant="quiet"
            onPress={() => router.back()}
          />
          {layer === 'goal-judge' ? (
            <SettingsButton
              testID="layer-editor-reset"
              label="Reset to default"
              variant="quiet"
              disabled={preferences.goalEvalPrompt === DEFAULT_GOAL_EVAL_PROMPT}
              onPress={() => void write({ goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT })}
            />
          ) : null}
          {layer === 'tools' ? (
            <SettingsButton
              testID="layer-editor-reset"
              label="Reset to default"
              variant="quiet"
              disabled={preferences.harnessToolsPrompt === null}
              // null restores the built-in default; '' turns the guidance off.
              onPress={() => void write({ harnessToolsPrompt: null })}
            />
          ) : null}
        </ButtonRow>
      </View>
    </SettingsPage>
  );
}
