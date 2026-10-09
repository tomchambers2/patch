// The chat's permission mode on the phone is a PADLOCK on the composer's action
// row (spec/15 § Composer — Permission mode padlock), not the full-width
// "Permission mode · X" bar that used to sit above the composer. Pins:
//   - the bar is gone; the padlock is in the composer's action row
//   - the padlock's icon says which mode: default a closed Lock, acceptEdits /
//     plan / auto each their own glyph, bypass an open lock in the danger red
//   - tapping it lists the modes by friendly name, the one in force ticked
//   - a mode the chat's model cannot run is listed greyed and cannot be chosen
//     (web's `permissionModesFor` rule), while the value sent on
//     `chat.settings` is still the SDK's own mode id

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PermissionMode } from '@patch/wire';
import type { ReactTestInstance } from 'react-test-renderer';
import { renderRN, findHost, findAllHost, queryHost, byTestId } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useTheme } from '../src/lib/theme';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(async () => ({ ok: true as const })),
    pinChat: vi.fn(async () => undefined),
    skills: vi.fn(async () => ({ skills: [] })),
    models: vi.fn(async () => ({ models: [] })),
  },
}));

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;
// The stubbed useColorScheme is fixed, so this is the palette the screen uses.
let palette: ReturnType<typeof useTheme>;

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
  const Probe = (): null => {
    palette = useTheme();
    return null;
  };
  renderRN(<Probe />);
});

/** Seed a chat carrying the mode (and model) the host reported. */
function seedChat(chatId: string, permissionMode: PermissionMode, model?: string | null): void {
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
      permissionMode,
      ...(model !== undefined ? { model } : {}),
    },
  ]);
}

function render(mode: PermissionMode, model?: string | null): ReturnType<typeof renderRN> {
  seedChat('c1', mode, model);
  __setLocalSearchParams({ chatId: 'c1' });
  return renderRN(<ChatDetailScreen />);
}

function padlockIcon(root: ReactTestInstance): ReactTestInstance {
  const padlock = findHost(root, byTestId('permission-mode-padlock'));
  return padlock.findAll((i) => i.type === ('Icon' as unknown as string))[0]!;
}

function option(root: ReactTestInstance, mode: PermissionMode): ReactTestInstance {
  return findHost(root, byTestId(`permission-mode-option-${mode}`));
}

describe('chat-detail — permission mode padlock', () => {
  it('the full-width permission-mode bar above the composer is gone', () => {
    const r = render('auto');
    expect(queryHost(r.root, byTestId('permission-mode-bar'))).toBeNull();
  });

  it('the padlock sits in the composer action row', () => {
    const r = render('default');
    const row = findHost(r.root, byTestId('composer-actions-row'));
    expect(
      row.findAll(
        (i) => typeof i.type === 'string' && i.props['testID'] === 'permission-mode-padlock',
      ).length,
    ).toBe(1);
  });

  it.each([
    ['default', 'Lock'],
    ['acceptEdits', 'FilePen'],
    ['plan', 'ClipboardList'],
    ['auto', 'Sparkles'],
    ['bypassPermissions', 'LockOpen'],
  ] as const)('mode %s draws the %s icon', (mode, icon) => {
    const r = render(mode);
    expect(padlockIcon(r.root).props['name']).toBe(icon);
  });

  it('bypass is drawn in the danger colour; every other mode is neutral', () => {
    const bypass = render('bypassPermissions');
    expect(padlockIcon(bypass.root).props['color']).toBe(palette.red);
    const def = render('default');
    expect(padlockIcon(def.root).props['color']).toBe(palette.ink2);
  });

  it('names the mode in force in its accessible label, by its friendly name', () => {
    const r = render('acceptEdits');
    expect(findHost(r.root, byTestId('permission-mode-padlock')).props['accessibilityLabel']).toBe(
      'Permission mode: Auto-accept edits',
    );
  });

  it('tapping it lists every mode by friendly name, the one in force ticked', () => {
    const r = render('plan');
    findHost(r.root, byTestId('permission-mode-padlock')).props['onPress']();
    const labels = findAllHost(r.root, (i) => i.props['accessibilityRole'] === 'menuitem').map(
      (i) => i.props['accessibilityLabel'] as string,
    );
    expect(labels).toEqual([
      'Ask before acting',
      'Auto-accept edits',
      'Plan only',
      'Auto',
      'Bypass — no checks',
    ]);
    expect(option(r.root, 'plan').props['accessibilityState']).toMatchObject({ selected: true });
    expect(option(r.root, 'default').props['accessibilityState']).toMatchObject({
      selected: false,
    });
  });

  it('choosing a mode sends chat.settings carrying the SDK mode id', () => {
    const r = render('default');
    findHost(r.root, byTestId('permission-mode-padlock')).props['onPress']();
    option(r.root, 'acceptEdits').props['onPress']();
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.settings',
      chatId: 'c1',
      permissionMode: 'acceptEdits',
    });
  });

  it('greys out a mode the chat model cannot run, and choosing it sends nothing', () => {
    // claude-opus-4-5 cannot run `auto` (Claude Code's own denylist).
    const r = render('default', 'claude-opus-4-5');
    findHost(r.root, byTestId('permission-mode-padlock')).props['onPress']();
    const auto = option(r.root, 'auto');
    expect(auto.props['disabled']).toBe(true);
    expect(auto.props['accessibilityState']).toMatchObject({ disabled: true });
    // A disabled Pressable has no live press handler; if one is wired, it
    // must still send nothing.
    (auto.props['onPress'] as (() => void) | undefined)?.();
    expect(wsMock.send).not.toHaveBeenCalled();
    // Everything else stays on offer.
    expect(option(r.root, 'plan').props['disabled']).toBeFalsy();
  });

  it('a model that CAN run auto offers it', () => {
    const r = render('default', 'claude-opus-5-5');
    findHost(r.root, byTestId('permission-mode-padlock')).props['onPress']();
    expect(option(r.root, 'auto').props['disabled']).toBeFalsy();
  });

  it('sends nothing when the list is not touched', () => {
    render('auto');
    expect(wsMock.send).not.toHaveBeenCalled();
  });
});
