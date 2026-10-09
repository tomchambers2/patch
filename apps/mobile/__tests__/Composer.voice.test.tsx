// Composer — dictation mic gestures (spec/07 § "Dictation into the composer",
// spec/15 § Composer; Todoist 6hHGqGVpJqfcXPmm — live transcription redesign).
// The composer's OWN mic streams live to the input: the interim transcript
// renders greyed while recording, then lands in the draft (editable, never
// auto-sent, no overlay) on gesture-end. Unlike the chat-row/Voice-tab/
// Manager-row voice-NOTE triggers (lib/voiceNote.ts + VoiceNoteOverlay, which
// DO auto-send — pinned separately in voiceGestures.test.ts / voiceNote.test.ts)
// the composer mic never touches that path.
//
// `dictationFactory` is a test seam (mirrors the old `recorderFactory` /
// `transcribeClip` seams before the live-streaming redesign) standing in for
// `lib/dictation.ts`'s `startDictation`, so these assert the Composer's OWN
// state machine (begin/commit/cancel, tap vs hold, greyed-preview rendering,
// the async-race guards) without touching the real native mic or the audio
// WSS — those are covered directly in `dictation.test.ts`.

import React from 'react';
import { Pressable as RNPressable } from 'react-native';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findHost,
  byLabel,
  byType,
  renderRN,
  update,
  actSync,
  actAsync,
  flush,
} from './testUtils/render';
import { lightColors as colors } from '../src/lib/theme';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';
import type { DictationHandle, DictationOutcome } from '../src/lib/dictation';
import * as dictationModule from '../src/lib/dictation';
import * as sendQueue from '../src/lib/sendQueue';

vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
  },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

let submitSpy: ReturnType<typeof vi.spyOn>;

/** A controllable fake dictation session — the test drives `onPartial` calls
 * and `finish()` resolution directly, standing in for the real WS/mic
 * session in `lib/dictation.ts`. */
interface FakeSession {
  onPartial: (text: string) => void;
  onError: (message: string) => void;
  finish: ReturnType<typeof vi.fn>;
}

function makeDictationFactory(): {
  factory: typeof dictationModule.startDictation;
  sessions: FakeSession[];
} {
  const sessions: FakeSession[] = [];
  const factory = vi.fn(
    (
      _chatId: string,
      onPartial: (t: string) => void,
      onError: (m: string) => void,
    ): DictationHandle => {
      const finish = vi.fn(async (_send: boolean) => ({ kind: 'no-audio' }) as DictationOutcome);
      sessions.push({ onPartial, onError, finish });
      return { finish };
    },
  ) as unknown as typeof dictationModule.startDictation;
  return { factory, sessions };
}

beforeEach(() => {
  // The composer now restores the open chat's unsent text (spec/15 §
  // Composer), and the MMKV stub's registry is shared by every test in the
  // file — without this each test starts holding the previous one's draft.
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  // Dictation must never touch this store — reset it so a leak would be
  // visible as a genuine assertion failure below, not a stale carry-over.
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  useComposerAttachmentStore.getState()._reset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
});

describe('Composer — dictation mic (tap-toggle)', () => {
  it('a tap starts a session; a second tap commits: transcript lands in the draft, nothing is sent', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(findHost(r.root, byLabel('Dictate into message'))).toBeTruthy();

    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('c1', expect.any(Function), expect.any(Function));
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);
    // Still recording — chatId untouched in voiceStore and nothing sent yet.
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();

    const session = sessions[0]!;
    session.finish.mockResolvedValueOnce({ kind: 'text', text: 'heard: hello world' });
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);

    expect(session.finish).toHaveBeenCalledWith(true);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('heard: hello world');
    // Never auto-sent, never touches the voice-note store/overlay.
    expect(submitSpy).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });

  it('appends to text already typed in the composer, separated by a space', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('buy oat milk');
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'text', text: 'and some bread' });
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe(
      'buy oat milk and some bread',
    );
  });

  it('shows the live/interim transcript in grey inside the input while recording', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(r.root.findAllByProps({ testID: 'dictation-preview' })).toHaveLength(0);

    await actAsync(() => {
      sessions[0]!.onPartial('buy oat');
    });
    expect(r.root.findAllByProps({ testID: 'dictation-preview' }).length).toBeGreaterThan(0);
    // Grey: still in progress, not yet the user's text.
    const live = findHost(r.root, (i) => i.props['testID'] === 'dictation-live-words');
    expect(live.props['style']).toMatchObject({ color: colors.ink3 });
    expect(live.props['children']).toBe('buy oat');

    // Committing clears the preview — the TextInput now owns the real text.
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'text', text: 'buy oat milk' });
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(r.root.findAllByProps({ testID: 'dictation-preview' })).toHaveLength(0);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('buy oat milk');
  });
});

describe('Composer — send while dictating', () => {
  const sent = (): string => JSON.stringify(submitSpy.mock.calls);

  it('Send is live mid-dictation, ends it, and sends typed text plus transcript', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('buy oat milk');
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'text', text: 'and some bread' });
    await actAsync(() => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
    });
    expect(sessions[0]!.finish).toHaveBeenCalledWith(true);
    expect(sent()).toContain('buy oat milk and some bread');
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    expect(r.root.findAllByProps({ accessibilityLabel: 'Clear dictation' })).toHaveLength(0);
  });

  it('with nothing typed, Send is enabled while dictating and sends just the transcript', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(findHost(r.root, byLabel('Send message')).props['disabled']).toBe(true);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(findHost(r.root, byLabel('Send message')).props['disabled']).toBe(false);
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'text', text: 'hello' });
    await actAsync(() => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
    });
    expect(sent()).toContain('hello');
  });

  it('nothing heard and nothing typed: nothing is sent, and the reason is shown', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'no-speech' });
    await actAsync(() => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
    });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors.at(-1)?.message).toBe('voice: no speech recognised');
  });

  it('a failed transcription sends nothing and keeps the typed text', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('typed first');
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    sessions[0]!.finish.mockRejectedValueOnce(new Error('groq 500'));
    await actAsync(() => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
    });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('typed first');
    expect(useUiStore.getState().errors.at(-1)?.message).toBe(
      'voice transcription failed: groq 500',
    );
  });
});

// A hold session must end on a genuine finger LIFT, never on React Native's
// `onPressOut` — Pressability fires that on LEAVE_PRESS_RECT as well as on
// release, so a few px of drift on a phone-sized button (or the composer
// growing under the finger as the dictation preview appears) used to commit
// mid-sentence with no feedback at all. The commit therefore hangs off the
// raw View touch events, which Pressability does not claim.
describe('Composer — dictation mic (press-and-hold)', () => {
  const mic = (r: ReturnType<typeof renderRN>): Record<string, (e?: unknown) => void> =>
    findHost(r.root, byLabel('Dictate into message')).props as Record<
      string,
      (e?: unknown) => void
    >;

  it('press-and-hold then a real lift commits (release-transcribes)', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'text', text: 'held dictation' });
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    expect(sessions[0]!.finish).toHaveBeenCalledWith(true);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('held dictation');
  });

  it('a drift-out onPressOut mid-hold does NOT commit — the session survives and only the lift ends it', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    // The finger slides off the button and back on again while still down:
    // RN reports that as onPressOut / onPressIn, NOT as a release.
    await actAsync(() => {
      mic(r)['onPressOut']!();
    });
    expect(sessions[0]!.finish).not.toHaveBeenCalled();
    // Still recording — the Clear control is still offered.
    expect(findHost(r.root, byLabel('Clear dictation'))).toBeTruthy();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onPressOut']!();
    });
    expect(sessions[0]!.finish).not.toHaveBeenCalled();

    // Only the genuine lift commits, and it commits the WHOLE utterance.
    sessions[0]!.finish.mockResolvedValueOnce({
      kind: 'text',
      text: 'the whole sentence, not half of it',
    });
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    expect(sessions[0]!.finish).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.finish).toHaveBeenCalledWith(true);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe(
      'the whole sentence, not half of it',
    );
  });

  it('a system touch cancel (the responder is taken away) ends the hold and keeps what was said', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'text', text: 'cancelled mid-hold' });
    await actAsync(() => {
      mic(r)['onTouchCancel']!();
    });
    expect(sessions[0]!.finish).toHaveBeenCalledWith(true);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('cancelled mid-hold');
  });

  it('the mic keeps a generous hit slop and press-retention offset so a drift-out is unlikely in the first place', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const props = findHost(r.root, byLabel('Dictate into message')).props;
    expect(props['hitSlop']).toBeGreaterThan(0);
    // Retention has to be much wider than the button itself: it is what stops
    // Pressability declaring a LEAVE_PRESS_RECT during a long hold.
    expect(props['pressRetentionOffset']).toBeGreaterThanOrEqual(60);
  });

  it('releasing a TAP session does not commit (only a second tap / hold-lift does)', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onPress']!();
    });
    await actAsync(() => {
      mic(r)['onPressOut']!();
    });
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    expect(sessions[0]!.finish).not.toHaveBeenCalled();
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });

  it('a hold whose session already died (setup error) is not committed again on the lift', async () => {
    const factory = vi.fn(
      (
        _chatId: string,
        _onPartial: (t: string) => void,
        onError: (m: string) => void,
      ): DictationHandle => {
        queueMicrotask(() => onError('mic permission denied'));
        return { finish: vi.fn(async () => ({ kind: 'no-audio' }) as DictationOutcome) };
      },
    ) as unknown as typeof dictationModule.startDictation;
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    await flush();
    expect(useUiStore.getState().errors).toHaveLength(1);
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    // The error already reset the mic to idle; the lift must not report a
    // second failure on top of it.
    expect(useUiStore.getState().errors).toHaveLength(1);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });

  it('a lift with no hold session in flight is a no-op (a bare tap-and-lift on an idle mic)', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    expect(sessions).toHaveLength(0);
  });
});

describe('Composer — dictation warms the audio plane ahead of the gesture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warms mic permission + the recording audio mode on mount, before any press', () => {
    const warmSpy = vi.spyOn(dictationModule, 'warmDictation').mockResolvedValue(undefined);
    const { factory } = makeDictationFactory();
    renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(warmSpy).toHaveBeenCalled();
  });

  it('warms again on press-in, which lands before the 350ms long-press threshold', async () => {
    const warmSpy = vi.spyOn(dictationModule, 'warmDictation').mockResolvedValue(undefined);
    const { factory } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    warmSpy.mockClear();
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPressIn']();
    });
    expect(warmSpy).toHaveBeenCalledTimes(1);
  });

  it('a rejected warm-up is not surfaced from the warm path — the press path is what reports a denial', async () => {
    vi.spyOn(dictationModule, 'warmDictation').mockRejectedValue(new Error('not granted yet'));
    const { factory } = makeDictationFactory();
    renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await flush();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });
});

describe('Composer — leaving the chat mid-dictation', () => {
  it('unmounting discards the in-flight session so the microphone is released', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    await actAsync(() => {
      r.unmount();
    });
    expect(sessions[0]!.finish).toHaveBeenCalledWith(false);
  });
});

describe('Composer — dictation clear/discard button', () => {
  it('shows a Clear button only while a dictation is in flight, and discards without transcribing', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(r.root.findAllByProps({ accessibilityLabel: 'Clear dictation' })).toHaveLength(0);

    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    await actAsync(() => {
      sessions[0]!.onPartial('this is going wrong');
    });
    expect(findHost(r.root, byLabel('Clear dictation'))).toBeTruthy();

    await actAsync(() => {
      findHost(r.root, byLabel('Clear dictation')).props['onPress']();
    });
    expect(sessions[0]!.finish).toHaveBeenCalledWith(false);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    expect(r.root.findAllByProps({ testID: 'dictation-preview' })).toHaveLength(0);
    expect(r.root.findAllByProps({ accessibilityLabel: 'Clear dictation' })).toHaveLength(0);
    // Back to idle — a fresh dictation can start.
    expect(findHost(r.root, byLabel('Dictate into message')).props['disabled']).toBeFalsy();
  });

  it('discarding while the upload is already in flight drops the result when it resolves', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onLongPress']();
    });
    let resolveFinish!: (v: DictationOutcome) => void;
    sessions[0]!.finish.mockImplementationOnce(() => new Promise((res) => (resolveFinish = res)));
    // Release commits (starts the upload)...
    findHost(r.root, byLabel('Dictate into message')).props['onPressOut']();
    await flush();
    // ...then Clear is pressed before the upload resolves.
    await actAsync(() => {
      findHost(r.root, byLabel('Clear dictation')).props['onPress']();
    });
    await actAsync(() => {
      resolveFinish({ kind: 'text', text: 'too late' });
    });
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });
});

describe('Composer — dictation error paths (NO silent drop)', () => {
  it('a session setup failure surfaces a toast and resets the mic to idle', async () => {
    const factory = vi.fn(
      (
        _chatId: string,
        _onPartial: (t: string) => void,
        onError: (m: string) => void,
      ): DictationHandle => {
        queueMicrotask(() => onError('mic permission denied'));
        return { finish: vi.fn(async () => ({ kind: 'no-audio' }) as DictationOutcome) };
      },
    ) as unknown as typeof dictationModule.startDictation;
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    await flush();
    expect(useUiStore.getState().errors.at(-1)?.message).toBe('voice: mic permission denied');
    // Idle again — pressable is enabled and labelled for a fresh dictation.
    expect(findHost(r.root, byLabel('Dictate into message')).props['disabled']).toBeFalsy();
  });

  it('a transcription/upload failure surfaces a toast and leaves the draft untouched', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    sessions[0]!.finish.mockRejectedValueOnce(new Error('groq 500'));
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(useUiStore.getState().errors.at(-1)?.message).toBe(
      'voice transcription failed: groq 500',
    );
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });

  // A dictation that yields nothing must SAY so, and say WHICH of the three
  // things happened. Swallowing any of them makes a broken microphone
  // indistinguishable from a working one the user mumbled into.
  const emptyOutcomes: [string, DictationOutcome, string][] = [
    [
      'nothing captured at all',
      { kind: 'no-audio' },
      'voice: nothing recorded — the mic never started',
    ],
    [
      'audio too short to be an utterance',
      { kind: 'too-short', ms: 180 },
      'voice: too short to transcribe (0.2s)',
    ],
    [
      'audio captured but no speech recognised',
      { kind: 'no-speech' },
      'voice: no speech recognised',
    ],
  ];

  for (const [name, outcome, message] of emptyOutcomes) {
    it(`surfaces its own distinct error when the dictation yields ${name}`, async () => {
      const { factory, sessions } = makeDictationFactory();
      const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
      await actAsync(() => {
        findHost(r.root, byLabel('Dictate into message')).props['onPress']();
      });
      sessions[0]!.finish.mockResolvedValueOnce(outcome);
      await actAsync(() => {
        findHost(r.root, byLabel('Dictate into message')).props['onPress']();
      });
      expect(useUiStore.getState().errors.at(-1)?.message).toBe(message);
      expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
      // Back to idle so the next attempt can start immediately.
      expect(findHost(r.root, byLabel('Dictate into message')).props['disabled']).toBeFalsy();
    });
  }

  it('a session that reports itself already discarded changes nothing and says nothing', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    sessions[0]!.finish.mockResolvedValueOnce({ kind: 'discarded' });
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(useUiStore.getState().errors).toHaveLength(0);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    expect(findHost(r.root, byLabel('Dictate into message')).props['disabled']).toBeFalsy();
  });

  it('the three empty outcomes all read differently — none of them is the same message twice', () => {
    expect(new Set(emptyOutcomes.map(([, , m]) => m)).size).toBe(3);
  });

  it('the mic is disabled while a transcription is in flight', async () => {
    const { factory, sessions } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    let resolveFinish!: (v: DictationOutcome) => void;
    sessions[0]!.finish.mockImplementationOnce(() => new Promise((res) => (resolveFinish = res)));
    findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    await flush();
    expect(findHost(r.root, byLabel('Transcribing…')).props['disabled']).toBe(true);
    await actAsync(() => {
      resolveFinish({ kind: 'text', text: 'done' });
    });
    expect(findHost(r.root, byLabel('Dictate into message')).props['disabled']).toBeFalsy();
  });
});

describe('Composer — dictation uses the default lib/dictation.startDictation when no test seam is injected', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls through to lib/dictation.startDictation', async () => {
    const startSpy = vi.spyOn(dictationModule, 'startDictation').mockImplementation(() => ({
      finish: vi.fn(async () => ({ kind: 'text', text: 'default path' }) as DictationOutcome),
    }));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(startSpy).toHaveBeenCalledWith('c1', expect.any(Function), expect.any(Function));
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('default path');
  });
});

describe('Composer — dictation mic (disabled: daemon/link down)', () => {
  it('tap/hold on a disabled mic never start a dictation (guarded by BOTH the Pressable and the handler body)', () => {
    usePresenceStore.setState({
      connection: 'connected',
      daemon: 'offline',
      accountId: null,
      surfaceId: null,
    });
    const { factory } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    const mic = findHost(
      r.root,
      (i) =>
        i.type === 'Pressable' &&
        String(i.props['accessibilityLabel']).startsWith('Dictate unavailable'),
    );
    expect(mic.props['onPress']).toBeUndefined();
    expect(mic.props['onLongPress']).toBeUndefined();

    const rawMic = r.root
      .findAllByType(RNPressable)
      .find((p) => String(p.props['accessibilityLabel']).startsWith('Dictate unavailable'));
    (rawMic!.props['onPress'] as () => void)();
    (rawMic!.props['onLongPress'] as () => void)();
    (rawMic!.props['onPressIn'] as () => void)();
    expect(factory).not.toHaveBeenCalled();
  });

  it('a disabled mic does not warm the audio plane — no unprovoked permission dialog', () => {
    const warmSpy = vi.spyOn(dictationModule, 'warmDictation').mockResolvedValue(undefined);
    usePresenceStore.setState({
      connection: 'connected',
      daemon: 'offline',
      accountId: null,
      surfaceId: null,
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    warmSpy.mockClear();
    const rawMic = r.root
      .findAllByType(RNPressable)
      .find((p) => String(p.props['accessibilityLabel']).startsWith('Dictate unavailable'));
    (rawMic!.props['onPressIn'] as () => void)();
    expect(warmSpy).not.toHaveBeenCalled();
    warmSpy.mockRestore();
  });

  it('delayLongPress is wired to 350ms (hold vs tap threshold)', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byLabel('Dictate into message')).props['delayLongPress']).toBe(350);
  });
});

// Two SEPARATE tests (not two renders in one test): usePresenceStore is a
// global singleton, so a still-mounted Composer from an earlier render in the
// SAME test would also re-render when the store changes underneath it —
// asserting on a stale captured instance would then observe the LATER value.
describe('Composer — mic icon color follows the disabled flag', () => {
  it('enabled: colors.ink2', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const icon = findHost(r.root, (i) => i.type === 'Icon' && i.props['name'] === 'Mic');
    expect(icon.props['color']).toBe(colors.ink2);
  });

  it('disabled: colors.inkFaint', () => {
    usePresenceStore.setState({
      connection: 'connected',
      daemon: 'offline',
      accountId: null,
      surfaceId: null,
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const icon = findHost(r.root, (i) => i.type === 'Icon' && i.props['name'] === 'Mic');
    expect(icon.props['color']).toBe(colors.inkFaint);
  });
});

// Todoist 6hfPVr2cxmjm97jc: "patch bug starting dictation removed my
// attachments". Investigated but not reproduced — every gesture below keeps
// the pending attachment through the whole dictation lifecycle, including a
// Send tapped mid-recording (the ref-based `submitRef`/`sendDraft` pattern
// that reads THIS render's attachments, not the one dictation began under —
// see the comment above that ref in Composer.tsx). Pinned as a regression
// guard for the report either way.
describe('Composer — dictation never disturbs a pending attachment', () => {
  function seedOneAttachment(chatId: string): void {
    actSync(() => {
      useComposerAttachmentStore.getState().add(chatId, [
        {
          key: 'seed-0',
          uri: 'file:///cache/img-0.png',
          name: 'pasted-image-0.png',
          mimeType: 'image/png',
          kind: 'image',
        },
      ]);
    });
  }

  it('a TAP dictation (begin + commit) leaves the attachment in place', async () => {
    seedOneAttachment('c1');
    const { factory } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);

    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toHaveLength(1);

    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toHaveLength(1);
  });

  it('a HOLD dictation (long-press + release) leaves the attachment in place', async () => {
    seedOneAttachment('c1');
    const { factory } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);

    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onLongPress']();
    });
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toHaveLength(1);

    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onTouchEnd']();
    });
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toHaveLength(1);
  });

  it('Send tapped mid-dictation still carries the attachment to sendMessage, then clears it', async () => {
    seedOneAttachment('c1');
    const sendMessageSpy = vi.spyOn(sendQueue, 'sendMessage').mockImplementation(() => {});
    const { factory } = makeDictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);

    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);

    await actAsync(() => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
    });
    update(r, <Composer chatId="c1" folder="work" dictationFactory={factory} />);

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const pending = sendMessageSpy.mock.calls[0]![2] as unknown[];
    expect(pending).toHaveLength(1);
    expect(useComposerAttachmentStore.getState().byKey['c1'] ?? []).toHaveLength(0);
    sendMessageSpy.mockRestore();
  });
});
