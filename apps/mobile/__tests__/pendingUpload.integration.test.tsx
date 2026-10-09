// Todoist "patch submitting message with an image doesnt go through
// immediately. should react immediately, show as pending" — spec/15 §
// Composer → Attachments. Driven through the real chat screen (composer +
// transcript), with only the network (upload + socket) and the delivery
// tracker's wire send stubbed:
//
//   - send with attachments clears the composer and puts the message in the
//     stream AT ONCE, drawn from the local copies, marked `Uploading 0/2`,
//     counting each landed upload
//   - only once every upload has landed is the turn handed to delivery (same
//     localId as the bubble), and from there it is an ordinary send
//   - a failed upload leaves the message marked `Not uploaded`, toasts the
//     error, and offers Retry (re-uploads the same files, then sends) and ×
//     (discards the message)
//   - the composer stays usable; a message sent behind an uploading one shows
//     at once but is delivered after it; a failed upload holds nothing up
//   - the upload survives the chat screen unmounting

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderRN,
  actSync,
  actAsync,
  update,
  flush,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  byLabel,
  byType,
  hasText,
} from './testUtils/render';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { _resetSendQueue } from '../src/lib/sendQueue';

const { uploadAttachmentSpy } = vi.hoisted(() => ({ uploadAttachmentSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: uploadAttachmentSpy,
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

import { __setLocalSearchParams } from './stubs/expo-router';

let ChatDetailScreen: React.ComponentType;
let submitSpy: ReturnType<typeof vi.spyOn>;

/** Upload calls parked until the test settles them, in call order. */
let uploads: Array<{
  name: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}>;

function ok(name: string): unknown {
  return { ok: true, ref: { id: `id-${name}`, name, mimeType: 'image/png', kind: 'image' } };
}

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  _resetSendQueue();
  useComposerAttachmentStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
  uploads = [];
  uploadAttachmentSpy.mockImplementation(
    (_chatId: string, f: { name: string }) =>
      new Promise((resolve, reject) => uploads.push({ name: f.name, resolve, reject })),
  );
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});

afterEach(() => {
  submitSpy.mockRestore();
});

function attach(names: string[], kind: 'image' | 'file' = 'image'): void {
  actSync(() => {
    useComposerAttachmentStore.getState().add(
      'c1',
      names.map((name) => ({
        key: `k-${name}`,
        uri: `file:///cache/${name}`,
        name,
        mimeType: kind === 'image' ? 'image/png' : 'application/pdf',
        kind,
      })),
    );
  });
}

function type(r: ReturnType<typeof renderRN>, text: string): void {
  actSync(() => findHost(r.root, byType('TextInput')).props['onChangeText'](text));
}

/** Press Send and let everything that can settle without the network settle. */
async function send(r: ReturnType<typeof renderRN>): Promise<void> {
  await actAsync(async () => {
    findHost(r.root, byLabel('Send message')).props['onPress']();
    await flush();
  });
  update(r, <ChatDetailScreen />);
}

async function settle(r: ReturnType<typeof renderRN>, fn: () => void): Promise<void> {
  await actAsync(async () => {
    fn();
    await flush();
    await flush();
  });
  update(r, <ChatDetailScreen />);
}

function userBubbles(r: ReturnType<typeof renderRN>) {
  return findAllHost(r.root, byTestId('message-user'));
}

function statusText(r: ReturnType<typeof renderRN>): string {
  const node = findHost(r.root, byTestId('upload-status'));
  return String(node.props['children']);
}

describe('sending with attachments reacts at once', () => {
  it('clears the composer and shows the message pending, drawn from the local files, before any upload lands', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png', 'b.png']);
    type(r, 'look at these');
    update(r, <ChatDetailScreen />);
    await send(r);

    // Nothing has uploaded yet…
    expect(uploads.length).toBeGreaterThan(0);
    expect(submitSpy).not.toHaveBeenCalled();
    // …but the composer has already cleared: no text, no chips.
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    expect(queryHost(r.root, byLabel('Remove a.png'))).toBeNull();
    expect(queryHost(r.root, byLabel('Remove b.png'))).toBeNull();
    // And the message is in the stream, its images from the local copies.
    expect(userBubbles(r)).toHaveLength(1);
    expect(hasText(r.root, 'look at these')).toBe(true);
    const uris = findAllHost(r.root, byType('Image')).map(
      (i) => (i.props['source'] as { uri: string }).uri,
    );
    expect(uris).toEqual(expect.arrayContaining(['file:///cache/a.png', 'file:///cache/b.png']));
    // In the pending style, with the upload count rather than "Sending…".
    expect(statusText(r)).toBe('Uploading 0/2');
    expect(queryHost(r.root, byTestId('delivery-pending'))).toBeNull();
    const body = findHost(r.root, byTestId('message-body-user'));
    expect(body.props['style'].opacity).toBeLessThan(1);
    // No claim that the agent is working — it has not been sent anything yet.
    expect(
      findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Claude is working'),
    ).toHaveLength(0);
  });

  it('counts the uploads as they land, then sends the turn with every ref under the same localId', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png', 'b.png', 'c.png']);
    type(r, 'three');
    update(r, <ChatDetailScreen />);
    await send(r);
    expect(statusText(r)).toBe('Uploading 0/3');

    await settle(r, () => uploads[0]!.resolve(ok('a.png')));
    expect(statusText(r)).toBe('Uploading 1/3');
    await settle(r, () => uploads[1]!.resolve(ok('b.png')));
    expect(statusText(r)).toBe('Uploading 2/3');
    expect(submitSpy).not.toHaveBeenCalled();
    await settle(r, () => uploads[2]!.resolve(ok('c.png')));

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [chatId, text, localId, refs] = submitSpy.mock.calls[0] as [
      string,
      string,
      string,
      Array<{ id: string }>,
    ];
    expect(chatId).toBe('c1');
    expect(text).toBe('three');
    expect(refs.map((x) => x.id)).toEqual(['id-a.png', 'id-b.png', 'id-c.png']);
    const entry = useChatStore.getState().timelines['c1']!.find((e) => e.role === 'user')!;
    expect(entry.localId).toBe(localId);
    // From here it is an ordinary send.
    expect(queryHost(r.root, byTestId('upload-status'))).toBeNull();
    expect(hasText(r.root, 'Sending…')).toBe(true);
    expect(userBubbles(r)).toHaveLength(1);
  });

  it('a file attachment shows as a chip in the pending message', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['doc.pdf'], 'file');
    await send(r);
    expect(userBubbles(r)).toHaveLength(1);
    expect(hasText(r.root, 'doc.pdf')).toBe(true);
    expect(statusText(r)).toBe('Uploading 0/1');
  });
});

describe('a failed upload', () => {
  it('stays in the stream marked Not uploaded, toasts the error, and Retry uploads the same files again then sends', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png']);
    type(r, 'try me');
    update(r, <ChatDetailScreen />);
    await send(r);
    await settle(r, () => uploads[0]!.reject(new Error('server 500')));

    expect(userBubbles(r)).toHaveLength(1);
    expect(statusText(r)).toBe('Not uploaded');
    expect(
      useUiStore
        .getState()
        .errors.some((e) => e.message === 'attachment upload failed: server 500'),
    ).toBe(true);
    expect(submitSpy).not.toHaveBeenCalled();

    await settle(r, () => findHost(r.root, byTestId('upload-retry')).props['onPress']());
    expect(uploads).toHaveLength(2);
    expect(uploads[1]!.name).toBe('a.png');
    expect(statusText(r)).toBe('Uploading 0/1');

    await settle(r, () => uploads[1]!.resolve(ok('a.png')));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![1]).toBe('try me');
    expect(userBubbles(r)).toHaveLength(1);
  });

  it('× discards the message', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png']);
    await send(r);
    await settle(r, () => uploads[0]!.reject(new Error('413')));
    expect(userBubbles(r)).toHaveLength(1);

    await settle(r, () => findHost(r.root, byTestId('upload-discard')).props['onPress']());
    expect(userBubbles(r)).toHaveLength(0);
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe('the composer stays usable while a message uploads', () => {
  it('a text sent behind an uploading message shows at once but is delivered after it', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png']);
    type(r, 'first, with a photo');
    update(r, <ChatDetailScreen />);
    await send(r);

    // The input is editable and Send is usable again straight away.
    expect(findHost(r.root, byType('TextInput')).props['editable']).not.toBe(false);
    type(r, 'second, text only');
    update(r, <ChatDetailScreen />);
    await send(r);

    expect(userBubbles(r)).toHaveLength(2);
    expect(hasText(r.root, 'second, text only')).toBe(true);
    expect(submitSpy).not.toHaveBeenCalled();

    await settle(r, () => uploads[0]!.resolve(ok('a.png')));
    expect(submitSpy.mock.calls.map((c) => c[1])).toEqual([
      'first, with a photo',
      'second, text only',
    ]);
  });

  it('a failed upload does not hold up the message behind it', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png']);
    await send(r);
    type(r, 'behind it');
    update(r, <ChatDetailScreen />);
    await send(r);
    expect(submitSpy).not.toHaveBeenCalled();

    await settle(r, () => uploads[0]!.reject(new Error('boom')));
    expect(submitSpy.mock.calls.map((c) => c[1])).toEqual(['behind it']);
    expect(statusText(r)).toBe('Not uploaded');
  });

  it('two attachment messages reach delivery in the order they were sent, whichever upload lands first', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png']);
    type(r, 'one');
    update(r, <ChatDetailScreen />);
    await send(r);
    attach(['b.png']);
    type(r, 'two');
    update(r, <ChatDetailScreen />);
    await send(r);

    await settle(r, () => uploads.find((u) => u.name === 'b.png')!.resolve(ok('b.png')));
    expect(submitSpy).not.toHaveBeenCalled();
    await settle(r, () => uploads.find((u) => u.name === 'a.png')!.resolve(ok('a.png')));
    expect(submitSpy.mock.calls.map((c) => c[1])).toEqual(['one', 'two']);
  });
});

describe('the upload outlives the screen', () => {
  it('still sends when the chat screen has unmounted mid-upload', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png']);
    type(r, 'leaving');
    update(r, <ChatDetailScreen />);
    await send(r);
    actSync(() => r.unmount());

    await actAsync(async () => {
      uploads[0]!.resolve(ok('a.png'));
      await flush();
      await flush();
    });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![1]).toBe('leaving');
  });
});

describe('a pending message draws its attachments from the local copies', () => {
  it('tapping a local image opens it in the in-app viewer', async () => {
    const r = renderRN(<ChatDetailScreen />);
    attach(['a.png']);
    await send(r);
    actSync(() =>
      findHost(r.root, (i) => i.props['accessibilityLabel'] === 'View a.png').props['onPress'](),
    );
    const img = findHost(
      r.root,
      (i) => i.type === 'Animated.Image' && i.props['accessibilityLabel'] === 'a.png',
    );
    expect((img.props['source'] as { uri: string }).uri).toBe('file:///cache/a.png');
  });

  it('a file chip opens nothing until it has uploaded, then opens the served copy', async () => {
    const { Linking } = await import('react-native');
    const openSpy = vi.spyOn(Linking, 'openURL');
    const r = renderRN(<ChatDetailScreen />);
    attach(['doc.pdf'], 'file');
    await send(r);
    const chip = (): ReturnType<typeof findHost> =>
      findHost(
        r.root,
        (i) => i.type === 'Pressable' && i.props['accessibilityLabel'] === 'doc.pdf',
      );
    expect(chip().props['disabled']).toBe(true);
    // The raw handler is guarded too, not only the disabled prop.
    const raw = r.root
      .findAll(
        (i) =>
          i.props['accessibilityLabel'] === 'doc.pdf' && typeof i.props['onPress'] === 'function',
      )
      .at(-1)!;
    actSync(() => raw.props['onPress']());
    expect(openSpy).not.toHaveBeenCalled();

    await settle(r, () =>
      uploads[0]!.resolve({
        ok: true,
        ref: { id: 'id-doc', name: 'doc.pdf', mimeType: 'application/pdf', kind: 'file' },
      }),
    );
    expect(chip().props['disabled']).toBe(false);
    actSync(() => chip().props['onPress']());
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/chats/c1/attachment/id-doc'),
    );
    openSpy.mockRestore();
  });
});
