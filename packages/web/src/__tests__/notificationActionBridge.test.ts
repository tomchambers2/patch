// notificationActionBridge.ts — the renderer half of spec/09 § Notification
// actions on desktop. Main decides WHAT a reply/action tap means
// (packages/desktop/src/notificationActions.ts) and hands the intent here;
// this module is the thin wiring that sends it through the SAME
// guaranteed-delivery path the composer / QuestionCard use, and reports back
// whether it went out. Each lower-level call (sendMessage,
// permissionDeliveryTracker, chatStore.resolvePermission) already has its
// own exhaustive tests — these pin only the wiring: right call, right args,
// right result reported back.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationSendPayload, PatchDesktopBridge } from '../lib/desktopBridge.js';

const sendMessage = vi.fn();
vi.mock('../lib/sendQueue.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

const permissionSend = vi.fn();
vi.mock('../lib/permissionDeliveryTracker.js', () => ({
  permissionDeliveryTracker: { send: (...args: unknown[]) => permissionSend(...args) },
}));

const resolvePermission = vi.fn();
vi.mock('../stores/chatStore.js', () => ({
  useChatStore: { getState: () => ({ resolvePermission }) },
}));

let connection: 'connected' | 'offline' = 'connected';
vi.mock('../stores/presenceStore.js', () => ({
  usePresenceStore: { getState: () => ({ connection }) },
}));

let activeWs: { send: ReturnType<typeof vi.fn> } | null = { send: vi.fn() };
vi.mock('../api/ws.js', () => ({ getActiveWs: () => activeWs }));

import {
  initNotificationActionBridge,
  _resetNotificationActionBridge,
} from '../lib/notificationActionBridge.js';

function installBridge(): {
  send: (payload: NotificationSendPayload) => void;
  result: ReturnType<typeof vi.fn>;
} {
  let handler: ((payload: NotificationSendPayload) => void) | null = null;
  const result = vi.fn();
  const bridge: Partial<PatchDesktopBridge> = {
    onNotificationSend: (cb) => {
      handler = cb;
      return () => {
        handler = null;
      };
    },
    notificationSendResult: result,
  };
  (window as unknown as { patch?: PatchDesktopBridge }).patch = bridge as PatchDesktopBridge;
  return {
    send: (payload) => handler?.(payload),
    result,
  };
}

describe('notificationActionBridge', () => {
  beforeEach(() => {
    _resetNotificationActionBridge();
    delete (window as unknown as { patch?: PatchDesktopBridge }).patch;
    connection = 'connected';
    activeWs = { send: vi.fn() };
    sendMessage.mockClear();
    permissionSend.mockClear();
    resolvePermission.mockClear();
  });

  it('is a no-op in a plain browser (no bridge)', () => {
    expect(() => initNotificationActionBridge()).not.toThrow();
  });

  it('is idempotent — calling init twice does not subscribe twice', () => {
    const { send, result } = installBridge();
    initNotificationActionBridge();
    initNotificationActionBridge();
    send({ requestId: 'r1', chatId: 'c1', intent: { kind: 'reply', text: 'hi' } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
  });

  it('a reply sends through sendMessage and reports ok:true', () => {
    const { send, result } = installBridge();
    initNotificationActionBridge();
    send({ requestId: 'r1', chatId: 'c1', intent: { kind: 'reply', text: 'on my way' } });
    expect(sendMessage).toHaveBeenCalledWith('c1', 'on my way', []);
    expect(result).toHaveBeenCalledWith('r1', true);
  });

  it('an ignore intent reports ok:true without sending anything', () => {
    const { send, result } = installBridge();
    initNotificationActionBridge();
    send({ requestId: 'r1', chatId: 'c1', intent: { kind: 'ignore' } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(permissionSend).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledWith('r1', true);
  });

  it('a permission decision sends chat.permission_response and resolves it locally', () => {
    const { send, result } = installBridge();
    initNotificationActionBridge();
    send({
      requestId: 'r1',
      chatId: 'c1',
      intent: { kind: 'permission', requestId: 'req-9', decision: 'deny' },
    });
    expect(permissionSend).toHaveBeenCalledWith(
      { type: 'chat.permission_response', chatId: 'c1', requestId: 'req-9', approve: false },
      expect.any(Function),
    );
    expect(resolvePermission).toHaveBeenCalledWith('c1', 'req-9', 'deny');
    expect(result).toHaveBeenCalledWith('r1', true);
  });

  it('a question answer sends approve_with_edits keyed on the question text', () => {
    const { send, result } = installBridge();
    initNotificationActionBridge();
    send({
      requestId: 'r1',
      chatId: 'c1',
      intent: {
        kind: 'question_answer',
        requestId: 'req-9',
        questionText: 'Which bed?',
        answer: 'North',
      },
    });
    expect(permissionSend).toHaveBeenCalledWith(
      {
        type: 'chat.permission_response',
        chatId: 'c1',
        requestId: 'req-9',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: JSON.stringify({ 'Which bed?': 'North' }),
      },
      expect.any(Function),
    );
    expect(resolvePermission).toHaveBeenCalledWith('c1', 'req-9', 'approve', {
      'Which bed?': 'North',
    });
    expect(result).toHaveBeenCalledWith('r1', true);
  });

  it('reports ok:false when offline, without touching any delivery path', () => {
    connection = 'offline';
    const { send, result } = installBridge();
    initNotificationActionBridge();
    send({ requestId: 'r1', chatId: 'c1', intent: { kind: 'reply', text: 'hi' } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledWith('r1', false);
  });

  it('reports ok:false when there is no active socket even if presence says connected', () => {
    activeWs = null;
    const { send, result } = installBridge();
    initNotificationActionBridge();
    send({
      requestId: 'r1',
      chatId: 'c1',
      intent: { kind: 'permission', requestId: 'req-9', decision: 'approve' },
    });
    expect(permissionSend).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledWith('r1', false);
  });
});
