// G5 — ws.ts dispatch: a chat.permission_request arriving DURING a voice
// interaction surfaces the voice permission banner (spec/07 ## Permission
// prompts during voice), and the banner clears once the chat leaves the
// awaiting-permission state (the spoken yes/no was parsed host-side).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, STORE_BATCH_MS } from '../api/ws.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  url: string;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  addEventListener(name: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener(): void {}
  emit(name: string, data: unknown): void {
    for (const cb of this.listeners[name] ?? []) cb(data as MessageEvent);
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

const PERM = {
  type: 'chat.permission_request',
  chatId: 'c1',
  requestId: 'req-1',
  request: { tool: 'Bash', args: { command: 'rm -rf build' }, description: 'Bash: rm -rf build' },
  seq: 3,
};

/** Let the one-frame store batch window close (see STORE_BATCH_MS in ws.ts). */
function settleStoreBatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, STORE_BATCH_MS + 5));
}

describe('ws permission-during-voice', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
    useVoiceStore.setState({ note: null, call: null, permission: null });
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT raise the voice banner when no voice interaction is active', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    FakeWS.instances[0]!.receive(PERM);
    expect(useVoiceStore.getState().permission).toBeNull();
    ws.close();
  });

  it('raises the voice banner when a voice note is in flight', async () => {
    useVoiceStore.getState().startNote('c1', 'ptt');
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    FakeWS.instances[0]!.receive(PERM);
    const perm = useVoiceStore.getState().permission;
    expect(perm).not.toBeNull();
    expect(perm?.requestId).toBe('req-1');
    expect(perm?.summary).toBe('Bash: rm -rf build');
    ws.close();
  });

  it('clears the banner when the chat leaves awaiting-permission (spoken answer parsed)', async () => {
    useVoiceStore.getState().startCall('c1');
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive(PERM);
    expect(useVoiceStore.getState().permission).not.toBeNull();
    // Host parsed "yes" → turn resumes → chat.state activity:'running'.
    fake.receive({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: Date.now(),
    });
    expect(useVoiceStore.getState().permission).toBeNull();
    ws.close();
  });

  // G5-9: the spoken yes/no path resolves the request DAEMON-SIDE, so the
  // surface never sent the response. The host echoes `chat.permission_response`
  // (carrying chatId) and the surface must flip the matching INLINE permission
  // card to resolved — not just dismiss the voice banner.
  it('resolves the inline card when the host echoes chat.permission_response (spoken yes)', async () => {
    useVoiceStore.getState().startCall('c1');
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    // The request landed as a timeline card + raised the voice banner. The
    // banner is raised synchronously; the timeline commit is coalesced by one
    // frame (STORE_BATCH_MS), so let the batch window close before reading it.
    fake.receive(PERM);
    expect(useVoiceStore.getState().permission).not.toBeNull();
    await settleStoreBatch();
    const before = useChatStore.getState().timelines['c1']!.find((e) => e.kind === 'permission');
    expect(before).toBeDefined();
    expect((before as { permissionResolved?: string }).permissionResolved).toBeUndefined();
    expect(useChatStore.getState().chats['c1']!.pendingPermissions).toHaveLength(1);

    // Host resolved the spoken "yes" and echoes the response to surfaces.
    fake.receive({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'req-1',
      approve: true,
      decision: 'approve',
    });

    const after = useChatStore.getState().timelines['c1']!.find((e) => e.kind === 'permission');
    expect((after as { permissionResolved?: string }).permissionResolved).toBe('approve');
    expect(useChatStore.getState().chats['c1']!.pendingPermissions).toHaveLength(0);
    // Banner cleared too.
    expect(useVoiceStore.getState().permission).toBeNull();
    ws.close();
  });

  it('resolves the inline card to denied on a spoken no echo', async () => {
    useVoiceStore.getState().startCall('c1');
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    // Deliberately NO batch settle between the two: the request and its echo
    // arrive inside the SAME store batch window. `resolvePermission` edits the
    // committed timeline, so dispatch must land the queued request before
    // resolving it — otherwise the resolve finds no card and the request then
    // commits unresolved, leaving a permission prompt stuck pending on a
    // question that was already answered.
    fake.receive(PERM);
    fake.receive({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'req-1',
      approve: false,
      decision: 'deny',
    });
    const after = useChatStore.getState().timelines['c1']!.find((e) => e.kind === 'permission');
    expect((after as { permissionResolved?: string }).permissionResolved).toBe('deny');
    expect(useVoiceStore.getState().permission).toBeNull();
    ws.close();
  });
});
