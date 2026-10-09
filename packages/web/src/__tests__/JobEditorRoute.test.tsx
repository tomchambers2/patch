// New-job editor: a SINGLE-PAGE form (spec/14 ## Jobs view — "one form
// view, no wizard"). All groups (Trigger / Filter / Action) are visible at
// once. Plus: the natural-language schedule field (NL → cron) and the I1-d4
// action validation (at least one of skill|prompt; both allowed).

import type { JSX } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  JobEditorRoute,
  resolveSkillLink,
  buildFolderGroups,
  buildGroupOptions,
  mostRecentPair,
} from '../routes/JobEditorRoute.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { resetModelCatalog } from '../lib/models.js';
import { reportHost } from './presenceHelpers.js';

// The lazy editor factory first pulls in the self-hosted Monaco bootstrap, which
// imports the real `monaco-editor` — jsdom cannot evaluate it (it reaches for
// `document.queryCommandSupported`). Stub it out alongside the wrapper below.
vi.mock('../lib/monaco-loader.js', () => ({
  ensureMonacoLoaded: async () => undefined,
}));

// The `script` action's Command field is Monaco (a gate's body is a whole
// script, not a one-liner), and jsdom cannot host the real editor. Stand in a
// textarea carrying the same testid the field has always had, so the tests
// below drive the command exactly as they did when it WAS a textarea.
vi.mock('@monaco-editor/react', async () => {
  const { useState } = await import('react');
  const Editor = (props: {
    defaultValue?: string;
    value?: string;
    language?: string;
    /** The Monaco model path. Each command editor has its own, which is what
     *  names the stand-in: a job can carry both a gate and a script action. */
    path?: string;
    onChange?: (v: string | undefined) => void;
  }): JSX.Element => {
    // Mirrors the real wrapper's contract, which the field depends on:
    // `defaultValue` SEEDS the buffer, the editor owns it from then on, and only
    // a remount (a new `key`) re-seeds it. A stand-in that echoed `value` back
    // every render would hide exactly the keystroke-dropping bug the field is
    // written to avoid.
    const [text, setText] = useState(props.defaultValue ?? props.value ?? '');
    return (
      <textarea
        data-testid={props.path ?? 'job-script-command'}
        data-language={props.language}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange?.(e.target.value);
        }}
      />
    );
  };
  return { Editor, DiffEditor: Editor };
});

function renderNew() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/jobs/new']}>
        <Routes>
          <Route path="/jobs/new" element={<JobEditorRoute />} />
          <Route path="/jobs" element={<div data-testid="jobs-list" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderEdit() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/jobs/j_test1']}>
        <Routes>
          <Route path="/jobs/:id" element={<JobEditorRoute />} />
          <Route path="/jobs" element={<div data-testid="jobs-list" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The folder picker's source of truth: EVERY host's own published registry,
// grouped by host (spec/14 § Jobs view). The option a user picks carries
// its host, so `pick()` builds the same encoded value the component does.
const FOLDERS_BODY = {
  hosts: [{ daemonId: 'd1', roots: ['/Users/tom/projects/portfolio'], recent: [] }],
};

function pick(daemonId: string, folder: string): string {
  return JSON.stringify([daemonId, folder]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fallback route every fetch mock ends with — serves the folder registry. */
function defaultRoute(url: string): Response {
  if (String(url).includes('/api/folders')) return jsonResponse(FOLDERS_BODY);
  return jsonResponse({});
}

/**
 * Pick a folder in the host-grouped picker. The options arrive with the host
 * registry (`GET /api/folders`), so a test has to wait for the machine's group
 * before it can choose anything under it.
 */
async function choosePickerFolder(daemonId: string, folder: string): Promise<void> {
  const sel = (await screen.findByTestId('job-spawn-folder')) as HTMLSelectElement;
  await waitFor(() => {
    expect([...sel.options].some((o) => o.value === pick(daemonId, folder))).toBe(true);
  });
  fireEvent.change(sel, { target: { value: pick(daemonId, folder) } });
}

/** Choose "Custom path on <host>…" and type an ad-hoc path on that machine. */
async function chooseCustomFolder(daemonId: string, path: string): Promise<void> {
  await choosePickerFolder(daemonId, '__custom__');
  fireEvent.change(await screen.findByTestId('job-spawn-folder-custom'), {
    target: { value: path },
  });
}

function makeChatRow(chatId: string, folder: string, name: string | null = null) {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name,
    folder,
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    lastUserActivity: Date.now(),
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
  };
}

describe('JobEditorRoute (single-page form)', () => {
  // A registered host, because every host-scoped action names one. With an
  // empty roster there is no right answer and the UI refuses rather than
  // guessing a machine — which is the behaviour, not a fixture detail.
  beforeEach(() => {
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
  });

  beforeEach(() => {
    useUiStore.getState().clearToasts();
    useLayoutStore.getState()._reset();
    // Clear any confirm left pending by a prior test (resolves its promise).
    useUiStore.getState().resolveConfirm(false);
    // A new job seeds from the most-recently-used (host, folder) PAIR, and a
    // pair only exists once there is a chat to learn it from (spec/14
    // § Jobs view). One chat on d1 is that pair.
    useChatStore.setState({
      chats: { c_seed: makeChatRow('c_seed', '/Users/tom/projects/portfolio') },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows trigger + action on one page with a Create button (no wizard)', () => {
    renderNew();
    // No wizard steps / Next button.
    expect(screen.queryByTestId('wizard-steps')).toBeNull();
    expect(screen.queryByTestId('wizard-next')).toBeNull();
    expect(screen.getByTestId('group-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('group-action')).toBeInTheDocument();
    expect(screen.getByTestId('job-name')).toBeInTheDocument();
    expect(screen.getByTestId('job-trigger-type')).toBeInTheDocument();
    expect(screen.getByTestId('action-payload-hint')).toHaveTextContent(/or both/i);
    expect(screen.getByTestId('job-save')).toHaveTextContent('Create');
  });

  it('hides the Filter group for cron triggers, shows it for webhook', () => {
    renderNew();
    // Default trigger is cron → no payload to filter.
    expect(screen.queryByTestId('group-filter')).toBeNull();
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
    expect(screen.getByTestId('group-filter')).toBeInTheDocument();
    expect(screen.getByTestId('job-filter')).toBeInTheDocument();
  });

  it('uses one NL schedule field and shows the computed cron read-only', () => {
    renderNew();
    // The raw cron input is hidden by default — only the NL field is shown.
    expect(screen.queryByTestId('job-cron')).toBeNull();
    fireEvent.change(screen.getByTestId('job-schedule-nl'), {
      target: { value: 'every weekday at 9am' },
    });
    // Computed cron + description shown read-only.
    expect(screen.getByTestId('job-cron-value')).toHaveTextContent('0 9 * * 1-5');
    expect(screen.getByTestId('job-cron-computed')).toHaveTextContent(/weekdays at 9am/i);
    // Power users can reveal the raw cron input on demand.
    fireEvent.click(screen.getByTestId('job-cron-edit-toggle'));
    expect(screen.getByTestId('job-cron')).toHaveValue('0 9 * * 1-5');
  });

  it('reveals the raw cron input when the phrase cannot be parsed', () => {
    renderNew();
    fireEvent.change(screen.getByTestId('job-schedule-nl'), {
      target: { value: 'whenever the mood strikes' },
    });
    expect(screen.getByTestId('job-cron-computed')).toHaveTextContent(/couldn’t read/i);
    expect(screen.getByTestId('job-cron')).toBeInTheDocument();
  });

  it('editing the revealed raw cron input directly updates the cron expression', () => {
    renderNew();
    fireEvent.click(screen.getByTestId('job-cron-edit-toggle'));
    fireEvent.change(screen.getByTestId('job-cron'), { target: { value: '*/15 * * * *' } });
    expect(screen.getByTestId('job-cron')).toHaveValue('*/15 * * * *');
    expect(screen.getByTestId('job-cron-value')).toHaveTextContent('*/15 * * * *');
  });

  it('falls back to the raw cron expression in the preview when describeCron can’t describe it', () => {
    renderNew();
    fireEvent.click(screen.getByTestId('job-cron-edit-toggle'));
    // A malformed (4-field) cron: describeCron returns '' for it, so the
    // preview falls back to showing the raw expression itself.
    fireEvent.change(screen.getByTestId('job-cron'), { target: { value: '0 9 * *' } });
    expect(screen.getByTestId('job-cron-computed')).toHaveTextContent('Runs 0 9 * *');
  });

  it('folder picker lists configured project folders and offers a Custom path escape hatch', async () => {
    // The old datalist filtered options by the input value, so the default "~"
    // hid every configured folder ("no folders available"). It is now a select
    // that always lists the folders, plus a Custom-path option for ad-hoc paths.
    const fetchMock = vi.fn(async (url: string) => {
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    const sel = (await screen.findByTestId('job-spawn-folder')) as HTMLSelectElement;
    // The configured folder is a real, selectable option (and the seeded value).
    await waitFor(() => {
      expect(
        [...sel.options].some((o) => o.value === pick('d1', '/Users/tom/projects/portfolio')),
      ).toBe(true);
    });
    expect([...sel.options].some((o) => o.value === pick('d1', '__custom__'))).toBe(true);
    // Choosing Custom reveals a free-text path input.
    expect(screen.queryByTestId('job-spawn-folder-custom')).toBeNull();
    fireEvent.change(sel, { target: { value: pick('d1', '__custom__') } });
    expect(screen.getByTestId('job-spawn-folder-custom')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('ensure action mode: shows the folder picker + hint and posts an ensure action', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'daily digest' } });
    // Switch to the persistent-chat (ensure) mode.
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
    // G2: the verbose "first fire creates one chat…" explainer is removed.
    expect(screen.queryByTestId('ensure-hint')).toBeNull();
    // It reuses the spawn folder picker + prompt fields.
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), {
      target: { value: 'summarise today' },
    });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    const body = calls[0]?.body as { action: { type: string; folder: string; prompt: string } };
    expect(body.action.type).toBe('continue');
    expect(body.action.folder).toBe('/Users/tom/projects/portfolio');
    expect(body.action.prompt).toBe('summarise today');
    vi.unstubAllGlobals();
  });

  // Save is a real button in every sense, including the one a click can prove:
  // it goes dead while its own request is in flight. Without that, a second
  // press before the POST returns creates the job TWICE — the navigate() that
  // takes the form off screen only runs on success.
  it('Save is disabled while its create is in flight, so it cannot post twice', async () => {
    const calls: Array<{ body: unknown }> = [];
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          await held;
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'digest' } });
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });

    const save = screen.getByTestId('job-save');
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    // The chord runs the same handler without touching the button, so it has to
    // refuse on the same predicate.
    fireEvent.click(save);
    fireEvent.keyDown(save, { key: 'Enter', ctrlKey: true });
    expect(calls.length).toBe(1);

    release!();
    await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  // spec/08 ## Action — a job's chat opens in the inbox like any other unless
  // the user ticks Hide chat, so a run that stops on a question is answerable.
  it('spawn: Hide chat is unticked by default and posts no hidden flag', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    const box = screen.getByTestId('job-spawn-hidden') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'visible job' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect((calls[0]?.body as { action: Record<string, unknown> }).action).not.toHaveProperty(
      'hidden',
    );
    vi.unstubAllGlobals();
  });

  it('spawn: ticking Hide chat posts action.startHidden = true', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'noisy tick' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-spawn-hidden'));
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect((calls[0]?.body as { action: { startHidden: boolean } }).action.startHidden).toBe(true);
    vi.unstubAllGlobals();
  });

  // spec/08 § Action — a job runs under `auto` unless it says otherwise, and
  // `auto` is what an absent field already means, so the default must post no
  // key at all rather than a no-op one.
  it('spawn: a new job defaults to Auto and posts no permissionMode', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    expect((screen.getByTestId('job-spawn-permission-mode') as HTMLSelectElement).value).toBe(
      'auto',
    );
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'quiet job' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect((calls[0]?.body as { action: Record<string, unknown> }).action).not.toHaveProperty(
      'permissionMode',
    );
    vi.unstubAllGlobals();
  });

  // spec/14 § Keyboard shortcuts — `⌘↵` commits the field being typed in. The
  // Prompt box is a `<textarea>`, which takes no part in a form's own
  // Enter-to-submit, so the longest field on the page had no keyboard save at all.
  it('⌘↵ in the Prompt box saves the job, exactly as the Create button does', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'chord job' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    const prompt = screen.getByTestId('job-spawn-prompt');
    fireEvent.change(prompt, { target: { value: 'summarise today' } });
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect((calls[0]?.body as { action: { prompt: string } }).action.prompt).toBe(
      'summarise today',
    );
    vi.unstubAllGlobals();
  });

  it('bare ↵ in the Prompt box writes a newline rather than saving the job', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), { status: 201 });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'chord job' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    const prompt = screen.getByTestId('job-spawn-prompt');
    fireEvent.change(prompt, { target: { value: 'line one' } });
    fireEvent.keyDown(prompt, { key: 'Enter' });
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(calls.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it('the save control names the chord that presses it', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    expect(screen.getByTestId('job-save').getAttribute('title')).toBe('Ctrl+Enter');
    vi.unstubAllGlobals();
  });

  it('spawn: picking a mode posts action.permissionMode', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'careful job' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.change(screen.getByTestId('job-spawn-permission-mode'), {
      target: { value: 'plan' },
    });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect((calls[0]?.body as { action: { permissionMode: string } }).action.permissionMode).toBe(
      'plan',
    );
    vi.unstubAllGlobals();
  });

  it('spawn: editing a job shows its stored mode and keeps it through an unrelated edit', async () => {
    const job = {
      id: 'j_test1',
      name: 'stored-mode',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/tmp',
        prompt: 'hi',
        permissionMode: 'acceptEdits',
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (method === 'PATCH') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
        }
        if (String(url).includes('/api/jobs/j_test1')) {
          return new Response(JSON.stringify(job), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() =>
      expect((screen.getByTestId('job-spawn-permission-mode') as HTMLSelectElement).value).toBe(
        'acceptEdits',
      ),
    );
    // Touch something else entirely — the stored mode must survive.
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { action: { permissionMode: string } }).action.permissionMode).toBe(
      'acceptEdits',
    );
    vi.unstubAllGlobals();
  });

  // spec/08 ## Action — `hidden` is carried by BOTH folder-carrying actions.
  // It used to be spawn-only, which left the one job that most needs it (a
  // keyed `ensure` opening a durable chat per Todoist task, i.e. an inbox row
  // per task) with no way to switch its rows off at all.
  describe('ensure: Hide chat', () => {
    it('offers the toggle in ensure mode, not just spawn', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => defaultRoute(String(url))),
      );
      renderNew();
      expect(screen.getByTestId('job-spawn-hidden')).toBeInTheDocument();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      expect(screen.getByTestId('job-spawn-hidden')).toBeInTheDocument();
      // Permission mode stays spawn-only — an ensure chat is durable and takes
      // its override directly.
      expect(screen.queryByTestId('job-spawn-permission-mode')).toBeNull();
      vi.unstubAllGlobals();
    });

    // WIRE COMPATIBILITY, and the one thing here that can break production:
    // `ContinueAction` is `.strict()` and a host OTAs its host separately from
    // the server, so for a while Tom's host parses jobs with a schema that
    // has never heard of `hidden`. An unticked job must therefore post NO
    // `hidden` key — not `false`, not `undefined`.
    it('unticked posts no hidden key at all, so the payload is what it always was', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'digest' } });
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action).not.toHaveProperty('hidden');
      // Exactly the keys an ensure action carried before this field existed.
      expect(Object.keys(action).sort()).toEqual(['daemonId', 'folder', 'prompt', 'type']);
      vi.unstubAllGlobals();
    });

    it('ticking it posts action.startHidden = true on an ensure action', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'digest' } });
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-spawn-hidden'));
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect((calls[0]?.body as { action: { startHidden: boolean } }).action.startHidden).toBe(
        true,
      );
      vi.unstubAllGlobals();
    });

    // The Patch Updates job in the shape it is actually stored in: a keyed
    // ensure. `key` has no editor field, so a save from this screen must carry
    // it through untouched — dropping it would silently collapse one chat per
    // task onto one shared chat, which is the exact failure keying prevents.
    it('a stored hidden+keyed ensure round-trips through an unrelated edit', async () => {
      const job = {
        id: 'j_test1',
        name: 'Patch Updates',
        enabled: true,
        trigger: { type: 'todoist' },
        filter: null,
        action: {
          type: 'continue',
          daemonId: 'd1',
          folder: '/tmp',
          skill: 'app-update',
          key: '{{payload.event_data.id}}',
          startHidden: true,
        },
        createdAt: 1,
        updatedAt: 1,
      };
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (String(url).includes('/runs')) {
            return new Response(JSON.stringify({ runs: [] }), { status: 200 });
          }
          if (method === 'PATCH') {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
          }
          if (String(url).includes('/api/jobs/j_test1')) {
            return new Response(JSON.stringify(job), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderEdit();
      await screen.findByTestId('job-name');
      // The stored flag shows as ticked — that is the bug Tom reported: there
      // was no control here at all, so its state was unreadable and unsettable.
      await waitFor(() =>
        expect((screen.getByTestId('job-spawn-hidden') as HTMLInputElement).checked).toBe(true),
      );
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action.startHidden).toBe(true);
      expect(action.key).toBe('{{payload.event_data.id}}');
      vi.unstubAllGlobals();
    });

    it('unticking a stored hidden ensure drops the key rather than writing false', async () => {
      const job = {
        id: 'j_test1',
        name: 'Patch Updates',
        enabled: true,
        trigger: { type: 'todoist' },
        filter: null,
        action: {
          type: 'continue',
          daemonId: 'd1',
          folder: '/tmp',
          skill: 'app-update',
          startHidden: true,
        },
        createdAt: 1,
        updatedAt: 1,
      };
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (String(url).includes('/runs')) {
            return new Response(JSON.stringify({ runs: [] }), { status: 200 });
          }
          if (method === 'PATCH') {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
          }
          if (String(url).includes('/api/jobs/j_test1')) {
            return new Response(JSON.stringify(job), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderEdit();
      await screen.findByTestId('job-name');
      await waitFor(() =>
        expect((screen.getByTestId('job-spawn-hidden') as HTMLInputElement).checked).toBe(true),
      );
      fireEvent.click(screen.getByTestId('job-spawn-hidden'));
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action).not.toHaveProperty('hidden');
      vi.unstubAllGlobals();
    });
  });

  // The same rule the new-chat picker follows (spec/04 § Folders), on the
  // editor's own select: patch's internal thread working dirs are bookkeeping,
  // never a project a job should be aimed at.
  describe('folder select excludes patch’s own thread folders', () => {
    const MANAGER = '/home/tom/.patch/threads/manager';
    const SPEAKERS = '/home/tom/.patch/threads/speakers';

    function seedThreadsAndProject(): void {
      useChatStore.setState({
        chats: {
          thread_manager: {
            ...makeChatRow('thread_manager', MANAGER, 'manager'),
            lastUpdated: 9000,
          },
          thread_speakers: {
            ...makeChatRow('thread_speakers', SPEAKERS, 'speakers'),
            lastUpdated: 8000,
          },
          c_real: { ...makeChatRow('c_real', '/home/tom/projects/alpha'), lastUpdated: 100 },
        },
      });
    }

    it('offers no thread folder as an option', async () => {
      seedThreadsAndProject();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => defaultRoute(String(url))) as unknown as typeof fetch,
      );
      renderNew();

      const sel = (await screen.findByTestId('job-spawn-folder')) as HTMLSelectElement;
      await waitFor(() => {
        expect(
          [...sel.options].some((o) => o.value === pick('d1', '/home/tom/projects/alpha')),
        ).toBe(true);
      });
      const values = [...sel.options].map((o) => o.value);
      expect(values).not.toContain(pick('d1', MANAGER));
      expect(values).not.toContain(pick('d1', SPEAKERS));
    });

    // The worst of the two: the seed SAVES this folder onto the job, so every
    // fire of it would have spawned inside `threads/manager`.
    it('seeds a new job to the newest real project, not a newer special thread', async () => {
      seedThreadsAndProject();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => defaultRoute(String(url))) as unknown as typeof fetch,
      );
      renderNew();

      const sel = (await screen.findByTestId('job-spawn-folder')) as HTMLSelectElement;
      await waitFor(() => {
        expect(sel.value).toBe(pick('d1', '/home/tom/projects/alpha'));
      });
    });

    // A job SAVED against a thread folder before this rule existed must still
    // show its stored path — as the ad-hoc path it now is — rather than have it
    // silently swapped for something else on the next edit.
    it('still shows a stored thread folder, as an ad-hoc custom path', async () => {
      seedThreadsAndProject();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
          if (String(url).includes('/api/jobs/j_test1')) {
            return jsonResponse({
              id: 'j_test1',
              name: 'legacy',
              enabled: true,
              trigger: { type: 'cron', expression: '0 9 * * *' },
              filter: null,
              action: { type: 'spawn', daemonId: 'd1', folder: MANAGER, prompt: 'go' },
              createdAt: 1,
              updatedAt: 1,
            });
          }
          return defaultRoute(String(url));
        }) as unknown as typeof fetch,
      );
      renderEdit();

      const custom = (await screen.findByTestId('job-spawn-folder-custom')) as HTMLInputElement;
      expect(custom.value).toBe(MANAGER);
    });
  });

  // spec/14 § Jobs view — Model. The catalogue is per HOST and live; a job that
  // stores no model leaves each fire to take that host's last-used one, so
  // `Account default` has to be a reachable, round-trippable state rather than
  // just the absence of a choice.
  describe('model picker (spec/14 § Jobs view)', () => {
    const MODELS_BODY = {
      models: [
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
        { id: 'openai/gpt-5', label: 'GPT-5' },
      ],
    };

    /** Every route the model tests need: folder registry + model catalogue. */
    function modelRoute(url: string): Response {
      if (String(url).includes('/api/models')) return jsonResponse(MODELS_BODY);
      return defaultRoute(String(url));
    }

    beforeEach(() => {
      // The catalogue is a module-level store shared across tests — a stale
      // 'ready' from a prior test would skip the fetch this one asserts on.
      resetModelCatalog();
    });

    it('defaults to Account default and posts no model', async () => {
      const calls: Array<{ body: unknown }> = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return jsonResponse({ id: 'j_new' }, 201);
        }
        return modelRoute(String(url));
      });
      vi.stubGlobal('fetch', fetchMock);
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'default model' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      expect((screen.getByTestId('job-spawn-model') as HTMLSelectElement).value).toBe('');
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => {
        expect(calls.length).toBe(1);
      });
      expect((calls[0]?.body as { action: Record<string, unknown> }).action).not.toHaveProperty(
        'model',
      );
      vi.unstubAllGlobals();
    });

    it('offers only the permission modes the chosen model can run, resetting one it cannot', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => modelRoute(String(url))),
      );
      renderNew();
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      const modes = () =>
        Array.from(
          (screen.getByTestId('job-spawn-permission-mode') as HTMLSelectElement).options,
        ).map((o) => o.value);
      expect(modes()).toContain('auto');
      fireEvent.change(screen.getByTestId('job-spawn-permission-mode'), {
        target: { value: 'auto' },
      });
      await screen.findByRole('option', { name: 'GPT-5' });
      fireEvent.change(screen.getByTestId('job-spawn-model'), {
        target: { value: 'openai/gpt-5' },
      });
      expect(modes()).toEqual(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
      expect((screen.getByTestId('job-spawn-permission-mode') as HTMLSelectElement).value).toBe(
        'default',
      );
      vi.unstubAllGlobals();
    });

    it('names which model Account default resolves to once the host is known', async () => {
      // `beforeEach` registers d1 with `host: null`, so no default has
      // reached it yet — report one, mirroring what a real `daemon.host`
      // does once the account default has propagated.
      reportHost('d1', { defaultModel: 'claude-opus-5' });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => modelRoute(String(url))),
      );
      renderNew();
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      const sel = screen.getByTestId('job-spawn-model') as HTMLSelectElement;
      await waitFor(() => {
        expect(sel.options[0]?.textContent).toBe('Account default (Opus 5)');
      });
      vi.unstubAllGlobals();
    });

    it('names the raw model id when the catalogue has not resolved a label for it', async () => {
      reportHost('d1', { defaultModel: 'claude-unknown-model' });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => modelRoute(String(url))),
      );
      renderNew();
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      const sel = screen.getByTestId('job-spawn-model') as HTMLSelectElement;
      await waitFor(() => {
        expect(sel.options[0]?.textContent).toBe('Account default (claude-unknown-model)');
      });
      vi.unstubAllGlobals();
    });

    it('leaves Account default unlabelled while no host is chosen yet', () => {
      // `beforeEach` registers d1 with `host: null` and this test never
      // chooses a folder, so which model the default resolves to is
      // genuinely unknown — not a guess dressed up as one.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => modelRoute(String(url))),
      );
      renderNew();
      const sel = screen.getByTestId('job-spawn-model') as HTMLSelectElement;
      expect(sel.options[0]?.textContent).toBe('Account default');
      vi.unstubAllGlobals();
    });

    it('loads the chosen host catalogue and posts the picked model', async () => {
      const calls: Array<{ body: unknown }> = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return jsonResponse({ id: 'j_new' }, 201);
        }
        return modelRoute(String(url));
      });
      vi.stubGlobal('fetch', fetchMock);
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'opus job' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      const sel = screen.getByTestId('job-spawn-model') as HTMLSelectElement;
      // The catalogue is fetched for the host the FOLDER picked — models are
      // per machine, so showing one host's list while pinning another's job is
      // how the wrong model gets stored.
      await waitFor(() => {
        expect([...sel.options].some((o) => o.value === 'claude-opus-5')).toBe(true);
      });
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/api/models?daemonId=d1')),
      ).toBe(true);
      fireEvent.change(sel, { target: { value: 'claude-opus-5' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => {
        expect(calls.length).toBe(1);
      });
      expect((calls[0]?.body as { action: { model: string } }).action.model).toBe('claude-opus-5');
      vi.unstubAllGlobals();
    });

    it('clearing back to Account default drops the field from the body', async () => {
      const calls: Array<{ body: unknown }> = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return jsonResponse({ id: 'j_new' }, 201);
        }
        return modelRoute(String(url));
      });
      vi.stubGlobal('fetch', fetchMock);
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'back to default' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      const sel = screen.getByTestId('job-spawn-model') as HTMLSelectElement;
      await waitFor(() => {
        expect([...sel.options].some((o) => o.value === 'claude-opus-5')).toBe(true);
      });
      fireEvent.change(sel, { target: { value: 'claude-opus-5' } });
      fireEvent.change(sel, { target: { value: '' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => {
        expect(calls.length).toBe(1);
      });
      expect((calls[0]?.body as { action: Record<string, unknown> }).action).not.toHaveProperty(
        'model',
      );
      vi.unstubAllGlobals();
    });

    it('offered for ensure too, but never for message', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => modelRoute(String(url))),
      );
      renderNew();
      expect(screen.getByTestId('job-spawn-model')).toBeTruthy();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      expect(screen.getByTestId('job-spawn-model')).toBeTruthy();
      // A `message` action inherits its model from the chat it delivers into,
      // so there is nothing here to choose.
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
      expect(screen.queryByTestId('job-spawn-model')).toBeNull();
      vi.unstubAllGlobals();
    });

    it('keeps a saved model as an option when the catalogue has not loaded', async () => {
      const job = {
        id: 'j_test1',
        name: 'pinned',
        enabled: true,
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: {
          type: 'spawn',
          daemonId: 'd1',
          folder: '/Users/tom/projects/portfolio',
          prompt: 'go',
          model: 'claude-retired-1',
        },
        createdAt: 1,
        updatedAt: 1,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          // The catalogue is unavailable — the saved id must survive anyway,
          // or an unrelated edit would silently unpin the job's model.
          if (u.includes('/api/models')) return jsonResponse({ error: 'offline' }, 503);
          if (u.includes('/runs')) return jsonResponse({ runs: [] });
          if (u.includes('/api/jobs/')) return jsonResponse(job);
          return defaultRoute(u);
        }),
      );
      renderEdit();
      const sel = (await screen.findByTestId('job-spawn-model')) as HTMLSelectElement;
      await waitFor(() => {
        expect(sel.value).toBe('claude-retired-1');
      });
      expect([...sel.options].some((o) => o.value === 'claude-retired-1')).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  // Was "Hide chat is spawn-only — ensure has no such control". It is not:
  // spec/08 ## Action gives it to both folder-carrying actions, because both
  // CREATE the chat they place. `message` is the one that cannot have it.
  it('Hide chat is offered by both actions that create a chat, and by neither that does not', () => {
    renderNew();
    expect(screen.getByTestId('job-spawn-hidden')).toBeTruthy();
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
    expect(screen.getByTestId('job-spawn-hidden')).toBeTruthy();
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
    expect(screen.queryByTestId('job-spawn-hidden')).toBeNull();
  });

  // spec/14 § Controls — "No bare native checkboxes anywhere in the UI." This
  // was the last one in the job editor, and being bare is exactly why it broke:
  // `.job-editor label` stacks caption-above-input for the text fields, and a
  // plain <label><input type=checkbox>…</label> got stacked too. The switch
  // brings its own `.toggle` class, which is what the CSS keys the inline
  // layout off. The geometry itself is proved in e2e/job-hide-chat-toggle.spec.ts.
  it('Hide chat is a toggle switch, not a bare checkbox in a bare label', () => {
    renderNew();
    const input = screen.getByTestId('job-spawn-hidden');
    expect(input.getAttribute('role')).toBe('switch');
    const label = input.closest('label');
    expect(label).not.toBeNull();
    expect(label?.classList.contains('toggle')).toBe(true);
    // The switch is drawn by the track+knob, so what the user sees is those,
    // not the input itself.
    expect(label?.querySelector('.toggle-track .toggle-knob')).not.toBeNull();
    expect(label?.querySelector('.toggle-label')?.textContent).toBe('Hide chat from sidebar');
  });

  // spec/14 § Copy — no helper text. The label named the setting and then
  // explained it ("Hide chat — start each run in Archived"); what `hidden` does
  // is the spec's business, not a caption's.
  it('Hide chat carries no explainer caption', () => {
    renderNew();
    expect(screen.queryByText(/start each run in Archived/i)).toBeNull();
    // The label names the setting and where the state is visible. It is not a
    // sentence about what ticking it will do.
    expect(screen.getByText('Hide chat from sidebar')).toBeTruthy();
  });

  // spec/08 ## Action / spec/14 § Jobs view — "Notify when job complete". The
  // one boolean on this form that starts ON, which inverts everything the Hide
  // chat tests above pin: TICKED is the absent-field state, so it is unticking
  // that writes a key.
  describe('Notify when job complete', () => {
    it('is offered by both actions that create a chat, and by neither that does not', () => {
      renderNew();
      expect(screen.getByTestId('job-spawn-notify-on-complete')).toBeTruthy();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      expect(screen.getByTestId('job-spawn-notify-on-complete')).toBeTruthy();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
      expect(screen.queryByTestId('job-spawn-notify-on-complete')).toBeNull();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'script' } });
      expect(screen.queryByTestId('job-spawn-notify-on-complete')).toBeNull();
    });

    it('is a toggle switch beside Hide chat, not a bare checkbox', () => {
      renderNew();
      const input = screen.getByTestId('job-spawn-notify-on-complete');
      expect(input.getAttribute('role')).toBe('switch');
      const label = input.closest('label');
      expect(label).not.toBeNull();
      expect(label?.classList.contains('toggle')).toBe(true);
      expect(label?.querySelector('.toggle-track .toggle-knob')).not.toBeNull();
      expect(label?.querySelector('.toggle-label')?.textContent).toBe('Notify when job complete');
    });

    // spec/14 § Copy — no helper text. Tom's house style: the label names the
    // setting and nothing explains it.
    it('carries no explainer caption', () => {
      renderNew();
      expect(screen.getByText('Notify when job complete')).toBeTruthy();
      expect(screen.queryByText(/push|doorbell|when the run finishes/i)).toBeNull();
    });

    it('is TICKED by default, and a default job posts no notifyOnComplete key', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      const box = screen.getByTestId('job-spawn-notify-on-complete') as HTMLInputElement;
      expect(box.checked).toBe(true);
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'noisy job' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      // WIRE COMPATIBILITY: default-ON means the default state writes NOTHING,
      // so a job nobody touched the toggle on is byte-identical to what the
      // editor posted before this field existed. `notifyOnComplete: true`
      // would be a new key on every job a not-yet-OTA'd host parses strictly.
      expect(action).not.toHaveProperty('notifyOnComplete');
      expect(Object.keys(action).sort()).toEqual(['daemonId', 'folder', 'prompt', 'type']);
      vi.unstubAllGlobals();
    });

    it('unticking it posts action.notifyOnComplete = false', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'quiet job' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-spawn-notify-on-complete'));
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action.notifyOnComplete).toBe(false);
      vi.unstubAllGlobals();
    });

    it('unticking it on a continue action posts false there too', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'digest' } });
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-spawn-notify-on-complete'));
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect(
        (calls[0]?.body as { action: { notifyOnComplete: boolean } }).action.notifyOnComplete,
      ).toBe(false);
      vi.unstubAllGlobals();
    });

    function storedJob(action: Record<string, unknown>): Record<string, unknown> {
      return {
        id: 'j_test1',
        name: 'Patch Updates',
        enabled: true,
        trigger: { type: 'todoist' },
        filter: null,
        action,
        createdAt: 1,
        updatedAt: 1,
      };
    }

    function stubEdit(job: Record<string, unknown>, calls: Array<{ body: unknown }>): void {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (String(url).includes('/runs')) {
            return new Response(JSON.stringify({ runs: [] }), { status: 200 });
          }
          if (method === 'PATCH') {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
          }
          if (String(url).includes('/api/jobs/j_test1')) {
            return new Response(JSON.stringify(job), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
    }

    // Every job already on disk has no such key, and must read as ON.
    it('a stored job with no such key shows TICKED and survives an unrelated edit', async () => {
      const job = storedJob({
        type: 'continue',
        daemonId: 'd1',
        folder: '/tmp',
        skill: 'app-update',
        key: '{{payload.event_data.id}}',
      });
      const calls: Array<{ body: unknown }> = [];
      stubEdit(job, calls);
      renderEdit();
      await screen.findByTestId('job-name');
      await waitFor(() =>
        expect(
          (screen.getByTestId('job-spawn-notify-on-complete') as HTMLInputElement).checked,
        ).toBe(true),
      );
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action).not.toHaveProperty('notifyOnComplete');
      expect(action.key).toBe('{{payload.event_data.id}}');
      vi.unstubAllGlobals();
    });

    it('Include trigger event is ticked by default, posts nothing, and unticking posts includePayload: false', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      expect((screen.getByTestId('job-include-payload') as HTMLInputElement).checked).toBe(true);
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'plain' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect((calls[0]?.body as { action: Record<string, unknown> }).action).not.toHaveProperty(
        'includePayload',
      );
      vi.unstubAllGlobals();
    });

    it('unticking Include trigger event posts action.includePayload = false', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'quiet' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-include-payload'));
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action.includePayload).toBe(false);
      vi.unstubAllGlobals();
    });

    it.each([
      [
        'spawn',
        {
          type: 'spawn',
          daemonId: 'd1',
          folder: '/tmp',
          skill: 'app-update',
          includePayload: false,
        },
      ],
      ['message', { type: 'message', chatId: 'c1', prompt: 'go', includePayload: false }],
    ] as const)(
      'a stored includePayload: false on %s shows UNTICKED and round-trips',
      async (_t, action) => {
        useChatStore.setState({ chats: { c1: makeChatRow('c1', '/home/tom/proj', 'Kitchen') } });
        const calls: Array<{ body: unknown }> = [];
        stubEdit(storedJob(action), calls);
        renderEdit();
        await screen.findByTestId('job-name');
        await waitFor(() =>
          expect((screen.getByTestId('job-include-payload') as HTMLInputElement).checked).toBe(
            false,
          ),
        );
        if (action.type === 'message') {
          // The recipient <select> is `required`: saving before its options load
          // is blocked by native form validation.
          await waitFor(() => {
            const sel = screen.getByTestId('job-message-chat') as HTMLSelectElement;
            expect(sel.value).toBe('c1');
          });
        }
        fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
        fireEvent.click(screen.getByTestId('job-save'));
        await waitFor(() => expect(calls.length).toBe(1));
        expect(
          (calls[0]?.body as { action: { includePayload: boolean } }).action.includePayload,
        ).toBe(false);
        vi.unstubAllGlobals();
      },
    );

    it('a stored notifyOnComplete: false shows UNTICKED and round-trips', async () => {
      const job = storedJob({
        type: 'spawn',
        daemonId: 'd1',
        folder: '/tmp',
        skill: 'app-update',
        notifyOnComplete: false,
      });
      const calls: Array<{ body: unknown }> = [];
      stubEdit(job, calls);
      renderEdit();
      await screen.findByTestId('job-name');
      await waitFor(() =>
        expect(
          (screen.getByTestId('job-spawn-notify-on-complete') as HTMLInputElement).checked,
        ).toBe(false),
      );
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect(
        (calls[0]?.body as { action: { notifyOnComplete: boolean } }).action.notifyOnComplete,
      ).toBe(false);
      vi.unstubAllGlobals();
    });

    // The other direction: turning the doorbell back ON must REMOVE the key,
    // not write `true` — the absent field is what the default is encoded as.
    it('re-ticking a stored false DROPS the key rather than writing true', async () => {
      const job = storedJob({
        type: 'spawn',
        daemonId: 'd1',
        folder: '/tmp',
        skill: 'app-update',
        notifyOnComplete: false,
      });
      const calls: Array<{ body: unknown }> = [];
      stubEdit(job, calls);
      renderEdit();
      await screen.findByTestId('job-name');
      await waitFor(() =>
        expect(
          (screen.getByTestId('job-spawn-notify-on-complete') as HTMLInputElement).checked,
        ).toBe(false),
      );
      fireEvent.click(screen.getByTestId('job-spawn-notify-on-complete'));
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action).not.toHaveProperty('notifyOnComplete');
      expect(Object.keys(action).sort()).toEqual(['daemonId', 'folder', 'skill', 'type']);
      vi.unstubAllGlobals();
    });

    // The two flags are independent and must not overwrite each other: a
    // hidden+silenced job is the exact shape of a five-minute tick.
    it('composes with Hide chat — a stored hidden+silenced job keeps both', async () => {
      const job = storedJob({
        type: 'continue',
        daemonId: 'd1',
        folder: '/tmp',
        skill: 'app-update',
        startHidden: true,
        notifyOnComplete: false,
      });
      const calls: Array<{ body: unknown }> = [];
      stubEdit(job, calls);
      renderEdit();
      await screen.findByTestId('job-name');
      await waitFor(() =>
        expect((screen.getByTestId('job-spawn-hidden') as HTMLInputElement).checked).toBe(true),
      );
      expect((screen.getByTestId('job-spawn-notify-on-complete') as HTMLInputElement).checked).toBe(
        false,
      );
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action.startHidden).toBe(true);
      expect(action.notifyOnComplete).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  it('G2: the verbose "first fire creates one chat…" explainer is gone in ensure mode', () => {
    renderNew();
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
    expect(
      screen.queryByText(
        /The first fire creates one chat in this folder; every later fire messages the SAME chat, so context builds up over time\. You don’t pre-create it\./,
      ),
    ).toBeNull();
    expect(screen.queryByText(/context builds up over time/i)).toBeNull();
  });

  it('Skill is a dropdown populated from the selected folder’s /api/skills', async () => {
    const skillCalls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/skills')) {
        skillCalls.push(String(url));
        return new Response(JSON.stringify({ skills: ['forage', 'plant', 'buy'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    const sel = (await screen.findByTestId('job-spawn-skill')) as HTMLSelectElement;
    // Options come from the folder's skills (plus the empty "— none —").
    await waitFor(() => {
      expect([...sel.options].map((o) => o.value)).toEqual(
        expect.arrayContaining(['', 'forage', 'plant', 'buy']),
      );
    });
    // It fetched skills for the seeded folder.
    expect(
      skillCalls.some((u) => u.includes(encodeURIComponent('/Users/tom/projects/portfolio'))),
    ).toBe(true);
    // Picking one sets the value.
    fireEvent.change(sel, { target: { value: 'plant' } });
    expect(sel.value).toBe('plant');
    vi.unstubAllGlobals();
  });

  it('does not present skill/prompt as optional', () => {
    renderNew();
    expect(screen.queryByText(/Skill \(optional\)/i)).toBeNull();
    expect(screen.queryByText(/Prompt \(optional\)/i)).toBeNull();
    expect(screen.getByTestId('action-payload-hint')).toHaveTextContent(/or both/i);
  });

  it('blocks submit and names the field when neither skill nor prompt is set', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'd4-empty-test' } });
    fireEvent.click(screen.getByTestId('job-save'));
    // The component fetches /api/settings on render for the folder picker; assert
    // only that NO job-creating request was made (not "fetch never called").
    expect(
      fetchMock.mock.calls.some(
        (c) => /\/api\/jobs/.test(String(c[0])) && (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
      ),
    ).toBe(false);
    const errs = useUiStore.getState().errors;
    expect(errs.some((e) => /Skill or .*Prompt/i.test(e.message))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('blocks submit with a visible error when Name is blank', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), {
      target: { value: 'G5-d2 probe prompt' },
    });
    fireEvent.click(screen.getByTestId('job-save'));
    expect(
      fetchMock.mock.calls.some(
        (c) => /\/api\/jobs/.test(String(c[0])) && (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
      ),
    ).toBe(false);
    const errs = useUiStore.getState().errors;
    expect(errs.some((e) => /name is required/i.test(e.message))).toBe(true);
    // Name field is right there on the same page to fix.
    expect(screen.getByTestId('job-name')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('blocks submit when the schedule phrase did not parse, rather than silently shipping the stale cron', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    // Otherwise-complete job: only the schedule is wrong, so a pass here can
    // only be the schedule guard, not one of the other required-field checks.
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'unparseable-schedule' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), {
      target: { value: 'do the thing' },
    });
    // A phrase the parser can't handle: leaves cronExpression at its default
    // ('0 9 * * *') and reveals the raw cron input with an inline warning.
    fireEvent.change(screen.getByTestId('job-schedule-nl'), {
      target: { value: 'whenever the mood strikes' },
    });
    expect(screen.getByTestId('job-cron-computed')).toHaveTextContent(/couldn’t read/i);

    // The button itself reflects the bad schedule, not just an in-flight save.
    expect(screen.getByTestId('job-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('job-save'));
    expect(
      fetchMock.mock.calls.some(
        (c) => /\/api\/jobs/.test(String(c[0])) && (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
      ),
    ).toBe(false);

    // `⌘↵` calls handleSubmit directly, bypassing the disabled button — the
    // guard has to live in handleSubmit itself, not just in `disabled`.
    fireEvent.keyDown(screen.getByTestId('job-spawn-prompt'), { key: 'Enter', metaKey: true });
    expect(
      fetchMock.mock.calls.some(
        (c) => /\/api\/jobs/.test(String(c[0])) && (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
      ),
    ).toBe(false);

    const errs = useUiStore.getState().errors;
    expect(errs.some((e) => /couldn’t read that schedule/i.test(e.message))).toBe(true);
    // The default cron is still sitting there, unsubmitted (the raw input is
    // auto-revealed for an unparsed phrase — see the `scheduleUnparsed` branch
    // above) — nothing silently shipped it.
    expect(screen.getByTestId('job-cron')).toHaveValue('0 9 * * *');
    vi.unstubAllGlobals();
  });

  it('an unparsed leftover schedule phrase does not block saving a non-cron trigger', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'webhook job' } });
    // Type a phrase that won't parse while still on cron, THEN switch away —
    // `scheduleText` is left behind uncleared, and `cronExpression` is never
    // read for a webhook trigger (see `formToBody`), so it must not block.
    fireEvent.change(screen.getByTestId('job-schedule-nl'), {
      target: { value: 'whenever the mood strikes' },
    });
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), {
      target: { value: 'handle the hook' },
    });
    expect(screen.getByTestId('job-save')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    vi.unstubAllGlobals();
  });

  describe('Deduplication key (continue action)', () => {
    it('is offered only by continue, never spawn/message/script', () => {
      renderNew();
      expect(screen.queryByTestId('job-ensure-key')).toBeNull();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      expect(screen.getByTestId('job-ensure-key')).toBeTruthy();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
      expect(screen.queryByTestId('job-ensure-key')).toBeNull();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'script' } });
      expect(screen.queryByTestId('job-ensure-key')).toBeNull();
    });

    it('left empty, posts an action with no key', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'shared chat' } });
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action).not.toHaveProperty('key');
      vi.unstubAllGlobals();
    });

    it('typing a template posts it as action.key', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: 'j_new' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'per-task thread' } });
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'continue' } });
      await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.change(screen.getByTestId('job-ensure-key'), {
        target: { value: '{{payload.event_data.id}}' },
      });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action.key).toBe('{{payload.event_data.id}}');
      vi.unstubAllGlobals();
    });

    it('loads a stored key into the field, and an unrelated edit round-trips it', async () => {
      const job = {
        id: 'j_test1',
        name: 'per-task thread',
        enabled: true,
        trigger: { type: 'todoist' },
        filter: null,
        action: {
          type: 'continue',
          daemonId: 'd1',
          folder: '/tmp',
          skill: 'why',
          key: '{{payload.event_data.id}}',
        },
        createdAt: 1,
        updatedAt: 1,
      };
      const calls: Array<{ method: string; body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (String(url).includes('/api/jobs/j_test1') && method === 'PATCH') {
            calls.push({ method, body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
          }
          if (String(url).includes('/api/jobs/j_test1')) {
            return new Response(JSON.stringify(job), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return defaultRoute(String(url));
        }),
      );
      renderEdit();
      const keyField = (await screen.findByTestId('job-ensure-key')) as HTMLInputElement;
      expect(keyField.value).toBe('{{payload.event_data.id}}');
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      const action = (calls[0]?.body as { action: Record<string, unknown> }).action;
      expect(action.key).toBe('{{payload.event_data.id}}');
      vi.unstubAllGlobals();
    });
  });

  it('a spawn action with a Skill only (no Prompt) omits the prompt field', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/skills')) {
        return new Response(JSON.stringify({ skills: ['forage'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'skill only spawn' } });
    const skillSel = (await screen.findByTestId('job-spawn-skill')) as HTMLSelectElement;
    await waitFor(() => {
      expect([...skillSel.options].some((o) => o.value === 'forage')).toBe(true);
    });
    fireEvent.change(skillSel, { target: { value: 'forage' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as { action: Record<string, unknown> };
    expect(body.action).toMatchObject({ skill: 'forage' });
    expect('prompt' in body.action).toBe(false);
    vi.unstubAllGlobals();
  });

  it('ALLOWS both a Skill and a Prompt — posts an action carrying both', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/skills')) {
        return new Response(JSON.stringify({ skills: ['forage', 'plant'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'both' } });
    const skillSel = (await screen.findByTestId('job-spawn-skill')) as HTMLSelectElement;
    await waitFor(() => {
      expect([...skillSel.options].some((o) => o.value === 'forage')).toBe(true);
    });
    fireEvent.change(skillSel, { target: { value: 'forage' } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    const body = calls[0]?.body as { action: { skill: string; prompt: string } };
    expect(body.action.skill).toBe('forage');
    expect(body.action.prompt).toBe('go');
    expect(useUiStore.getState().errors.length).toBe(0);
    vi.unstubAllGlobals();
  });

  // Task 1: "save a schedule does nothing" — patchMut.onSuccess must navigate
  // back to /jobs after a successful PATCH.
  it('Task 1: save an edited job navigates to /jobs on success', async () => {
    const job = {
      id: 'j_test1',
      name: 'nav-test',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (method === 'PATCH') {
        return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByTestId('job-save'));
    // After success, the route must be /jobs — rendered as jobs-list sentinel.
    await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  // Task 2: "no back button on edit schedule" — the editor must have a back
  // button that navigates to /jobs regardless of save.
  it('Task 2: back button is present in new-job view and navigates to /jobs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    renderNew();
    expect(screen.getByTestId('nav-history')).toBeInTheDocument();
    const back = screen.getByTestId('job-editor-back');
    expect(back).toBeInTheDocument();
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it('Task 2: back button is present in edit view and navigates to /jobs', async () => {
    const job = {
      id: 'j_test1',
      name: 'back-test',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(job), { status: 200 });
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    const back = screen.getByTestId('job-editor-back');
    expect(back).toBeInTheDocument();
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  // Bug report 23 Sep 2026: "patch job back page only goes back to jobs
  // instead of where you actually where". Opened from a chat (the chat is the
  // history entry behind the editor), Back must return there rather than
  // always landing on the jobs list (lib/useGoBack).
  it('back button returns to the chat it was opened from', async () => {
    const job = {
      id: 'j_test1',
      name: 'back-test',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(job), { status: 200 });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/c_abc', '/jobs/j_test1']} initialIndex={1}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/chats/:chatId" element={<div data-testid="chat-route" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByTestId('job-editor-back'));
    await waitFor(() => expect(screen.getByTestId('chat-route')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  // Regression (G4 live-verify): saving an edited job must hit PATCH /api/jobs/:id.
  it('saves an edited job via PATCH /api/jobs/:id', async () => {
    const job = {
      id: 'j_test1',
      name: 'old-name',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: String(url), method });
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (method === 'PATCH') {
        return new Response(JSON.stringify({ ...job, name: 'new-name', updatedAt: 2 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();
    await screen.findByTestId('job-name');
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'new-name' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('/api/jobs/j_test1'))).toBe(
        true,
      );
    });
    expect(calls.some((c) => c.method === 'POST' && /\/api\/jobs\/j_test1$/.test(c.url))).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });

  it('edit summary: Recent runs links to the job’s chat (header + per-run)', async () => {
    const job = {
      id: 'j_test1',
      name: 'digest',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'continue', daemonId: 'd1', folder: '/tmp', skill: 'why' },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/runs')) {
        return new Response(
          JSON.stringify({
            runs: [
              {
                ts: 1,
                jobId: 'j_test1',
                status: 'ok',
                trigger: 'cron',
                action: { type: 'continue', chatId: 'jobchat-j_test1' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();
    // Header "open chat" → the ensure job's deterministic chat.
    await waitFor(() =>
      expect(screen.getByTestId('recent-runs-chat')).toHaveAttribute(
        'href',
        '/chats/jobchat-j_test1',
      ),
    );
    // Each run also links to its chat.
    const runLink = document.querySelector('.recent-runs .run-chat-link');
    expect(runLink?.getAttribute('href')).toBe('/chats/jobchat-j_test1');
    vi.unstubAllGlobals();
  });

  // The Command field is uncontrolled Monaco, reloaded only when the form hands
  // it a value it did not emit. Feeding its own `onChange` back in as `value`
  // dropped keystrokes — the round trip through React state lands a render late
  // and re-applies a stale string to the live model. These pin both halves.
  describe('script action: the command survives the round trip', () => {
    it('loads the stored command when the job arrives from the API', async () => {
      const GATE = '#!/usr/bin/env bash\nset -euo pipefail\necho "holding"';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
          return jsonResponse({
            id: 'j_test1',
            name: 'gate',
            enabled: true,
            trigger: { type: 'cron', expression: '*/15 * * * *' },
            filter: null,
            action: { type: 'script', daemonId: 'd1', folder: '/work', command: GATE },
            createdAt: 1,
            updatedAt: 1,
          });
        }),
      );
      renderEdit();
      const field = (await screen.findByTestId('job-script-command')) as HTMLTextAreaElement;
      await waitFor(() => expect(field.value).toBe(GATE));
      vi.unstubAllGlobals();
    });

    it('an echo of its own edit does not reload the editor', async () => {
      // The Monaco stand-in remounts on `key`, so a spurious reload shows up as
      // the field reverting to the value the form last sent it.
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return jsonResponse({ id: 'j_new' }, 201);
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'gate' } });
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'script' } });
      fireEvent.change(screen.getByTestId('job-script-daemon'), { target: { value: 'd1' } });
      fireEvent.change(screen.getByTestId('job-script-folder'), { target: { value: '/work' } });
      const field = (await screen.findByTestId('job-script-command')) as HTMLTextAreaElement;
      // Three edits in a row — the shape that lost characters.
      fireEvent.change(field, { target: { value: 'set -e' } });
      fireEvent.change(field, { target: { value: 'set -euo pipefail' } });
      fireEvent.change(field, { target: { value: 'set -euo pipefail\necho held' } });
      expect(field.value).toBe('set -euo pipefail\necho held');
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      const body = calls[0]?.body as { action: { command: string } };
      expect(body.action.command).toBe('set -euo pipefail\necho held');
      vi.unstubAllGlobals();
    });
  });

  // spec/08 § Gate — a command asked before each fire that decides whether the
  // action runs at all. It replaced a `script` action that decided AND spawned,
  // which meant the chat it made was not the job's chat and none of the job's
  // machinery reached it.
  describe('the gate', () => {
    const GATED = {
      id: 'j_test1',
      name: 'Foreman',
      enabled: true,
      trigger: { type: 'cron', expression: '*/15 * * * *', timezone: 'Europe/London' },
      filter: null,
      gate: {
        daemonId: 'd1',
        folder: '/work',
        command: '#!/usr/bin/env bash\nQUIET_FROM=23\nexit 1',
        timeoutMs: 120000,
      },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', skill: 'foreman' },
      concurrency: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** GATED carries a concurrency limit, so its page renders the queue panel too. */
    function gatedRoutes(onWrite?: (body: unknown) => void) {
      return vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PATCH' || method === 'POST') {
          onWrite?.(JSON.parse(String(init?.body)));
          return jsonResponse(GATED, method === 'POST' ? 201 : 200);
        }
        if (u.includes('/runs')) return jsonResponse({ runs: [] });
        if (u.includes('/queue')) return jsonResponse({ concurrency: 1, inFlight: [], queued: [] });
        if (u.includes('/api/jobs/j_test1')) return jsonResponse(GATED);
        return defaultRoute(u);
      });
    }

    it('loads a stored gate with the switch on and the script in the editor', async () => {
      vi.stubGlobal('fetch', gatedRoutes());
      renderEdit();
      const cmd = (await screen.findByTestId('job-gate-command')) as HTMLTextAreaElement;
      await waitFor(() => expect(cmd.value).toBe(GATED.gate.command));
      expect(screen.getByTestId('job-gate-on')).toBeChecked();
      expect(screen.getByTestId('job-gate-folder')).toHaveValue('/work');
      expect(screen.getByTestId('job-gate-timeout')).toHaveValue('120000');
    });

    it('unticking posts gate: null — an omitted key would leave the stored one', async () => {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        gatedRoutes((body) => calls.push({ body })),
      );
      renderEdit();
      await screen.findByTestId('job-gate-command');
      fireEvent.click(screen.getByTestId('job-gate-on'));
      expect(screen.queryByTestId('job-gate-command')).toBeNull();
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect((calls[0]?.body as { gate: unknown }).gate).toBeNull();
    });

    it('a gate with no command saves as no gate at all', async () => {
      // Ticking the switch and typing nothing is not a gate — and it must not
      // reach the server as `{command: ""}`, which `JobGate` refuses.
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return jsonResponse({ id: 'j_new' }, 201);
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'w' } });
      fireEvent.click(screen.getByTestId('job-gate-on'));
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      expect((calls[0]?.body as { gate: unknown }).gate).toBeNull();
    });

    it('a run window saves as {start,end,timezone}, and unticking it posts window: null', async () => {
      const calls: Array<{ method: string; body: unknown }> = [];
      const WINDOWED = { ...GATED, window: { start: '07:00', end: '09:30', timezone: 'UTC' } };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const u = String(url);
          const method = (init?.method ?? 'GET').toUpperCase();
          if (method === 'PATCH' || method === 'POST') {
            calls.push({ method, body: JSON.parse(String(init?.body)) });
            return jsonResponse(WINDOWED, method === 'POST' ? 201 : 200);
          }
          if (u.includes('/runs')) return jsonResponse({ runs: [] });
          if (u.includes('/queue'))
            return jsonResponse({ concurrency: 1, inFlight: [], queued: [] });
          if (u.includes('/api/jobs/j_test1')) return jsonResponse(WINDOWED);
          return defaultRoute(u);
        }),
      );
      renderEdit();
      // The stored window loads with the switch on.
      await waitFor(() => expect(screen.getByTestId('job-window-start')).toHaveValue('07:00'));
      expect(screen.getByTestId('job-window-on')).toBeChecked();
      expect(screen.getByTestId('job-window-end')).toHaveValue('09:30');
      expect(screen.getByTestId('job-window-timezone')).toHaveValue('UTC');
      fireEvent.change(screen.getByTestId('job-window-end'), { target: { value: '10:00' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect((calls[0]?.body as { window: unknown }).window).toEqual({
        start: '07:00',
        end: '10:00',
        timezone: 'UTC',
      });
    });

    it('unticking the run window posts window: null — an omitted key would leave it', async () => {
      const calls: Array<{ body: unknown }> = [];
      const WINDOWED = { ...GATED, window: { start: '07:00', end: '09:30', timezone: 'UTC' } };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const u = String(url);
          const method = (init?.method ?? 'GET').toUpperCase();
          if (method === 'PATCH') {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return jsonResponse(WINDOWED);
          }
          if (u.includes('/runs')) return jsonResponse({ runs: [] });
          if (u.includes('/queue'))
            return jsonResponse({ concurrency: 1, inFlight: [], queued: [] });
          if (u.includes('/api/jobs/j_test1')) return jsonResponse(WINDOWED);
          return defaultRoute(u);
        }),
      );
      renderEdit();
      await waitFor(() => expect(screen.getByTestId('job-window-on')).toBeChecked());
      fireEvent.click(screen.getByTestId('job-window-on'));
      expect(screen.queryByTestId('job-window-start')).toBeNull();
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect((calls[0]?.body as { window: unknown }).window).toBeNull();
    });

    it('refuses a gate with no host, naming the gate rather than 400ing', async () => {
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'w' } });
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-gate-on'));
      fireEvent.change(await screen.findByTestId('job-gate-command'), {
        target: { value: 'exit 1' },
      });
      fireEvent.change(screen.getByTestId('job-gate-daemon'), { target: { value: '' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() =>
        expect(
          useUiStore.getState().errors.some((e) => /gate command runs on/.test(e.message)),
        ).toBe(true),
      );
    });
  });

  describe('Starts / stops (spec/08 § Filter)', () => {
    function stubCreate(): Array<{ body: unknown }> {
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            String(url).includes('/api/jobs') &&
            (init?.method ?? 'GET').toUpperCase() === 'POST'
          ) {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return jsonResponse({ id: 'j_new' }, 201);
          }
          return defaultRoute(String(url));
        }),
      );
      return calls;
    }

    // Real dates, not JSONata, is the whole point — verified with the raw
    // filter textarea gone entirely on a cron trigger.
    it('is shown even for a cron trigger, unlike the raw JSONata filter', () => {
      renderNew();
      expect(screen.getByTestId('job-date-start')).toBeInTheDocument();
      expect(screen.getByTestId('job-date-stop')).toBeInTheDocument();
      expect(screen.queryByTestId('job-filter')).toBeNull();
    });

    it('no dates set → no filter at all, same as before this feature existed', async () => {
      const calls = stubCreate();
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'w' } });
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      expect((calls[0]?.body as { filter: unknown }).filter).toBeNull();
    });

    it('a start date alone posts a plain `now >= "..."` filter', async () => {
      const calls = stubCreate();
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'w' } });
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.change(screen.getByTestId('job-date-start'), {
        target: { value: '2027-05-01T16:00' },
      });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      const filter = (calls[0]?.body as { filter: string }).filter;
      expect(filter).toMatch(/^now >= "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/);
    });

    it('start and stop together are ANDed into one filter', async () => {
      const calls = stubCreate();
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'w' } });
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.change(screen.getByTestId('job-date-start'), {
        target: { value: '2027-05-01T16:00' },
      });
      fireEvent.change(screen.getByTestId('job-date-stop'), {
        target: { value: '2027-09-01T16:00' },
      });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      const filter = (calls[0]?.body as { filter: string }).filter;
      expect(filter).toMatch(
        /^now >= "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z" and now <= "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/,
      );
    });

    it('a date range plus a custom payload filter (webhook trigger) ANDs both together', async () => {
      const calls = stubCreate();
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'w' } });
      fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
      await chooseCustomFolder('d1', '/tmp/w');
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      fireEvent.change(screen.getByTestId('job-date-start'), {
        target: { value: '2027-05-01T16:00' },
      });
      fireEvent.change(screen.getByTestId('job-filter'), {
        target: { value: 'payload.foo = "bar"' },
      });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      const filter = (calls[0]?.body as { filter: string }).filter;
      expect(filter).toMatch(/^now >= ".*" and payload\.foo = "bar"$/);
    });

    it('a date range set on a cron trigger is NOT discarded, unlike a custom payload filter would be', async () => {
      const calls = stubCreate();
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'w' } });
      fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
      // triggerType defaults to 'cron' — the raw Filter group is hidden here,
      // but the date range widget still applies and still saves.
      fireEvent.change(screen.getByTestId('job-date-start'), {
        target: { value: '2027-05-01T16:00' },
      });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      expect((calls[0]?.body as { filter: string }).filter).toMatch(/^now >= "/);
    });

    it('loading an existing job with a date-range filter pre-fills both pickers in local time', async () => {
      const job = {
        id: 'j_test1',
        name: 'friday pop-up check',
        enabled: true,
        trigger: { type: 'cron', expression: '0 16 * * 5' },
        filter: 'now >= "2027-05-01T16:00:00.000Z" and now <= "2027-09-01T16:00:00.000Z"',
        action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
        createdAt: 1,
        updatedAt: 1,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
          if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
          return defaultRoute(String(url));
        }),
      );
      renderEdit();
      await screen.findByTestId('job-name');
      await waitFor(() =>
        expect((screen.getByTestId('job-date-start') as HTMLInputElement).value).not.toBe(''),
      );
      const startInput = screen.getByTestId('job-date-start') as HTMLInputElement;
      const stopInput = screen.getByTestId('job-date-stop') as HTMLInputElement;
      expect(new Date(startInput.value).toISOString()).toBe('2027-05-01T16:00:00.000Z');
      expect(new Date(stopInput.value).toISOString()).toBe('2027-09-01T16:00:00.000Z');
    });

    it('re-saving an untouched job with a date range preserves it exactly', async () => {
      const job = {
        id: 'j_test1',
        name: 'friday pop-up check',
        enabled: true,
        trigger: { type: 'cron', expression: '0 16 * * 5' },
        filter: 'now >= "2027-05-01T16:00:00.000Z"',
        action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
        createdAt: 1,
        updatedAt: 1,
      };
      const calls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
          if (method === 'PATCH') {
            calls.push({ body: JSON.parse(String(init?.body)) });
            return jsonResponse({ ...job, updatedAt: 2 });
          }
          if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
          return defaultRoute(String(url));
        }),
      );
      renderEdit();
      await screen.findByTestId('job-name');
      await waitFor(() =>
        expect((screen.getByTestId('job-date-start') as HTMLInputElement).value).not.toBe(''),
      );
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(calls.length).toBe(1));
      expect((calls[0]?.body as { filter: string }).filter).toBe(
        'now >= "2027-05-01T16:00:00.000Z"',
      );
    });
  });

  // A gate job (`script`) fires on a tight cron and mostly decides there is no
  // work, so its history was a wall of identical `ok` rows: Tom — "i cant
  // actually dig into when the job gets launched because its in code. and
  // control hidden etc". The exit code and output tail were already recorded by
  // the dispatcher; nothing rendered them.
  describe('recent runs: a script fire shows what it decided', () => {
    const SCRIPT_JOB = {
      id: 'j_test1',
      name: 'Foreman: 15-min gate',
      enabled: true,
      trigger: { type: 'cron', expression: '*/15 * * * *', timezone: 'Europe/London' },
      filter: null,
      action: {
        type: 'script',
        daemonId: 'd1',
        folder: '/home/claude-dev/projects/portfolio',
        command: '#!/usr/bin/env bash\nset -euo pipefail\necho holding',
      },
      createdAt: 1,
      updatedAt: 1,
    };

    function withRuns(runs: unknown[]) {
      return vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(SCRIPT_JOB), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('shows the verdict the command printed, not just "ok"', async () => {
      vi.stubGlobal(
        'fetch',
        withRuns([
          {
            ts: 1,
            jobId: 'j_test1',
            status: 'ok',
            trigger: 'cron',
            action: {
              type: 'script',
              exitCode: 0,
              output: 'observer reachable\nnot due (next wake in 420s) — holding\n',
            },
          },
        ]),
      );
      renderEdit();
      const verdict = await screen.findByTestId('run-verdict');
      expect(verdict).toHaveTextContent('not due (next wake in 420s) — holding');
      // Exit 0 is the noise this row exists to cut — a held gate SUCCEEDED.
      expect(screen.queryByTestId('run-exit')).toBeNull();
    });

    it('links the chat the gate announced, so a launch is visible at a glance', async () => {
      vi.stubGlobal(
        'fetch',
        withRuns([
          {
            ts: 1,
            jobId: 'j_test1',
            status: 'ok',
            trigger: 'cron',
            action: {
              type: 'script',
              exitCode: 0,
              chatId: '01M2SPAWNED',
              output: 'patch:chat 01M2SPAWNED\ndue (desktop 40s ago, sonnet) -> spawned\n',
            },
          },
        ]),
      );
      renderEdit();
      await waitFor(() =>
        expect(document.querySelector('.recent-runs .run-chat-link')?.getAttribute('href')).toBe(
          '/chats/01M2SPAWNED',
        ),
      );
      // The announcement is machinery; the line above it is the verdict.
      expect(screen.getByTestId('run-verdict')).toHaveTextContent(
        'due (desktop 40s ago, sonnet) -> spawned',
      );
    });

    it('keeps the full output behind an expander', async () => {
      vi.stubGlobal(
        'fetch',
        withRuns([
          {
            ts: 1,
            jobId: 'j_test1',
            status: 'ok',
            trigger: 'cron',
            action: { type: 'script', exitCode: 0, output: 'checked queue\n0 waiting — holding' },
          },
        ]),
      );
      renderEdit();
      const toggle = await screen.findByTestId('run-output-toggle');
      expect(screen.queryByTestId('run-output')).toBeNull();
      fireEvent.click(toggle);
      expect(screen.getByTestId('run-output')).toHaveTextContent('checked queue');
    });

    it('a verdict that is the WHOLE output gets no expander', async () => {
      vi.stubGlobal(
        'fetch',
        withRuns([
          {
            ts: 1,
            jobId: 'j_test1',
            status: 'ok',
            trigger: 'cron',
            action: { type: 'script', exitCode: 0, output: '0 waiting — holding\n' },
          },
        ]),
      );
      renderEdit();
      await screen.findByTestId('run-verdict');
      expect(screen.queryByTestId('run-output-toggle')).toBeNull();
    });

    it('shows a non-zero exit, and says "killed" when there is no code at all', async () => {
      vi.stubGlobal(
        'fetch',
        withRuns([
          {
            ts: 2,
            jobId: 'j_test1',
            status: 'dispatch-error',
            trigger: 'cron',
            error: 'command failed',
            action: { type: 'script', exitCode: 1, output: 'observer unreachable' },
          },
          {
            ts: 1,
            jobId: 'j_test1',
            status: 'dispatch-error',
            trigger: 'cron',
            error: 'command killed after its 120000ms timeout',
            // A killed command reports no code — `null` is a real value here,
            // distinct from the absent field every non-script fire has.
            action: { type: 'script', exitCode: null, output: '' },
          },
        ]),
      );
      renderEdit();
      await waitFor(() => expect(screen.getAllByTestId('run-exit')).toHaveLength(2));
      const labels = screen.getAllByTestId('run-exit').map((e) => e.textContent);
      expect(labels).toEqual(['exit 1', 'killed']);
    });
  });

  // Tom, Patch Updates: "recent runs should filter out rejected by default (add
  // toggle). it should show everything (paginated if necessary)". On a
  // Todoist-triggered job nearly every fire is `filter-rejected` — every
  // unrelated task edit in the account — so the run you came to look at was
  // never on screen.
  it('recent runs: hides filter-rejected fires behind a counted toggle', async () => {
    const job = {
      id: 'j_test1',
      name: 'todoist job',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'continue', daemonId: 'd1', folder: '/tmp', skill: 'why' },
      createdAt: 1,
      updatedAt: 1,
    };
    const runs = [
      { ts: 5, jobId: 'j_test1', status: 'ok', trigger: 'todoist' },
      { ts: 4, jobId: 'j_test1', status: 'filter-rejected', trigger: 'todoist' },
      { ts: 3, jobId: 'j_test1', status: 'filter-rejected', trigger: 'todoist' },
      // A filter that THREW is a fault, not a decision — it is never hidden.
      { ts: 2, jobId: 'j_test1', status: 'filter-error', trigger: 'todoist' },
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();

    const toggle = await screen.findByTestId('recent-runs-rejected-toggle');
    expect(toggle).toHaveTextContent('Show 2 rejected');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    let statuses = Array.from(document.querySelectorAll('.recent-runs li .status')).map(
      (el) => el.textContent,
    );
    expect(statuses).toEqual(['ok', 'filter-error']);

    fireEvent.click(toggle);
    expect(screen.getByTestId('recent-runs-rejected-toggle')).toHaveTextContent('Hide rejected');
    statuses = Array.from(document.querySelectorAll('.recent-runs li .status')).map(
      (el) => el.textContent,
    );
    expect(statuses).toEqual(['ok', 'filter-rejected', 'filter-rejected', 'filter-error']);
    vi.unstubAllGlobals();
  });

  it('recent runs: says so when the filter turned every fire away', async () => {
    // Distinct from "No runs yet" — it is the answer to "why is nothing
    // happening?", and hiding it behind the toggle would look like silence.
    const job = {
      id: 'j_test1',
      name: 'todoist job',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'continue', daemonId: 'd1', folder: '/tmp', skill: 'why' },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/runs')) {
        return new Response(
          JSON.stringify({
            runs: [{ ts: 1, jobId: 'j_test1', status: 'filter-rejected', trigger: 'todoist' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();
    await screen.findByTestId('recent-runs-all-rejected');
    expect(screen.queryByText('No runs yet.')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('recent runs: pages further back when a full page comes home', async () => {
    const job = {
      id: 'j_test1',
      name: 'busy job',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'continue', daemonId: 'd1', folder: '/tmp', skill: 'why' },
      createdAt: 1,
      updatedAt: 1,
    };
    const asked: number[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/runs')) {
        const limit = Number(new URL(u, 'http://x').searchParams.get('limit'));
        asked.push(limit);
        // A FULL page every time — the log has more behind it.
        const runs = Array.from({ length: limit }, (_, i) => ({
          ts: 1000 - i,
          jobId: 'j_test1',
          status: 'ok',
          trigger: 'cron',
        }));
        return new Response(JSON.stringify({ runs }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();

    await waitFor(() => expect(document.querySelectorAll('.recent-runs li')).toHaveLength(25));
    fireEvent.click(screen.getByTestId('recent-runs-more'));
    await waitFor(() => expect(document.querySelectorAll('.recent-runs li')).toHaveLength(50));
    expect(asked).toEqual([25, 50]);
    vi.unstubAllGlobals();
  });

  // spec/08 § Concurrency + spec/14 § Jobs view — a limited job's page shows
  // what it is running and what is waiting behind the limit.
  it('queue panel: lists the running fires and the waiting ones for a limited job', async () => {
    const job = {
      id: 'j_test1',
      name: 'serialised',
      enabled: true,
      trigger: { type: 'todoist' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      concurrency: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/queue')) {
        return jsonResponse({
          concurrency: 1,
          inFlight: [
            {
              chatId: 'c-running',
              localId: 'l1',
              startedAt: 1,
              trigger: 'todoist',
              actionType: 'spawn',
              daemonId: 'd1',
            },
          ],
          queued: [
            {
              fireId: 'f2',
              queuedAt: 2,
              chatId: 'c-waiting',
              trigger: 'todoist',
              actionType: 'spawn',
              daemonId: 'd1',
            },
          ],
        });
      }
      if (u.includes('/runs')) return jsonResponse({ runs: [] });
      return jsonResponse(job);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();

    await screen.findByTestId('job-queue');
    expect(screen.getByTestId('job-queue-limit')).toHaveTextContent('1 at a time');
    const running = await screen.findAllByTestId('job-queue-running');
    expect(running).toHaveLength(1);
    // The fire that is actually running has a chat to open.
    expect(running[0]?.querySelector('.run-chat-link')?.getAttribute('href')).toBe(
      '/chats/c-running',
    );
    const waiting = screen.getAllByTestId('job-queue-waiting');
    expect(waiting).toHaveLength(1);
    // A waiting fire has NOT been sent, so it must not offer a link to a chat
    // that does not exist yet.
    expect(waiting[0]?.querySelector('.run-chat-link')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('queue panel: a limited job with nothing waiting says so', async () => {
    const job = {
      id: 'j_test1',
      name: 'serialised',
      enabled: true,
      trigger: { type: 'todoist' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      concurrency: 2,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/queue')) {
        return jsonResponse({ concurrency: 2, inFlight: [], queued: [] });
      }
      if (u.includes('/runs')) return jsonResponse({ runs: [] });
      return jsonResponse(job);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();
    const panel = await screen.findByTestId('job-queue');
    await waitFor(() => expect(panel).toHaveTextContent('Nothing running or queued.'));
    expect(screen.getByTestId('job-queue-limit')).toHaveTextContent('2 at a time');
    vi.unstubAllGlobals();
  });

  it('queue panel: a job with no limit has no queue, so no panel and no request', async () => {
    const job = {
      id: 'j_test1',
      name: 'unlimited',
      enabled: true,
      trigger: { type: 'todoist' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      createdAt: 1,
      updatedAt: 1,
    };
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
      return jsonResponse(job);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEdit();
    // The runs panel below it renders, so the page has settled.
    await screen.findByTestId('recent-runs');
    expect(screen.queryByTestId('job-queue')).toBeNull();
    expect(urls.some((u) => u.includes('/queue'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('webhook trigger: shows scheme/secret + filter, and posts a webhook trigger with a filter', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'webhook job' } });
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
    // Locate the Scheme select + Secret input by their label text.
    const schemeLabel = screen.getByText('Scheme').closest('label');
    const schemeSel = schemeLabel?.querySelector('select') as HTMLSelectElement;
    fireEvent.change(schemeSel, { target: { value: 'github' } });
    const secretLabel = screen.getByText('Secret').closest('label');
    const secret = secretLabel?.querySelector('input') as HTMLInputElement;
    fireEvent.change(secret, { target: { value: 's3cr3t' } });
    fireEvent.change(screen.getByTestId('job-filter'), { target: { value: 'payload.ok = true' } });
    // Needs a folder + skill/prompt for spawn action to pass validation.
    await chooseCustomFolder('d1', '/tmp/webhook');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as {
      trigger: { type: string; scheme: string; secret: string };
      filter: string;
    };
    expect(body.trigger).toEqual({ type: 'webhook', scheme: 'github', secret: 's3cr3t' });
    expect(body.filter).toBe('payload.ok = true');
  });

  it('webhook trigger with no secret typed omits the secret field entirely', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'webhook2' } });
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
    await chooseCustomFolder('d1', '/tmp/webhook2');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as { trigger: Record<string, unknown> };
    expect(body.trigger).toEqual({ type: 'webhook', scheme: 'none' });
    expect('secret' in body.trigger).toBe(false);
  });

  it('todoist is a webhook scheme, not a trigger type: posts a webhook trigger carrying the secret; the type menu has no todoist entry', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'todoist job' } });
    expect(
      Array.from(
        (screen.getByTestId('job-trigger-type') as HTMLSelectElement).options,
        (o) => o.value,
      ),
    ).not.toContain('todoist');
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
    fireEvent.change(screen.getByTestId('job-webhook-scheme'), { target: { value: 'todoist' } });
    fireEvent.change(screen.getByTestId('job-webhook-secret'), { target: { value: 's3cret' } });
    expect(screen.getByTestId('group-filter')).toBeInTheDocument();
    await chooseCustomFolder('d1', '/tmp/todoist');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as { trigger: Record<string, unknown> };
    expect(body.trigger).toEqual({ type: 'webhook', scheme: 'todoist', secret: 's3cret' });
  });

  it('message action: lists chats, seeds folder-scoped skills, and posts a message action', async () => {
    useChatStore.setState({
      chats: {
        c1: makeChatRow('c1', '/home/tom/proj', 'Kitchen'),
      },
    });
    const calls: Array<{ body: unknown }> = [];
    const skillCalls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/skills')) {
        skillCalls.push(u);
        return new Response(JSON.stringify({ skills: ['plant'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: 'j_new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'message job' } });
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
    const chatSelect = screen.getByTestId('job-message-chat') as HTMLSelectElement;
    expect([...chatSelect.options].some((o) => o.value === 'c1')).toBe(true);
    fireEvent.change(chatSelect, { target: { value: 'c1' } });
    await waitFor(() => {
      expect(skillCalls.some((u) => u.includes(encodeURIComponent('/home/tom/proj')))).toBe(true);
    });
    const skillSel = screen.getByTestId('job-message-skill') as HTMLSelectElement;
    // A <select> silently ignores `.value = …` when no matching <option> exists
    // yet — wait for the fetched skill to actually render as an option first.
    await waitFor(() => {
      expect([...skillSel.options].some((o) => o.value === 'plant')).toBe(true);
    });
    fireEvent.change(skillSel, { target: { value: 'plant' } });
    fireEvent.change(screen.getByTestId('job-message-prompt'), { target: { value: 'ping' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as { action: Record<string, unknown> };
    expect(body.action).toEqual({ type: 'message', chatId: 'c1', prompt: 'ping', skill: 'plant' });
  });

  it('message action: an unmatched messageChatId (no chat store row) falls back to an empty skill folder', async () => {
    // No chats seeded at all — messageChatFolder resolves to '' via the `?? ''`
    // fallback, so the skill picker shows its "pick a recipient chat first"
    // placeholder rather than crashing on an undefined folder lookup.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
    const skillSel = screen.getByTestId('job-message-skill') as HTMLSelectElement;
    expect(skillSel.options[0]?.textContent).toBe('— pick a recipient chat first —');
  });

  it('Delete: cancelling the custom modal makes no request', async () => {
    const job = {
      id: 'j_del1',
      name: 'to-delete',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_del1']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/jobs" element={<div data-testid="jobs-list" />} />
          </Routes>
          <ConfirmModal />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await Promise.resolve();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('DELETE'))).toBe(false);
    expect(screen.queryByTestId('jobs-list')).not.toBeInTheDocument();
  });

  it('Delete: confirmed — DELETEs the job and navigates to /jobs', async () => {
    const job = {
      id: 'j_del2',
      name: 'to-delete-2',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: String(url), method });
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_del2']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/jobs" element={<div data-testid="jobs-list" />} />
          </Routes>
          <ConfirmModal />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('j_del2'))).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
  });

  it('Delete: a server failure surfaces "delete failed: …"', async () => {
    const job = {
      id: 'j_del3',
      name: 'to-delete-3',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_del3']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/jobs" element={<div data-testid="jobs-list" />} />
          </Routes>
          <ConfirmModal />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /delete failed/i.test(e.message))).toBe(true);
    });
  });

  it('Run now: POSTs /api/jobs/:id/run and refetches the runs panel (spec/08 ## Manual run)', async () => {
    const job = {
      id: 'j_run1',
      name: 'to-run',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ url: string; method: string }> = [];
    let runsCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: String(url), method });
      if (String(url).includes('/runs')) {
        runsCalls += 1;
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (method === 'POST' && String(url).includes('/run')) {
        return new Response(JSON.stringify({ status: 'sent', fireId: 'f1' }), { status: 200 });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_run1']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/jobs" element={<div data-testid="jobs-list" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    const runsBefore = runsCalls;
    fireEvent.click(screen.getByTestId('job-run-now'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('j_run1/run'))).toBe(true),
    );
    // The panel refetches on success (its own query invalidated) — no separate
    // success toast, the panel updating is the confirmation.
    await waitFor(() => expect(runsCalls).toBeGreaterThan(runsBefore));
    expect(useUiStore.getState().errors.length).toBe(0);
  });

  it('Run now: with unsaved edits it says so and POSTs the draft; clean it runs the saved job', async () => {
    const job = {
      id: 'j_run2',
      name: 'to-run',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const posts: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (String(url).includes('/runs')) return new Response(JSON.stringify({ runs: [] }));
        if (method === 'POST' && String(url).includes('/run')) {
          posts.push({ url: String(url), body: (init?.body as string | null) ?? null });
          return new Response(JSON.stringify({ status: 'sent', fireId: 'f1' }));
        }
        return new Response(JSON.stringify(job));
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_run2']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    expect(screen.getByTestId('job-run-now').textContent).toBe('Run saved job');
    fireEvent.click(screen.getByTestId('job-run-now'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toBeNull();

    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
    expect(screen.getByTestId('job-run-now').textContent).toBe('Test run');
    fireEvent.click(screen.getByTestId('job-run-now'));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(JSON.parse(posts[1]!.body as string).draft.name).toBe('renamed');
  });

  it('Run now: a server failure surfaces "run now failed: …"', async () => {
    const job = {
      id: 'j_run2',
      name: 'to-run-2',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (method === 'POST' && String(url).includes('/run')) {
        return new Response(JSON.stringify({ error: 'dispatch failed' }), { status: 502 });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_run2']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/jobs" element={<div data-testid="jobs-list" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByTestId('job-run-now'));
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /run now failed/i.test(e.message))).toBe(
        true,
      );
    });
  });

  it('Run now is not rendered on the new-job form', () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    expect(screen.queryByTestId('job-run-now')).not.toBeInTheDocument();
  });

  it('blocks submit with a visible error when a spawn/ensure action has no folder chosen', () => {
    // No host registry and no chats — there is no (host, folder) pair to seed
    // from, so the picker stays on its empty, disabled placeholder. A Prompt is
    // set so the skill-or-prompt check passes, isolating the folder check.
    useChatStore.setState({ chats: {} });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'no folder job' } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    expect(
      fetchMock.mock.calls.some(
        (c) => /\/api\/jobs/.test(String(c[0])) && (c[1]?.method ?? 'GET').toUpperCase() === 'POST',
      ),
    ).toBe(false);
    expect(
      useUiStore.getState().errors.some((e) => /choose a folder for the chat/i.test(e.message)),
    ).toBe(true);
  });

  it('a create failure with issues but no top-level body.error surfaces just the issue message', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({ issues: [{ message: 'prompt is too long' }] }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'issues only' } });
    const folderSelect = screen.getByTestId('job-spawn-folder') as HTMLSelectElement;
    fireEvent.change(folderSelect, { target: { value: pick('d1', '__custom__') } });
    fireEvent.change(screen.getByTestId('job-spawn-folder-custom'), { target: { value: '/tmp' } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .errors.some((e) =>
            /^create failed. try again. prompt is too long$/i.test(`${e.message} ${e.detail}`),
          ),
      ).toBe(true);
    });
  });

  it('message action: a skill-only submission (no prompt) omits the prompt field', async () => {
    useChatStore.setState({ chats: { c2: makeChatRow('c2', '/tmp/skillonly', 'Skillonly') } });
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/skills')) {
          return new Response(JSON.stringify({ skills: ['plant'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'skill only' } });
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
    fireEvent.change(screen.getByTestId('job-message-chat'), { target: { value: 'c2' } });
    const skillSel = screen.getByTestId('job-message-skill') as HTMLSelectElement;
    await waitFor(() => expect([...skillSel.options].some((o) => o.value === 'plant')).toBe(true));
    fireEvent.change(skillSel, { target: { value: 'plant' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as { action: Record<string, unknown> };
    expect(body.action).toEqual({ type: 'message', chatId: 'c2', skill: 'plant' });
    expect('prompt' in body.action).toBe(false);
  });

  it('message action: a prompt-only submission (no skill) omits the skill field', async () => {
    useChatStore.setState({ chats: { c3: makeChatRow('c3', '/tmp/promptonly', 'Promptonly') } });
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'prompt only' } });
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
    fireEvent.change(screen.getByTestId('job-message-chat'), { target: { value: 'c3' } });
    fireEvent.change(screen.getByTestId('job-message-prompt'), { target: { value: 'hey' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as { action: Record<string, unknown> };
    expect(body.action).toEqual({ type: 'message', chatId: 'c3', prompt: 'hey' });
    expect('skill' in body.action).toBe(false);
  });

  it('the recipient-chat option label falls back to the raw chatId when the chat has no name', async () => {
    useChatStore.setState({ chats: { c4: makeChatRow('c4', '/tmp/noname', null) } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
    const sel = screen.getByTestId('job-message-chat') as HTMLSelectElement;
    const opt = [...sel.options].find((o) => o.value === 'c4');
    expect(opt?.textContent).toBe('c4 · /tmp/noname');
  });

  it('edit mode: a webhook job with no stored secret leaves the Secret field blank', async () => {
    const job = {
      id: 'j_webhook_nosecret',
      name: 'webhook no secret',
      enabled: true,
      trigger: { type: 'webhook', scheme: 'none' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp/wh2', prompt: 'go' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_webhook_nosecret']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    const secretLabel = screen.getByText('Secret').closest('label');
    expect((secretLabel?.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('edit mode: a message-action job with no stored prompt/skill leaves those fields blank', async () => {
    useChatStore.setState({ chats: { c5: makeChatRow('c5', '/tmp/msg2', 'Five') } });
    const job = {
      id: 'j_msg_bare',
      name: 'message bare',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'message', chatId: 'c5' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_msg_bare']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    expect(screen.getByTestId('job-message-prompt')).toHaveValue('');
  });

  it('a create failure surfaces the server-named field from the ApiError issues array', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(
          JSON.stringify({
            error: 'invalid_body',
            issues: [{ message: 'action.folder is required' }],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'bad job' } });
    const folderSelect = screen.getByTestId('job-spawn-folder') as HTMLSelectElement;
    fireEvent.change(folderSelect, { target: { value: pick('d1', '__custom__') } });
    fireEvent.change(screen.getByTestId('job-spawn-folder-custom'), { target: { value: '/tmp' } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .errors.some((e) => /invalid_body: action\.folder is required/i.test(e.detail ?? '')),
      ).toBe(true);
    });
  });

  it('a create failure with an ApiError body.error but no issues array surfaces just the error', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({ error: 'folder_not_found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'bad job 2' } });
    const folderSelect = screen.getByTestId('job-spawn-folder') as HTMLSelectElement;
    fireEvent.change(folderSelect, { target: { value: pick('d1', '__custom__') } });
    fireEvent.change(screen.getByTestId('job-spawn-folder-custom'), { target: { value: '/tmp' } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(
        useUiStore.getState().errors.some((e) => /folder_not_found/i.test(e.detail ?? '')),
      ).toBe(true);
    });
  });

  it('a create failure that is a plain network Error (not ApiError) surfaces its message', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        throw new Error('network down');
      }
      return defaultRoute(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'bad job 3' } });
    const folderSelect = screen.getByTestId('job-spawn-folder') as HTMLSelectElement;
    fireEvent.change(folderSelect, { target: { value: pick('d1', '__custom__') } });
    fireEvent.change(screen.getByTestId('job-spawn-folder-custom'), { target: { value: '/tmp' } });
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /network down/i.test(e.detail ?? ''))).toBe(
        true,
      );
    });
  });

  it('a patch (edit-save) failure surfaces "patch failed: …"', async () => {
    const job = {
      id: 'j_patchfail',
      name: 'edit-me',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(url).includes('/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (method === 'PATCH') {
        return new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
      }
      return new Response(JSON.stringify(job), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_patchfail']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/jobs" element={<div data-testid="jobs-list" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /patch failed/i.test(e.message))).toBe(true);
    });
  });

  it('edit mode: loads a webhook-trigger job into the form', async () => {
    const job = {
      id: 'j_webhook_edit',
      name: 'webhook edit',
      enabled: true,
      trigger: { type: 'webhook', scheme: 'stripe', secret: 'whsec' },
      filter: 'payload.ok',
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp/wh', prompt: 'go' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_webhook_edit']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    expect((screen.getByTestId('job-trigger-type') as HTMLSelectElement).value).toBe('webhook');
    const secretLabel = screen.getByText('Secret').closest('label');
    expect((secretLabel?.querySelector('input') as HTMLInputElement).value).toBe('whsec');
    expect(screen.getByTestId('job-filter')).toHaveValue('payload.ok');
  });

  it('edit mode: loads a message-action job into the form', async () => {
    useChatStore.setState({ chats: { c9: makeChatRow('c9', '/tmp/msg', 'Nine') } });
    const job = {
      id: 'j_msg_edit',
      name: 'message edit',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'message', chatId: 'c9', prompt: 'ping', skill: 'plant' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (String(url).includes('/api/skills')) {
          return new Response(JSON.stringify({ skills: ['plant'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_msg_edit']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('job-name');
    expect((screen.getByTestId('job-action-type') as HTMLSelectElement).value).toBe('message');
    expect((screen.getByTestId('job-message-chat') as HTMLSelectElement).value).toBe('c9');
    expect(screen.getByTestId('job-message-prompt')).toHaveValue('ping');
  });

  it('Recent runs: a failed job-runs fetch shows "failed to load runs: …"', async () => {
    const job = {
      id: 'j_runsfail',
      name: 'runs-fail',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
        }
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_runsfail']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('recent-runs')).toHaveTextContent(/failed to load runs/i);
    });
  });

  it('Recent runs: an empty runs array shows "No runs yet." and no header chat link', async () => {
    const job = {
      id: 'j_norunschat',
      name: 'no-runs',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_norunschat']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('recent-runs')).toHaveTextContent('No runs yet.');
    });
    expect(screen.queryByTestId('recent-runs-chat')).not.toBeInTheDocument();
  });

  it('Recent runs: a run with an error and no action.chatId shows the error text and no per-run chat link', async () => {
    const job = {
      id: 'j_runerr',
      name: 'run-error',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(
            JSON.stringify({
              runs: [
                {
                  ts: 2,
                  jobId: 'j_runerr',
                  status: 'dispatch-error',
                  trigger: 'cron',
                  error: 'host unreachable',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_runerr']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('recent-runs')).toHaveTextContent('host unreachable');
    });
    expect(document.querySelector('.recent-runs .run-chat-link')).toBeNull();
    // No action.chatId anywhere → no header chat link either.
    expect(screen.queryByTestId('recent-runs-chat')).not.toBeInTheDocument();
  });

  it('with no host registry and no chats the picker offers nothing to pick — no host-less folder', async () => {
    // Every option in this picker belongs to a machine (spec/08 § Action). With
    // no machine there is nothing to offer, and the placeholder says so rather
    // than presenting a path with no host behind it.
    useChatStore.setState({ chats: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    renderNew();
    const sel = (await screen.findByTestId('job-spawn-folder')) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['']);
    expect(sel.querySelectorAll('optgroup')).toHaveLength(0);
  });

  it('every option carries its host, and picking one stores that host with the folder', async () => {
    // The defect this replaces: a flat list of bare paths let a folder that
    // lives on host A be saved against host B (spec/14 § Jobs view —
    // "picking a folder picks the host, and that pair is stored on the action
    // as daemonId + folder").
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/folders')) {
          return jsonResponse({
            hosts: [
              { daemonId: 'd1', roots: ['/shared/path'], recent: [] },
              { daemonId: 'd2', roots: ['/shared/path'], recent: [] },
            ],
          });
        }
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return jsonResponse({ id: 'j_new' }, 201);
        }
        return jsonResponse({});
      }),
    );
    renderNew();
    const sel = (await screen.findByTestId('job-spawn-folder')) as HTMLSelectElement;
    await waitFor(() => {
      expect(sel.querySelectorAll('optgroup')).toHaveLength(2);
    });
    // The SAME path under two machines is two distinct choices.
    expect([...sel.options].filter((o) => o.textContent === '/shared/path')).toHaveLength(2);
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'host-carrying' } });
    await choosePickerFolder('d2', '/shared/path');
    expect(screen.getByTestId('job-spawn-host')).toHaveTextContent('d2');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as { action: { daemonId: string; folder: string } };
    expect(body.action.daemonId).toBe('d2');
    expect(body.action.folder).toBe('/shared/path');
  });

  // Task 2: "Loading… - view scheduled job stuck on loading for too long"
  // Fix: pre-seed the job from the ['jobs'] list cache as initialData so the
  // edit form renders immediately without waiting for GET /api/jobs/:id.
  it('edit route: pre-seeded list cache avoids a "Loading…" round-trip (Task 2)', async () => {
    const job = {
      id: 'j_test1',
      name: 'cached-job',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/Users/tom/projects/portfolio',
        skill: 'why',
      },
      createdAt: 1,
      updatedAt: 1,
    };

    // Create the QueryClient, pre-seed ['jobs'] cache, then render.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['jobs'], { jobs: [job] });

    // Stub fetch — it should NOT be needed for the initial form render when
    // the cache is warm, but we supply it to satisfy background refetches.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes(`/api/jobs/${job.id}`)) return jsonResponse(job);
        return defaultRoute(url);
      }),
    );

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/jobs/j_test1']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobEditorRoute />} />
            <Route path="/jobs" element={<div data-testid="jobs-list" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The form should render at once (no "Loading…" spinner) because the cache
    // provides initialData and isLoading stays false.
    const nameInput = screen.getByTestId('job-name') as HTMLInputElement;
    expect(nameInput.value).toBe('cached-job');
    // No "Loading…" text in the document.
    expect(document.body.textContent).not.toMatch(/loading…/i);
  });

  // Task 3: "schedule cron should support complex time like ev 5 mins between 9-5"
  // The naturalCron parser already handles this — the test pins the UI path:
  // typing a windowed interval phrase computes the correct cron expression.
  it('NL schedule: "every 5 minutes between 9am and 5pm" produces windowed cron (Task 3)', () => {
    renderNew();
    fireEvent.change(screen.getByTestId('job-schedule-nl'), {
      target: { value: 'every 5 minutes between 9am and 5pm' },
    });
    // */5 9-17 * * * — every 5 minutes confined to 9 AM–5 PM (inclusive of 17).
    expect(screen.getByTestId('job-cron-value')).toHaveTextContent('*/5 9-17 * * *');
    expect(screen.getByTestId('job-cron-computed')).toHaveTextContent(
      /every 5 minutes between 9am and 5pm/i,
    );
  });

  it('NL schedule: "every 15 minutes from 8am to 6pm on weekdays" produces windowed weekday cron (Task 3)', () => {
    renderNew();
    fireEvent.change(screen.getByTestId('job-schedule-nl'), {
      target: { value: 'every 15 minutes from 8am to 6pm on weekdays' },
    });
    expect(screen.getByTestId('job-cron-value')).toHaveTextContent('*/15 8-18 * * 1-5');
    expect(screen.getByTestId('job-cron-computed')).toHaveTextContent(
      /every 15 minutes between 8am and 6pm on weekdays/i,
    );
  });

  it('NL schedule: "every hour between 9am and 5pm" produces hourly windowed cron (Task 3)', () => {
    renderNew();
    fireEvent.change(screen.getByTestId('job-schedule-nl'), {
      target: { value: 'every hour between 9am and 5pm' },
    });
    expect(screen.getByTestId('job-cron-value')).toHaveTextContent('0 9-17 * * *');
    expect(screen.getByTestId('job-cron-computed')).toHaveTextContent(
      /every hour between 9am and 5pm/i,
    );
  });

  // `script` has no chat, so no skill/prompt fields render for it — Command is
  // its payload. Reported 11 Sep 2026: Save on a `script` job always refused
  // with "Add a Skill or a Prompt", even with Command filled in, because the
  // skill|prompt check ran against `script` too (both always empty for it).
  describe('script action: save needs Command, not Skill/Prompt', () => {
    it('saves with only a command, no skill/prompt error', async () => {
      const calls: Array<{ body: unknown }> = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      });
      vi.stubGlobal('fetch', fetchMock);
      renderNew();
      fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'script job' } });
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'script' } });
      fireEvent.change(screen.getByTestId('job-script-daemon'), { target: { value: 'd1' } });
      fireEvent.change(screen.getByTestId('job-script-folder'), {
        target: { value: '/home/x' },
      });
      // Monaco is lazy — the field arrives a tick after `script` is chosen.
      fireEvent.change(await screen.findByTestId('job-script-command'), {
        target: { value: './tick.sh' },
      });
      fireEvent.click(screen.getByTestId('job-save'));
      await waitFor(() => expect(screen.getByTestId('jobs-list')).toBeInTheDocument());
      expect(calls.length).toBe(1);
      const body = calls[0]?.body as { action: { type: string; command: string } };
      expect(body.action.type).toBe('script');
      expect(body.action.command).toBe('./tick.sh');
      vi.unstubAllGlobals();
    });
  });

  // "link to the skill from the job page so easy to edit" — the job page names
  // the skill it runs, so changing what the job DOES should not mean leaving
  // Patch to find a SKILL.md by hand (spec/14 § Jobs view).
  describe('Edit link beside the chosen skill', () => {
    const SEED = '/Users/tom/projects/portfolio';

    /** Skills response naming where each skill is defined, as a real host does. */
    function skillsRoute(body: unknown) {
      return vi.fn(async (url: string) => {
        if (String(url).includes('/api/skills')) return jsonResponse(body);
        return defaultRoute(String(url));
      });
    }

    async function chooseSkill(name: string): Promise<HTMLSelectElement> {
      const sel = (await screen.findByTestId('job-spawn-skill')) as HTMLSelectElement;
      await waitFor(() => {
        expect([...sel.options].some((o) => o.value === name)).toBe(true);
      });
      fireEvent.change(sel, { target: { value: name } });
      return sel;
    }

    it('opens the skill’s own file in the browser, rooted at a chat in the same folder', async () => {
      vi.stubGlobal(
        'fetch',
        skillsRoute({
          skills: ['plant'],
          paths: { plant: `${SEED}/.claude/skills/plant/SKILL.md` },
        }),
      );
      renderNew();
      await chooseSkill('plant');
      fireEvent.click(await screen.findByTestId('job-spawn-skill-edit'));
      // The rail renders whichever chat is active, so the chat sharing the
      // action's (host, folder) becomes active and the path is relative to it.
      expect(useChatStore.getState().activeChatId).toBe('c_seed');
      // …and the file opened as its own tab, ready to edit.
      expect(
        useLayoutStore
          .getState()
          .findTab({ kind: 'file', chatId: 'c_seed', path: '.claude/skills/plant/SKILL.md' }),
      ).not.toBeNull();
    });

    it('offers no link at all until a skill is chosen', async () => {
      vi.stubGlobal(
        'fetch',
        skillsRoute({
          skills: ['plant'],
          paths: { plant: `${SEED}/.claude/skills/plant/SKILL.md` },
        }),
      );
      renderNew();
      await screen.findByTestId('job-spawn-skill');
      expect(screen.queryByTestId('job-spawn-skill-edit')).toBeNull();
      expect(screen.queryByTestId('job-spawn-skill-edit-unavailable')).toBeNull();
    });

    it('says why instead of guessing when the host reports no skill files (older host)', async () => {
      // `paths` is optional on the wire because a host OTAs its host
      // separately and may be many versions behind. NO FALLBACK: the path is
      // never reconstructed from the skill's name.
      vi.stubGlobal('fetch', skillsRoute({ skills: ['plant'] }));
      renderNew();
      await chooseSkill('plant');
      expect(screen.queryByTestId('job-spawn-skill-edit')).toBeNull();
      expect(await screen.findByTestId('job-spawn-skill-edit-unavailable')).toHaveTextContent(
        /does not report skill files/i,
      );
    });

    it('says why instead of linking when the skill lives outside the job’s folder', async () => {
      // A machine-wide `~/.claude/skills` skill is reachable by the agent but
      // not by the file browser, which is rooted at the chat's folder.
      vi.stubGlobal(
        'fetch',
        skillsRoute({ skills: ['plant'], paths: { plant: '/Users/tom/.claude/skills/plant.md' } }),
      );
      renderNew();
      await chooseSkill('plant');
      expect(screen.queryByTestId('job-spawn-skill-edit')).toBeNull();
      expect(await screen.findByTestId('job-spawn-skill-edit-unavailable')).toHaveTextContent(
        /outside this folder/i,
      );
    });

    it('says why instead of linking when no chat sits on the action’s (host, folder)', async () => {
      // The only chat is on another machine, so its folder root is a different
      // filesystem — opening the path through it would read the wrong file.
      useChatStore.setState({
        chats: { c_other: { ...makeChatRow('c_other', SEED), daemonId: 'd2' } },
      });
      vi.stubGlobal(
        'fetch',
        skillsRoute({
          skills: ['plant'],
          paths: { plant: `${SEED}/.claude/skills/plant/SKILL.md` },
        }),
      );
      renderNew();
      await choosePickerFolder('d1', SEED);
      await chooseSkill('plant');
      expect(screen.queryByTestId('job-spawn-skill-edit')).toBeNull();
      expect(await screen.findByTestId('job-spawn-skill-edit-unavailable')).toHaveTextContent(
        /no chat in this folder/i,
      );
    });

    it('links a flat `<name>.md` skill as well as a SKILL.md directory', async () => {
      vi.stubGlobal(
        'fetch',
        skillsRoute({ skills: ['plant'], paths: { plant: `${SEED}/.claude/skills/plant.md` } }),
      );
      renderNew();
      await chooseSkill('plant');
      fireEvent.click(await screen.findByTestId('job-spawn-skill-edit'));
      expect(
        useLayoutStore
          .getState()
          .findTab({ kind: 'file', chatId: 'c_seed', path: '.claude/skills/plant.md' }),
      ).not.toBeNull();
    });

    it('links the recipient chat’s skill for a message action', async () => {
      useChatStore.setState({
        chats: { c_msg: makeChatRow('c_msg', '/tmp/msgfolder', 'Msg') },
      });
      vi.stubGlobal(
        'fetch',
        skillsRoute({
          skills: ['plant'],
          paths: { plant: '/tmp/msgfolder/.claude/skills/plant/SKILL.md' },
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
      fireEvent.change(await screen.findByTestId('job-message-chat'), {
        target: { value: 'c_msg' },
      });
      const sel = (await screen.findByTestId('job-message-skill')) as HTMLSelectElement;
      await waitFor(() => {
        expect([...sel.options].some((o) => o.value === 'plant')).toBe(true);
      });
      fireEvent.change(sel, { target: { value: 'plant' } });
      fireEvent.click(await screen.findByTestId('job-message-skill-edit'));
      expect(
        useLayoutStore
          .getState()
          .findTab({ kind: 'file', chatId: 'c_msg', path: '.claude/skills/plant/SKILL.md' }),
      ).not.toBeNull();
    });
  });

  // A job prompt is usually several paragraphs of instructions (spec/14 § Jobs
  // view — Prompt). A bare <textarea> defaults to two rows, which is a slot to
  // squint through rather than a box to write in. The rendered height itself is
  // CSS, so it is proven in the browser (e2e/job-prompt-box.spec.ts); what the
  // markup has to carry is the row count and the class that CSS hangs off.
  describe('Prompt box is sized for a real prompt', () => {
    it('spawn: the Prompt textarea opens many rows tall, not the 2-row default', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => defaultRoute(String(url))),
      );
      renderNew();
      const prompt = screen.getByTestId('job-spawn-prompt') as HTMLTextAreaElement;
      expect(prompt.tagName).toBe('TEXTAREA');
      expect(prompt.rows).toBeGreaterThanOrEqual(10);
      expect(prompt.classList.contains('job-prompt')).toBe(true);
    });

    it('message: the Prompt textarea is sized the same as the spawn one', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => defaultRoute(String(url))),
      );
      renderNew();
      const spawn = screen.getByTestId('job-spawn-prompt') as HTMLTextAreaElement;
      fireEvent.change(screen.getByTestId('job-action-type'), { target: { value: 'message' } });
      const message = screen.getByTestId('job-message-prompt') as HTMLTextAreaElement;
      expect(message.rows).toBe(spawn.rows);
      expect(message.classList.contains('job-prompt')).toBe(true);
    });

    it('the JSONata filter box is left alone — only the Prompt grew', () => {
      // The filter is a one-line expression the agent wrote; it is inspected far
      // more often than it is edited, and giving it a prompt-sized box would
      // push the Action group off the screen for nothing.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => defaultRoute(String(url))),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'webhook' } });
      const filter = screen.getByTestId('job-filter') as HTMLTextAreaElement;
      expect(filter.rows).toBe(3);
      expect(filter.classList.contains('job-prompt')).toBe(false);
    });
  });
});

describe('JobEditorRoute — end condition (spec/08 § One-off jobs)', () => {
  // Before this, the editor said nothing about `oneOff`/`expiredAt` anywhere
  // on the page — a one-off job and an ordinary recurring one looked
  // identical here, even though the Jobs list already groups them apart and
  // disables the row's Toggle once expired (Patch Updates — "patch cant see
  // end condition in job ui").
  it('shows a One-off chip for a job that has not fired yet', async () => {
    const job = {
      id: 'j_test1',
      name: 'retire-me',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      oneOff: true,
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
        if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    expect(await screen.findByTestId('job-editor-oneoff')).toHaveTextContent('One-off');
    expect(screen.queryByTestId('job-editor-expired')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('shows an Expired chip for a one-off job that has already retired', async () => {
    const job = {
      id: 'j_test1',
      name: 'already-fired',
      enabled: false,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      oneOff: true,
      expiredAt: 1_700_000_000_000,
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
        if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    expect(await screen.findByTestId('job-editor-expired')).toHaveTextContent('Expired');
    expect(await screen.findByTestId('job-editor-oneoff')).toHaveTextContent('One-off');
    vi.unstubAllGlobals();
  });

  it('shows neither chip for an ordinary recurring job', async () => {
    const job = {
      id: 'j_test1',
      name: 'recurring',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
        if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    expect(screen.queryByTestId('job-editor-oneoff')).toBeNull();
    expect(screen.queryByTestId('job-editor-expired')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('shows neither chip while creating a new job', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    expect(screen.queryByTestId('job-editor-oneoff')).toBeNull();
    expect(screen.queryByTestId('job-editor-expired')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('resolveSkillLink', () => {
  const CHATS = [{ chatId: 'c1', folder: '/p', daemonId: 'd1' }];
  const base = { daemonId: 'd1', folder: '/p', chats: CHATS };

  it('is silent (not an explanation) when no skill is chosen', () => {
    expect(resolveSkillLink({ ...base, skill: '', paths: { a: '/p/a.md' } })).toBeNull();
  });

  it('does not treat a sibling folder with a shared prefix as inside the folder', () => {
    // `/project-other` starts with `/project` as a STRING but is a different
    // directory — a prefix test without the separator would link into it.
    expect(
      resolveSkillLink({
        daemonId: 'd1',
        folder: '/project',
        chats: [{ chatId: 'c1', folder: '/project', daemonId: 'd1' }],
        skill: 'a',
        paths: { a: '/project-other/.claude/skills/a.md' },
      }),
    ).toEqual({ reason: 'skill lives outside this folder' });
  });

  it('picks the chat on the SAME host when two chats share a folder path', () => {
    // The same path exists on two machines; only the action's own host can
    // open the file the job actually runs.
    expect(
      resolveSkillLink({
        ...base,
        daemonId: 'd2',
        chats: [
          { chatId: 'c1', folder: '/p', daemonId: 'd1' },
          { chatId: 'c2', folder: '/p', daemonId: 'd2' },
        ],
        skill: 'a',
        paths: { a: '/p/a.md' },
      }),
    ).toEqual({ chatId: 'c2', path: 'a.md', name: 'a.md' });
  });

  // Todoist 6hfrrmrhG6GM3V36 — `paths` undefined (an old host with no
  // `paths` field at all) and `paths` present but missing one skill's key (a
  // machine-level skill, e.g. chrome-cdp, genuinely absent from THIS host's
  // fetch) were conflated into the same "host does not report skill files"
  // message, which read as the host being incapable even when it answered
  // fine for every other skill.
  it('distinguishes an old host (no paths at all) from a skill missing on this host', () => {
    expect(resolveSkillLink({ ...base, skill: 'chrome-cdp', paths: undefined })).toEqual({
      reason: 'host does not report skill files',
    });
    // `plant` resolves fine from the SAME `paths` map that has no `chrome-cdp`
    // key — proving the fetch succeeded and this one skill simply isn't on
    // this host, not that the host can't answer at all.
    const paths = { plant: '/p/.claude/skills/plant/SKILL.md' };
    expect(resolveSkillLink({ ...base, skill: 'chrome-cdp', paths })).toEqual({
      reason: 'skill not found on this host',
    });
    expect(resolveSkillLink({ ...base, skill: 'plant', paths })).toEqual({
      chatId: 'c1',
      path: '.claude/skills/plant/SKILL.md',
      name: 'SKILL.md',
    });
  });
});

// Recent-folder selection rule on the job editor (spec/04 § Folders,
// spec/14 § Jobs view). The editor's folder select and its MRU seed both read
// from chat history, so patch's own `threads/{manager,speakers}`
// working dirs were offered as projects — and, because a special thread is
// usually the most recently updated chat on the account, the seed CHOSE one.
describe('buildFolderGroups — excludes patch’s own thread folders', () => {
  const HOSTS = { d1: 'alpha' };

  it('drops a special thread’s folder learnt from chat history', () => {
    const groups = buildFolderGroups({
      registry: [],
      chats: [
        { chatId: 'thread_manager', folder: '/home/tom/.patch/threads/manager', daemonId: 'd1' },
        { chatId: 'thread_speakers', folder: '/home/tom/.patch/threads/speakers', daemonId: 'd1' },
        { chatId: 'c1', folder: '/home/tom/projects/alpha', daemonId: 'd1' },
      ],
      hostNames: HOSTS,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.folders).toEqual(['/home/tom/projects/alpha']);
  });

  // The chatId and the path test are independent (spec/04 § Folders). An
  // ordinary chat that happens to sit in a thread dir, or in scratch, is caught
  // by path alone.
  it('drops a thread dir and other junk paths reached from an ordinary chat', () => {
    const groups = buildFolderGroups({
      registry: [],
      chats: [
        { chatId: 'c1', folder: '/daemon-home/threads/manager', daemonId: 'd1' },
        { chatId: 'c2', folder: '/tmp/scratch', daemonId: 'd1' },
        { chatId: 'c3', folder: '/home/tom/projects/alpha', daemonId: 'd1' },
      ],
      hostNames: HOSTS,
    });
    expect(groups[0]?.folders).toEqual(['/home/tom/projects/alpha']);
  });

  it('filters a host’s published recent list but never its configured roots', () => {
    const groups = buildFolderGroups({
      registry: [
        {
          daemonId: 'd1',
          // A root deliberately placed in scratch is a user designation and
          // survives (spec/04 § Folders).
          roots: ['/tmp/work'],
          recent: ['/daemon-home/threads/speakers', '/home/tom/projects/alpha'],
        },
      ],
      chats: [],
      hostNames: HOSTS,
    });
    expect(groups[0]?.folders).toEqual(['/tmp/work', '/home/tom/projects/alpha']);
  });

  it('keeps a host group with no offerable folder at all', () => {
    // The group still has to exist — its Custom path… option is the only way
    // to aim a job at a machine patch has never been used on.
    const groups = buildFolderGroups({
      registry: [{ daemonId: 'd1', roots: [], recent: [] }],
      chats: [
        { chatId: 'thread_manager', folder: '/home/tom/.patch/threads/manager', daemonId: 'd1' },
      ],
      hostNames: HOSTS,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.folders).toEqual([]);
  });
});

describe('mostRecentPair — the seed a new job starts from', () => {
  it('skips a special thread even when it is the most recent chat of all', () => {
    expect(
      mostRecentPair([
        {
          chatId: 'thread_manager',
          folder: '/home/tom/.patch/threads/manager',
          daemonId: 'd1',
          lastUpdated: 9000,
        },
        { chatId: 'older', folder: '/home/tom/projects/alpha', daemonId: 'd1', lastUpdated: 100 },
        { chatId: 'newest', folder: '/home/tom/projects/bravo', daemonId: 'd1', lastUpdated: 200 },
      ]),
    ).toEqual({ folder: '/home/tom/projects/bravo', daemonId: 'd1' });
  });

  it('skips a junk path reached from an ordinary chat', () => {
    expect(
      mostRecentPair([
        { chatId: 'c1', folder: '/daemon-home/threads/speakers', daemonId: 'd1', lastUpdated: 900 },
        { chatId: 'c2', folder: '/tmp/scratch', daemonId: 'd1', lastUpdated: 800 },
        { chatId: 'c3', folder: '/home/tom/projects/alpha', daemonId: 'd1', lastUpdated: 100 },
      ]),
    ).toEqual({ folder: '/home/tom/projects/alpha', daemonId: 'd1' });
  });

  // NO FALLBACK: with nothing but thread folders to learn from there is no
  // pair, so the editor stays on "Select a host and folder…" and save refuses.
  // Seeding a thread folder, or the folder without its host, would both be
  // worse than an empty field.
  it('returns null rather than settling for a thread folder', () => {
    expect(
      mostRecentPair([
        {
          chatId: 'thread_manager',
          folder: '/home/tom/.patch/threads/manager',
          daemonId: 'd1',
          lastUpdated: 9000,
        },
      ]),
    ).toBeNull();
  });
});

// spec/08 § Recurrence — the structured builder, the raw RRULE fallback, and
// the natural-language translate path. Self-contained (own beforeEach) rather
// than nested in the main describe above, since it needs the same host/chat
// seeding but exercises a different trigger type end to end.
describe('JobEditorRoute — recurrence trigger', () => {
  beforeEach(() => {
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
    useUiStore.getState().clearToasts();
    useUiStore.getState().resolveConfirm(false);
    useChatStore.setState({
      chats: { c_seed: makeChatRow('c_seed', '/Users/tom/projects/portfolio') },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides the Filter group for a recurrence trigger, same as cron', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'recurrence' } });
    expect(screen.queryByTestId('group-filter')).toBeNull();
  });

  it('builds "every 3rd Sunday, May through August at 9am" from the structured controls', async () => {
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'summer sunday' } });
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'recurrence' } });
    fireEvent.change(screen.getByTestId('job-recurrence-frequency'), {
      target: { value: 'MONTHLY' },
    });
    // Weekday chip picker: pick Sunday.
    fireEvent.click(screen.getByRole('button', { name: 'Sun' }));
    fireEvent.change(screen.getByTestId('job-recurrence-nth'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'May' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jun' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jul' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aug' }));
    expect(screen.getByTestId('job-recurrence-value')).toHaveTextContent(
      'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
    );
    expect(screen.getByTestId('job-recurrence-computed')).toHaveTextContent(
      'every 3rd Sunday, May through August at 9am',
    );
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]?.body as {
      trigger: { type: string; rrule: string; timezone: string };
    };
    expect(body.trigger.type).toBe('recurrence');
    expect(body.trigger.rrule).toBe(
      'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
    );
    expect(typeof body.trigger.timezone).toBe('string');
    expect(body.trigger.timezone.length).toBeGreaterThan(0);
  });

  it('WEEKLY keeps the weekday picker a multi-select; MONTHLY/YEARLY collapse to one day', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'recurrence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }));
    expect(screen.getByTestId('job-recurrence-value')).toHaveTextContent(
      'BYDAY=SU,MO,WE', // default Sunday plus the two picked — WEEKLY is additive.
    );
    // Switching to MONTHLY collapses the multi-selection to its first day.
    fireEvent.change(screen.getByTestId('job-recurrence-frequency'), {
      target: { value: 'MONTHLY' },
    });
    expect(screen.getByTestId('job-recurrence-value')).toHaveTextContent('BYDAY=SU');
    // Picking a different day in MONTHLY mode REPLACES, not adds.
    fireEvent.click(screen.getByRole('button', { name: 'Fri' }));
    expect(screen.getByTestId('job-recurrence-value')).toHaveTextContent('BYDAY=FR');
    expect(screen.getByTestId('job-recurrence-value')).not.toHaveTextContent('BYDAY=FR,SU');
  });

  it('editing the revealed raw RRULE directly updates the field, independent of the builder', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'recurrence' } });
    fireEvent.click(screen.getByTestId('job-recurrence-edit-toggle'));
    fireEvent.change(screen.getByTestId('job-recurrence-rule'), {
      target: { value: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;COUNT=5' },
    });
    expect(screen.getByTestId('job-recurrence-rule')).toHaveValue(
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;COUNT=5',
    );
    // COUNT-bounded — describeRecurrence refuses it, so the preview falls back
    // to the raw RRULE rather than a wrong-sounding guess.
    expect(screen.getByTestId('job-recurrence-computed')).toHaveTextContent(
      /couldn.t phrase this one in English/i,
    );
  });

  it('loading an existing job backfills the structured builder from its RRULE', async () => {
    const job = {
      id: 'j_test1',
      name: 'seasonal sunday',
      enabled: true,
      trigger: {
        type: 'recurrence',
        rrule: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
        timezone: 'Europe/London',
      },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (String(url).includes('/api/jobs/j_test1')) {
          return new Response(JSON.stringify(job), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() =>
      expect((screen.getByTestId('job-recurrence-frequency') as HTMLSelectElement).value).toBe(
        'MONTHLY',
      ),
    );
    expect((screen.getByTestId('job-recurrence-nth') as HTMLSelectElement).value).toBe('3');
    expect((screen.getByTestId('job-recurrence-time') as HTMLInputElement).value).toBe('09:00');
    expect((screen.getByTestId('job-recurrence-timezone') as HTMLSelectElement).value).toBe(
      'Europe/London',
    );
    expect(screen.getByRole('button', { name: 'Sun' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('job-recurrence-computed')).toHaveTextContent(
      'every 3rd Sunday, May through August at 9am',
    );
  });

  it('auto-reveals the raw RRULE editor for an existing job whose rule falls outside the structured shape', async () => {
    const job = {
      id: 'j_test1',
      name: 'bounded',
      enabled: true,
      trigger: {
        type: 'recurrence',
        rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;COUNT=5',
        timezone: 'UTC',
      },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (String(url).includes('/api/jobs/j_test1')) {
          return new Response(JSON.stringify(job), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() =>
      expect(screen.getByTestId('job-recurrence-rule')).toHaveValue(
        'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;COUNT=5',
      ),
    );
  });

  it('Save is disabled and refuses when the raw RRULE is cleared to empty', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => defaultRoute(String(url))),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('job-trigger-type'), { target: { value: 'recurrence' } });
    fireEvent.click(screen.getByTestId('job-recurrence-edit-toggle'));
    fireEvent.change(screen.getByTestId('job-recurrence-rule'), { target: { value: '' } });
    expect(screen.getByTestId('job-save')).toBeDisabled();
  });

  describe('natural-language translate', () => {
    it('translates on explicit action, writes the confirmed rrule, and shows the confirmation', async () => {
      const translateCalls: Array<{ body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).includes('/api/jobs/recurrence/translate')) {
            translateCalls.push({ body: JSON.parse(String(init?.body)) });
            return new Response(
              JSON.stringify({
                rrule: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
                description: 'every 3rd Sunday, May through August at 9am',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-trigger-type'), {
        target: { value: 'recurrence' },
      });
      fireEvent.change(screen.getByTestId('job-recurrence-nl'), {
        target: { value: 'every 3rd Sunday between May and August' },
      });
      // Not fired on keystroke — only the explicit action below hits the network.
      expect(translateCalls.length).toBe(0);
      fireEvent.click(screen.getByTestId('job-recurrence-translate'));
      await waitFor(() => expect(translateCalls.length).toBe(1));
      expect((translateCalls[0]?.body as { phrase: string }).phrase).toBe(
        'every 3rd Sunday between May and August',
      );
      await waitFor(() =>
        expect(screen.getByTestId('job-recurrence-value')).toHaveTextContent(
          'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
        ),
      );
      expect(screen.getByTestId('job-recurrence-nl-confirm')).toHaveTextContent(
        'every 3rd Sunday, May through August at 9am',
      );
      // The raw editor auto-reveals so the translated rule is visible/editable.
      expect(screen.getByTestId('job-recurrence-rule')).toHaveValue(
        'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
      );
    });

    it("shows the server's own reason on a failed translation — never a silent guess", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('/api/jobs/recurrence/translate')) {
            return new Response(
              JSON.stringify({
                error: 'translation_failed',
                message: 'could not confidently translate that phrase into a schedule',
              }),
              { status: 422, headers: { 'content-type': 'application/json' } },
            );
          }
          return defaultRoute(String(url));
        }),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-trigger-type'), {
        target: { value: 'recurrence' },
      });
      fireEvent.change(screen.getByTestId('job-recurrence-nl'), {
        target: { value: 'sometime, whenever' },
      });
      fireEvent.click(screen.getByTestId('job-recurrence-translate'));
      await waitFor(() =>
        expect(screen.getByTestId('job-recurrence-nl-error')).toHaveTextContent(
          'could not confidently translate that phrase into a schedule',
        ),
      );
      // A failed translation must not have touched the actual rrule field.
      expect(screen.getByTestId('job-recurrence-value')).not.toHaveTextContent('sometime');
    });

    it('the Translate button is disabled with no phrase typed', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => defaultRoute(String(url))),
      );
      renderNew();
      fireEvent.change(screen.getByTestId('job-trigger-type'), {
        target: { value: 'recurrence' },
      });
      expect(screen.getByTestId('job-recurrence-translate')).toBeDisabled();
    });
  });
});

describe('buildGroupOptions', () => {
  it('returns every distinct non-empty group, alphabetical, deduped', () => {
    expect(
      buildGroupOptions([
        { group: 'Home' },
        { group: 'Finance' },
        { group: '' },
        { group: undefined },
        { group: 'Home' },
      ]),
    ).toEqual(['Finance', 'Home']);
  });

  it('is empty when no job carries a group', () => {
    expect(buildGroupOptions([{ group: '' }, {}])).toEqual([]);
  });
});

// spec/08 § Groups, spec/14 § Jobs view — the organisational label, picked
// from a dropdown of groups already in use, with a "New group…" option that
// reveals free text for a name not yet seen.
describe('JobEditorRoute — group', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a new job posts its typed group', async () => {
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'watcher' } });
    fireEvent.change(screen.getByTestId('job-group'), { target: { value: '__new_group__' } });
    fireEvent.change(screen.getByTestId('job-group-custom'), { target: { value: 'Home' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { group: string }).group).toBe('Home');
  });

  it('a new job with no group typed posts an empty string, not omitted', async () => {
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'watcher' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { group: string }).group).toBe('');
  });

  it('editing a grouped job shows its stored group, and an unrelated edit keeps it', async () => {
    const job = {
      id: 'j_test1',
      name: 'grouped job',
      group: 'Finance',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (method === 'PATCH') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
        }
        if (String(url).includes('/api/jobs/j_test1')) {
          return new Response(JSON.stringify(job), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() =>
      expect((screen.getByTestId('job-group-custom') as HTMLInputElement).value).toBe('Finance'),
    );
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { group: string }).group).toBe('Finance');
  });

  it('clearing the group field on an existing job posts an empty string', async () => {
    const job = {
      id: 'j_test1',
      name: 'grouped job',
      group: 'Finance',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (String(url).includes('/runs')) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (method === 'PATCH') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
        }
        if (String(url).includes('/api/jobs/j_test1')) {
          return new Response(JSON.stringify(job), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await waitFor(() =>
      expect((screen.getByTestId('job-group-custom') as HTMLInputElement).value).toBe('Finance'),
    );
    fireEvent.change(screen.getByTestId('job-group'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { group: string }).group).toBe('');
  });

  it('offers every distinct group already in use across jobs as a dropdown option', async () => {
    const jobsList = {
      jobs: [
        { id: 'j_a', group: 'Finance' },
        { id: 'j_b', group: 'Home' },
        { id: 'j_c', group: '' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url) === '/api/jobs') return jsonResponse(jobsList);
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    const select = (await screen.findByTestId('job-group')) as HTMLSelectElement;
    await waitFor(() => {
      expect([...select.options].map((o) => o.value)).toEqual([
        '',
        'Finance',
        'Home',
        '__new_group__',
      ]);
    });
    // Picking an existing option needs no free-text field at all.
    fireEvent.change(select, { target: { value: 'Finance' } });
    expect(screen.queryByTestId('job-group-custom')).toBeNull();
  });
});

describe('JobEditorRoute — autonomy prompt', () => {
  afterEach(() => vi.unstubAllGlobals());

  const DEFAULT_PROMPT = "You are running autonomously, don't stop to ask the user questions";

  it('the section is a collapsed Advanced area on a new job', async () => {
    renderNew();
    await screen.findByTestId('job-name');
    const group = screen.getByTestId('group-autonomy-prompt') as HTMLDetailsElement;
    expect(group.open).toBe(false);
    expect(screen.getByTestId('job-advanced-toggle')).toHaveTextContent('Advanced');
  });

  it('an uncustomised job shows the ACCOUNT prompt from Settings, read-only', async () => {
    usePreferencesStore.setState({
      preferences: {
        ...usePreferencesStore.getState().preferences,
        jobAutonomyPrompt: 'House rule.',
      },
    });
    try {
      renderNew();
      await screen.findByTestId('job-name');
      const box = screen.getByTestId('job-autonomy-prompt-text') as HTMLTextAreaElement;
      expect(box.value).toBe('House rule.');
      expect(box).toBeDisabled();
      fireEvent.click(screen.getByTestId('job-autonomy-prompt-custom'));
      expect(box.value).toBe('House rule.');
      expect(box).not.toBeDisabled();
    } finally {
      usePreferencesStore.setState({
        preferences: {
          ...usePreferencesStore.getState().preferences,
          jobAutonomyPrompt: DEFAULT_PROMPT,
        },
      });
    }
  });

  it('a job that already has an override opens Advanced so the override is not hidden', async () => {
    const job = {
      id: 'j_test1',
      name: 'quiet job',
      autonomyPrompt: 'Be quick.',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
        if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() =>
      expect((screen.getByTestId('group-autonomy-prompt') as HTMLDetailsElement).open).toBe(true),
    );
  });

  it('a new job shows the default prompt, unticked and read-only', async () => {
    renderNew();
    await screen.findByTestId('job-name');
    expect(screen.getByTestId('job-autonomy-prompt-custom')).not.toBeChecked();
    const box = screen.getByTestId('job-autonomy-prompt-text') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT_PROMPT);
    expect(box).toBeDisabled();
  });

  it('left as default, a new job posts null — the explicit clear-to-default, not an omitted key', async () => {
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'watcher' } });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { autonomyPrompt: unknown }).autonomyPrompt).toBeNull();
  });

  it('ticking Customise unlocks the box, seeded from the default text', async () => {
    renderNew();
    await screen.findByTestId('job-name');
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-custom'));
    const box = screen.getByTestId('job-autonomy-prompt-text') as HTMLTextAreaElement;
    expect(box).not.toBeDisabled();
    expect(box.value).toBe(DEFAULT_PROMPT);
  });

  it('customising and editing the prompt posts the typed text', async () => {
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/jobs') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 'j_new' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return defaultRoute(String(url));
      }),
    );
    renderNew();
    fireEvent.change(screen.getByTestId('job-name'), { target: { value: 'watcher' } });
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-custom'));
    fireEvent.change(screen.getByTestId('job-autonomy-prompt-text'), {
      target: { value: 'Just get on with it.' },
    });
    await choosePickerFolder('d1', '/Users/tom/projects/portfolio');
    fireEvent.change(screen.getByTestId('job-spawn-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { autonomyPrompt: string }).autonomyPrompt).toBe(
      'Just get on with it.',
    );
  });

  it('editing a job with a stored override shows it ticked, pre-filled with that text', async () => {
    const job = {
      id: 'j_test1',
      name: 'quiet job',
      autonomyPrompt: 'Be quick.',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
        if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() => expect(screen.getByTestId('job-autonomy-prompt-custom')).toBeChecked());
    const box = screen.getByTestId('job-autonomy-prompt-text') as HTMLTextAreaElement;
    expect(box.value).toBe('Be quick.');
    expect(box).not.toBeDisabled();
  });

  it('un-ticking Customise on a stored override posts null, clearing it back to default', async () => {
    const job = {
      id: 'j_test1',
      name: 'quiet job',
      autonomyPrompt: 'Be quick.',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (String(url).includes('/runs')) return jsonResponse({ runs: [] });
        if (method === 'PATCH') {
          calls.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ...job, updatedAt: 2 }), { status: 200 });
        }
        if (String(url).includes('/api/jobs/j_test1')) return jsonResponse(job);
        return defaultRoute(String(url));
      }),
    );
    renderEdit();
    await screen.findByTestId('job-name');
    await waitFor(() => expect(screen.getByTestId('job-autonomy-prompt-custom')).toBeChecked());
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-custom'));
    fireEvent.click(screen.getByTestId('job-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]?.body as { autonomyPrompt: unknown }).autonomyPrompt).toBeNull();
  });
});
