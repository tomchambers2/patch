import { describe, it, expect, vi, beforeEach } from 'vitest';

const getNotifications = vi.fn();
const markNotificationsRead = vi.fn();
vi.mock('../api/rest.js', () => ({ api: { getNotifications, markNotificationsRead } }));

const { useNotificationsStore } = await import('../stores/notificationsStore.js');

describe('notificationsStore', () => {
  beforeEach(() => {
    getNotifications.mockReset();
    markNotificationsRead.mockReset();
    useNotificationsStore.setState({ items: [], unread: 0, error: null });
  });

  it('loads items and unread from the server', async () => {
    getNotifications.mockResolvedValue({ items: [{ id: 'a' }], unread: 1 });
    await useNotificationsStore.getState().load();
    expect(useNotificationsStore.getState()).toMatchObject({ unread: 1, error: null });
  });

  it('surfaces a failed load instead of showing an empty list as truth', async () => {
    getNotifications.mockRejectedValue(new Error('HTTP 500'));
    await useNotificationsStore.getState().load();
    expect(useNotificationsStore.getState().error).toBe('HTTP 500');
  });

  it('takes the server answer on markRead', async () => {
    markNotificationsRead.mockResolvedValue({ items: [], unread: 0 });
    useNotificationsStore.setState({ unread: 3 });
    await useNotificationsStore.getState().markRead({ all: true });
    expect(markNotificationsRead).toHaveBeenCalledWith({ all: true });
    expect(useNotificationsStore.getState().unread).toBe(0);
  });
});
