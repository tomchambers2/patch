// The phone's model control (spec/15 § New chat flow → Model picker). Pins:
//   - the pill names the model in force, preferring the catalogue's label and
//     showing the raw id when the catalogue doesn't carry it
//   - with no model in force at all the pill reads the placeholder rather than
//     inventing an id
//   - the list is LIVE: it is fetched per host, ticks the model in force, and
//     reports a failed load in place of the options — NO FALLBACK, never a
//     stand-in set of model names
//   - `Loading models…` while the catalogue is in flight
//   - choosing closes the list and reports the id; the backdrop dismisses it
//     and changes nothing
//   - a host that has not been resolved yet is not asked for a catalogue

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderRN,
  update,
  findHost,
  queryHost,
  byTestId,
  byLabel,
  hasText,
  textOf,
  actAsync,
  actSync,
  flush,
} from './testUtils/render';
import { ModelPicker } from '../src/components/ModelPicker';

const { modelsSpy } = vi.hoisted(() => ({ modelsSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({ api: { models: modelsSpy } }));

const HOST = 'd1';

beforeEach(() => {
  modelsSpy.mockReset();
});

async function renderPicker(
  props: Partial<React.ComponentProps<typeof ModelPicker>> = {},
): Promise<ReturnType<typeof renderRN>> {
  let r!: ReturnType<typeof renderRN>;
  await actAsync(async () => {
    r = renderRN(<ModelPicker daemonId={HOST} selected={null} onSelect={() => {}} {...props} />);
    await flush();
  });
  return r;
}

describe('ModelPicker — the pill', () => {
  it('prefers the catalogue label for the model in force', async () => {
    modelsSpy.mockResolvedValue({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] });
    const r = await renderPicker({ selected: 'claude-opus-5' });
    expect(textOf(findHost(r.root, byTestId('new-chat-model-pill')))).toContain('Opus 5');
  });

  it('shows the raw id when the catalogue does not carry it', async () => {
    modelsSpy.mockResolvedValue({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] });
    const r = await renderPicker({ selected: 'claude-retired-1' });
    expect(textOf(findHost(r.root, byTestId('new-chat-model-pill')))).toContain('claude-retired-1');
  });

  it('reads the placeholder when there is no model in force', async () => {
    modelsSpy.mockResolvedValue({ models: [] });
    const r = await renderPicker({ selected: null });
    expect(textOf(findHost(r.root, byTestId('new-chat-model-pill')))).toContain('Choose a model');
  });
});

describe('ModelPicker — the catalogue', () => {
  it('asks for the CHOSEN host catalogue, once', async () => {
    modelsSpy.mockResolvedValue({ models: [] });
    await renderPicker();
    expect(modelsSpy).toHaveBeenCalledTimes(1);
    expect(modelsSpy).toHaveBeenCalledWith(HOST);
  });

  it('does not ask when no host has been resolved', async () => {
    await renderPicker({ daemonId: null });
    expect(modelsSpy).not.toHaveBeenCalled();
  });

  it('re-reads the catalogue when the host changes — a catalogue is per machine', async () => {
    modelsSpy.mockResolvedValue({ models: [] });
    const r = await renderPicker();
    await actAsync(async () => {
      update(r, <ModelPicker daemonId="d2" selected={null} onSelect={() => {}} />);
      await flush();
    });
    expect(modelsSpy).toHaveBeenCalledTimes(2);
    expect(modelsSpy).toHaveBeenLastCalledWith('d2');
  });
});

describe('ModelPicker — the list', () => {
  it('lists the catalogue and ticks the model in force', async () => {
    modelsSpy.mockResolvedValue({
      models: [
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      ],
    });
    const r = await renderPicker({ selected: 'claude-haiku-4-5' });
    actSync(() => findHost(r.root, byTestId('new-chat-model-pill')).props.onPress());
    expect(queryHost(r.root, byTestId('new-chat-model-option-claude-opus-5'))).not.toBeNull();
    const chosen = findHost(r.root, byTestId('new-chat-model-option-claude-haiku-4-5'));
    expect(queryHost(chosen, (i) => i.type === 'Icon' && i.props.name === 'Check')).not.toBeNull();
    const other = findHost(r.root, byTestId('new-chat-model-option-claude-opus-5'));
    expect(queryHost(other, (i) => i.type === 'Icon' && i.props.name === 'Check')).toBeNull();
  });

  it('says the catalogue is loading rather than showing an empty list', async () => {
    let release!: (v: { models: [] }) => void;
    modelsSpy.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const r = await renderPicker();
    actSync(() => findHost(r.root, byTestId('new-chat-model-pill')).props.onPress());
    expect(hasText(r.root, 'Loading models…')).toBe(true);
    await actAsync(async () => {
      release({ models: [] });
      await flush();
    });
  });

  it('surfaces a failed load in place of the options — NO FALLBACK', async () => {
    modelsSpy.mockRejectedValue(new Error('oauth_unavailable: not signed in'));
    const r = await renderPicker();
    actSync(() => findHost(r.root, byTestId('new-chat-model-pill')).props.onPress());
    const err = findHost(r.root, byTestId('new-chat-model-error'));
    expect(textOf(err)).toContain('oauth_unavailable');
    // Nothing selectable is offered — an error must not read as a short list.
    expect(queryHost(r.root, byTestId('new-chat-model-option-claude-opus-5'))).toBeNull();
    expect(hasText(r.root, 'Loading models…')).toBe(false);
  });
});

describe('ModelPicker — choosing', () => {
  it('reports the chosen id and closes the list', async () => {
    modelsSpy.mockResolvedValue({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] });
    const onSelect = vi.fn();
    const r = await renderPicker({ onSelect });
    actSync(() => findHost(r.root, byTestId('new-chat-model-pill')).props.onPress());
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-opus-5')).props.onPress(),
    );
    expect(onSelect).toHaveBeenCalledWith('claude-opus-5');
    expect(queryHost(r.root, byTestId('new-chat-model-option-claude-opus-5'))).toBeNull();
  });

  it('dismisses on the backdrop without choosing anything', async () => {
    modelsSpy.mockResolvedValue({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] });
    const onSelect = vi.fn();
    const r = await renderPicker({ onSelect });
    actSync(() => findHost(r.root, byTestId('new-chat-model-pill')).props.onPress());
    actSync(() => findHost(r.root, byLabel('Dismiss model list')).props.onPress());
    expect(onSelect).not.toHaveBeenCalled();
    expect(queryHost(r.root, byTestId('new-chat-model-option-claude-opus-5'))).toBeNull();
  });
});
