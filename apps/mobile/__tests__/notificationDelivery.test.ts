import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveCredential, clearCredential } from '../src/lib/credential';
import {
  sendBackgroundChatInput,
  sendBackgroundPermissionDecision,
  sendBackgroundQuestionAnswer,
} from '../src/lib/notificationDelivery';
import { FakeWebSocket, installFakeWebSocket, restoreWebSocket } from './testUtils/fakeWebSocket';

beforeEach(async () => {
  const { __clearAllMmkv } = await import('./stubs/mmkv');
  __clearAllMmkv();
  installFakeWebSocket();
});
afterEach(() => {
  restoreWebSocket();
});

describe('sendBackgroundChatInput', () => {
  it('throws when the device is not linked', async () => {
    clearCredential();
    await expect(sendBackgroundChatInput('c1', 'hello')).rejects.toThrow('not linked');
  });

  it('sends hello then chat.input, resolves sent on the matching ack, and closes', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundChatInput('c1', 'hello');
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    expect(JSON.parse(ws.sent[0] as string)).toMatchObject({ type: 'hello', auth: 'jwt' });
    const input = JSON.parse(ws.sent[1] as string) as {
      type: string;
      chatId: string;
      message: string;
      localId: string;
    };
    expect(input).toMatchObject({ type: 'chat.input', chatId: 'c1', message: 'hello' });
    ws.emitMessage(
      JSON.stringify({ type: 'chat.input_ack', chatId: 'c1', localId: input.localId }),
    );
    await expect(promise).resolves.toBe('sent');
    expect(ws.close).toHaveBeenCalled();
  });

  it('a chat.queued ack also counts as sent (type queued behind a running turn)', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundChatInput('c1', 'hello');
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    const input = JSON.parse(ws.sent[1] as string) as { localId: string };
    ws.emitMessage(JSON.stringify({ type: 'chat.queued', chatId: 'c1', localId: input.localId }));
    await expect(promise).resolves.toBe('sent');
  });

  it('an ack for a different chatId/localId does not settle it', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundChatInput('c1', 'hello', { timeoutMs: 20 });
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    ws.emitMessage(JSON.stringify({ type: 'chat.input_ack', chatId: 'other', localId: 'x' }));
    await expect(promise).resolves.toBe('failed');
  });

  it('resolves failed on timeout, socket error, or close before an ack', async () => {
    saveCredential('jwt');
    await expect(sendBackgroundChatInput('c1', 'x', { timeoutMs: 10 })).resolves.toBe('failed');

    saveCredential('jwt');
    const p2 = sendBackgroundChatInput('c1', 'x', { timeoutMs: 1000 });
    FakeWebSocket.last().emitError();
    await expect(p2).resolves.toBe('failed');

    saveCredential('jwt');
    const p3 = sendBackgroundChatInput('c1', 'x', { timeoutMs: 1000 });
    FakeWebSocket.last().emitClose();
    await expect(p3).resolves.toBe('failed');
  });

  it('ignores a non-JSON / non-string / non-object-JSON message', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundChatInput('c1', 'x', { timeoutMs: 20 });
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    ws.emitMessage('not json');
    ws.emitMessage(new ArrayBuffer(0));
    // Valid JSON that parses to a non-object (a bare number/string/null).
    ws.emitMessage('42');
    ws.emitMessage('null');
    await expect(promise).resolves.toBe('failed');
  });

  it('swallows a close() that itself throws', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundChatInput('c1', 'x', { timeoutMs: 10 });
    FakeWebSocket.last().close.mockImplementationOnce(() => {
      throw new Error('already closed');
    });
    await expect(promise).resolves.toBe('failed');
  });
});

describe('sendBackgroundPermissionDecision', () => {
  it('sends chat.permission_response and resolves sent on the matching echo', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundPermissionDecision('mac-chat', 'req-9', 'deny');
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    const sent = JSON.parse(ws.sent[1] as string);
    expect(sent).toEqual({
      type: 'chat.permission_response',
      // Names the chat so the server relays to its owning host (a Mac chat
      // answered with no chatId went to Hetzner and was lost).
      chatId: 'mac-chat',
      requestId: 'req-9',
      approve: false,
      decision: 'deny',
    });
    ws.emitMessage(JSON.stringify({ type: 'chat.permission_response', requestId: 'req-9' }));
    await expect(promise).resolves.toBe('sent');
  });

  it('approve maps to approve:true', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundPermissionDecision('mac-chat', 'req-9', 'approve');
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    expect(JSON.parse(ws.sent[1] as string)).toMatchObject({ approve: true, decision: 'approve' });
    ws.emitMessage(JSON.stringify({ type: 'chat.permission_response', requestId: 'req-9' }));
    await expect(promise).resolves.toBe('sent');
  });

  it('an echo for a different requestId does not settle it', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundPermissionDecision('mac-chat', 'req-9', 'approve', {
      timeoutMs: 20,
    });
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    ws.emitMessage(JSON.stringify({ type: 'chat.permission_response', requestId: 'other' }));
    await expect(promise).resolves.toBe('failed');
  });
});

describe('sendBackgroundQuestionAnswer', () => {
  it('sends approve_with_edits carrying the answer keyed on the question text', async () => {
    saveCredential('jwt');
    const promise = sendBackgroundQuestionAnswer('mac-chat', 'req-9', 'Which bed?', 'North');
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    const sent = JSON.parse(ws.sent[1] as string);
    expect(sent).toEqual({
      type: 'chat.permission_response',
      // Names the chat so the server relays to its owning host (a Mac chat
      // answered with no chatId went to Hetzner and was lost).
      chatId: 'mac-chat',
      requestId: 'req-9',
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which bed?': 'North' }),
    });
    ws.emitMessage(JSON.stringify({ type: 'chat.permission_response', requestId: 'req-9' }));
    await expect(promise).resolves.toBe('sent');
  });
});
