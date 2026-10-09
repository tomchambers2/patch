// "Send to new chat" (spec/14 § Message context menu): quotes a message or
// selection into an unsent new-chat draft on the source chat's host + folder.
import { describe, it, expect, beforeEach } from 'vitest';
import { sendToNewChat } from '../lib/sendToNewChat.js';
import { useChatStore } from '../stores/chatStore.js';
import { useDraftStore } from '../stores/draftStore.js';

describe('sendToNewChat', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'a chat',
        folder: '/home/me/proj',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 0,
        goal: null,
        reminder: null,
        pendingWake: null,
        todos: [],
        snoozedUntil: null,
      },
    ] as never);
  });

  it('mints a draft in the same folder and host, quoting the text, and returns its route', () => {
    const path = sendToNewChat('c1', 'line one\nline two');
    const id = new URL(path, 'http://x').searchParams.get('draft')!;
    const d = useDraftStore.getState().drafts[id]!;
    expect(path.startsWith('/chats/new?draft=')).toBe(true);
    expect(d.folder).toBe('/home/me/proj');
    expect(d.daemonId).toBe('d1');
    expect(d.text).toBe('> line one\n> line two\n\n');
  });

  it('throws for an unknown chat rather than guessing a folder', () => {
    expect(() => sendToNewChat('nope', 'x')).toThrow(/unknown chat/);
  });
});
