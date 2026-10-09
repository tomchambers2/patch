// Settings → Memories: Claude Code's own memory on one host — whether it is on
// for chats there, and every entry it has written, to read, edit or delete.
//
// Entries arrive whole in the host's `claude_settings.list` / `.updated`
// report and are never patched locally: an edit or a delete goes to the host
// (`host.claude_memory_set` / `_delete`) and the list settles on its answer. A
// host older than the entry text sends no `body`, which is said, not shown as
// an empty memory.

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import type { ClaudeMemoryEntry } from '@patch/wire';
import { useUiStore } from '../../stores/uiStore.js';
import type { HostPresence } from '../../stores/presenceStore.js';
import { Toggle } from '../../components/Toggle.js';
import { Markdown } from '../../components/Markdown.js';
import { isSubmitChord } from '../../lib/submitChord.js';
import { hostLabel } from './hostScope.js';
import { sendToHost } from './hostWrite.js';
import { patchShared } from './sharedWrite.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { Group, Note, Row, SettingsPage, useHostGate } from './ui.js';

const TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type Filter = 'All' | (typeof TYPES)[number];

/** A memory's project, as a person names it: the folder's last segment. */
export function projectLabel(m: ClaudeMemoryEntry): string {
  if (m.projectDir) {
    const parts = m.projectDir.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || m.projectDir;
  }
  return m.project;
}

const key = (m: ClaudeMemoryEntry): string => `${m.project}/${m.file}`;

export function MemoriesPage(): JSX.Element {
  const { host, gate } = useHostGate();
  return (
    <SettingsPage title="Memories" testid="settings-memories" hostSwitch fill>
      {gate ?? (host ? <HostMemories host={host} /> : null)}
    </SettingsPage>
  );
}

function HostMemories({ host }: { host: HostPresence }): JSX.Element {
  // Whether Claude Code keeps memory at all is shared (spec/01 § Settings); the
  // entries it wrote live on each machine, under that machine's project paths.
  const enabled = usePreferencesStore((s) => s.preferences.harnessMemoryEnabled);
  const loaded = usePreferencesStore((s) => s.loaded);
  const cs = host.claudeSettings;
  return (
    <>
      <Group>
        <Row title="Memory">
          <Toggle
            checked={enabled}
            disabled={!loaded}
            onChange={(next) => void patchShared('memory', { harnessMemoryEnabled: next })}
            testid="harness-memory-enabled"
          />
        </Row>
      </Group>
      {cs === null ? (
        <Group>
          <Note testid={`host-${host.daemonId}-memory-unreported`}>
            {hostLabel(host)} hasn’t sent its memories yet
          </Note>
        </Group>
      ) : (
        <MemoryBrowser host={host} memories={cs.memories} />
      )}
    </>
  );
}

function MemoryBrowser({
  host,
  memories,
}: {
  host: HostPresence;
  memories: ClaudeMemoryEntry[];
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [selected, setSelected] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = memories.filter(
      (m) =>
        (filter === 'All' || m.memoryType === filter) &&
        (q === '' ||
          [m.name, m.description, m.body ?? '', projectLabel(m), m.file].some((s) =>
            s.toLowerCase().includes(q),
          )),
    );
    const byProject = new Map<string, ClaudeMemoryEntry[]>();
    for (const m of shown) {
      const label = projectLabel(m);
      byProject.set(label, [...(byProject.get(label) ?? []), m]);
    }
    return [...byProject.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
  }, [memories, query, filter]);

  const visible = groups.flatMap(([, ms]) => ms);
  const current = visible.find((m) => key(m) === selected) ?? visible[0] ?? null;

  return (
    <>
      <div className="set-mem-filter">
        <input
          type="search"
          aria-label="Search memories"
          data-testid="memory-search"
          placeholder={`Search ${memories.length} memories`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="set-pills" role="group" aria-label="Memory type">
          {(['All', ...TYPES] as Filter[]).map((t) => (
            <button
              key={t}
              type="button"
              className={t === filter ? 'on' : undefined}
              aria-pressed={t === filter}
              data-testid={`memory-filter-${t}`}
              onClick={() => setFilter(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {memories.length === 0 ? (
        <Group>
          <Note testid={`host-${host.daemonId}-memory-empty`}>
            No memories on {hostLabel(host)}
          </Note>
        </Group>
      ) : (
        <div className="set-mem" data-testid={`host-${host.daemonId}-memory-list`}>
          <div className="set-mem-list">
            {groups.length === 0 ? <Note testid="memory-no-match">No matches</Note> : null}
            {groups.map(([label, ms]) => (
              <div key={label} className="set-mem-project">
                <div className="set-mem-proj">
                  <span className="set-label">{label}</span>
                  <span className="set-chip">{ms.length}</span>
                </div>
                {ms.map((m) => (
                  <button
                    type="button"
                    key={key(m)}
                    className={`set-mem-item${current && key(current) === key(m) ? ' on' : ''}`}
                    data-testid={`host-${host.daemonId}-memory-${m.project}-${m.file}`}
                    onClick={() => setSelected(key(m))}
                  >
                    <b>{m.name || m.file}</b>
                    {m.description ? <small>{m.description}</small> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {current ? (
            <MemoryDetail
              key={`${key(current)}@${current.updatedAt ?? 0}`}
              host={host}
              memory={current}
            />
          ) : null}
        </div>
      )}
    </>
  );
}

function MemoryDetail({
  host,
  memory,
}: {
  host: HostPresence;
  memory: ClaudeMemoryEntry;
}): JSX.Element {
  const [draft, setDraft] = useState(memory.body ?? '');
  const [editing, setEditing] = useState(false);
  const id = `host-${host.daemonId}-memory-${memory.project}-${memory.file}`;
  const meta = [
    memory.memoryType || 'unknown',
    projectLabel(memory),
    memory.updatedAt !== undefined
      ? new Date(memory.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : null,
  ].filter((x): x is string => x !== null);

  function save(): void {
    setEditing(false);
    if (memory.body === undefined || draft === memory.body) return;
    sendToHost(host, {
      type: 'host.claude_memory_set',
      daemonId: host.daemonId,
      project: memory.project,
      file: memory.file,
      body: draft,
    });
  }

  async function remove(): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: 'Delete memory',
      message: `Delete “${memory.name || memory.file}” from ${hostLabel(host)}?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    sendToHost(host, {
      type: 'host.claude_memory_delete',
      daemonId: host.daemonId,
      project: memory.project,
      file: memory.file,
    });
  }

  return (
    <div className="set-mem-detail" data-testid="memory-detail">
      <h3 className="display">{memory.name || memory.file}</h3>
      <div className="set-sub" data-testid="memory-meta">
        {meta.join(' · ')}
      </div>
      {memory.body === undefined ? (
        <>
          {memory.description ? <p className="set-mem-body">{memory.description}</p> : null}
          <p className="set-sub" data-testid="memory-body-unsupported">
            Update {hostLabel(host)} to read this memory
          </p>
        </>
      ) : editing ? (
        <textarea
          className="set-mem-body"
          aria-label="Memory text"
          data-testid="memory-body"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (!isSubmitChord(e)) return;
            e.preventDefault();
            save();
          }}
        />
      ) : (
        <div className="set-mem-body set-mem-md" data-testid="memory-rendered">
          <Markdown content={draft} />
        </div>
      )}
      <div className="set-actions start">
        {memory.body !== undefined && !editing ? (
          <button
            type="button"
            className="set-btn"
            data-testid="memory-edit"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        ) : null}
        <button
          type="button"
          className="set-btn danger"
          data-testid={`${id}-remove`}
          onClick={() => void remove()}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
