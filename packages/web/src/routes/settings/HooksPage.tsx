// Settings → Hooks (spec/14 § `/settings` details — Hooks, spec/20-hooks.md).
// List every configured hook, with an editor for add/edit, same shape as
// Settings → Keys' Secrets block: a card of rows, an inline editor form,
// enable/disable, delete.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Hook, HookCreateBody, HookKind } from '@patch/wire/hooks';
import { isJunkFolder, isReservedSpecialThread } from '@patch/wire';
import { api, ApiError } from '../../api/rest.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import { useChatStore } from '../../stores/chatStore.js';
import { defaultDaemonId, usePresenceStore } from '../../stores/presenceStore.js';
import { loadModels, useModelCatalog } from '../../lib/models.js';
import { Group, Note, Row, SettingsPage } from './ui.js';

function problemText(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const message = (err.body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Editor draft — gate list fields are edited as comma-separated text. */
interface Draft {
  id: string | null;
  name: string;
  kind: HookKind;
  command: string;
  instructions: string;
  model: string;
  hosts: string[];
  folders: string[];
  chatIds: string[];
  specialThreads: boolean;
  filter: string;
  timeoutMs: string;
  enabled: boolean;
}

function blankDraft(): Draft {
  return {
    id: null,
    name: '',
    kind: 'script',
    command: '',
    instructions: '',
    model: '',
    hosts: [],
    folders: [],
    chatIds: [],
    specialThreads: false,
    filter: '',
    timeoutMs: '',
    enabled: true,
  };
}

function draftFromHook(h: Hook): Draft {
  return {
    id: h.id,
    name: h.name,
    kind: h.kind,
    command: h.script?.command ?? '',
    instructions: h.prompt?.instructions ?? '',
    model: h.prompt?.model ?? '',
    hosts: h.gate.hosts ?? [],
    folders: h.gate.folders ?? [],
    chatIds: h.gate.chatIds ?? [],
    specialThreads: h.gate.specialThreads === true,
    filter: h.gate.filter ?? '',
    timeoutMs: String(h.timeoutMs),
    enabled: h.enabled,
  };
}

function listOrNull(items: string[]): string[] | null {
  return items.length > 0 ? items : null;
}

function draftToBody(d: Draft): HookCreateBody {
  const timeoutMs = d.timeoutMs.trim() === '' ? undefined : Number(d.timeoutMs);
  return {
    name: d.name.trim(),
    when: 'user_message',
    kind: d.kind,
    ...(d.kind === 'script' ? { script: { command: d.command } } : {}),
    ...(d.kind === 'prompt' ? { prompt: { instructions: d.instructions, model: d.model } } : {}),
    gate: {
      hosts: listOrNull(d.hosts),
      folders: listOrNull(d.folders),
      chatIds: listOrNull(d.chatIds),
      specialThreads: d.specialThreads,
      filter: d.filter.trim() === '' ? null : d.filter.trim(),
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    enabled: d.enabled,
  };
}

export function HooksPage(): JSX.Element {
  const qc = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const { data, error } = useQuery({ queryKey: ['hooks'], queryFn: () => api.listHooks() });
  const [editing, setEditing] = useState<Draft | null>(null);

  const invalidate = (): Promise<void> => qc.invalidateQueries({ queryKey: ['hooks'] });

  const saveMut = useMutation({
    mutationFn: (d: Draft) =>
      d.id ? api.patchHook(d.id, draftToBody(d)) : api.createHook(draftToBody(d)),
    onSuccess: () => {
      setEditing(null);
      void invalidate();
    },
    onError: (e) => pushError(`hook: ${problemText(e)}`),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteHook(id),
    onSuccess: () => void invalidate(),
    onError: (e) => pushError(`hook: ${problemText(e)}`),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? api.enableHook(id) : api.disableHook(id),
    onSuccess: () => void invalidate(),
    onError: (e) => pushError(`hook: ${problemText(e)}`),
  });

  async function remove(h: Hook): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: `Delete ${h.name}`,
      message: `Delete the hook "${h.name}"? It stops checking messages immediately.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) deleteMut.mutate(h.id);
  }

  const busy = saveMut.isPending;
  const hooks = data?.hooks ?? [];

  return (
    <SettingsPage title="Hooks" testid="settings-hooks-page">
      <Group
        label="Message hooks"
        testid="settings-hooks"
        after={
          editing ? null : (
            <div className="set-add-bar start">
              <button
                type="button"
                className="set-btn"
                data-testid="hook-add"
                onClick={() => setEditing(blankDraft())}
              >
                Add hook
              </button>
            </div>
          )
        }
      >
        {error ? (
          <Note testid="hooks-error">Could not read hooks: {problemText(error)}</Note>
        ) : !data ? (
          <Note>Loading…</Note>
        ) : hooks.length === 0 && !editing ? (
          <Note testid="hooks-empty">No hooks configured</Note>
        ) : null}
        {hooks.map((h) =>
          editing && editing.id === h.id ? (
            <HookEditor
              key={h.id}
              draft={editing}
              busy={busy}
              onChange={setEditing}
              onCancel={() => setEditing(null)}
              onSave={() => saveMut.mutate(editing)}
            />
          ) : (
            <Row key={h.id} title={h.name} sub={`${h.when} · ${h.kind}`} testid={`hook-${h.id}`}>
              <Toggle
                checked={h.enabled}
                testid={`hook-${h.id}-enabled`}
                onChange={(next) => toggleMut.mutate({ id: h.id, enabled: next })}
              />
              <button
                type="button"
                className="set-btn"
                data-testid={`hook-${h.id}-edit`}
                onClick={() => setEditing(draftFromHook(h))}
              >
                Edit
              </button>
            </Row>
          ),
        )}
        {editing && editing.id === null ? (
          <HookEditor
            draft={editing}
            busy={busy}
            onChange={setEditing}
            onCancel={() => setEditing(null)}
            onSave={() => saveMut.mutate(editing)}
          />
        ) : null}
        {editing?.id ? (
          <div className="set-row" data-testid={`hook-${editing.id}-delete-row`}>
            <button
              type="button"
              className="set-btn danger"
              data-testid={`hook-${editing.id}-delete`}
              onClick={() => {
                const h = hooks.find((x) => x.id === editing.id);
                if (h) void remove(h);
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </Group>
    </SettingsPage>
  );
}

function HookEditor({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  busy: boolean;
  onChange(d: Draft): void;
  onCancel(): void;
  onSave(): void;
}): JSX.Element {
  const hosts = usePresenceStore((st) => st.hosts);
  const chats = useChatStore((st) => st.chats);
  const { data: folderData } = useQuery({ queryKey: ['folders'], queryFn: () => api.folders() });
  const modelCatalog = useModelCatalog();
  // The model catalogue is per machine: ask the first host the hook is gated
  // to, else the home host. No host to ask means no list — said, not guessed.
  const modelDaemonId = draft.hosts[0] ?? defaultDaemonId(hosts);
  useEffect(() => {
    if (draft.kind !== 'prompt' || modelDaemonId === null) return;
    void loadModels(modelDaemonId);
  }, [draft.kind, modelDaemonId]);

  const hostOptions = Object.values(hosts).map((h) => ({
    value: h.daemonId,
    label: h.host?.hostName ?? h.daemonId,
  }));
  const folderOptions = [
    ...new Set([
      ...(folderData?.hosts ?? []).flatMap((h) => [
        ...h.roots,
        ...h.recent.filter((f) => !isJunkFolder(f)),
      ]),
      ...Object.values(chats)
        .filter((c) => !isReservedSpecialThread(c.chatId) && !isJunkFolder(c.folder))
        .map((c) => c.folder),
    ]),
  ]
    .filter((f) => f !== '')
    .sort()
    .map((f) => ({ value: f, label: f }));
  const chatOptions = Object.values(chats).map((c) => ({
    value: c.chatId,
    label: c.name ?? c.folder ?? c.chatId,
  }));
  const modelOptions = modelCatalog.models.map((m) => ({ value: m.id, label: m.label }));
  if (draft.model !== '' && !modelOptions.some((m) => m.value === draft.model)) {
    modelOptions.unshift({ value: draft.model, label: draft.model });
  }

  const canSave =
    draft.name.trim() !== '' &&
    (draft.kind === 'script'
      ? draft.command.trim() !== ''
      : draft.instructions.trim() !== '' && draft.model.trim() !== '');
  return (
    <form
      className="set-row stack set-form"
      data-testid="hook-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSave();
      }}
    >
      <label className="set-field">
        <span className="set-row-title">Name</span>
        <input
          value={draft.name}
          data-testid="hook-editor-name"
          autoFocus
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="set-field">
        <span className="set-row-title">Kind</span>
        <select
          value={draft.kind}
          data-testid="hook-editor-kind"
          onChange={(e) => onChange({ ...draft, kind: e.target.value as HookKind })}
        >
          <option value="script">script</option>
          <option value="prompt">prompt</option>
        </select>
      </label>
      {draft.kind === 'script' ? (
        <label className="set-field">
          <span className="set-row-title">Command</span>
          <textarea
            className="mono"
            value={draft.command}
            data-testid="hook-editor-command"
            onChange={(e) => onChange({ ...draft, command: e.target.value })}
          />
        </label>
      ) : (
        <>
          <label className="set-field">
            <span className="set-row-title">Instructions</span>
            <textarea
              value={draft.instructions}
              data-testid="hook-editor-instructions"
              onChange={(e) => onChange({ ...draft, instructions: e.target.value })}
            />
          </label>
          <label className="set-field">
            <span className="set-row-title">Model</span>
            <select
              value={draft.model}
              data-testid="hook-editor-model"
              onChange={(e) => onChange({ ...draft, model: e.target.value })}
            >
              <option value="">Select a model…</option>
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            {modelDaemonId === null ? (
              <Note testid="hook-editor-model-error">
                No host to read models from — gate the hook to a host first.
              </Note>
            ) : modelCatalog.status === 'error' ? (
              <Note testid="hook-editor-model-error">
                Couldn’t load models: {modelCatalog.error ?? 'unknown error'}
              </Note>
            ) : null}
          </label>
        </>
      )}
      <label className="set-field">
        <span className="set-row-title">Hosts (none selected = any)</span>
        <MultiSelect
          values={draft.hosts}
          options={hostOptions}
          testid="hook-editor-hosts"
          onChange={(v) => onChange({ ...draft, hosts: v })}
        />
      </label>
      <label className="set-field">
        <span className="set-row-title">Folders (none selected = any)</span>
        <MultiSelect
          values={draft.folders}
          options={folderOptions}
          testid="hook-editor-folders"
          onChange={(v) => onChange({ ...draft, folders: v })}
        />
      </label>
      <label className="set-field">
        <span className="set-row-title">Chats (none selected = any)</span>
        <MultiSelect
          values={draft.chatIds}
          options={chatOptions}
          testid="hook-editor-chatids"
          onChange={(v) => onChange({ ...draft, chatIds: v })}
        />
      </label>
      <Row title="Special threads only">
        <Toggle
          checked={draft.specialThreads}
          testid="hook-editor-special-threads"
          onChange={(next) => onChange({ ...draft, specialThreads: next })}
        />
      </Row>
      <label className="set-field">
        <span className="set-row-title">Filter (JSONata, optional)</span>
        <input
          className="mono"
          value={draft.filter}
          data-testid="hook-editor-filter"
          onChange={(e) => onChange({ ...draft, filter: e.target.value })}
        />
      </label>
      <label className="set-field">
        <span className="set-row-title">Timeout (ms)</span>
        <input
          type="number"
          value={draft.timeoutMs}
          data-testid="hook-editor-timeout"
          placeholder="15000"
          onChange={(e) => onChange({ ...draft, timeoutMs: e.target.value })}
        />
      </label>
      <Row title="Enabled">
        <Toggle
          checked={draft.enabled}
          testid="hook-editor-enabled"
          onChange={(next) => onChange({ ...draft, enabled: next })}
        />
      </Row>
      <div className="set-actions">
        <span className="set-spacer" />
        <button
          type="button"
          className="set-btn ghost"
          data-testid="hook-editor-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="set-btn primary"
          data-testid="hook-editor-save"
          disabled={busy || !canSave}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** A dropdown that takes several values; a saved value no longer offered stays listed. */
function MultiSelect({
  values,
  options,
  testid,
  onChange,
}: {
  values: string[];
  options: Array<{ value: string; label: string }>;
  testid: string;
  onChange(v: string[]): void;
}): JSX.Element {
  const all = [
    ...values
      .filter((v) => !options.some((o) => o.value === v))
      .map((v) => ({ value: v, label: v })),
    ...options,
  ];
  return (
    <select
      multiple
      value={values}
      data-testid={testid}
      onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
    >
      {all.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
