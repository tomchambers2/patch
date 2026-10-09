// Composer — core text/send behaviour (spec/15 § Composer): draft typing,
// text-only send, the daemon-offline/link-down disabled-control model
// (spec/12 § Daemon-offline UX), and the recording-blurs-input effect.
// Attachments, skill autocomplete and voice-mic gestures are covered by
// their own Composer.*.test.tsx siblings so each file stays legible.
//
// deliveryTracker.submit is replaced with a spy so these tests never touch
// the real WS/getWs() plumbing or its redelivery timers — this file is only
// about what the COMPOSER decides to submit, not guaranteed-delivery itself
// (that's deliveryTracker.test.ts's job).

import React from 'react';
import { Pressable as RNPressable } from 'react-native';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findHost, findAllHost, byLabel, byType, renderRN, update } from './testUtils/render';
import { lightColors as colors } from '../src/lib/theme';
import {
  usePresenceStore,
  type ConnectionState,
  type DaemonPresence,
} from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
  },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

function setPresence(connection: ConnectionState, daemon: DaemonPresence): void {
  usePresenceStore.setState({ connection, daemon, accountId: null, surfaceId: null });
}

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The composer now restores the open chat's unsent text (spec/15 §
  // Composer), and the MMKV stub's registry is shared by every test in the
  // file — without this each test starts holding the previous one's draft.
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  setPresence('connected', 'online');
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
});

describe('Composer — draft + text-only send', () => {
  it('typing updates the draft and enables Send once there is text', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = findHost(r.root, byType('TextInput'));
    expect(input.props['value']).toBe('');
    const send = findHost(r.root, byLabel('Send message'));
    expect(send.props['disabled']).toBe(true); // empty draft, no attachments

    update(r, <Composer chatId="c1" folder="work" />);
    input.props['onChangeText']('hello');
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('hello');
    expect(findHost(r.root, byLabel('Send message')).props['disabled']).toBe(false);
  });

  it('pressing Send submits the trimmed text, clears the draft, and never opens the upload path', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = findHost(r.root, byType('TextInput'));
    input.props['onChangeText']('  buy oat milk  ');
    update(r, <Composer chatId="c1" folder="work" />);

    findHost(r.root, byLabel('Send message')).props['onPress']();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [chatId, text, , attachments] = submitSpy.mock.calls[0] as [
      string,
      string,
      string,
      unknown,
    ];
    expect(chatId).toBe('c1');
    expect(text).toBe('buy oat milk');
    expect(attachments).toBeUndefined();
    // The optimistic local echo landed in the chat store.
    expect(useChatStore.getState().timelines['c1']?.[0]?.content).toBe('buy oat milk');

    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });

  it('sends the chat’s current Tools OFF set alongside the message', async () => {
    const { useToolsStore } = await import('../src/stores/toolsStore');
    useToolsStore.getState()._reset();
    useToolsStore.getState().toggle('c1', 'Bash');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('hi');
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byLabel('Send message')).props['onPress']();
    const disabledTools = submitSpy.mock.calls[0]?.[5];
    expect(disabledTools).toEqual(['Bash']);
    useToolsStore.getState()._reset();
  });

  it('Send stays disabled (and un-pressable) while the draft is whitespace-only with no attachments', () => {
    const r = renderRN(<Composer chatId="c1" />);
    const input = findHost(r.root, byType('TextInput'));
    input.props['onChangeText']('   ');
    update(r, <Composer chatId="c1" />);
    // sendDisabled = ... || (draft.trim() === '' && attachments.length === 0):
    // the RN Pressable stub withholds onPress entirely once disabled, so a
    // whitespace-only draft can never reach submit()'s own internal guard.
    const send = findHost(r.root, byLabel('Send message'));
    expect(send.props['disabled']).toBe(true);
    expect(send.props['onPress']).toBeUndefined();
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe('Composer — daemon-offline / link-down disabled controls (spec/12)', () => {
  it('fully connected + host online: every control enabled, Send says "Send message"', () => {
    setPresence('connected', 'online');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byLabel('Attach photo or image')).props['disabled']).toBe(false);
    expect(findHost(r.root, byLabel('Attach any file')).props['disabled']).toBe(false);
    expect(findHost(r.root, byLabel('Dictate into message')).props['disabled']).toBe(false);
    const input = findHost(r.root, byType('TextInput'));
    expect(input.props['editable']).toBe(true);
    input.props['onChangeText']('hi');
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byLabel('Send message')).props['disabled']).toBe(false);
  });

  it('WS connected but host offline: attach/mic disabled (named reason), Send still enabled but QUEUED', () => {
    setPresence('connected', 'offline');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const reason = 'Host offline — paused until your Hetzner box reconnects.';
    // Both attach buttons (image + file) share the same label text.
    const attachButtons = findAllHost(r.root, byLabel(`Attach unavailable — ${reason}`));
    expect(attachButtons).toHaveLength(2);
    for (const b of attachButtons) expect(b.props['disabled']).toBe(true);
    expect(findHost(r.root, byLabel(`Dictate unavailable — ${reason}`)).props['disabled']).toBe(
      true,
    );
    const input = findHost(r.root, byType('TextInput'));
    input.props['onChangeText']('hi');
    update(r, <Composer chatId="c1" folder="work" />);
    // Text + send stay usable — a message sent while the host is offline is
    // queued, never blocked (spec/12).
    const send = findHost(r.root, byLabel('Send message (queued until the agent reconnects)'));
    expect(send.props['disabled']).toBe(false);
    send.props['onPress']();
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('WS connecting: attach/voice disabled with "Connecting…"; text still types and sends (queued)', () => {
    setPresence('connecting', 'unknown');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    for (const b of findAllHost(r.root, byLabel('Attach unavailable — Connecting…'))) {
      expect(b.props['disabled']).toBe(true);
    }
    expect(findHost(r.root, byLabel('Dictate unavailable — Connecting…')).props['disabled']).toBe(
      true,
    );
    const input = findHost(r.root, byType('TextInput'));
    expect(input.props['placeholder']).toBe('Connecting…');
    // Typing AND sending stay possible while the link is down (Todoist
    // 6hWrcpCQFqXGJpF6) — a send here queues and flushes on reconnect, same
    // as daemon-offline (spec/12).
    expect(input.props['editable']).toBe(true);
    input.props['onChangeText']('hi');
    update(r, <Composer chatId="c1" folder="work" />);
    const send = findHost(r.root, byLabel('Send message (queued until the agent reconnects)'));
    expect(send.props['disabled']).toBe(false);
    send.props['onPress']();
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('WS offline: attach/voice named "Offline — no connection to the server."; send stays queued+enabled', () => {
    setPresence('offline', 'unknown');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const reason = 'Offline — no connection to the server.';
    expect(findAllHost(r.root, byLabel(`Attach unavailable — ${reason}`))).toHaveLength(2);
    expect(findHost(r.root, byType('TextInput')).props['placeholder']).toBe(reason);
    const input = findHost(r.root, byType('TextInput'));
    input.props['onChangeText']('hi');
    update(r, <Composer chatId="c1" folder="work" />);
    const send = findHost(r.root, byLabel('Send message (queued until the agent reconnects)'));
    expect(send.props['disabled']).toBe(false);
  });

  it('WS reconnecting: attach/voice named "Reconnecting to server…"; send stays queued+enabled', () => {
    setPresence('reconnecting', 'unknown');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const reason = 'Reconnecting to server…';
    expect(findAllHost(r.root, byLabel(`Attach unavailable — ${reason}`))).toHaveLength(2);
    const input = findHost(r.root, byType('TextInput'));
    input.props['onChangeText']('hi');
    update(r, <Composer chatId="c1" folder="work" />);
    const send = findHost(r.root, byLabel('Send message (queued until the agent reconnects)'));
    expect(send.props['disabled']).toBe(false);
  });

  it('host unknown (connected WS, presence not yet greeted): "Connecting to host…"', () => {
    setPresence('connected', 'unknown');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const reason = 'Connecting to host…';
    expect(findAllHost(r.root, byLabel(`Attach unavailable — ${reason}`))).toHaveLength(2);
  });

  it('pressing a disabled attach/mic button never opens the picker or starts a note', () => {
    setPresence('connected', 'offline'); // disabled = true
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    // The Pressable stub itself withholds onPress when disabled=true, so
    // there is nothing to press — assert that directly (belt + braces with
    // the guard clause inside each handler body).
    const img = findAllHost(r.root, byType('Pressable')).find((p) =>
      String(p.props['accessibilityLabel']).startsWith('Attach unavailable'),
    );
    expect(img?.props['onPress']).toBeUndefined();
    const mic = findAllHost(r.root, byType('Pressable')).find((p) =>
      String(p.props['accessibilityLabel']).startsWith('Dictate unavailable'),
    );
    expect(mic?.props['onPress']).toBeUndefined();
    expect(mic?.props['onLongPress']).toBeUndefined();
  });
});

describe('Composer — Send pressed-style branches', () => {
  it('disabled: divider background regardless of press state', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />); // empty draft → disabled
    const send = findHost(r.root, byLabel('Send message'));
    expect((send.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
  });

  it('enabled + not pressed: leaf background; pressed: leafSoft', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('go');
    update(r, <Composer chatId="c1" folder="work" />);
    const send = findHost(r.root, byLabel('Send message'));
    expect((send.props['style'] as { backgroundColor: string }).backgroundColor).toBe(colors.leaf);
    send.props['onPressIn']();
    const pressed = findHost(r.root, byLabel('Send message'));
    expect((pressed.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.leafSoft,
    );
    pressed.props['onPressOut']();
  });
});

describe('Composer — attach/mic button pressed-style branches (enabled)', () => {
  it('shows the pressed background on the camera button', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btn = findHost(r.root, byLabel('Take photo'));
    expect((btn.props['style'] as { backgroundColor: string }).backgroundColor).toBe('transparent');
    btn.props['onPressIn']();
    const pressed = findHost(r.root, byLabel('Take photo'));
    expect((pressed.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
    pressed.props['onPressOut']();
  });

  it('shows the pressed background on the image-attach button', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btn = findHost(r.root, byLabel('Attach photo or image'));
    expect((btn.props['style'] as { backgroundColor: string }).backgroundColor).toBe('transparent');
    btn.props['onPressIn']();
    const pressed = findHost(r.root, byLabel('Attach photo or image'));
    expect((pressed.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
    pressed.props['onPressOut']();
  });

  it('shows the pressed background on the file-attach button', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btn = findHost(r.root, byLabel('Attach any file'));
    expect((btn.props['style'] as { backgroundColor: string }).backgroundColor).toBe('transparent');
    btn.props['onPressIn']();
    const pressed = findHost(r.root, byLabel('Attach any file'));
    expect((pressed.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
    pressed.props['onPressOut']();
  });

  it('shows the pressed background on the mic button', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const btn = findHost(r.root, byLabel('Dictate into message'));
    expect((btn.props['style'] as { backgroundColor: string }).backgroundColor).toBe('transparent');
    btn.props['onPressIn']();
    const pressed = findHost(r.root, byLabel('Dictate into message'));
    expect((pressed.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
    pressed.props['onPressOut']();
  });
});

describe('Composer — dictation never blurs/disables the input (spec/07 § Dictation into the composer)', () => {
  it('the text input stays editable regardless of mic state — dictation has no overlay to protect', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = findHost(r.root, byType('TextInput'));
    expect(input.props['editable']).toBe(true);
  });
});

// The mic Pressable's onPress/onLongPress bodies re-check `if (disabled) return;`
// even though the surrounding Pressable's own `disabled` prop already withholds
// onPress at that same condition — belt-and-braces, matching the codebase's
// "never a silent no-op" style. The RN Pressable stub (faithfully, like real
// RN) never invokes onPress/onLongPress on a disabled Pressable, so reaching
// these internal guards means reading the RAW handler off the COMPOSITE
// Pressable element (before Pressable's own disabled-gating), not the host
// node `findHost` returns.
describe('Composer — mic handler internal disabled guards (defensive, normally unreachable via UI)', () => {
  it("the mic's onPress/onLongPress guard bails without starting a recording", () => {
    setPresence('connected', 'offline'); // disabled = true
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const mic = r.root
      .findAllByType(RNPressable)
      .find((p) => p.props['accessibilityLabel']?.toString().startsWith('Dictate'));
    expect(mic).toBeTruthy();
    // Calling the RAW handlers directly must not start a recording or error.
    (mic!.props['onPress'] as () => void)();
    (mic!.props['onLongPress'] as () => void)();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });
});

// Likewise, submit()'s own `if (uploading) return;` / empty-draft guards
// duplicate the Send Pressable's `disabled` gating — reached the same way.
describe('Composer — submit() internal guards (defensive, normally unreachable via UI)', () => {
  it('the empty-draft/no-attachments guard bails without calling deliveryTracker.submit', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />); // draft is ''
    const send = r.root
      .findAllByType(RNPressable)
      .find((p) => p.props['accessibilityLabel'] === 'Send message');
    (send!.props['onPress'] as () => void)();
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe('Composer — autoFocus (opening a chat puts the cursor in the composer)', () => {
  it('focuses the input on mount when autoFocus is set', () => {
    const r = renderRN(<Composer chatId="c1" autoFocus />);
    expect(findHost(r.root, byType('TextInput')).props['autoFocus']).toBe(true);
  });

  it('does not grab focus when autoFocus is not set', () => {
    const r = renderRN(<Composer chatId="c1" />);
    expect(findHost(r.root, byType('TextInput')).props['autoFocus']).toBeFalsy();
  });
});
