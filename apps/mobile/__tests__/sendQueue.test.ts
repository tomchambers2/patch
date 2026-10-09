// lib/sendQueue.ts + the chatStore actions it drives (spec/15 § Composer →
// Attachments). The end-to-end behaviour — composer, transcript, Retry/× — is
// pinned in pendingUpload.integration.test.tsx; this covers the module's own
// contract and the edges a screen cannot reach.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { uploadAttachmentSpy, wsSend } = vi.hoisted(() => ({
  uploadAttachmentSpy: vi.fn(),
  wsSend: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({ api: { uploadAttachment: uploadAttachmentSpy } }));
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: wsSend }) }));

import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useToolsStore } from '../src/stores/toolsStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { _resetSendQueue, discardUpload, retryUpload, sendMessage } from '../src/lib/sendQueue';

let submitSpy: ReturnType<typeof vi.spyOn>;

const file = (name: string) => ({
  key: `k-${name}`,
  uri: `file:///c/${name}`,
  name,
  mimeType: 'application/pdf',
  kind: 'file' as const,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  _resetSendQueue();
  uploadAttachmentSpy.mockReset();
  wsSend.mockReset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('sendMessage', () => {
  it('a text-only send is echoed and handed to delivery synchronously, like before', () => {
    const localId = sendMessage('c1', 'hello', []);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [chatId, text, id, refs] = submitSpy.mock.calls[0]!;
    expect([chatId, text, id, refs]).toEqual(['c1', 'hello', localId, undefined]);
    const entry = useChatStore.getState().timelines['c1']![0]!;
    expect(entry.deliveryPending).toBe(true);
    expect(entry.upload).toBeUndefined();
    expect(entry.localAttachments).toBeUndefined();
  });

  it('two sends in the same millisecond get distinct localIds', () => {
    const a = sendMessage('c1', 'a', []);
    const b = sendMessage('c1', 'b', []);
    expect(a).not.toBe(b);
  });

  it('delivery goes through the socket and carries the Tools OFF set captured at send time', () => {
    vi.spyOn(useToolsStore.getState(), 'disabledFor').mockReturnValue(['Bash']);
    sendMessage('c1', 'x', []);
    const [, , , , send, disabled] = submitSpy.mock.calls[0]!;
    expect(disabled).toEqual(['Bash']);
    (send as (e: unknown) => void)({ type: 'chat.input' });
    expect(wsSend).toHaveBeenCalledWith({ type: 'chat.input' });
  });

  it('chains are per chat: an upload in one chat does not hold up another', () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    sendMessage('c1', 'slow', [file('a.pdf')]);
    sendMessage('c2', 'fast', []);
    expect(submitSpy.mock.calls.map((c) => c[1])).toEqual(['fast']);
  });
});

describe('retryUpload / discardUpload', () => {
  it('Retry of a turn whose files are gone (app restarted) says so instead of doing nothing', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'old', 'L1', undefined, {
      localAttachments: [{ uri: 'file:///x', name: 'x', mimeType: 'text/plain', kind: 'file' }],
    });
    retryUpload('c1', 'L1');
    expect(useUiStore.getState().errors[0]?.message).toBe(
      'attachment upload failed: the files are no longer available — discard and resend',
    );
    expect(uploadAttachmentSpy).not.toHaveBeenCalled();
  });

  it('× removes the turn, and a later Retry of it has nothing to upload', async () => {
    uploadAttachmentSpy.mockRejectedValue(new Error('nope'));
    const localId = sendMessage('c1', 'bye', [file('a.pdf')]);
    await flush();
    discardUpload('c1', localId);
    expect(useChatStore.getState().timelines['c1']).toEqual([]);
    retryUpload('c1', localId);
    expect(uploadAttachmentSpy).toHaveBeenCalledTimes(1);
  });

  it('a retried turn rejoins the chain at the back: a turn sent after the retry waits for it', async () => {
    let fail = true;
    const parked: Array<(v: unknown) => void> = [];
    uploadAttachmentSpy.mockImplementation(() =>
      fail ? Promise.reject(new Error('x')) : new Promise((resolve) => parked.push(resolve)),
    );
    const localId = sendMessage('c1', 'retried', [file('a.pdf')]);
    await flush();
    fail = false;
    retryUpload('c1', localId);
    sendMessage('c1', 'after', []);
    expect(submitSpy).not.toHaveBeenCalled();
    parked[0]!({ ref: { id: 'i', name: 'a.pdf', mimeType: 'application/pdf', kind: 'file' } });
    await flush();
    expect(submitSpy.mock.calls.map((c) => c[1])).toEqual(['retried', 'after']);
  });
});

describe('chatStore — outgoing-turn actions', () => {
  it('patchLocalMessage / removeLocalMessage ignore a chat or turn that is not there', () => {
    const before = useChatStore.getState().timelines;
    useChatStore.getState().patchLocalMessage('nope', 'L1', { content: 'x' });
    useChatStore.getState().removeLocalMessage('nope', 'L1');
    expect(useChatStore.getState().timelines).toBe(before);
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    useChatStore.getState().patchLocalMessage('c1', 'other', { content: 'x' });
    expect(useChatStore.getState().timelines['c1']![0]!.content).toBe('hi');
  });

  it('a same-text persisted turn from elsewhere never swallows a turn still uploading', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'same', 'L1', undefined, {
      localAttachments: [{ uri: 'file:///x', name: 'x', mimeType: 'text/plain', kind: 'file' }],
    });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'user',
      content: 'same',
    });
    const list = useChatStore.getState().timelines['c1']!;
    expect(list).toHaveLength(2);
    expect(list[0]!.localId).toBe('L1');
    expect(list[0]!.upload).toEqual({ done: 0, total: 1, failed: false });
  });
});
