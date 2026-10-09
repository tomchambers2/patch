// Todoist "patch submitting message with an image doesnt go through
// immediately. should react immediately, show as pending" — spec/15 § Composer
// → Attachments (the cross-surface contract) on web/desktop. Driven through
// the real chat route (composer + transcript) with only the network stubbed:
//
//   - Send with an attachment clears the composer and puts the message in the
//     stream AT ONCE, its image drawn from the local copy, marked `Uploading
//     0/1` — nothing is on the wire yet
//   - once every upload has landed the turn goes out as an ordinary send, with
//     every ref, under the bubble's own localId
//   - a failed upload leaves the message `Not uploaded`, toasts the error, and
//     offers Retry (upload the same files again, then send) and × (discard)
//   - a text sent behind an uploading message shows at once but is delivered
//     after it; a failed upload holds nothing up

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { WireEvent } from '@patch/wire';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { _resetSendQueue } from '../lib/sendQueue.js';
import { setActiveWs } from '../api/ws.js';
import * as imageResizeModule from '../lib/imageResize.js';
import { api, type UploadedAttachment } from '../api/rest.js';

type Ws = Parameters<typeof ChatRoute>[0]['ws'];
type Upload = { ok: true; ref: UploadedAttachment };

function seedChat(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
}

function renderChat(chatId: string, ws: Ws) {
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Uploads that settle only when the test says so, in any order. */
function deferredUploads() {
  const pending: Array<{ resolve(v: Upload): void; reject(e: Error): void }> = [];
  vi.spyOn(api, 'uploadAttachment').mockImplementation(
    () =>
      new Promise<Upload>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return pending;
}

const ref = (id: string, name: string): Upload => ({
  ok: true,
  ref: { id, name, mimeType: 'image/png', kind: 'image', url: `/x/${id}` },
});

function attach(name: string): void {
  fireEvent.change(screen.getByTestId('composer-file-input'), {
    target: { files: [new File(['bytes'], name, { type: 'image/png' })] },
  });
}

const inputs = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls
    .map(([e]) => e as WireEvent)
    .filter((e): e is Extract<WireEvent, { type: 'chat.input' }> => e.type === 'chat.input');

const userMsgs = () => screen.getAllByTestId('msg');

describe('ChatRoute — a message with attachments shows at once, pending, while it uploads', () => {
  let send: ReturnType<typeof vi.fn>;
  let ws: Ws;
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    _resetSendQueue();
    send = vi.fn();
    ws = { send, requestReplay: vi.fn() } as unknown as Ws;
    let n = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:local-${++n}`),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(imageResizeModule, 'downscaleImageFile').mockImplementation(async (f) => f);
    // spec/20-hooks.md — every send checks hooks first; nothing is configured
    // here, so this file is about the attachment/upload lifecycle, not hooks.
    vi.spyOn(api, 'checkHooks').mockResolvedValue({ decision: 'pass', results: [] });
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('clears the composer and shows the message pending, from the local image, before any upload lands', async () => {
    deferredUploads();
    seedChat('c-pu');
    renderChat('c-pu', ws);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'look at this' } });
    attach('photo.png');
    fireEvent.click(screen.getByTestId('send-btn'));

    // spec/20-hooks.md — the composer clears at once (nothing to restore
    // unless the check blocks), but the message itself lands in the stream
    // once the (mocked, near-instant) hook check has cleared it to send.
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryAllByTestId('composer-attachment')).toHaveLength(0);
    await waitFor(() => expect(userMsgs().at(-1)).toHaveTextContent('look at this'));
    const msg = userMsgs().at(-1)!;
    expect(within(msg).getByTestId('upload-status')).toHaveTextContent('Uploading 0/1');
    expect(within(msg).getByRole('img', { name: 'photo.png' })).toHaveAttribute(
      'src',
      'blob:local-1',
    );
    // Nothing has been sent — the agent never gets a message missing its image.
    expect(inputs(send)).toHaveLength(0);
    // The composer stays usable.
    expect(screen.getByTestId('composer-input')).not.toBeDisabled();
  });

  it('once every upload has landed, sends the turn with every ref under the same localId', async () => {
    const uploads = deferredUploads();
    seedChat('c-pu-ok');
    renderChat('c-pu-ok', ws);
    attach('a.png');
    attach('b.png');
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve(ref('a1', 'a.png')));
    await waitFor(() =>
      expect(within(userMsgs().at(-1)!).getByTestId('upload-status')).toHaveTextContent(
        'Uploading 1/2',
      ),
    );
    expect(inputs(send)).toHaveLength(0);
    await waitFor(() => expect(uploads).toHaveLength(2));
    await act(async () => uploads[1]!.resolve(ref('b1', 'b.png')));

    await waitFor(() => expect(inputs(send)).toHaveLength(1));
    const input = inputs(send)[0]!;
    expect(input.attachments?.map((a) => a.id)).toEqual(['a1', 'b1']);
    const entry = useChatStore
      .getState()
      .timelines['c-pu-ok']!.find((e) => e.localId === input.localId)!;
    expect(entry.upload).toBeUndefined();
    expect(entry.deliveryPending).toBe(true);
    expect(within(userMsgs().at(-1)!).queryByTestId('upload-status')).toBeNull();
  });

  it('a failed upload stays in the stream as Not uploaded; Retry uploads the same file again, then sends', async () => {
    const uploads = deferredUploads();
    seedChat('c-pu-fail');
    renderChat('c-pu-fail', ws);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'hi' } });
    attach('photo.png');
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.reject(new Error('413 too large')));

    const msg = userMsgs().at(-1)!;
    await waitFor(() =>
      expect(within(msg).getByTestId('upload-status')).toHaveTextContent('Not uploaded'),
    );
    expect(useUiStore.getState().errors.some((e) => /413 too large/.test(e.detail ?? ''))).toBe(
      true,
    );
    expect(inputs(send)).toHaveLength(0);

    fireEvent.click(within(msg).getByTestId('upload-retry'));
    await waitFor(() => expect(uploads).toHaveLength(2));
    const firstFile = vi.mocked(api.uploadAttachment).mock.calls[0]![1];
    expect(vi.mocked(api.uploadAttachment).mock.calls[1]![1]).toBe(firstFile);
    await act(async () => uploads[1]!.resolve(ref('p1', 'photo.png')));
    await waitFor(() => expect(inputs(send)).toHaveLength(1));
    expect(inputs(send)[0]).toMatchObject({ message: 'hi', attachments: [{ id: 'p1' }] });
  });

  it('× discards a message whose upload failed', async () => {
    const uploads = deferredUploads();
    seedChat('c-pu-discard');
    renderChat('c-pu-discard', ws);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'bye' } });
    attach('photo.png');
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.reject(new Error('boom')));
    await waitFor(() => screen.getByTestId('upload-discard'));
    fireEvent.click(screen.getByTestId('upload-discard'));
    expect(screen.queryAllByTestId('msg').some((m) => /bye/.test(m.textContent ?? ''))).toBe(false);
    expect(inputs(send)).toHaveLength(0);
  });

  it('a text sent behind an uploading message shows at once but is delivered after it', async () => {
    const uploads = deferredUploads();
    seedChat('c-pu-order');
    renderChat('c-pu-order', ws);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'first' } });
    attach('photo.png');
    fireEvent.click(screen.getByTestId('send-btn'));
    // spec/20-hooks.md — the first send's hook check (mocked, but still a
    // microtask) has to settle, and an empty composer offers Stop until the host
    // confirms the turn is running, so type the next message before looking for Send.
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'second' } });
    await waitFor(() => expect(screen.getByTestId('send-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('send-btn'));

    // spec/20-hooks.md — the optimistic echo now lands once the (mocked, near-
    // instant) hook check resolves rather than purely synchronously on click.
    await waitFor(() => expect(userMsgs().at(-1)).toHaveTextContent('second'));
    expect(inputs(send)).toHaveLength(0);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve(ref('p1', 'photo.png')));
    await waitFor(() => expect(inputs(send)).toHaveLength(2));
    expect(inputs(send).map((i) => i.message)).toEqual(['first', 'second']);
  });

  it('a failed upload does not hold up the message behind it', async () => {
    const uploads = deferredUploads();
    seedChat('c-pu-nohold');
    renderChat('c-pu-nohold', ws);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'first' } });
    attach('photo.png');
    fireEvent.click(screen.getByTestId('send-btn'));
    // spec/20-hooks.md — the first send's hook check (mocked, but still a
    // microtask) has to settle, and an empty composer offers Stop until the host
    // confirms the turn is running, so type the next message before looking for Send.
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'second' } });
    await waitFor(() => expect(screen.getByTestId('send-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.reject(new Error('boom')));
    await waitFor(() => expect(inputs(send)).toHaveLength(1));
    expect(inputs(send)[0]!.message).toBe('second');
  });
});
