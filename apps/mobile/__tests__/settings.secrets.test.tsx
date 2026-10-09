// Settings → Keys → Secrets (spec/15 § Settings tab — Secrets;
// design/settings-redesign): one row per secret (key over a masked value; tap
// the row to reveal/hide), Edit opening a write-only value field with Save /
// Cancel / Delete, and an Add secret footer button that toggles the add form.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { SecretsSection } from '../src/components/settings/SecretsSection';
import {
  renderRN,
  findHost,
  queryHost,
  byLabel,
  byTestId,
  hasText,
  textOf,
  actAsync,
  actSync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';

vi.mock('../src/api/rest', () => ({
  api: { listSecrets: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() },
}));

const TWO = {
  secrets: [
    { key: 'API_KEY', value: 'sekret' },
    { key: 'OTHER', value: 'other-val' },
  ],
};

beforeEach(() => {
  vi.mocked(api.listSecrets).mockReset().mockResolvedValue({ secrets: [] });
  vi.mocked(api.setSecret).mockReset();
  vi.mocked(api.deleteSecret).mockReset();
  __clearLastAlert();
});

async function mount(): Promise<ReactTestRenderer> {
  const r = renderRN(<SecretsSection />);
  await flush();
  return r;
}

async function press(node: ReactTestInstance): Promise<void> {
  await actAsync(async () => {
    node.props.onPress();
    await flush();
  });
}

function type(r: ReactTestRenderer, testIDOrLabel: string, text: string): void {
  const node =
    queryHost(r.root, byTestId(testIDOrLabel)) ?? findHost(r.root, byLabel(testIDOrLabel));
  actSync(() => node.props.onChangeText(text));
}

async function openAdd(r: ReactTestRenderer): Promise<void> {
  await press(findHost(r.root, byTestId('secret-add-open')));
}

describe('Settings — Secrets — load', () => {
  it('reads the list from GET /api/secrets, titled Secrets', async () => {
    const r = await mount();
    expect(api.listSecrets).toHaveBeenCalledTimes(1);
    expect(hasText(r.root, 'Secrets')).toBe(true);
  });

  it('shows Loading… and keeps Add secret disabled until the list has loaded', () => {
    vi.mocked(api.listSecrets).mockReturnValue(new Promise(() => {}));
    const r = renderRN(<SecretsSection />);
    expect(hasText(r.root, 'Loading…')).toBe(true);
    const add = findHost(r.root, byTestId('secret-add-open'));
    expect(add.props.disabled).toBe(true);
    expect(add.props.accessibilityState).toEqual({ disabled: true });
  });

  it('a failed read is shown with a Retry rather than an empty list', async () => {
    vi.mocked(api.listSecrets).mockRejectedValueOnce(new Error('HTTP 500'));
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('secrets-error')))).toBe(
      'Couldn’t load secrets: HTTP 500',
    );
    expect(queryHost(r.root, byTestId('secrets-empty'))).toBeNull();
    await press(findHost(r.root, byLabel('Retry')));
    expect(api.listSecrets).toHaveBeenCalledTimes(2);
    expect(queryHost(r.root, byTestId('secrets-error'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('secrets-empty')))).toBe('No secrets');
  });
});

describe('Settings — Secrets — empty + add', () => {
  it('shows "No secrets" when the list is empty, with Add secret enabled', async () => {
    const r = await mount();
    expect(textOf(findHost(r.root, byTestId('secrets-empty')))).toBe('No secrets');
    const add = findHost(r.root, byTestId('secret-add-open'));
    expect(textOf(add)).toBe('Add secret');
    expect(add.props.disabled).toBe(false);
  });

  it('Add secret toggles the add form open and closed', async () => {
    const r = await mount();
    expect(queryHost(r.root, byTestId('secret-new-key'))).toBeNull();
    await openAdd(r);
    expect(findHost(r.root, byTestId('secret-new-key')).props.placeholder).toBe('KEY_NAME');
    const value = findHost(r.root, byTestId('secret-new-value'));
    expect(value.props.secureTextEntry).toBe(true);
    expect(textOf(findHost(r.root, byTestId('secret-add')))).toBe('Add');
    await openAdd(r);
    expect(queryHost(r.root, byTestId('secret-new-key'))).toBeNull();
    expect(queryHost(r.root, byTestId('secret-add'))).toBeNull();
  });

  it('rejects an invalid new key locally without a round-trip', async () => {
    const r = await mount();
    await openAdd(r);
    type(r, 'secret-new-key', '1bad key');
    type(r, 'secret-new-value', 'v');
    await press(findHost(r.root, byTestId('secret-add')));
    expect(__getLastAlert()?.title).toBe('Invalid secret');
    expect(api.setSecret).not.toHaveBeenCalled();
  });

  it('rejects a key that already exists', async () => {
    vi.mocked(api.listSecrets).mockResolvedValue(TWO);
    const r = await mount();
    await openAdd(r);
    type(r, 'secret-new-key', 'API_KEY');
    type(r, 'secret-new-value', 'v');
    await press(findHost(r.root, byTestId('secret-add')));
    expect(__getLastAlert()).toMatchObject({
      title: 'Invalid secret',
      message: 'A secret named API_KEY already exists.',
    });
    expect(api.setSecret).not.toHaveBeenCalled();
  });

  it('adds a valid new secret: calls setSecret with the trimmed key, lists it, closes the form', async () => {
    vi.mocked(api.setSecret).mockResolvedValue({ ok: true });
    const r = await mount();
    await openAdd(r);
    type(r, 'secret-new-key', ' API_KEY ');
    type(r, 'secret-new-value', 'secretvalue');
    await press(findHost(r.root, byTestId('secret-add')));
    expect(api.setSecret).toHaveBeenCalledWith('API_KEY', 'secretvalue');
    expect(textOf(findHost(r.root, byTestId('secret-API_KEY')))).toContain('API_KEY');
    expect(queryHost(r.root, byTestId('secrets-empty'))).toBeNull();
    // Form closed; reopening it shows cleared inputs.
    expect(queryHost(r.root, byTestId('secret-new-key'))).toBeNull();
    await openAdd(r);
    expect(findHost(r.root, byTestId('secret-new-key')).props.value).toBe('');
    expect(findHost(r.root, byTestId('secret-new-value')).props.value).toBe('');
  });

  it('a failed add surfaces an Alert, keeps the form open and does not clear the inputs', async () => {
    vi.mocked(api.setSecret).mockRejectedValue(new Error('write failed'));
    const r = await mount();
    await openAdd(r);
    type(r, 'secret-new-key', 'API_KEY');
    type(r, 'secret-new-value', 'v');
    await press(findHost(r.root, byTestId('secret-add')));
    expect(__getLastAlert()).toEqual({
      title: 'Failed to save secret',
      message: 'write failed',
      buttons: undefined,
    });
    expect(findHost(r.root, byTestId('secret-new-key')).props.value).toBe('API_KEY');
    // Not left busy.
    expect(findHost(r.root, byTestId('secret-add')).props.disabled).toBe(false);
  });

  it('disables Add while a save is in flight', async () => {
    let resolve!: (v: { ok: true }) => void;
    vi.mocked(api.setSecret).mockReturnValue(new Promise((res) => (resolve = res)));
    const r = await mount();
    await openAdd(r);
    type(r, 'secret-new-key', 'API_KEY');
    type(r, 'secret-new-value', 'v');
    await press(findHost(r.root, byTestId('secret-add')));
    expect(findHost(r.root, byTestId('secret-add')).props.disabled).toBe(true);
    await actAsync(async () => {
      resolve({ ok: true });
      await flush();
    });
    expect(findHost(r.root, byTestId('secret-API_KEY'))).toBeTruthy();
  });
});

describe('Settings — Secrets — existing rows: reveal/edit/delete', () => {
  beforeEach(() => {
    vi.mocked(api.listSecrets).mockResolvedValue(TWO);
  });

  it('one row per secret: key as title, value masked as ••••••••', async () => {
    const r = await mount();
    const row = findHost(r.root, byTestId('secret-API_KEY'));
    expect(textOf(row)).toBe('API_KEY••••••••Edit');
    expect(findHost(r.root, byTestId('secret-OTHER'))).toBeTruthy();
    expect(hasText(r.root, 'sekret')).toBe(false);
  });

  it('tapping the row reveals the value; tapping again hides it', async () => {
    const r = await mount();
    const row = (): ReactTestInstance => findHost(r.root, byTestId('secret-API_KEY'));
    expect(row().props.accessibilityLabel).toBe('Reveal API_KEY');
    actSync(() => row().props.onPress());
    expect(hasText(row(), 'sekret')).toBe(true);
    expect(row().props.accessibilityLabel).toBe('Hide API_KEY');
    // Only that row is revealed.
    expect(hasText(r.root, 'other-val')).toBe(false);
    actSync(() => findHost(r.root, byLabel('Hide API_KEY')).props.onPress());
    expect(hasText(r.root, 'sekret')).toBe(false);
    expect(row().props.accessibilityLabel).toBe('Reveal API_KEY');
  });

  it('Edit opens a write-only value field; Cancel discards without a round-trip', async () => {
    const r = await mount();
    actSync(() => findHost(r.root, byLabel('Edit API_KEY')).props.onPress());
    const field = findHost(r.root, byLabel('New value for API_KEY'));
    expect(field.props.value).toBe(''); // never prefilled with the old value
    expect(field.props.secureTextEntry).toBe(true);
    // The row's Edit button is replaced by the editor while open.
    expect(queryHost(r.root, byLabel('Edit API_KEY'))).toBeNull();
    expect(findHost(r.root, byLabel('Save API_KEY'))).toBeTruthy();
    expect(findHost(r.root, byLabel('Delete API_KEY'))).toBeTruthy();
    actSync(() => findHost(r.root, byLabel('Cancel')).props.onPress());
    expect(queryHost(r.root, byLabel('New value for API_KEY'))).toBeNull();
    expect(findHost(r.root, byLabel('Edit API_KEY'))).toBeTruthy();
    expect(api.setSecret).not.toHaveBeenCalled();
  });

  it('an invalid edit value is rejected locally (empty value)', async () => {
    const r = await mount();
    actSync(() => findHost(r.root, byLabel('Edit API_KEY')).props.onPress());
    await press(findHost(r.root, byLabel('Save API_KEY')));
    expect(__getLastAlert()?.title).toBe('Invalid value');
    expect(api.setSecret).not.toHaveBeenCalled();
  });

  it('saving a valid edit calls setSecret, updates the row, and closes the editor', async () => {
    vi.mocked(api.setSecret).mockResolvedValue({ ok: true });
    const r = await mount();
    actSync(() => findHost(r.root, byLabel('Edit API_KEY')).props.onPress());
    type(r, 'New value for API_KEY', 'new-secret-value');
    await press(findHost(r.root, byLabel('Save API_KEY')));
    expect(api.setSecret).toHaveBeenCalledWith('API_KEY', 'new-secret-value');
    expect(queryHost(r.root, byLabel('New value for API_KEY'))).toBeNull();
    actSync(() => findHost(r.root, byLabel('Reveal API_KEY')).props.onPress());
    expect(hasText(r.root, 'new-secret-value')).toBe(true);
  });

  it('a failed edit save surfaces an Alert and keeps the editor open', async () => {
    vi.mocked(api.setSecret).mockRejectedValue(new Error('edit failed'));
    const r = await mount();
    actSync(() => findHost(r.root, byLabel('Edit API_KEY')).props.onPress());
    type(r, 'New value for API_KEY', 'x');
    await press(findHost(r.root, byLabel('Save API_KEY')));
    expect(__getLastAlert()).toEqual({
      title: 'Failed to update secret',
      message: 'edit failed',
      buttons: undefined,
    });
    expect(findHost(r.root, byLabel('New value for API_KEY')).props.value).toBe('x');
  });

  it('Delete asks for confirmation; Cancel does nothing', async () => {
    const r = await mount();
    actSync(() => findHost(r.root, byLabel('Edit API_KEY')).props.onPress());
    actSync(() => findHost(r.root, byLabel('Delete API_KEY')).props.onPress());
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Delete secret?');
    expect(alert?.message).toBe('Remove API_KEY? This cannot be undone.');
    expect(alert?.buttons?.map((b) => b.text)).toEqual(['Cancel', 'Delete']);
    expect(alert?.buttons?.[0]?.onPress).toBeUndefined();
    expect(api.deleteSecret).not.toHaveBeenCalled();
  });

  it('confirming Delete calls deleteSecret and removes the row', async () => {
    vi.mocked(api.deleteSecret).mockResolvedValue({ ok: true });
    const r = await mount();
    actSync(() => findHost(r.root, byLabel('Edit API_KEY')).props.onPress());
    actSync(() => findHost(r.root, byLabel('Delete API_KEY')).props.onPress());
    await actAsync(async () => {
      __getLastAlert()!.buttons!.find((b) => b.text === 'Delete')!.onPress!();
      await flush();
    });
    expect(api.deleteSecret).toHaveBeenCalledWith('API_KEY');
    expect(queryHost(r.root, byTestId('secret-API_KEY'))).toBeNull();
    expect(findHost(r.root, byTestId('secret-OTHER'))).toBeTruthy();
  });

  it('a failed delete surfaces an Alert and keeps the row', async () => {
    vi.mocked(api.deleteSecret).mockRejectedValue(new Error('delete boom'));
    const r = await mount();
    actSync(() => findHost(r.root, byLabel('Edit API_KEY')).props.onPress());
    actSync(() => findHost(r.root, byLabel('Delete API_KEY')).props.onPress());
    await actAsync(async () => {
      __getLastAlert()!.buttons!.find((b) => b.text === 'Delete')!.onPress!();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Failed to delete secret',
      message: 'delete boom',
      buttons: undefined,
    });
    expect(findHost(r.root, byTestId('secret-API_KEY'))).toBeTruthy();
    expect(findHost(r.root, byLabel('Save API_KEY')).props.disabled).toBe(false);
  });
});
