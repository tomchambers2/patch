// Render coverage for the bottom-tab layout (app/(tabs)/_layout.tsx). New
// chat is in the true centre + raised (a raised green button so the affordance is
// obvious for one-handed use) via a custom tabBarButton (NewChatTabButton)
// rather than the default icon+label cell that Chats/Jobs/Settings use.
// Voice is a plain icon+label tab, but its button still wraps the rendered
// children to carry the hold-to-talk-to-Manager gesture.
//
// Tabs/Tabs.Screen are host nodes in the expo-router stub (no real
// navigator), so the tabBarIcon/tabBarButton render-prop functions are
// invoked directly here — that's the only way their bodies run under test.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findAllHost, findHost, byType, actSync } from './testUtils/render';

const { startVoiceNoteSpy, releaseVoiceNoteIfHeldSpy } = vi.hoisted(() => ({
  startVoiceNoteSpy: vi.fn(),
  releaseVoiceNoteIfHeldSpy: vi.fn(),
}));
vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: startVoiceNoteSpy,
  releaseVoiceNoteIfHeld: releaseVoiceNoteIfHeldSpy,
}));

import { routerMock } from './stubs/expo-router';
import { useVoiceStore } from '../src/stores/voiceStore';
import TabLayout from '../app/(tabs)/_layout';

beforeEach(() => {
  startVoiceNoteSpy.mockClear();
  releaseVoiceNoteIfHeldSpy.mockClear();
});

describe('TabLayout — screen options', () => {
  // Tom's order: New chat is the raised button in the true centre (index 2 of
  // 5), with Voice as a plain tab to its right.
  it('renders the five tab screens in order (chats, jobs, new-chat, voice, settings)', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    expect(screens.map((s) => s.props.name)).toEqual(['chats', 'jobs', 'new', 'voice', 'settings']);
  });

  // Jobs is a bottom tab, not a Settings sub-screen (spec/15 § Navigation
  // shell). It is a real destination — no tabPress interception, unlike New
  // chat — so tapping it focuses the Jobs tab rather than pushing a route.
  it('the jobs tab is a real destination with a Clock glyph and no press interception', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const jobs = screens.find((s) => s.props.name === 'jobs')!;
    expect(jobs.props.options.title).toBe('Jobs');
    const icon = jobs.props.options.tabBarIcon({ color: '#111', size: 20 });
    expect(icon.type.displayName ?? icon.type.name).toBe('Clock');
    expect(jobs.props.listeners).toBeUndefined();
  });

  it('the chats tab icon renders a MessageCircle glyph', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const chats = screens.find((s) => s.props.name === 'chats')!;
    const icon = chats.props.options.tabBarIcon({ color: '#111', size: 20 });
    expect(icon.type.displayName ?? icon.type.name).toBe('MessageCircle');
  });

  it('the new-chat tab is the raised button in the true centre of the bar', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const names = screens.map((s) => s.props.name);
    expect(names.indexOf('new')).toBe((names.length - 1) / 2);
    const newChat = screens.find((s) => s.props.name === 'new')!;
    expect(newChat.props.options.tabBarButton).toBeDefined();
  });

  // Voice is a regular tab: an icon + title React Navigation draws like the
  // others (its button only adds the hold gesture), sitting right of New chat.
  it('the voice tab is a regular tab immediately right of new-chat', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const names = screens.map((s) => s.props.name);
    expect(names.indexOf('voice')).toBe(names.indexOf('new') + 1);
    const voice = screens.find((s) => s.props.name === 'voice')!;
    expect(voice.props.options.title).toBe('Voice');
    expect(voice.props.options.tabBarIcon).toBeDefined();
    expect(voice.props.listeners).toBeUndefined();
  });

  it('the voice tab icon renders a Mic glyph', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const voice = screens.find((s) => s.props.name === 'voice')!;
    const icon = voice.props.options.tabBarIcon({ color: '#111', size: 20 });
    expect(icon.type.displayName ?? icon.type.name).toBe('Mic');
  });

  // The New chat tab is an ACTION, not a destination. Letting it focus and
  // bouncing off it with <Redirect> is what left the app on a blank screen:
  // Redirect fires from useFocusEffect, so a tab that stays focused re-fires it
  // forever ("Maximum update depth exceeded"), which wedged the whole UI.
  it('the new-chat tab press is intercepted and pushes /new-chat instead of focusing', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const newChat = screens.find((s) => s.props.name === 'new')!;
    const preventDefault = vi.fn();
    routerMock.push.mockClear();
    newChat.props.listeners.tabPress({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith('/new-chat');
  });

  it('the settings tab icon renders a Settings glyph', () => {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const settings = screens.find((s) => s.props.name === 'settings')!;
    const icon = settings.props.options.tabBarIcon({ color: '#111', size: 20 });
    expect(icon.type.displayName ?? icon.type.name).toBe('Settings');
  });
});

describe('TabLayout — NewChatTabButton (raised plus)', () => {
  function renderNewChatButton(onPress = vi.fn()): ReturnType<typeof renderRN> {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const newChat = screens.find((s) => s.props.name === 'new')!;
    const NewChatTabButton = newChat.props.options.tabBarButton;
    return renderRN(<NewChatTabButton onPress={onPress} />);
  }

  it('tapping (onPress) forwards to the navigator-supplied onPress (pushes /new-chat via the tabPress listener)', () => {
    const onPress = vi.fn();
    const r = renderNewChatButton(onPress);
    const pressable = findHost(r.root, byType('Pressable'));
    actSync(() => {
      (pressable.props as { onPress: () => void }).onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders the accessibility label for the raised new-chat button', () => {
    const r = renderNewChatButton();
    const pressable = findHost(r.root, byType('Pressable'));
    expect(pressable.props.accessibilityLabel).toBe('New chat');
  });
});

describe('TabLayout — VoiceTabButton (plain tab, hold-to-talk)', () => {
  function renderVoiceButton(onPress = vi.fn()): ReturnType<typeof renderRN> {
    const r = renderRN(<TabLayout />);
    const screens = findAllHost(r.root, byType('Tabs.Screen'));
    const voice = screens.find((s) => s.props.name === 'voice')!;
    const VoiceTabButton = voice.props.options.tabBarButton;
    return renderRN(
      <VoiceTabButton onPress={onPress}>
        <></>
      </VoiceTabButton>,
    );
  }

  it('tapping (onPress) forwards to the navigator-supplied onPress (opens the Voice tab)', () => {
    const onPress = vi.fn();
    const r = renderVoiceButton(onPress);
    const pressable = findHost(r.root, byType('Pressable'));
    actSync(() => {
      (pressable.props as { onPress: () => void }).onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('long-pressing starts a hold-to-talk voice note targeting the Manager chat', () => {
    const r = renderVoiceButton();
    const pressable = findHost(r.root, byType('Pressable'));
    actSync(() => {
      (pressable.props as { onLongPress: () => void }).onLongPress();
    });
    expect(startVoiceNoteSpy).toHaveBeenCalledWith('thread_manager', 'hold');
  });

  it('releasing (onPressOut) sends the held note via releaseVoiceNoteIfHeld', () => {
    const r = renderVoiceButton();
    const pressable = findHost(r.root, byType('Pressable'));
    actSync(() => {
      (pressable.props as { onPressOut: () => void }).onPressOut();
    });
    expect(releaseVoiceNoteIfHeldSpy).toHaveBeenCalledWith('thread_manager');
  });

  it('renders the accessibility label for the hold-to-talk gesture', () => {
    const r = renderVoiceButton();
    const pressable = findHost(r.root, byType('Pressable'));
    expect(pressable.props.accessibilityLabel).toBe('Voice tab — tap-to-talk Manager');
  });

  it('renders its children (the icon+label React Navigation composed) rather than a hardcoded glyph', () => {
    const screens = findAllHost(renderRN(<TabLayout />).root, byType('Tabs.Screen'));
    const voice = screens.find((s) => s.props.name === 'voice')!;
    const VoiceTabButton = voice.props.options.tabBarButton;
    const marker = <TestMarker />;
    const r = renderRN(<VoiceTabButton onPress={vi.fn()}>{marker}</VoiceTabButton>);
    const pressable = findHost(r.root, byType('Pressable'));
    expect(pressable.props.children).toBe(marker);
  });
});

function TestMarker(): null {
  return null;
}

// spec/15 § Voice states — while a call is open, the on-call pill floats just
// above the tab bar on every tab; with no call there is nothing there.
describe('TabLayout — on-call pill', () => {
  it('shows no pill with no call', () => {
    useVoiceStore.setState({ activeSession: null });
    const r = renderRN(<TabLayout />);
    expect(r.root.findAll((i) => i.props['testID'] === 'call-pill')).toHaveLength(0);
  });

  it('floats the pill above the tab bar while a call is open', () => {
    useVoiceStore.setState({
      activeSession: { sessionId: 's', chatId: 'thread_manager', audioUrl: '/a', startedAt: 0 },
      callPhase: 'listening',
      callError: null,
      callMode: 'call',
      callConnectedAt: null,
    });
    const r = renderRN(<TabLayout />);
    const pill = findAllHost(r.root, (i) => i.props['testID'] === 'call-pill');
    expect(pill).toHaveLength(1);
    // Its holder floats over the screens, just clear of the 64px tab bar.
    const holder = findAllHost(
      r.root,
      (i) =>
        i.type === 'View' && (i.props['style'] as { position?: string })?.position === 'absolute',
    ).find((v) => v.findAll((i) => i.props['testID'] === 'call-pill').length > 0);
    expect(holder?.props['style']).toMatchObject({ position: 'absolute', bottom: 64 + 8 });
    expect(holder?.props['pointerEvents']).toBe('box-none');
    actSync(() => r.unmount());
    useVoiceStore.setState({ activeSession: null });
  });
});

it('guards a direct launch into tabs when the saved server is missing', async () => {
  const { clearRoute } = await import('../src/config');
  const { seedRoute } = await import('./stubs/mmkv');
  clearRoute();
  try {
    const r = renderRN(<TabLayout />);
    expect(findHost(r.root, byType('Redirect')).props.href).toBe('/pair');
    expect(findAllHost(r.root, byType('Tabs'))).toHaveLength(0);
  } finally {
    seedRoute();
  }
});
