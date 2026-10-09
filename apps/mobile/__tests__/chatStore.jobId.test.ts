// Which chats a JOB started (spec/08 § Action) — the phone needs it to leave
// them out of the new-chat screen's recently used models (spec/14 § Sidebar
// §8, spec/15 § New chat flow). Set once at spawn, by the server, and carried
// on both the roster and `chat.spawned`; web's chatStore holds it the same way.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import { toChatListRow } from '../src/lib/chatListRow';
import type { ChatListEntry } from '../src/api/rest';

function entry(chatId: string, jobId?: string | null): ChatListEntry {
  return {
    chatId,
    name: null,
    daemonId: 'd1',
    folder: '/f',
    activity: 'idle',
    permissionMode: 'default',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    pendingWake: null,
    snoozedUntil: null,
    ...(jobId !== undefined ? { jobId } : {}),
  };
}

const hydrate = (...entries: ChatListEntry[]): void =>
  useChatStore.getState().hydrate(entries.map(toChatListRow));

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chatStore jobId', () => {
  it('takes the job from the roster, and null for a chat a person started', () => {
    hydrate(entry('jobchat-j1', 'j1'), entry('mine', null));
    const chats = useChatStore.getState().chats;
    expect(chats['jobchat-j1']?.jobId).toBe('j1');
    expect(chats['mine']?.jobId).toBeNull();
  });

  it('keeps a known job when a roster row omits the field (an older server)', () => {
    hydrate(entry('jobchat-j1', 'j1'));
    hydrate(entry('jobchat-j1'));
    expect(useChatStore.getState().chats['jobchat-j1']?.jobId).toBe('j1');
    useChatStore.getState().mergeRows([toChatListRow(entry('jobchat-j1'))]);
    expect(useChatStore.getState().chats['jobchat-j1']?.jobId).toBe('j1');
  });

  it('takes the job from chat.spawned, and leaves a user-started chat at null', () => {
    const { applyEvent } = useChatStore.getState();
    applyEvent({
      type: 'chat.spawned',
      chatId: 'c_job',
      daemonId: 'd1',
      folder: '/f',
      jobId: 'j2',
    });
    applyEvent({ type: 'chat.spawned', chatId: 'c_mine', daemonId: 'd1', folder: '/f' });
    const chats = useChatStore.getState().chats;
    expect(chats['c_job']?.jobId).toBe('j2');
    expect(chats['c_mine']?.jobId).toBeNull();
  });

  it('a later chat.spawned without a job does not wipe the one already known', () => {
    hydrate(entry('jobchat-j1', 'j1'));
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', chatId: 'jobchat-j1', daemonId: 'd1', folder: '/f' });
    expect(useChatStore.getState().chats['jobchat-j1']?.jobId).toBe('j1');
  });
});
