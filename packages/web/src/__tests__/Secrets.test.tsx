// Settings → Keys → Secrets (spec/15 § Settings tab — Secrets).
//
// Key/value pairs the host injects into chats, read from and written to
// /api/secrets. Values are masked in the list and appear only in the editor; a
// write is re-read from the server rather than patched locally; a refusal or a
// silent host is said in a toast, in the host's own words.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeysPage } from '../routes/settings/KeysPage.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { setActiveWs } from '../api/ws.js';
import { useUiStore } from '../stores/uiStore.js';
import { clearHosts } from './presenceHelpers.js';

const TOKEN = 'tok-very-secret-value-1234';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A /api/secrets server holding `initial`. PUT and DELETE change what the next
 * GET returns, so a refetch is observable; `failWrite` answers writes instead.
 */
function stubSecrets(
  initial: Record<string, string>,
  opts: { failList?: Response; failWrite?: () => Response } = {},
): Call[] {
  const store = { ...initial };
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ url: u, method, body });
      if (u === '/api/secrets' && method === 'GET') {
        if (opts.failList) return opts.failList;
        return json({ secrets: Object.entries(store).map(([key, value]) => ({ key, value })) });
      }
      const m = /^\/api\/secrets\/(.+)$/.exec(u);
      if (m) {
        if (opts.failWrite) return opts.failWrite();
        const key = decodeURIComponent(m[1]!);
        if (method === 'PUT') store[key] = (body as { value: string }).value;
        if (method === 'DELETE') delete store[key];
        return json({ ok: true });
      }
      return json({ error: 'unexpected', message: `unexpected ${method} ${u}` }, 500);
    }),
  );
  return calls;
}

const gets = (calls: Call[]): number =>
  calls.filter((c) => c.url === '/api/secrets' && c.method === 'GET').length;

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/keys']}>
        <KeysPage />
        <ErrorToasts />
        <ConfirmModal />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  clearHosts();
  useSettingsHostStore.setState({ selected: null });
  useUiStore.getState().clearToasts();
  useUiStore.getState().resolveConfirm(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings → Keys → Secrets', () => {
  it('says Loading… until the list arrives', async () => {
    let release!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(json({ secrets: [{ key: 'TODOIST_TOKEN', value: TOKEN }] }));
          }),
      ),
    );
    renderPage();
    const group = screen.getByTestId('settings-secrets');
    expect(group).toHaveTextContent('Loading…');
    release();
    await screen.findByTestId('secret-TODOIST_TOKEN');
    expect(screen.getByTestId('settings-secrets')).not.toHaveTextContent('Loading…');
  });

  it('lists every secret with its value masked — never in the page', async () => {
    stubSecrets({ TODOIST_TOKEN: TOKEN, GH_TOKEN: 'ghp-another-value' });
    renderPage();
    const row = await screen.findByTestId('secret-TODOIST_TOKEN');
    expect(row).toHaveTextContent('TODOIST_TOKEN');
    expect(row).toHaveTextContent('••••••••');
    expect(screen.getByTestId('secret-GH_TOKEN')).toHaveTextContent('••••••••');
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain('ghp-another-value');
    for (const input of document.querySelectorAll('input')) {
      expect(input.value).not.toBe(TOKEN);
    }
    expect(screen.queryByTestId('secret-editor')).toBeNull();
    expect(screen.queryByTestId('secrets-empty')).toBeNull();
  });

  it('says so when there are none', async () => {
    stubSecrets({});
    renderPage();
    expect(await screen.findByTestId('secrets-empty')).toHaveTextContent('No secrets');
  });

  it('says why when the list cannot be read', async () => {
    stubSecrets(
      {},
      {
        failList: json({ error: 'daemon_offline', message: 'The host is not connected' }, 503),
      },
    );
    renderPage();
    expect(await screen.findByTestId('secrets-error')).toHaveTextContent(
      'Could not read secrets: The host is not connected',
    );
    expect(screen.queryByTestId('secrets-empty')).toBeNull();
  });

  it('falls back to the error code when the server gives no sentence', async () => {
    stubSecrets({}, { failList: json({ error: 'unauthenticated' }, 401) });
    renderPage();
    expect(await screen.findByTestId('secrets-error')).toHaveTextContent(
      'Could not read secrets: unauthenticated',
    );
  });

  it('Add opens an editor with key and value; Save PUTs, closes and re-reads', async () => {
    const calls = stubSecrets({});
    renderPage();
    await screen.findByTestId('secrets-empty');
    fireEvent.click(screen.getByTestId('secret-add'));
    const editor = screen.getByTestId('secret-editor');
    expect(editor).toBeInTheDocument();
    // The empty note gives way to the editor, and there is no second Add.
    expect(screen.queryByTestId('secrets-empty')).toBeNull();
    expect(screen.queryByTestId('secret-add')).toBeNull();
    expect(screen.queryByTestId('secret-editor-delete')).toBeNull();
    const value = screen.getByTestId('secret-editor-value') as HTMLInputElement;
    expect(value.type).toBe('password');
    fireEvent.change(screen.getByTestId('secret-editor-key'), {
      target: { value: '  NEW_KEY ' },
    });
    // Typing the key must not remount the form under the user: the value field
    // found before the key was typed is still the one on the page.
    expect(value).toBe(screen.getByTestId('secret-editor-value'));
    expect(value.isConnected).toBe(true);
    fireEvent.change(value, { target: { value: 'v4lue' } });
    const before = gets(calls);
    fireEvent.click(screen.getByTestId('secret-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('secret-editor')).toBeNull());
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toEqual({ url: '/api/secrets/NEW_KEY', method: 'PUT', body: { value: 'v4lue' } });
    await screen.findByTestId('secret-NEW_KEY');
    expect(gets(calls)).toBeGreaterThan(before);
    expect(screen.getByTestId('secret-add')).toBeInTheDocument();
  });

  it('will not save a secret with a blank key', async () => {
    const calls = stubSecrets({});
    renderPage();
    await screen.findByTestId('secrets-empty');
    fireEvent.click(screen.getByTestId('secret-add'));
    expect(screen.getByTestId('secret-editor-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('secret-editor-key'), { target: { value: '   ' } });
    fireEvent.change(screen.getByTestId('secret-editor-value'), { target: { value: 'x' } });
    expect(screen.getByTestId('secret-editor-save')).toBeDisabled();
    // Enter in the field submits the form: still nothing is sent.
    fireEvent.submit(screen.getByTestId('secret-editor'));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.change(screen.getByTestId('secret-editor-key'), { target: { value: 'K' } });
    expect(screen.getByTestId('secret-editor-save')).toBeEnabled();
  });

  it('encodes a key in the URL', async () => {
    const calls = stubSecrets({});
    renderPage();
    await screen.findByTestId('secrets-empty');
    fireEvent.click(screen.getByTestId('secret-add'));
    fireEvent.change(screen.getByTestId('secret-editor-key'), { target: { value: 'A/B C' } });
    fireEvent.click(screen.getByTestId('secret-editor-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.url).toBe('/api/secrets/A%2FB%20C');
  });

  it('Edit shows the value in the editor, with no key field, and Save PUTs it', async () => {
    const calls = stubSecrets({ TODOIST_TOKEN: TOKEN });
    renderPage();
    fireEvent.click(await screen.findByTestId('secret-TODOIST_TOKEN-edit'));
    const editor = screen.getByTestId('secret-editor');
    expect(editor).toHaveTextContent('TODOIST_TOKEN');
    expect(screen.queryByTestId('secret-editor-key')).toBeNull();
    // The row it replaced is gone while it is being edited.
    expect(screen.queryByTestId('secret-TODOIST_TOKEN')).toBeNull();
    const value = screen.getByTestId('secret-editor-value') as HTMLInputElement;
    expect(value.type).toBe('password');
    expect(value.value).toBe(TOKEN);
    fireEvent.change(value, { target: { value: 'tok-rotated' } });
    fireEvent.click(screen.getByTestId('secret-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('secret-editor')).toBeNull());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      url: '/api/secrets/TODOIST_TOKEN',
      method: 'PUT',
      body: { value: 'tok-rotated' },
    });
    expect(await screen.findByTestId('secret-TODOIST_TOKEN')).toHaveTextContent('••••••••');
  });

  it('Delete asks first; cancelling sends nothing', async () => {
    const calls = stubSecrets({ TODOIST_TOKEN: TOKEN });
    renderPage();
    fireEvent.click(await screen.findByTestId('secret-TODOIST_TOKEN-edit'));
    fireEvent.click(screen.getByTestId('secret-editor-delete'));
    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toHaveTextContent('Delete the secret TODOIST_TOKEN? Chats stop receiving it.');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-modal')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    // Still editing.
    expect(screen.getByTestId('secret-editor')).toBeInTheDocument();
  });

  it('Delete, confirmed, DELETEs the secret and re-reads the list', async () => {
    const calls = stubSecrets({ TODOIST_TOKEN: TOKEN });
    renderPage();
    fireEvent.click(await screen.findByTestId('secret-TODOIST_TOKEN-edit'));
    fireEvent.click(screen.getByTestId('secret-editor-delete'));
    await screen.findByTestId('confirm-modal');
    const before = gets(calls);
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'DELETE')).toEqual({
        url: '/api/secrets/TODOIST_TOKEN',
        method: 'DELETE',
        body: null,
      }),
    );
    expect(await screen.findByTestId('secrets-empty')).toBeInTheDocument();
    expect(gets(calls)).toBeGreaterThan(before);
    expect(screen.queryByTestId('secret-editor')).toBeNull();
  });

  it('a failed write says what the host said, and keeps the editor open', async () => {
    stubSecrets(
      { TODOIST_TOKEN: TOKEN },
      {
        failWrite: () => json({ error: 'daemon_timeout', message: 'The host did not answer' }, 504),
      },
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('secret-TODOIST_TOKEN-edit'));
    fireEvent.change(screen.getByTestId('secret-editor-value'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('secret-editor-save'));
    await waitFor(() =>
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(
        'secret TODOIST_TOKEN: The host did not answer',
      ),
    );
    expect(screen.getByTestId('secret-editor')).toBeInTheDocument();
    expect(screen.getByTestId('secret-editor-value')).toHaveValue('x');
  });

  it('a failed delete says what the host said', async () => {
    stubSecrets(
      { TODOIST_TOKEN: TOKEN },
      { failWrite: () => json({ error: 'daemon_timeout' }, 504) },
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('secret-TODOIST_TOKEN-edit'));
    fireEvent.click(screen.getByTestId('secret-editor-delete'));
    await screen.findByTestId('confirm-modal');
    fireEvent.click(screen.getByTestId('confirm-ok'));
    // No sentence in the body: the error code is what is said.
    await waitFor(() =>
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(
        'secret TODOIST_TOKEN: daemon_timeout',
      ),
    );
  });

  it('Cancel closes the editor without writing', async () => {
    const calls = stubSecrets({ TODOIST_TOKEN: TOKEN });
    renderPage();
    fireEvent.click(await screen.findByTestId('secret-TODOIST_TOKEN-edit'));
    fireEvent.click(screen.getByTestId('secret-editor-cancel'));
    expect(screen.queryByTestId('secret-editor')).toBeNull();
    expect(screen.getByTestId('secret-TODOIST_TOKEN')).toHaveTextContent('••••••••');
    expect(document.body.textContent).not.toContain(TOKEN);

    fireEvent.click(screen.getByTestId('secret-add'));
    fireEvent.change(screen.getByTestId('secret-editor-key'), { target: { value: 'DRAFT' } });
    fireEvent.click(screen.getByTestId('secret-editor-cancel'));
    expect(screen.queryByTestId('secret-editor')).toBeNull();
    expect(screen.getByTestId('secret-add')).toBeInTheDocument();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
