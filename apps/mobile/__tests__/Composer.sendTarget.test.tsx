// Composer — `sendTarget` (spec/15 § New chat flow): on the new-chat screen
// `chatId` is only the draft key, and the chat to send into is resolved (and
// created) by the first send.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findHost, byLabel, byType, renderRN, update } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
  },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  usePresenceStore.setState({ connection: 'connected', daemon: 'online' });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
});

function typeAndRender(r: ReturnType<typeof renderRN>, el: React.ReactElement, text: string): void {
  findHost(r.root, byType('TextInput')).props['onChangeText'](text);
  update(r, el);
}

describe('Composer — sendTarget', () => {
  it('holds Send busy while the chat is created, then sends into the resolved chat', async () => {
    let resolve!: (id: string | null) => void;
    const sendTarget = vi.fn(() => new Promise<string | null>((res) => (resolve = res)));
    const onSent = vi.fn();
    const el = <Composer chatId="new" sendTarget={sendTarget} onSent={onSent} />;
    const r = renderRN(el);
    typeAndRender(r, el, 'first');
    act(() => findHost(r.root, byLabel('Send message')).props['onPress']());
    expect(findHost(r.root, byLabel('Sending — creating the chat'))).toBeDefined();
    await act(async () => {
      resolve('chat_x');
      await Promise.resolve();
    });
    expect(submitSpy.mock.calls[0]?.[0]).toBe('chat_x');
    expect(submitSpy.mock.calls[0]?.[1]).toBe('first');
    expect(onSent).toHaveBeenCalledWith('chat_x');
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });

  it('a target that cannot be resolved keeps the text and sends nothing', async () => {
    const onSent = vi.fn();
    const sendTarget = vi.fn(async () => null);
    const el = <Composer chatId="new" sendTarget={sendTarget} onSent={onSent} />;
    const r = renderRN(el);
    typeAndRender(r, el, 'keep');
    await act(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await Promise.resolve();
    });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('keep');
  });

  it('a target that throws is reported, never swallowed', async () => {
    const sendTarget = vi.fn(async (): Promise<string | null> => {
      throw new Error('boom');
    });
    const el = <Composer chatId="new" sendTarget={sendTarget} />;
    const r = renderRN(el);
    typeAndRender(r, el, 'x');
    await act(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await Promise.resolve();
    });
    expect(useUiStore.getState().errors[0]?.message).toBe('failed to create chat: boom');
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
