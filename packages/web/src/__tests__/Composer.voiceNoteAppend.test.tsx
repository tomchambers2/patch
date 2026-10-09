// Starting a voice note must APPEND to the message, never erase it.
//
// Tom, Todoist 6hW5QcMPmf6gWhwc — "patch starting a voice note deletes all
// current content!" — and 6hVhq54fM2mFf8c6 — "patch erases the current content
// of text when you start a voice note. should append."
//
// A voice note commits its OWN turn (`POST /api/voice/note`), so whatever was
// half-typed into the composer the note was started from used to be thrown away
// by the act of starting it. It now rides along as the note's `prefix`: the
// committed turn is the typed text followed by the transcript, one turn, one
// bubble.
//
// The other half is the failure case, and it is the part that matters most:
// NO FALLBACK. A note that never delivers — a failed upload, an esc, a gesture
// released before the mic spun up — must hand those words straight back to the
// composer. Losing them to an error is the very bug being fixed.
//
// Also covered here: Todoist 6hVPGMcWfgcW6256 — "when voice note is recording,
// placeholder should disappear, its writing on top in patch". The live-dictation
// mirror sits exactly on top of the textarea, so on an empty input the
// placeholder renders THROUGH it and the two strings overlap.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { api } from '../api/rest.js';
import {
  startVoiceNote,
  sendVoiceNote,
  cancelVoiceNote,
  __setRecorderFactoryForTests,
} from '../lib/voiceController.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';
import type { startDictationPreview, DictationPreviewCallbacks } from '../lib/dictationPreview.js';

describe('voice note — the typed message is appended to, never erased', () => {
  const clip = new Blob(['x'], { type: 'audio/wav' });
  let rec: {
    onLevel: (cb: (l: number) => void) => void;
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  let voiceNote: MockInstance<typeof api.voiceNote>;

  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useVoiceStore.getState().endNote();
    useVoiceStore.getState().clearComposerRestore();
    useUiStore.getState().clearToasts();
    useChatStore.setState({ timelines: { c1: [] } });
    rec = {
      onLevel: () => {},
      stop: vi.fn(async () => clip),
      cancel: vi.fn(),
    };
    __setRecorderFactoryForTests(async () => rec as unknown as VoiceRecording);
    // The server joins prefix + transcript and returns the turn it injected.
    voiceNote = vi.spyOn(api, 'voiceNote').mockImplementation(async (_chatId, _clip, prefix) => {
      const transcript = 'buy oat milk';
      const text = [prefix.trim(), transcript].filter((p) => p.length > 0).join(' ');
      return { ok: true as const, transcript, text };
    });
  });
  afterEach(() => {
    __setRecorderFactoryForTests(null);
    voiceNote.mockRestore();
    useVoiceStore.getState().endNote();
    useVoiceStore.getState().clearComposerRestore();
  });

  const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;

  // ------------------------------------------------------------------
  // The typed text rides along with the note
  // ------------------------------------------------------------------

  it('the composer hands what is typed to the note it starts', () => {
    // NOTE mode (the `+ New chat` composer's mic): providing `onStartVoiceNote`
    // is what puts the composer in note mode rather than dictation mode.
    const onStartVoiceNote = vi.fn();
    render(
      <Composer chatId="c1" daemonId="d1" onSend={vi.fn()} onStartVoiceNote={onStartVoiceNote} />,
    );
    fireEvent.change(input(), { target: { value: 'remind me to' } });
    fireEvent.mouseDown(screen.getByTestId('voice-note-btn'));
    // The half-written message is the third argument — without it the note
    // would commit its own turn and this text would go nowhere.
    expect(onStartVoiceNote).toHaveBeenCalledWith('c1', 'ptt', 'remind me to');
  });

  it('an empty composer starts a note with no prefix', () => {
    const onStartVoiceNote = vi.fn();
    render(
      <Composer chatId="c1" daemonId="d1" onSend={vi.fn()} onStartVoiceNote={onStartVoiceNote} />,
    );
    fireEvent.mouseDown(screen.getByTestId('voice-note-btn'));
    expect(onStartVoiceNote).toHaveBeenCalledWith('c1', 'ptt', '');
  });

  it('uploads the typed text as the prefix and lands ONE turn of typed-then-spoken', async () => {
    await startVoiceNote('c1', 'toggle', 'remind me to');
    await sendVoiceNote();

    expect(voiceNote).toHaveBeenCalledWith('c1', clip, 'remind me to');

    // ONE bubble, carrying the joined turn — not the bare transcript, and not
    // two separate messages.
    const timeline = useChatStore.getState().timelines['c1'] ?? [];
    const userTurns = timeline.filter((e) => e.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.content).toBe('remind me to buy oat milk');
    expect(userTurns[0]?.transcribing).not.toBe(true);
  });

  it('a note started with nothing typed still sends just the transcript', async () => {
    await startVoiceNote('c1', 'toggle');
    await sendVoiceNote();
    expect(voiceNote).toHaveBeenCalledWith('c1', clip, '');
    const userTurns = (useChatStore.getState().timelines['c1'] ?? []).filter(
      (e) => e.role === 'user',
    );
    expect(userTurns[0]?.content).toBe('buy oat milk');
  });

  // ------------------------------------------------------------------
  // A note that never delivers gives the words back (NO FALLBACK)
  // ------------------------------------------------------------------

  it('a FAILED upload puts the typed text back into the composer', async () => {
    voiceNote.mockRejectedValue(new Error('groq 500'));
    render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
    expect(input().value).toBe('');

    await startVoiceNote('c1', 'toggle', 'remind me to buy milk');
    await act(async () => {
      await sendVoiceNote();
    });

    // The words are back in the box, ready to retry or send by hand. If this
    // regresses, a failed note silently eats a half-written message.
    await waitFor(() => expect(input().value).toBe('remind me to buy milk'));
    // And the failure is LOUD, not swallowed.
    expect(useUiStore.getState().errors.some((t) => /Voice note failed/.test(t.message))).toBe(
      true,
    );
    // No orphaned "Transcribing…" bubble left behind.
    const timeline = useChatStore.getState().timelines['c1'] ?? [];
    expect(timeline.filter((e) => e.transcribing === true)).toHaveLength(0);
  });

  it('CANCELLING a note (esc) puts the typed text back into the composer', async () => {
    render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
    await startVoiceNote('c1', 'toggle', 'half a thought');
    act(() => {
      cancelVoiceNote();
    });
    // Cancelling the note cancels the NOTE, not the message already written.
    await waitFor(() => expect(input().value).toBe('half a thought'));
    expect(voiceNote).not.toHaveBeenCalled();
  });

  it('a note released before the mic started puts the typed text back', async () => {
    // No recorder ever becomes available, so there is no clip to send.
    __setRecorderFactoryForTests(
      () => new Promise<VoiceRecording>(() => {}), // never resolves
    );
    render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
    void startVoiceNote('c1', 'ptt', 'quick note');
    await act(async () => {
      await sendVoiceNote();
    });
    await waitFor(() => expect(input().value).toBe('quick note'));
    expect(voiceNote).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors.some((t) => /nothing recorded/.test(t.message))).toBe(true);
  });

  it('text typed WHILE the note ran survives too, with the owed words leading', async () => {
    voiceNote.mockRejectedValue(new Error('offline'));
    render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
    await startVoiceNote('c1', 'toggle', 'remind me to');
    // The user carries on typing into the composer while the note is running.
    fireEvent.change(input(), { target: { value: 'and also' } });
    await act(async () => {
      await sendVoiceNote();
    });
    // The owed text was typed FIRST, so it leads — nothing is overwritten.
    await waitFor(() => expect(input().value).toBe('remind me to and also'));
  });

  it('the owed text goes to the note’s OWN chat, never into another one', async () => {
    voiceNote.mockRejectedValue(new Error('groq 500'));
    // The composer on screen belongs to a different chat than the note.
    render(<Composer chatId="other-chat" daemonId="d1" onSend={vi.fn()} />);
    await startVoiceNote('c1', 'toggle', 'private thought');
    await act(async () => {
      await sendVoiceNote();
    });
    await waitFor(() =>
      expect(useVoiceStore.getState().composerRestore).toEqual({
        chatId: 'c1',
        text: 'private thought',
      }),
    );
    // It did NOT leak into the composer that happens to be open.
    expect(input().value).toBe('');
  });

  it('a note that DELIVERS owes nothing back', async () => {
    render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
    await startVoiceNote('c1', 'toggle', 'remind me to');
    await act(async () => {
      await sendVoiceNote();
    });
    // The turn landed, so the text belongs to the timeline, not the composer —
    // putting it back would duplicate it.
    expect(useVoiceStore.getState().composerRestore).toBeNull();
    expect(input().value).toBe('');
  });

  // ------------------------------------------------------------------
  // The placeholder must not paint under live voice (6hVPGMcWfgcW6256)
  // ------------------------------------------------------------------

  describe('the placeholder does not render on top of live voice text', () => {
    function makePreview(): {
      factory: typeof startDictationPreview;
      emit: (text: string) => void;
    } {
      let cbs: DictationPreviewCallbacks | null = null;
      const factory: typeof startDictationPreview = (_chatId, callbacks) => {
        cbs = callbacks;
        return { push: () => {}, stop: () => {} };
      };
      return { factory, emit: (text) => act(() => cbs?.onPartial(text)) };
    }

    it('an idle composer still names the field', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
      expect(input().getAttribute('placeholder')).toBe('Type a message');
    });

    it('drops the placeholder while a voice NOTE is recording', async () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
      await startVoiceNote('c1', 'toggle', '');
      // Nothing is typed, so without this the placeholder paints in the same box
      // as the note's live text — two strings on top of each other.
      await waitFor(() => expect(input().getAttribute('placeholder')).toBeNull());
    });

    it('drops the placeholder while a DICTATION preview is painting over the input', async () => {
      const preview = makePreview();
      const dictationRec = {
        onLevel: () => {},
        onPcm: () => {},
        stop: vi.fn(async () => clip),
        cancel: vi.fn(),
      };
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={vi.fn()}
          previewFactory={preview.factory}
          recorderFactory={async () => dictationRec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'buy oat milk' })}
        />,
      );
      expect(input().getAttribute('placeholder')).toBe('Type a message');
      // Tap-toggle a dictation session and let the live transcript arrive.
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(input().getAttribute('placeholder')).toBeNull());
      preview.emit('buy oat');
      // The mirror is mounted and the placeholder is gone — they can't overlap.
      expect(screen.getByTestId('composer-live-preview')).toBeTruthy();
      expect(input().getAttribute('placeholder')).toBeNull();
    });

    it('the placeholder comes back once voice is over', async () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={vi.fn()} />);
      await startVoiceNote('c1', 'toggle', '');
      await waitFor(() => expect(input().getAttribute('placeholder')).toBeNull());
      act(() => {
        cancelVoiceNote();
      });
      await waitFor(() => expect(input().getAttribute('placeholder')).toBe('Type a message'));
    });
  });
});
