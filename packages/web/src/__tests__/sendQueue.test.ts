// lib/sendQueue.ts — outgoing turns from Send to delivery (spec/15 § Composer
// → Attachments). The route-level behaviour (pending bubble, Uploading n/total,
// Not uploaded, Retry / ×, ordering) is in ChatRoute.pendingUpload.test.tsx;
// these pin the parts only visible at the module: what is uploaded, delivery
// details, and the edges.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { api } from '../api/rest.js';
import * as imageResizeModule from '../lib/imageResize.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import {
  _resetSendQueue,
  discardUpload,
  retryUpload,
  sendMessage,
  type OutgoingFile,
} from '../lib/sendQueue.js';
import { useChatStore } from '../stores/chatStore.js';
import { useToolsStore } from '../stores/toolsStore.js';
import { useUiStore } from '../stores/uiStore.js';

const image = (name: string): OutgoingFile => ({
  file: new File(['x'], name, { type: 'image/png' }),
  name,
  kind: 'image',
  previewUrl: `blob:${name}`,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sendQueue', () => {
  let sent: WireEvent[];
  const send = (e: WireEvent) => void sent.push(e);
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    _resetSendQueue();
    sent = [];
    vi.spyOn(imageResizeModule, 'downscaleImageFile').mockImplementation(async (f) => f);
    vi.spyOn(api, 'uploadAttachment').mockImplementation(async (_c, file) => ({
      ok: true,
      ref: {
        id: `id-${file.name}`,
        name: file.name,
        mimeType: file.type,
        kind: 'image',
        url: '/x',
      },
    }));
  });
  afterEach(() => {
    deliveryTracker.reset();
    vi.restoreAllMocks();
  });

  it('a text-only send is echoed and delivered synchronously, like before', () => {
    const localId = sendMessage('c1', 'hello', [], { send });
    const entry = useChatStore.getState().timelines['c1']![0]!;
    expect(entry).toMatchObject({ localId, content: 'hello', deliveryPending: true });
    expect(entry.upload).toBeUndefined();
    expect(sent).toEqual([{ type: 'chat.input', chatId: 'c1', message: 'hello', localId }]);
  });

  it('uploads the ORIGINAL plus the downscaled copy when an image was downscaled', async () => {
    const small = new File(['s'], 'photo.jpg', { type: 'image/jpeg' });
    vi.mocked(imageResizeModule.downscaleImageFile).mockResolvedValue(small);
    const f = image('photo.png');
    sendMessage('c1', '', [f], { send });
    await flush();
    const call = vi.mocked(api.uploadAttachment).mock.calls[0]!;
    expect(call).toEqual(['c1', f.file, small]);
  });

  it('sends no downscaled copy when the image was already within the cap', async () => {
    const f = image('small.png');
    sendMessage('c1', '', [f], { send });
    await flush();
    expect(vi.mocked(api.uploadAttachment).mock.calls[0]).toEqual(['c1', f.file, undefined]);
  });

  it('uploads a non-image attachment as-is (no downscale call)', async () => {
    const file = new File(['t'], 'notes.txt', { type: 'text/plain' });
    sendMessage('c1', '', [{ file, name: 'notes.txt', kind: 'file' }], { send });
    await flush();
    expect(imageResizeModule.downscaleImageFile).not.toHaveBeenCalled();
    expect(vi.mocked(api.uploadAttachment).mock.calls[0]).toEqual(['c1', file, undefined]);
    // A file has no local preview to draw.
    expect(useChatStore.getState().timelines['c1']![0]!.localAttachments).toEqual([
      { name: 'notes.txt', kind: 'file' },
    ]);
  });

  it('carries the Tools OFF set captured at send time', async () => {
    if (!useToolsStore.getState().isDisabled('c1', 'Bash')) {
      useToolsStore.getState().toggle('c1', 'Bash');
    }
    const localId = sendMessage('c1', 'go', [image('a.png')], { send });
    await flush();
    const input = sent[0] as Extract<WireEvent, { type: 'chat.input' }>;
    expect(input.localId).toBe(localId);
    expect(input.disabledTools).toContain('Bash');
  });

  it('chains are per chat: an upload in one chat does not hold up another', () => {
    vi.mocked(api.uploadAttachment).mockReturnValue(new Promise(() => {}));
    sendMessage('c1', 'slow', [image('a.png')], { send });
    sendMessage('c2', 'fast', [], { send });
    expect(sent.map((e) => (e as { chatId: string }).chatId)).toEqual(['c2']);
  });

  it('Retry of a turn whose files are gone (page reloaded) says so instead of doing nothing', () => {
    retryUpload('c1', 'nope');
    expect(useUiStore.getState().errors.some((e) => /no longer available/.test(e.message))).toBe(
      true,
    );
  });

  it('× revokes the local previews and removes the turn', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: revoke });
    vi.mocked(api.uploadAttachment).mockRejectedValue(new Error('boom'));
    const localId = sendMessage('c1', 'x', [image('a.png')], { send });
    await flush();
    discardUpload('c1', localId);
    expect(revoke).toHaveBeenCalledWith('blob:a.png');
    expect(useChatStore.getState().timelines['c1']).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('a same-text persisted turn from elsewhere never swallows a turn still uploading', () => {
    vi.mocked(api.uploadAttachment).mockReturnValue(new Promise(() => {}));
    const localId = sendMessage('c1', 'same', [image('a.png')], { send });
    useChatStore
      .getState()
      .applyEvents([{ type: 'chat.message', chatId: 'c1', role: 'user', content: 'same', seq: 3 }]);
    const list = useChatStore.getState().timelines['c1']!;
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.localId === localId)?.upload).toEqual({
      done: 0,
      total: 1,
      failed: false,
    });
  });
});
