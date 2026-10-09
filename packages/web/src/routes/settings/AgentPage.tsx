// Settings → Agent: what a new chat starts with, how questions expire, and the
// layers Patch adds on top of bare Claude Code.
//
// Every row is a shared setting (spec/01 § Settings): written to the server,
// which sends it to every host. A row settles on the server's answer.

import type { JSX } from 'react';
import { useState } from 'react';
import {
  QUESTION_EXPIRY_SECONDS_MAX,
  QUESTION_EXPIRY_SECONDS_MIN,
  type PermissionMode,
} from '@patch/wire';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import { PERMISSION_MODES } from '../../components/Composer.js';
import { permissionModeLabel } from '../../lib/permissionModeLabel.js';
import { isSubmitChord } from '../../lib/submitChord.js';
import { shortcutLabel } from '../../lib/shortcuts.js';
import { patchShared } from './sharedWrite.js';
import { useModelOptions } from './modelOptions.js';
import { Group, Pills, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';

type Verbosity = 'off' | 'summary' | 'full';
const VERBOSITY: readonly Verbosity[] = ['off', 'summary', 'full'];

export function AgentPage(): JSX.Element {
  return (
    <SettingsPage title="Agent" testid="settings-agent">
      <Group label="Defaults" testid="settings-default-model">
        <DefaultModelRow />
        <PermissionModeRow />
      </Group>
      <QuestionsGroup />
      <ChatsGroup />
      <LayersGroup />
    </SettingsPage>
  );
}

/**
 * The account's default model (spec/02 § Agent backends, spec/14 § `/settings`).
 *
 * The model EVERY new chat starts on — opened from a surface, fired by a job, or
 * started on a machine — unless it names its own. One decision, in one place.
 *
 * It used to resolve through each HOST's last-used model: whatever the last chat
 * on that machine happened to pick. So one throwaway cheap-model chat silently
 * moved every later model-less spawn onto it, unattended jobs included, through
 * deploys and purchases, until someone happened to pick something else.
 */
function DefaultModelRow(): JSX.Element {
  const value = usePreferencesStore((s) => s.preferences.defaultModel);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const { options, problem } = useModelOptions(value);
  return (
    <Row
      title="Model for new chats"
      sub={
        problem ? (
          <span
            data-testid={
              problem.kind === 'no-host' ? 'default-model-no-host' : 'default-model-error'
            }
          >
            {problem.text}
          </span>
        ) : undefined
      }
    >
      <select
        id="default-model"
        aria-label="Model for new chats"
        value={value}
        disabled={!loaded}
        data-testid="default-model"
        onChange={(e) => {
          void update({ defaultModel: e.target.value }).catch((err: Error) =>
            pushError(failed('settings'), undefined, err.message),
          );
        }}
      >
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * The mode new chats are stamped with (spec/02 § Permission mode) — a change
 * here never reaches back into a chat already running.
 *
 * The options are the SDK's own mode names, unchanged: the value is handed
 * straight to the agent, so a friendlier word on screen would mean the user
 * picks one thing and the model is told another.
 */
function PermissionModeRow(): JSX.Element {
  const value = usePreferencesStore((s) => s.preferences.permissionModeDefault);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <Row title="Permission mode" testid="permission-default-row">
      <select
        aria-label="Permission mode"
        data-testid="permission-default"
        value={value}
        disabled={!loaded}
        onChange={(e) =>
          void patchShared('permission mode', {
            permissionModeDefault: e.target.value as PermissionMode,
          })
        }
      >
        {PERMISSION_MODES.map((m) => (
          <option key={m} value={m}>
            {permissionModeLabel(m)}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * Whether an unanswered question expires, and the window it gets (spec/02 §
 * Questions are not approvals).
 */
function QuestionsGroup(): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const questionExpiry = usePreferencesStore((s) => s.preferences.questionExpiry);
  const questionExpirySeconds = usePreferencesStore((s) => s.preferences.questionExpirySeconds);
  const loaded = usePreferencesStore((s) => s.loaded);

  function setSeconds(raw: string): void {
    const n = parseInt(raw, 10);
    if (
      isNaN(n) ||
      !Number.isInteger(n) ||
      n < QUESTION_EXPIRY_SECONDS_MIN ||
      n > QUESTION_EXPIRY_SECONDS_MAX
    ) {
      // Said here rather than sent and refused: a silently-ignored keystroke
      // would leave the field showing a number no host is running.
      pushError(
        `Question timeout must be between ${QUESTION_EXPIRY_SECONDS_MIN} and ${QUESTION_EXPIRY_SECONDS_MAX} seconds`,
      );
      return;
    }
    if (n === questionExpirySeconds) return;
    void patchShared('question timeout', { questionExpirySeconds: n });
  }

  return (
    <Group label="Questions" testid="question-expiry">
      <Row title="Expire unanswered questions">
        <Toggle
          checked={questionExpiry}
          disabled={!loaded}
          onChange={() => void patchShared('question expiry', { questionExpiry: !questionExpiry })}
          testid="question-expiry-toggle"
        />
      </Row>
      <Row title="Expire after">
        <input
          type="number"
          className="set-num"
          aria-label="Expire after (seconds)"
          min={QUESTION_EXPIRY_SECONDS_MIN}
          max={QUESTION_EXPIRY_SECONDS_MAX}
          // Keyed on the committed value so a fresh answer re-seeds the field.
          key={questionExpirySeconds}
          defaultValue={questionExpirySeconds}
          data-testid="question-expiry-seconds"
          onBlur={(e) => setSeconds(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSeconds((e.target as HTMLInputElement).value);
          }}
        />
        <span className="set-unit">s</span>
      </Row>
    </Group>
  );
}

/** Account-wide chat preferences. */
function ChatsGroup(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };
  return (
    <Group label="Chats" testid="settings-transcript">
      <Row title="Warn before switching provider">
        <Toggle
          checked={!preferences.suppressProviderSwitchWarning}
          disabled={!loaded}
          onChange={(next) => write({ suppressProviderSwitchWarning: !next })}
          testid="provider-switch-warning"
        />
      </Row>
      {/* Default expand state a chat's provider-level context panel opens with
          (spec/02-daemon.md § Provider-level context). Does not touch Patch's
          own `<system-reminder>` disclosures, which stay collapsed regardless. */}
      <Row title="Provider-level context">
        <Pills
          label="Provider-level context"
          options={VERBOSITY}
          value={preferences.providerContextVerbosity}
          disabled={!loaded}
          testid="provider-context-verbosity"
          onChange={(next) => write({ providerContextVerbosity: next })}
        />
      </Row>
    </Group>
  );
}

/**
 * The layers Patch adds on top of bare Claude Code (spec/14 § Agent behavior),
 * each opened in an editor from its row.
 */
function LayersGroup(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  // The built-in tools guidance is the host's own text; any host that has
  // reported can show it. Absent override means that text is in force, so the
  // editor shows it rather than sitting empty — a default nobody can read is a
  // hidden directive (`principles.md § No system-prompt injection`).
  const toolsDefault = usePresenceStore(
    (s) =>
      Object.values(s.hosts).find((h) => h.host?.harnessToolsPromptDefault !== undefined)?.host
        ?.harnessToolsPromptDefault ?? '',
  );
  const tools = preferences.harnessToolsPrompt;
  const toolsState =
    tools === null || (toolsDefault !== '' && tools === toolsDefault)
      ? 'Built-in default'
      : tools === ''
        ? 'Off'
        : 'Edited';
  const system = preferences.harnessSystemPrompt;
  const systemFirstLine = system.trim().split('\n')[0] ?? '';

  return (
    <Group label="Layers added to Claude Code" testid="harness-config">
      <LayerEditor
        title="Patch tools prompt"
        sub={toolsState}
        initial={tools ?? toolsDefault}
        testid="harness-tools-prompt"
        placeholder="Empty: patch adds no tool guidance"
        onSave={(text) => patchShared('tools prompt', { harnessToolsPrompt: text })}
        // null restores the built-in default; '' turns the guidance off.
        onReset={
          tools === null
            ? undefined
            : () => patchShared('tools prompt', { harnessToolsPrompt: null })
        }
      />
      <LayerEditor
        title="System prompt override"
        sub={systemFirstLine === '' ? 'None' : systemFirstLine}
        initial={system}
        testid="harness-system-prompt"
        placeholder="Empty: the SDK default"
        // Empty string clears the override (reverts to SDK default).
        onSave={(text) => patchShared('system prompt', { harnessSystemPrompt: text })}
      />
      <ClaudeSettingsEditor which="shared" title="Claude Code settings.json" />
      <ClaudeSettingsEditor which="darwin" title="settings.json on macOS" />
      <ClaudeSettingsEditor which="linux" title="settings.json on Linux" />
    </Group>
  );
}

/** A row whose Edit button opens a text editor under it: Save, Cancel, ⌘↵. */
export function LayerEditor({
  title,
  sub,
  initial,
  testid,
  placeholder,
  onSave,
  onReset,
}: {
  title: string;
  sub: string;
  initial: string;
  testid: string;
  placeholder: string;
  onSave: (text: string) => Promise<boolean>;
  onReset?: () => Promise<boolean>;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const save = (): void => {
    if (draft === null) return;
    void onSave(draft).then((ok) => {
      if (ok) setDraft(null);
    });
  };
  return (
    <div className={`set-row${draft === null ? '' : ' stack'}`} data-testid={`${testid}-row`}>
      <div className="set-row-head">
        <div className="set-row-text">
          <span className="set-row-title">{title}</span>
          <span className="set-sub" data-testid={`${testid}-state`}>
            {sub}
          </span>
        </div>
        {draft === null ? (
          <button
            type="button"
            className="set-btn"
            data-testid={`${testid}-edit`}
            onClick={() => setDraft(initial)}
          >
            Edit
          </button>
        ) : null}
      </div>
      {draft !== null ? (
        <>
          <textarea
            aria-label={title}
            data-testid={testid}
            value={draft}
            rows={10}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // spec/14 § Keyboard shortcuts — `⌘↵` commits the field.
              if (!isSubmitChord(e)) return;
              e.preventDefault();
              save();
            }}
          />
          <div className="set-actions">
            {onReset ? (
              <button
                type="button"
                className="set-btn ghost"
                data-testid={`${testid}-reset`}
                onClick={() => {
                  void onReset().then((ok) => {
                    if (ok) setDraft(null);
                  });
                }}
              >
                Reset to default
              </button>
            ) : null}
            <button
              type="button"
              className="set-btn ghost"
              onClick={() => setDraft(null)}
              data-testid={`${testid}-cancel`}
            >
              Cancel
            </button>
            <button
              type="button"
              className="set-btn primary"
              data-testid={`${testid}-save`}
              title={shortcutLabel('⌘↵')}
              onClick={save}
            >
              Save
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Claude Code's `settings.json` as a shared setting (spec/02 § Claude Code
 * settings): one text for every host, and an override per OS whose top-level
 * keys replace the shared ones. The server refuses text that is not a JSON
 * object and says why; the editor stays open with the text until it commits.
 */
function ClaudeSettingsEditor({
  which,
  title,
}: {
  which: 'shared' | 'darwin' | 'linux';
  title: string;
}): JSX.Element {
  const setting = usePreferencesStore((s) => s.preferences.claudeSettings);
  const loaded = usePreferencesStore((s) => s.loaded);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = setting[which];
  const id = `claude-settings-${which}`;

  function save(): void {
    if (draft === null) return;
    setSaving(true);
    void patchShared(title, { claudeSettings: { ...setting, [which]: draft } }).then((ok) => {
      setSaving(false);
      if (ok) setDraft(null);
    });
  }

  return (
    <div className={`set-row${draft === null ? '' : ' stack'}`} data-testid={id}>
      <div className="set-row-head">
        <div className="set-row-text">
          <span className="set-row-title">{title}</span>
          <span className="set-sub">{value.trim() === '' ? 'None' : 'Set'}</span>
        </div>
        {draft === null ? (
          <button
            type="button"
            className="set-btn"
            data-testid={`${id}-edit`}
            disabled={!loaded}
            onClick={() => setDraft(value)}
          >
            Edit
          </button>
        ) : null}
      </div>
      {draft !== null ? (
        <>
          <textarea
            className="claude-settings-json"
            aria-label={title}
            data-testid={`${id}-json`}
            rows={12}
            placeholder="{}"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (!isSubmitChord(e)) return;
              e.preventDefault();
              save();
            }}
          />
          <div className="set-actions">
            <button
              type="button"
              className="set-btn ghost"
              onClick={() => setDraft(null)}
              data-testid={`${id}-cancel`}
            >
              Cancel
            </button>
            <button
              type="button"
              className="set-btn primary"
              data-testid={`${id}-save`}
              disabled={saving || draft === value}
              title={shortcutLabel('⌘↵')}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
