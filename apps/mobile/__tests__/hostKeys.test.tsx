// Settings → Keys on mobile (design/settings-redesign; spec/02 § Provider keys,
// spec/15 § Settings tab). The account's provider keys, shared by every
// host — where each value comes from and its last four characters, never the
// value. Add/Replace takes a write-only value, Revoke asks first, an
// env-only key says why it can't be revoked here, and the row settles on the
// reporting host's next report. Then Secrets.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import {
  renderRN,
  byTestId,
  findHost,
  queryHost,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { KeysPage } from '../src/components/settings/HostsSection';
import { useSettingsStore } from '../src/stores/settingsStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { api, ApiError } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => {
  class ApiError extends Error {
    override readonly name = 'ApiError';
    constructor(
      readonly status: number,
      message: string,
      readonly body: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      setProviderKey: vi.fn(),
      revokeProviderKey: vi.fn(),
      adoptProviderKey: vi.fn(),
      listSecrets: vi.fn(),
      setSecret: vi.fn(),
    },
  };
});

const KEYS = [
  { id: 'gemini' as const, set: true, last4: 'WXYZ' },
  { id: 'openai' as const, set: false },
  { id: 'groq' as const, set: false },
];

/** The committed shared state a write answers with. */
function state(providerKeys = KEYS) {
  return {
    version: 2,
    settings: { ...DEFAULT_SHARED_SETTINGS },
    secrets: { claude: [], codex: [], providerKeys },
    hosts: [],
  };
}

const mounted: ReactTestRenderer[] = [];
async function openKeys(): Promise<ReactTestRenderer> {
  const r = renderRN(<KeysPage />);
  mounted.push(r);
  await flush(); // SecretsSection's load
  return r;
}
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

function pressAlertButton(text: string): Promise<void> {
  const button = __getLastAlert()?.buttons?.find((b) => b.text === text);
  if (!button) throw new Error(`no "${text}" button on the last alert`);
  return actAsync(() => button.onPress?.());
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearLastAlert();
  resetHosts();
  vi.mocked(api.listSecrets).mockResolvedValue({ secrets: [] });
  seedSettings({
    shared: { version: 1, secrets: { claude: [], codex: [], providerKeys: KEYS }, hosts: [] },
  });
});

describe('mobile Settings → Keys → provider keys (shared, spec/01 § Settings)', () => {
  it('lists every key: set with its last four, or not set — never the value', async () => {
    const r = await openKeys();
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Keys');
    expect(textOf(findHost(r.root, byTestId('provider-key-gemini-status')))).toBe(
      'Set · ends WXYZ',
    );
    expect(textOf(findHost(r.root, byTestId('provider-key-openai-status')))).toBe('Not set');
    expect(queryHost(r.root, byTestId('provider-key-gemini-revoke'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('provider-key-openai-revoke'))).toBeNull();
  });

  it('says it is loading until the shared settings arrive', async () => {
    useSettingsStore.getState()._reset();
    const r = await openKeys();
    expect(queryHost(r.root, byTestId('providers-keys-loading'))).not.toBeNull();
  });

  it('names the hosts whose environment has a key the account has not set, and adopts it', async () => {
    reportHost('h1', {
      hostName: 'laptop',
      providerKeys: [{ id: 'groq', source: 'env', last4: '1234', envSet: true }],
    });
    vi.mocked(api.adoptProviderKey).mockResolvedValue(
      state([KEYS[0]!, KEYS[1]!, { id: 'groq', set: true, last4: '1234' }]),
    );
    const r = await openKeys();
    expect(textOf(findHost(r.root, byTestId('provider-key-groq-status')))).toBe(
      'From the environment on laptop',
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('provider-key-groq-adopt')).props.onPress();
      await flush();
    });
    expect(api.adoptProviderKey).toHaveBeenCalledWith('groq', 'h1');
    expect(textOf(findHost(r.root, byTestId('provider-key-groq-status')))).toBe('Set · ends 1234');
  });

  it('Add sends the trimmed value from a secure field and settles on the answer', async () => {
    vi.mocked(api.setProviderKey).mockResolvedValue(
      state([KEYS[0]!, { id: 'openai', set: true, last4: '0000' }, KEYS[2]!]),
    );
    const r = await openKeys();
    await actAsync(() => findHost(r.root, byTestId('provider-key-openai-edit')).props.onPress());
    const input = findHost(r.root, byTestId('provider-key-openai-input'));
    expect(input.props.secureTextEntry).toBe(true);
    await actAsync(() => input.props.onChangeText('  sk-fake-000000000000  '));
    await actAsync(async () => {
      findHost(r.root, byTestId('provider-key-openai-save')).props.onPress();
      await flush();
    });
    expect(api.setProviderKey).toHaveBeenCalledWith('openai', 'sk-fake-000000000000');
    expect(queryHost(r.root, byTestId('provider-key-openai-input'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('provider-key-openai-status')))).toBe(
      'Set · ends 0000',
    );
  });

  it('a refusal says the server’s own sentence, and keeps the form open', async () => {
    vi.mocked(api.setProviderKey).mockRejectedValue(
      new ApiError(400, 'invalid_value', { message: 'A key must be at least 16 characters' }),
    );
    const r = await openKeys();
    await actAsync(() => findHost(r.root, byTestId('provider-key-openai-edit')).props.onPress());
    await actAsync(() =>
      findHost(r.root, byTestId('provider-key-openai-input')).props.onChangeText('short'),
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('provider-key-openai-save')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()?.message).toBe('A key must be at least 16 characters');
    expect(queryHost(r.root, byTestId('provider-key-openai-input'))).not.toBeNull();
  });

  it('Revoke asks first; Cancel does nothing, Revoke deletes', async () => {
    vi.mocked(api.revokeProviderKey).mockResolvedValue(
      state([{ id: 'gemini', set: false }, KEYS[1]!, KEYS[2]!]),
    );
    const r = await openKeys();
    await actAsync(() => findHost(r.root, byTestId('provider-key-gemini-revoke')).props.onPress());
    await pressAlertButton('Cancel');
    expect(api.revokeProviderKey).not.toHaveBeenCalled();
    await actAsync(() => findHost(r.root, byTestId('provider-key-gemini-revoke')).props.onPress());
    await pressAlertButton('Revoke');
    await flush();
    expect(api.revokeProviderKey).toHaveBeenCalledWith('gemini');
  });

  it('Cancel closes the form and sends nothing', async () => {
    const r = await openKeys();
    await actAsync(() => findHost(r.root, byTestId('provider-key-openai-edit')).props.onPress());
    await actAsync(() => findHost(r.root, byTestId('provider-key-openai-cancel')).props.onPress());
    expect(queryHost(r.root, byTestId('provider-key-openai-input'))).toBeNull();
    expect(api.setProviderKey).not.toHaveBeenCalled();
  });

  it('is unpressable while the link to the server is down, and not while a host is', async () => {
    usePresenceStore.setState({ connection: 'offline' });
    const r = await openKeys();
    expect(findHost(r.root, byTestId('provider-key-openai-edit')).props.disabled).toBe(true);
    await actAsync(() => usePresenceStore.setState({ connection: 'connected' }));
    expect(findHost(r.root, byTestId('provider-key-openai-edit')).props.disabled).toBe(false);
  });
});
