// app/chats/[chatId].tsx — header + kebab menu + read-only-mirror composer
// gating (spec/15 ## Chat detail; spec/06 ## Composer policy). The FlatList/
// scroll-restore/PanResponder-zoom-viewer/timeline-item-rendering pieces of
// this screen have their own dedicated test files
// (chatDetail.timeline.test.tsx / chatDetail.scroll.test.tsx /
// chatDetail.zoom.test.tsx) — this file covers the top chrome: back/call/
// kebab buttons, the folder/title line, the awaiting-permission pill, the
// OfflineBanner/DaemonOfflineBanner mount, and the composer-vs-read-only-hint
// gate for Manager / Speakers / a regular chat.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byLabel,
  byTestId,
  hasText,
  textOf,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams, routerMock } from './stubs/expo-router';

const apiMocks = {
  deleteChat: vi.fn(async () => ({ ok: true as const })),
  pinChat: vi.fn(async () => undefined),
  snoozeChat: vi.fn(async () => undefined),
  archiveChat: vi.fn(async () => undefined),
  disableChat: vi.fn(async () => undefined),
  rotateChat: vi.fn(async () => ({ ok: true as const })),
  createChat: vi.fn(async () => ({
    chatId: 'c_fresh',
    folder: '/home/tom/project',
    status: 'pending' as const,
  })),
  markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
};
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

const startVoiceCallMock = vi.fn();
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: startVoiceCallMock }));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
});

function seedChat(
  chatId: string,
  overrides: {
    pinned?: boolean;
    status?: 'active' | 'archived' | 'errored';
    snoozedUntil?: number | null;
    daemonId?: string;
  } = {},
): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      ...overrides,
    },
  ]);
}

describe('chat-detail header', () => {
  it('shows the folder + derived title', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(textOf(findHost(r.root, byTestId('chat-folder')))).toBe('project');
    expect(hasText(r.root, 'My Chat')).toBe(true);
  });

  // Todoist "Patch mobile show host": web's crumb reads `folder · host`; with
  // several registered hosts the phone's header must say which machine the
  // chat runs on, each segment only when known.
  it('crumb reads `folder · host` when the chat has a known host', () => {
    seedChat('c1', { daemonId: 'd1' });
    usePresenceStore.getState().setHostReport({
      type: 'daemon.host',
      daemonId: 'd1',
      hostName: 'hetzner',
      platform: 'linux',
      arch: 'x64',
      daemonVersion: '0.1.400',
      updateAvailable: false,
      permissionModeDefault: 'default',
      permissionOverrides: 0,
      isHomeHost: false,
      backends: [],
      components: [],
    });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    const crumb = findHost(r.root, byTestId('chat-folder'));
    expect(textOf(crumb)).toBe('project · hetzner');
    expect(crumb.props.numberOfLines).toBe(1);
  });

  it('crumb omits the host segment when the chat has no host yet', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(textOf(findHost(r.root, byTestId('chat-folder')))).toBe('project');
  });

  // Todoist "Screenshot (Aug 28, 2026 17:35:21) can't see filename" reported a
  // second failure in the same frame: the crumb had NO numberOfLines, so
  // `/home/claude-dev/projects/portfolio` wrapped into a ~8-line, ~6-character
  // column inside its `flex: 1` box and squeezed the chat name — which IS
  // one-line — down to `R…`. The crumb is one line and reads the folder NAME
  // (`folderName`, spec/15 § Chat detail), the same rule the folder pickers use.
  it('the folder crumb is ONE line and shows the folder name, not the absolute path', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'Refactor the deploy script',
        folder: '/home/claude-dev/projects/portfolio',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    const crumb = findHost(r.root, byTestId('chat-folder'));
    expect(crumb.props.numberOfLines).toBe(1);
    expect(textOf(crumb)).toBe('portfolio');
    expect(hasText(r.root, '/home/claude-dev')).toBe(false);
    // And the title still gets the width it needs.
    expect(hasText(r.root, 'Refactor the deploy script')).toBe(true);
  });

  // Tom: "Manager chat says Manager twice" — a special thread's folder crumb is
  // the same word as its fixed title, so the crumb is not drawn at all.
  it('a special thread shows its title with NO folder crumb above it', () => {
    for (const id of [SPECIAL_THREAD_IDS.manager, SPECIAL_THREAD_IDS.speakers]) {
      useChatStore.getState()._reset();
      useChatStore.getState().hydrate([
        {
          chatId: id,
          name: null,
          folder: '/home/tom/Manager',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 1,
        },
      ]);
      __setLocalSearchParams({ chatId: id });
      const r = renderRN(<ChatDetailScreen />);
      expect(queryHost(r.root, byTestId('chat-folder'))).toBeNull();
    }
  });

  // The root layout's SafeAreaView already clears the status bar; the header
  // adds only a small normal gap on top of that, never a second inset's worth.
  it('the header adds only a small top padding (the inset is counted once, at the root)', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    const header = findHost(r.root, byTestId('chat-header'));
    const style = header.props.style as { paddingTop?: number };
    expect(style.paddingTop).toBeLessThanOrEqual(8);
  });

  it('falls back to "Chat" title + em dash folder when the row has not hydrated yet', () => {
    __setLocalSearchParams({ chatId: 'ghost' });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Chat')).toBe(true);
    expect(hasText(r.root, '—')).toBe(true);
  });

  it('a brand-new chat (ensureChat, pre-chat.spawned) renders its real folder + title, not the row-less fallback', () => {
    // End-to-end half of the "New chat locked up on mobile" fix. The new-chat
    // flow seeds the row before navigating, so by the time this screen mounts
    // the chat is known even though the host has not spawned it yet: the
    // crumb is the chosen folder's name rather than "—", and the title is the folder
    // basename rather than the generic "Chat" (spec/15 § Chat detail — the
    // title falls back to the folder basename before the AI name lands).
    useChatStore.getState().ensureChat('c_new', '/home/tom/work');
    __setLocalSearchParams({ chatId: 'c_new' });
    const r = renderRN(<ChatDetailScreen />);
    expect(textOf(findHost(r.root, byTestId('chat-folder')))).toBe('work');
    expect(hasText(r.root, 'work')).toBe(true);
    expect(hasText(r.root, '—')).toBe(false);
    // And the screen requests a replay for it, which is what subscribes this
    // surface to the chat's detail events on the server. The cursor is derived
    // inside the ws client, so both it and the connect handler ask the same
    // question (see coldStartDeepLink.integration.test.tsx).
    expect(wsMock.requestReplay).toHaveBeenCalledWith('c_new');
  });

  it('a spawn rejection on a brand-new chat is VISIBLE, not a silent empty room (spec/12 § No fallbacks)', () => {
    // The optimistic row must never become a screen that just sits there. A
    // host that refuses the spawn emits chat.error, which is deliberately
    // NOT detail-gated on the server, so it arrives whether or not the replay
    // subscription landed — and it renders as the red `turn-error` alert row.
    useChatStore.getState().ensureChat('c_new', '/home/tom/work');
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c_new',
      seq: 0,
      error: { code: 'no_model_catalogue', message: 'that machine has no last-used model' },
    });
    __setLocalSearchParams({ chatId: 'c_new' });
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('turn-error'))).toBeTruthy();
    expect(hasText(r.root, 'that machine has no last-used model')).toBe(true);
    expect(hasText(r.root, 'no_model_catalogue')).toBe(true);
  });

  it('back button navigates back', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    const back = findAllHost(r.root, (i) => i.type === 'Pressable')[0]!;
    back.props.onPress();
    expect(routerMock.back).toHaveBeenCalled();
  });

  // Opened on a cold start from a patch://chats/<id> link, the chat is the only
  // screen in the stack and `router.back()` would do nothing: the arrow goes to
  // the chat list instead (spec/15 § Navigation shell).
  it('back with nothing beneath it goes to the chat list', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    routerMock.canGoBack.mockReturnValueOnce(false);
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('Back')).props.onPress();
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/chats');
  });

  it('shows the "waiting on you" pill only when awaitingPermission', () => {
    seedChat('c1');
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 1,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'rm', args: {} },
    });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'waiting on you')).toBe(true);
  });

  it('the call button starts a voice call for a regular chat', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    const call = findHost(r.root, byLabel('Start voice call'));
    call.props.onPress();
    expect(startVoiceCallMock).toHaveBeenCalledWith('c1');
  });

  it('the call button is hidden on a read-only mirror thread (Speakers)', () => {
    seedChat(SPECIAL_THREAD_IDS.speakers);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.speakers });
    const r = renderRN(<ChatDetailScreen />);
    expect(() => findHost(r.root, byLabel('Start voice call'))).toThrow();
  });
});

describe('chat-detail — Tools (a page from the ⋯ menu, not a header wrench)', () => {
  it('there is no Tools icon in the header any more', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(() => findHost(r.root, byLabel('Tools'))).toThrow();
    expect(findAllHost(r.root, (i) => i.type === 'Icon' && i.props.name === 'Wrench')).toHaveLength(
      0,
    );
  });

  it('⋯ → Tools pushes the full-screen tools page for THIS chat', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem')
      .find((i) => hasText(i, 'Tools'))!
      .props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c1/tools');
  });
});

describe('chat-detail — title tap opens the full name in a modal', () => {
  // The RN Modal stub mirrors the real component: it renders NOTHING while
  // `visible` is false, so "closed" is asserted by absence, not by a
  // visible=false prop on a mounted node.
  it('is closed by default', () => {
    seedChat('c1', { pinned: false });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('chat-title-modal'))).toBeNull();
  });

  it('tapping the title/folder crumb opens it, showing the full folder + title', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'A chat name long enough that the header would have to clip it',
        folder: '/home/claude-dev/projects/some-very-long-project-folder-name',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('Chat name — tap to view in full')).props.onPress();
    expect(queryHost(r.root, byTestId('chat-title-modal'))).not.toBeNull();
    expect(hasText(r.root, '/home/claude-dev/projects/some-very-long-project-folder-name')).toBe(
      true,
    );
    expect(hasText(r.root, 'A chat name long enough that the header would have to clip it')).toBe(
      true,
    );
  });

  it('tapping the backdrop closes it again', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('Chat name — tap to view in full')).props.onPress();
    expect(queryHost(r.root, byTestId('chat-title-modal'))).not.toBeNull();
    findHost(r.root, byTestId('chat-title-modal-backdrop')).props.onPress();
    expect(queryHost(r.root, byTestId('chat-title-modal'))).toBeNull();
  });
});

describe('chat-detail — composer vs read-only hint (spec/06 ## Composer policy)', () => {
  it('a regular chat keeps the full composer (a TextInput, not a readonly hint)', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, (i) => i.type === 'TextInput')).toHaveLength(1);
    expect(hasText(r.root, 'Read-only')).toBe(false);
  });

  it('Manager keeps the full composer', () => {
    seedChat(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Read-only')).toBe(false);
  });

  it('Speakers shows the read-only transcript hint', () => {
    seedChat(SPECIAL_THREAD_IDS.speakers);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.speakers });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Read-only transcript')).toBe(true);
  });
});

describe('chat-detail — kebab menu', () => {
  function menuLabels(root: Parameters<typeof findAllHost>[0]): string[] {
    return findAllHost(root, (i) => i.props.accessibilityRole === 'menuitem').map(
      (i) => i.props.accessibilityLabel as string,
    );
  }
  function tapItem(root: Parameters<typeof findAllHost>[0], label: string): void {
    findAllHost(root, (i) => i.props.accessibilityRole === 'menuitem')
      .find((i) => hasText(i, label))!
      .props.onPress();
  }

  it('orders the items New chat, Call, Tools, Pin, Snooze, Archive, then Delete last', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    expect(menuLabels(r.root)).toEqual([
      'New chat',
      'Call',
      'Tools',
      'Pin chat',
      'Snooze chat',
      'Archive chat',
      'Move to…',
      'Delete chat',
    ]);
  });

  it('New chat opens the new-chat screen on the SAME folder and host, creating nothing yet', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'My Chat',
        daemonId: 'd1',
        folder: '/home/tom/project',
        activity: 'idle',
        permissionMode: 'auto',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    tapItem(r.root, 'New chat');
    expect(apiMocks.createChat).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/new-chat',
      params: { daemonId: 'd1', folder: '/home/tom/project' },
    });
  });

  it('New chat on a chat whose host is not known yet says so rather than guessing', async () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    tapItem(r.root, 'New chat');
    await Promise.resolve();
    expect(apiMocks.createChat).not.toHaveBeenCalled();
    const { useUiStore } = await import('../src/stores/uiStore');
    expect(useUiStore.getState().errors.at(-1)?.message).toMatch(/machine isn't known/);
  });

  it('Call in the menu starts the same voice call as the header button', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    tapItem(r.root, 'Call');
    expect(startVoiceCallMock).toHaveBeenCalledWith('c1');
  });

  it('Archive chat archives through the same API the list uses and navigates back', async () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    tapItem(r.root, 'Archive chat');
    await Promise.resolve();
    expect(apiMocks.archiveChat).toHaveBeenCalledWith('c1', true);
    expect(useChatStore.getState().chats['c1']!.status).toBe('archived');
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('an archived chat offers Unarchive chat, which restores it and stays put', async () => {
    seedChat('c1', { status: 'archived' });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    expect(menuLabels(r.root)).toEqual([
      'New chat',
      'Call',
      'Tools',
      'Pin chat',
      'Snooze chat',
      'Unarchive chat',
      'Move to…',
      'Delete chat',
    ]);
    tapItem(r.root, 'Unarchive chat');
    await Promise.resolve();
    expect(apiMocks.archiveChat).toHaveBeenCalledWith('c1', false);
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('Manager shows the menu with what applies: New chat, Call, Tools, Disable, Clear context', () => {
    seedChat(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    expect(menuLabels(r.root)).toEqual(['New chat', 'Call', 'Tools', 'Disable', 'Clear context']);
  });

  it('Disable on Manager turns it off through the same route as web, then offers Enable', async () => {
    seedChat(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    tapItem(r.root, 'Disable');
    await Promise.resolve();
    expect(apiMocks.disableChat).toHaveBeenCalledWith(SPECIAL_THREAD_IDS.manager, true);
    expect(useChatStore.getState().chats[SPECIAL_THREAD_IDS.manager]!.disabled).toBe(true);
    findHost(r.root, byLabel('More')).props.onPress();
    expect(menuLabels(r.root)).toContain('Enable');
  });

  it('Clear context on Manager calls rotateChat through the same route as web', async () => {
    seedChat(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    tapItem(r.root, 'Clear context');
    await Promise.resolve();
    expect(apiMocks.rotateChat).toHaveBeenCalledWith(SPECIAL_THREAD_IDS.manager);
  });

  it('New chat from Manager opens the folder picker (its folder is not a project)', () => {
    seedChat(SPECIAL_THREAD_IDS.manager);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.manager });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    tapItem(r.root, 'New chat');
    expect(apiMocks.createChat).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith('/new-chat');
  });

  it('opens on tap and Delete chat removes the chat + navigates back', async () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    // AnchoredMenu should now render its items.
    expect(hasText(r.root, 'Delete chat')).toBe(true);
    const del = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem').find((i) =>
      hasText(i, 'Delete chat'),
    )!;
    del.props.onPress();
    await Promise.resolve();
    expect(apiMocks.deleteChat).toHaveBeenCalledWith('c1');
    expect(routerMock.back).toHaveBeenCalled();
    expect(useChatStore.getState().chats['c1']).toBeUndefined();
  });

  it('Pin chat pins an unpinned chat', async () => {
    seedChat('c1', { pinned: false });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    const pin = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem').find((i) =>
      hasText(i, 'Pin chat'),
    )!;
    pin.props.onPress();
    await Promise.resolve();
    expect(apiMocks.pinChat).toHaveBeenCalledWith('c1', true);
    expect(useChatStore.getState().chats['c1']!.pinned).toBe(true);
  });

  it('Unpin chat unpins a pinned chat', async () => {
    seedChat('c1', { pinned: true });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    const unpin = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem').find((i) =>
      hasText(i, 'Unpin chat'),
    )!;
    unpin.props.onPress();
    await Promise.resolve();
    expect(apiMocks.pinChat).toHaveBeenCalledWith('c1', false);
  });

  it('dismisses without acting when the backdrop is tapped', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    findHost(r.root, byLabel('Dismiss menu')).props.onPress();
    expect(apiMocks.deleteChat).not.toHaveBeenCalled();
    expect(apiMocks.pinChat).not.toHaveBeenCalled();
  });

  // Snooze from the chat detail (spec/15 ## Chat detail; spec/04 § Snooze).
  // The kebab hands off to the SAME preset sheet the Chats-tab row tools open,
  // so there is one preset ladder on the phone, not two.
  it('Snooze chat opens the preset sheet without committing anything', async () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    const snooze = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem').find((i) =>
      hasText(i, 'Snooze chat'),
    )!;
    snooze.props.onPress();
    expect(apiMocks.snoozeChat).not.toHaveBeenCalled();

    // The sheet lives at the app root, not in this screen — render it against
    // the same (shared) store to prove the hand-off actually landed.
    const { ChatLongPressSheet } = await import('../src/components/ChatLongPressSheet');
    const sheet = renderRN(<ChatLongPressSheet />);
    expect(hasText(sheet.root, '1 hour')).toBe(true);
  });

  it('a snoozed chat offers Unsnooze chat, clearing it in one tap', async () => {
    seedChat('c1', { snoozedUntil: Date.now() + 60 * 60_000 });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    expect(hasText(r.root, 'Snooze chat')).toBe(false);
    const unsnooze = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem').find(
      (i) => hasText(i, 'Unsnooze chat'),
    )!;
    unsnooze.props.onPress();
    await Promise.resolve();
    expect(apiMocks.snoozeChat).toHaveBeenCalledWith('c1', null);
    expect(useChatStore.getState().chats['c1']!.snoozedUntil).toBeNull();
  });

  it('a snoozed chat names its wake time in a banner above the transcript', () => {
    seedChat('c1', { snoozedUntil: Date.now() + 60 * 60_000 });
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(findHost(r.root, byTestId('snoozed-banner')), 'Snoozed until')).toBe(true);
  });

  it('mounts the status bars above the transcript (goal, tasks, archived)', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'My Chat',
        daemonId: 'd1',
        folder: '~/project',
        activity: 'idle',
        permissionMode: 'auto',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
        goal: 'Ship the bars',
        todos: [{ text: 'Port TaskBar', status: 'in_progress' }],
      },
    ]);
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(findHost(r.root, byTestId('goal-bar')), 'Ship the bars')).toBe(true);
    expect(hasText(findHost(r.root, byTestId('task-bar')), 'Port TaskBar')).toBe(true);
    expect(findHost(r.root, byTestId('archived-bar'))).toBeTruthy();
  });

  it('an unsnoozed chat has no banner', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    expect(() => findHost(r.root, byTestId('snoozed-banner'))).toThrow();
  });

  it('Pin chat still works (defaults to unpinned) when the row has not hydrated yet', async () => {
    // No hydrate() call for this chatId — `row` is undefined; the pin toggle
    // reads `row?.pinned ?? false`.
    __setLocalSearchParams({ chatId: 'ghost' });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byLabel('More')).props.onPress();
    const pin = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem').find((i) =>
      hasText(i, 'Pin chat'),
    )!;
    pin.props.onPress();
    await Promise.resolve();
    expect(apiMocks.pinChat).toHaveBeenCalledWith('ghost', true);
  });
});

describe('chat-detail — KeyboardAvoidingView behavior prop (iOS vs Android)', () => {
  it('pads on iOS', async () => {
    const { Platform } = await import('react-native');
    const prev = Platform.OS;
    Platform.OS = 'ios';
    try {
      seedChat('c1');
      __setLocalSearchParams({ chatId: 'c1' });
      const r = renderRN(<ChatDetailScreen />);
      const kav = findHost(r.root, (i) => i.type === 'KeyboardAvoidingView');
      expect(kav.props.behavior).toBe('padding');
    } finally {
      Platform.OS = prev;
    }
  });

  it('no behavior override off-iOS (Android window is adjustResize)', () => {
    seedChat('c1');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatDetailScreen />);
    const kav = findHost(r.root, (i) => i.type === 'KeyboardAvoidingView');
    expect(kav.props.behavior).toBeUndefined();
  });
});
