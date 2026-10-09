// Agent-notification log (spec/09 § bell), mirrored from the server.
//
// NO FALLBACK: a failed load leaves `error` set for the bell to show, rather
// than presenting an empty list as the truth.

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
