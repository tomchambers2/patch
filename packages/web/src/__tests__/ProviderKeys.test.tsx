// Settings → Keys → Provider keys (spec/02 § Provider keys, spec/01 § Settings).
//
// The keys are shared settings: held on the server, sent to every host. A row
// states whether a key is set, with its last four characters — never the value
// — and a key only some hosts' environments supply names those hosts and can
// be adopted as the shared one. Every change is a server write and settles on
// its answer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeysPage } from '../routes/settings/KeysPage.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api, ApiError } from '../api/rest.js';
import { reportHost, clearHosts } from './presenceHelpers.js';
import { loadShared, resetShared, sharedState } from './sharedHelpers.js';

function renderSection(): void {
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

const KEYS = {
  providerKeys: [
    { id: 'gemini' as const, set: true, last4: 'WXYZ' },
    { id: 'openai' as const, set: false },
    { id: 'groq' as const, set: false },
  ],
};

describe('Settings → Keys → Provider keys', () => {
  beforeEach(() => {
    clearHosts();
    resetShared();
    useUiStore.getState().clearToasts();
    useUiStore.getState().resolveConfirm(false);
    usePresenceStore.getState().setConnection('connected');
    // The Secrets group on the same page reads /api/secrets; keep it quiet.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ secrets: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says it is loading until the shared settings arrive', () => {
    renderSection();
    expect(screen.getByTestId('providers-keys-loading')).toBeInTheDocument();
  });

  it('lists every key with whether it is set and its last four, never the value', () => {
    loadShared({ secrets: KEYS });
    renderSection();
    expect(screen.getByTestId('provider-key-gemini-status')).toHaveTextContent('Set · ends WXYZ');
    expect(screen.getByTestId('provider-key-openai-status')).toHaveTextContent('Not set');
    expect(screen.getByTestId('provider-key-gemini-revoke')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-key-openai-revoke')).toBeNull();
    expect(screen.getByTestId('provider-key-gemini-edit')).toHaveTextContent('Replace');
    expect(screen.getByTestId('provider-key-openai-edit')).toHaveTextContent('Add');
  });

  it('names the hosts whose environment supplies a key the account has not set, and adopts it', async () => {
    loadShared({ secrets: KEYS });
    reportHost('host-a', {
      hostName: 'hetzner',
      providerKeys: [{ id: 'groq', source: 'env', last4: '1234', envSet: true }],
    });
    usePresenceStore.getState().setHostOnline('host-a', true);
    const adopted = sharedState({
      version: 2,
      secrets: {
        providerKeys: [...KEYS.providerKeys.slice(0, 2), { id: 'groq', set: true, last4: '1234' }],
      },
    });
    const adopt = vi.spyOn(api, 'adoptProviderKey').mockResolvedValue(adopted);
    renderSection();
    expect(screen.getByTestId('provider-key-groq-status')).toHaveTextContent(
      'From the environment on hetzner',
    );
    fireEvent.click(screen.getByTestId('provider-key-groq-adopt'));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith('groq', 'host-a'));
    await waitFor(() =>
      expect(screen.getByTestId('provider-key-groq-status')).toHaveTextContent('Set · ends 1234'),
    );
  });

  it('Add sends the value in a password field and settles on the server’s answer', async () => {
    loadShared({ secrets: KEYS });
    const next = sharedState({
      version: 2,
      secrets: {
        providerKeys: [
          KEYS.providerKeys[0]!,
          { id: 'openai', set: true, last4: '0000' },
          KEYS.providerKeys[2]!,
        ],
      },
    });
    const set = vi.spyOn(api, 'setProviderKey').mockResolvedValue(next);
    renderSection();
    fireEvent.click(screen.getByTestId('provider-key-openai-edit'));
    const input = screen.getByTestId('provider-key-openai-input');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'sk-fake-test-key-000000000000' } });
    fireEvent.click(screen.getByTestId('provider-key-openai-save'));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith('openai', 'sk-fake-test-key-000000000000'),
    );
    await waitFor(() => expect(screen.queryByTestId('provider-key-openai-input')).toBeNull());
    expect(screen.getByTestId('provider-key-openai-status')).toHaveTextContent('Set · ends 0000');
    expect(usePreferencesStore.getState().shared?.version).toBe(2);
  });

  it('Cancel closes the field without sending anything', () => {
    loadShared({ secrets: KEYS });
    const set = vi.spyOn(api, 'setProviderKey');
    renderSection();
    fireEvent.click(screen.getByTestId('provider-key-openai-edit'));
    fireEvent.change(screen.getByTestId('provider-key-openai-input'), {
      target: { value: 'sk-fake-test-key-000000000000' },
    });
    fireEvent.click(screen.getByTestId('provider-key-openai-cancel'));
    expect(screen.queryByTestId('provider-key-openai-input')).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it('a refusal shows the server’s own sentence and keeps the field open', async () => {
    loadShared({ secrets: KEYS });
    vi.spyOn(api, 'setProviderKey').mockRejectedValue(
      new ApiError(400, 'invalid_value', {
        error: 'invalid_value',
        message: 'A key must be at least 16 characters with no whitespace',
      }),
    );
    renderSection();
    fireEvent.click(screen.getByTestId('provider-key-openai-edit'));
    fireEvent.change(screen.getByTestId('provider-key-openai-input'), {
      target: { value: 'short' },
    });
    fireEvent.click(screen.getByTestId('provider-key-openai-save'));
    await waitFor(() =>
      expect(
        useUiStore.getState().errors.some((e) => e.message.includes('at least 16 characters')),
      ).toBe(true),
    );
    expect(screen.getByTestId('provider-key-openai-input')).toBeInTheDocument();
  });

  it('Revoke asks first, and only then deletes', async () => {
    loadShared({ secrets: KEYS });
    const revoke = vi
      .spyOn(api, 'revokeProviderKey')
      .mockResolvedValue(sharedState({ version: 2 }));
    renderSection();
    fireEvent.click(screen.getByTestId('provider-key-gemini-revoke'));
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    expect(revoke).not.toHaveBeenCalled();
    useUiStore.getState().resolveConfirm(true);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('gemini'));
  });

  it('is disabled while this surface has no link to the server', () => {
    loadShared({ secrets: KEYS });
    usePresenceStore.getState().setConnection('reconnecting');
    renderSection();
    expect(screen.getByTestId('provider-key-openai-edit')).toBeDisabled();
    expect(screen.getByTestId('provider-key-gemini-revoke')).toBeDisabled();
  });
});
