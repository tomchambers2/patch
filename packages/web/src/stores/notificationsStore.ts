// Agent-notification log (spec/09 § bell), mirrored from the server.
//
// NO FALLBACK: a failed load leaves `error` set for the bell to show, rather
// than presenting an empty list as the truth.

import { useEffect } from 'react';
import { create } from 'zustand';
import { api, type NotificationEntry } from '../api/rest.js';

interface NotificationsState {
  items: NotificationEntry[];
  unread: number;
  error: string | null;
  load(): Promise<void>;
  markRead(target: { ids: string[] } | { all: true }): Promise<void>;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  items: [],
  unread: 0,
  error: null,
  async load() {
    try {
      const r = await api.getNotifications();
      set({ items: r.items, unread: r.unread, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  async markRead(target) {
    try {
      const r = await api.markNotificationsRead(target);
      set({ items: r.items, unread: r.unread, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));

/** True when the chat has at least one unread agent notification (spec/09 § bell). */
export function useChatHasUnread(chatId: string): boolean {
  return useNotificationsStore((s) =>
    s.items.some((n) => n.chatId === chatId && n.readAt === null),
  );
}

/**
 * Looking at a chat reads its notifications (spec/09 § bell): while `chatId`
 * is on screen, any unread entry for it — already there or arriving live — is
 * marked read.
 */
export function useMarkChatNotificationsRead(chatId: string): void {
  const ids = useNotificationsStore((s) =>
    s.items
      .filter((n) => n.chatId === chatId && n.readAt === null)
      .map((n) => n.id)
      .join(','),
  );
  useEffect(() => {
    if (ids === '') return;
    void useNotificationsStore.getState().markRead({ ids: ids.split(',') });
  }, [ids]);
}
