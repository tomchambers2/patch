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

describe('viewing a chat', async () => {
  const { renderHook, act } = await import('@testing-library/react');
  const { useMarkChatNotificationsRead, useChatHasUnread } =
    await import('../stores/notificationsStore.js');
  const entry = (id: string, chatId: string, readAt: number | null) => ({
    id,
    chatId,
    message: id,
    importance: 'normal',
    sentAt: 1,
    readAt,
  });

  beforeEach(() => {
    markNotificationsRead.mockReset();
    markNotificationsRead.mockResolvedValue({ items: [], unread: 0 });
  });

  it('reports unread only for the chat that has one', () => {
    useNotificationsStore.setState({
      items: [entry('a', 'c1', null), entry('b', 'c2', 5)] as never,
    });
    expect(renderHook(() => useChatHasUnread('c1')).result.current).toBe(true);
    expect(renderHook(() => useChatHasUnread('c2')).result.current).toBe(false);
  });

  it("marks the viewed chat's unread entries read, and ones that arrive later", async () => {
    useNotificationsStore.setState({
      items: [entry('a', 'c1', null), entry('b', 'c2', null)] as never,
    });
    renderHook(() => useMarkChatNotificationsRead('c1'));
    expect(markNotificationsRead).toHaveBeenCalledWith({ ids: ['a'] });
    await act(async () => {
      useNotificationsStore.setState({
        items: [entry('c', 'c1', null), entry('b', 'c2', null)] as never,
      });
    });
    expect(markNotificationsRead).toHaveBeenLastCalledWith({ ids: ['c'] });
    expect(markNotificationsRead).toHaveBeenCalledTimes(2);
  });

  it('leaves other chats alone', () => {
    useNotificationsStore.setState({ items: [entry('b', 'c2', null)] as never });
    renderHook(() => useMarkChatNotificationsRead('c1'));
    expect(markNotificationsRead).not.toHaveBeenCalled();
  });
});
