// Composer — image paste (spec/15 § Composer — "Paste"). Long-press → Paste of
// an image, and a keyboard's image insertion, arrive from the PatchPaste
// native listener on the input and are attached like picked images. Text
// paste stays the input's own, and there is no "Paste image" chip any more.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Platform, NativeModules, NativeEventEmitter } from 'react-native';
import {
  findHost,
  queryHost,
  byTestId,
  byType,
  renderRN as renderOnce,
  actAsync,
  actSync,
  flush,
  hasText,
} from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { useUiStore } from '../src/stores/uiStore';

vi.mock('../src/api/rest', () => ({
  api: { skills: vi.fn().mockResolvedValue({ skills: [] }), uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';

type Cb = (ev: unknown) => void;
const listeners: { event: string; cb: Cb }[] = [];
const realAddListener = NativeEventEmitter.prototype.addListener;
let attach: ReturnType<typeof vi.fn>;

beforeEach(() => {
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
  });
  useChatStore.getState()._reset();
  useComposerAttachmentStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  Platform.OS = 'android';
  attach = vi.fn(async () => {});
  NativeModules['PatchPaste'] = { attach, addListener: vi.fn(), removeListeners: vi.fn() };
  listeners.length = 0;
  NativeEventEmitter.prototype.addListener = function (event: string, cb: Cb) {
    const entry = { event, cb };
    listeners.push(entry);
    const sub = realAddListener.call(this, event, cb);
    return {
      remove: (): void => {
        listeners.splice(listeners.indexOf(entry), 1);
        sub.remove();
      },
    };
  };
});

type R = ReturnType<typeof renderOnce>;
const mounted: R[] = [];
function renderRN(el: React.ReactElement): R {
  const r = renderOnce(el);
  mounted.push(r);
  return r;
}
afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
  NativeEventEmitter.prototype.addListener = realAddListener;
  delete NativeModules['PatchPaste'];
  Platform.OS = 'test';
});

const attachments = () => useComposerAttachmentStore.getState().byKey['c1'] ?? [];
const errors = () => useUiStore.getState().errors.map((e) => e.message);
const tag = () => attach.mock.calls[0]![0] as number;
async function paste(payload: unknown): Promise<void> {
  await actAsync(async () => {
    for (const l of listeners.filter((x) => x.event === 'PatchPasteReceived')) l.cb(payload);
    await flush();
  });
}

describe('Composer — image paste', () => {
  it('attaches the input on mount and a pasted image lands as an image attachment', async () => {
    renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(flush);
    expect(attach).toHaveBeenCalledTimes(1);
    await paste({
      tag: tag(),
      files: [
        {
          uri: 'file:///cache/pasted-in/1-1-Screenshot.png',
          name: 'Screenshot.png',
          mimeType: 'image/png',
          width: 1080,
          height: 2400,
        },
      ],
      errors: [],
    });
    expect(attachments()).toEqual([
      expect.objectContaining({
        uri: 'file:///cache/pasted-in/1-1-Screenshot.png',
        name: 'Screenshot.png',
        mimeType: 'image/png',
        kind: 'image',
        width: 1080,
        height: 2400,
      }),
    ]);
    expect(errors()).toEqual([]);
  });

  it('a keyboard GIF and sticker (no dimensions) both attach, keeping their types', async () => {
    renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(flush);
    await paste({
      tag: tag(),
      files: [
        { uri: 'file:///cache/pasted-in/2-a.gif', name: 'a.gif', mimeType: 'image/gif' },
        { uri: 'file:///cache/pasted-in/3-b.webp', name: 'b.webp', mimeType: 'image/webp' },
      ],
      errors: [],
    });
    expect(attachments().map((a) => [a.name, a.mimeType, a.kind])).toEqual([
      ['a.gif', 'image/gif', 'image'],
      ['b.webp', 'image/webp', 'image'],
    ]);
  });

  it('an image that could not be copied is an error toast; the others still attach', async () => {
    renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(flush);
    await paste({
      tag: tag(),
      files: [{ uri: 'file:///cache/pasted-in/4-c.png', name: 'c.png', mimeType: 'image/png' }],
      errors: ['d.png: no data behind the image'],
    });
    expect(attachments()).toHaveLength(1);
    expect(errors()).toEqual(['paste image failed: d.png: no data behind the image']);
  });

  it('a failed attach is an error toast', async () => {
    attach.mockImplementation(async () => {
      throw new Error('view 9 is a ReactViewGroup, not an EditText');
    });
    renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(flush);
    expect(errors()).toEqual([
      'image paste unavailable: view 9 is a ReactViewGroup, not an EditText',
    ]);
  });

  it('a missing native module is an error toast (NO FALLBACK)', async () => {
    delete NativeModules['PatchPaste'];
    renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(flush);
    expect(errors()).toEqual([expect.stringMatching(/PatchPaste native module missing/)]);
  });

  it('text paste is untouched: it is the input’s own text change, and attaches nothing', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(flush);
    const input = findHost(r.root, byType('TextInput'));
    expect(input.props['onPaste']).toBeUndefined();
    await actAsync(async () => {
      input.props['onChangeText']('pasted words');
      await flush();
    });
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('pasted words');
    expect(attachments()).toEqual([]);
    expect(errors()).toEqual([]);
  });

  it('has no "Paste image" chip', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onFocus']?.();
      await flush();
    });
    expect(queryHost(r.root, byTestId('paste-image-chip'))).toBeNull();
    expect(hasText(r.root, 'Paste image')).toBe(false);
  });

  it('stops listening when the composer unmounts', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(flush);
    expect(listeners.filter((l) => l.event === 'PatchPasteReceived')).toHaveLength(1);
    actSync(() => r.unmount());
    mounted.splice(mounted.indexOf(r), 1);
    expect(listeners.filter((l) => l.event === 'PatchPasteReceived')).toHaveLength(0);
  });
});
