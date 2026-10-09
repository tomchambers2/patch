// Settings → Hooks (spec/14 § Hooks, spec/20-hooks.md): list, add, edit,
// enable/disable, delete.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { setModelCatalog } from '../lib/models.js';
import { json, makeFetch, renderSettings, resetSettingsState } from './settingsHarness.js';

const HOOK = {
  id: 'hook_01HXYZ',
  name: 'no secrets',
  enabled: true,
  when: 'user_message',
  kind: 'script',
  script: { command: 'exit 0' },
  gate: {},
  timeoutMs: 15000,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  resetSettingsState();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Hooks', () => {
  it('shows the empty state when there are none', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/hooks')) return json({ hooks: [] });
        return null;
      }),
    );
    renderSettings('/settings/hooks');
    await waitFor(() => expect(screen.getByTestId('hooks-empty')).toHaveTextContent('No hooks'));
  });

  it('lists an existing hook with its enabled toggle', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/hooks')) return json({ hooks: [HOOK] });
        return null;
      }),
    );
    renderSettings('/settings/hooks');
    await waitFor(() => expect(screen.getByTestId('hook-hook_01HXYZ')).toBeTruthy());
    expect(screen.getByTestId('hook-hook_01HXYZ')).toHaveTextContent('no secrets');
    expect(screen.getByTestId('hook-hook_01HXYZ')).toHaveTextContent('user_message · script');
    expect(screen.getByTestId('hook-hook_01HXYZ-enabled')).toBeChecked();
  });

  it('disabling a hook POSTs to /api/hooks/:id/disable', async () => {
    const posted: string[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/hooks/hook_01HXYZ/disable')) {
          posted.push(url);
          return json({ ...HOOK, enabled: false });
        }
        if (url.includes('/api/hooks')) return json({ hooks: [HOOK] });
        return null;
      }),
    );
    renderSettings('/settings/hooks');
    await waitFor(() => expect(screen.getByTestId('hook-hook_01HXYZ-enabled')).toBeTruthy());
    fireEvent.click(screen.getByTestId('hook-hook_01HXYZ-enabled'));
    await waitFor(() => expect(posted.length).toBe(1));
  });

  it('creates a script hook from the Add form', async () => {
    let created: unknown = null;
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url, init) => {
        if (url.includes('/api/hooks') && init?.method === 'POST') {
          created = JSON.parse(String(init.body));
          return json({ ...HOOK, id: 'hook_new', ...(created as object) });
        }
        if (url.includes('/api/hooks')) return json({ hooks: [] });
        return null;
      }),
    );
    renderSettings('/settings/hooks');
    await waitFor(() => expect(screen.getByTestId('hook-add')).toBeTruthy());
    fireEvent.click(screen.getByTestId('hook-add'));
    fireEvent.change(screen.getByTestId('hook-editor-name'), {
      target: { value: 'block passwords' },
    });
    fireEvent.change(screen.getByTestId('hook-editor-command'), {
      target: { value: 'exit 0' },
    });
    fireEvent.click(screen.getByTestId('hook-editor-save'));
    await waitFor(() => expect(created).not.toBeNull());
    expect((created as { name: string }).name).toBe('block passwords');
    expect((created as { kind: string }).kind).toBe('script');
    expect((created as { script: { command: string } }).script.command).toBe('exit 0');
  });

  it('switching kind to prompt requires instructions + model before Save enables', async () => {
    setModelCatalog({
      status: 'ready',
      models: [{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }],
    });
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/hooks')) return json({ hooks: [] });
        return null;
      }),
    );
    renderSettings('/settings/hooks');
    await waitFor(() => expect(screen.getByTestId('hook-add')).toBeTruthy());
    fireEvent.click(screen.getByTestId('hook-add'));
    fireEvent.change(screen.getByTestId('hook-editor-name'), { target: { value: 'be nice' } });
    fireEvent.change(screen.getByTestId('hook-editor-kind'), { target: { value: 'prompt' } });
    expect(screen.getByTestId('hook-editor-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('hook-editor-instructions'), {
      target: { value: 'Be nice.' },
    });
    expect(screen.getByTestId('hook-editor-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('hook-editor-model'), {
      target: { value: 'claude-haiku-4-5-20251001' },
    });
    expect(screen.getByTestId('hook-editor-save')).not.toBeDisabled();
  });

  it('the prompt model, hosts, folders and chats are dropdowns, not text inputs', async () => {
    setModelCatalog({
      status: 'ready',
      models: [{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }],
    });
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/hooks')) return json({ hooks: [] });
        return null;
      }),
    );
    renderSettings('/settings/hooks');
    await waitFor(() => expect(screen.getByTestId('hook-add')).toBeTruthy());
    fireEvent.click(screen.getByTestId('hook-add'));
    fireEvent.change(screen.getByTestId('hook-editor-kind'), { target: { value: 'prompt' } });
    for (const id of ['model', 'hosts', 'folders', 'chatids']) {
      expect(screen.getByTestId(`hook-editor-${id}`).tagName).toBe('SELECT');
    }
    expect(screen.getByTestId('hook-editor-model')).toHaveTextContent('Haiku 4.5');
  });

  it('deleting a hook asks for confirmation then DELETEs it', async () => {
    let deleted = false;
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url, init) => {
        if (url.includes('/api/hooks/hook_01HXYZ') && init?.method === 'DELETE') {
          deleted = true;
          return json(undefined, 204);
        }
        if (url.includes('/api/hooks')) return json({ hooks: deleted ? [] : [HOOK] });
        return null;
      }),
    );
    renderSettings('/settings/hooks');
    await waitFor(() => expect(screen.getByTestId('hook-hook_01HXYZ-edit')).toBeTruthy());
    fireEvent.click(screen.getByTestId('hook-hook_01HXYZ-edit'));
    fireEvent.click(await screen.findByTestId('hook-hook_01HXYZ-delete'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(deleted).toBe(true));
  });
});
