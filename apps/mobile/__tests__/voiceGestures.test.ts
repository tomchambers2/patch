// Regression tests for the voice-gesture overlay-on-gesture guarantee.
//
// The defect these guard (G6-8 / G6-10): startVoiceNote / startVoiceCall
// used to `await` mic-permission + recording / token setup BEFORE flipping
// the store that mounts the overlay. On a slow or failing device the
// overlay therefore never appeared and the gesture looked dead. The fix
// mounts the overlay SYNCHRONOUSLY, then does setup in the background.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVoiceStore } from '../src/stores/voiceStore';

// The voice note streams over the audio WSS (spec/07 § End-to-end voice
// transport). Mock the REST surface with NO me/voiceToken so the async note
// setup throws immediately and never opens a real socket — these tests assert
// the SYNCHRONOUS overlay flip + note-vs-call separation + hold/tap gesture
// semantics, not the streaming session itself (that's device-verified). The
// startVoiceCall describe below resetModules + doMocks rest with its own stub.
vi.mock('../src/api/rest', () => ({
  api: {},
}));

beforeEach(() => {
  useVoiceStore.setState({
    incomingCall: null,
    activeSession: null,
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteTranscript: '',
    callMuted: false,
    callError: null,
  });
});

describe('startVoiceNote (overlay-on-gesture)', () => {
  it('mounts the voice-note overlay SYNCHRONOUSLY, before any async setup', async () => {
    const { startVoiceNote } = await import('../src/lib/voiceNote');
    startVoiceNote('thread_manager');
    // No await: the overlay must already be visible the instant the
    // gesture fires — recording setup happens afterwards.
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('thread_manager');
    expect(useVoiceStore.getState().voiceNoteState).toBe('recording');
  });

  it('targets the chat passed in (Manager for the Voice tab long-press)', async () => {
    const { startVoiceNote } = await import('../src/lib/voiceNote');
    startVoiceNote('thread_manager');
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('thread_manager');
  });

  it('endVoiceNote(false) clears the overlay even if released before setup finished', async () => {
    const { startVoiceNote, endVoiceNote } = await import('../src/lib/voiceNote');
    startVoiceNote('c1', 'hold');
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c1');
    // Release immediately (no session opened yet) — overlay must clear,
    // nothing committed.
    await endVoiceNote(false);
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
    expect(useVoiceStore.getState().voiceNoteState).toBe('idle');
  });
});

// Item 4 — BOTH gestures must work: press-and-hold → release sends; tap-to-
// toggle → a second tap / the overlay Send sends. `releaseVoiceNoteIfHeld`
// (the onPressOut handler wired on the Voice tab, chat-row mic and Manager row)
// must send ONLY when the note was started by a HOLD.
describe('releaseVoiceNoteIfHeld (release-to-send, hold only)', () => {
  // Drive the store directly to a "recording" state (the store action is
  // synchronous and doesn't open a session) so these assert the release GATING
  // in isolation, independent of the networked note setup.
  it('sends (clears the overlay) when a hold-mode note is recording', async () => {
    const { releaseVoiceNoteIfHeld } = await import('../src/lib/voiceNote');
    useVoiceStore.getState().startVoiceNote('c1', 'hold');
    expect(useVoiceStore.getState().voiceNoteState).toBe('recording');
    releaseVoiceNoteIfHeld('c1');
    // Give the async endVoiceNote a tick to clear.
    await new Promise((r) => setTimeout(r, 20));
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });

  it('does NOT send on release when the note was started by a TAP', async () => {
    const { releaseVoiceNoteIfHeld } = await import('../src/lib/voiceNote');
    useVoiceStore.getState().startVoiceNote('c1', 'tap');
    releaseVoiceNoteIfHeld('c1');
    await new Promise((r) => setTimeout(r, 20));
    // Tap-started note is untouched by a finger-release — still recording.
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c1');
    expect(useVoiceStore.getState().voiceNoteState).toBe('recording');
  });

  it('does nothing when the recording chat differs from the released chat', async () => {
    const { releaseVoiceNoteIfHeld } = await import('../src/lib/voiceNote');
    useVoiceStore.getState().startVoiceNote('c1', 'hold');
    releaseVoiceNoteIfHeld('other');
    await new Promise((r) => setTimeout(r, 20));
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c1');
  });
});

// Item 17 formerly pinned the composer mic's note-vs-call separation — the
// composer mic now DICTATES into the composer input (spec/07 § "Dictation
// into the composer") and no longer drives voiceStore at all, so those
// gesture semantics moved to Composer.voice.test.tsx (which asserts against
// the rendered component, not this module). This file still backs the OTHER
// voice-note triggers (chat-row, Voice tab, Manager row) above, untouched.

describe('startVoiceCall (overlay-on-gesture)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('mounts the call overlay SYNCHRONOUSLY in a connecting state', async () => {
    // api.me / api.voiceToken are network calls; stub them so the bg setup
    // does not hit the network in the test runner.
    vi.doMock('../src/api/rest', () => ({
      api: {
        me: async () => ({
          account: { accountId: 'a', userPublicKey: 'k', createdAt: 0 },
          surface: { surfaceId: 's', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
        }),
        voiceToken: async () => ({
          token: 't',
          sessionId: 'sess-1',
          audioUrl: '/audio/sess-1',
          expiresAt: 0,
        }),
      },
    }));
    vi.doMock('../src/lib/voiceAudioService', () => ({
      startVoiceAudioService: async () => undefined,
      stopVoiceAudioService: async () => undefined,
    }));
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    // After resetModules the voiceCall module holds a FRESH voiceStore
    // instance; assert against that same instance, not the top-level import.
    const { useVoiceStore: freshStore } = await import('../src/stores/voiceStore');
    startVoiceCall('thread_manager');
    // Overlay up immediately, CONNECTING (empty session id, but present).
    const s = freshStore.getState().activeSession;
    expect(s).not.toBeNull();
    expect(s?.chatId).toBe('thread_manager');
    expect(s?.sessionId).toBe('');
    expect(typeof s?.startedAt).toBe('number');
  });
});
