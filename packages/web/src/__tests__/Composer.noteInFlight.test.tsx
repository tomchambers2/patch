// A voice NOTE that is already in flight, seen from the chat composer (spec/07
// ## Voice-input modes — mode 1, "An in-flight note owns ⏎ and esc wherever
// focus is").
//
// Tom, patch/todo.md — "voice note buggy, does not record, cannot be ended or
// cancelled". The new-chat mic starts a note and then NAVIGATES into the chat it
// created, whose composer auto-focuses its textarea. From there:
//   • esc did nothing   — the global handler bails when the target is a TEXTAREA
//     and the composer's own esc only knew about its dictation mode.
//   • ⏎ sent the typed text instead of committing the note.
//   • the mic under the cursor was now the chat composer's (dictation) mic, so
//     pressing it opened a SECOND, overlapping recording instead of ending the note.
// The note therefore sat on screen forever showing `…` and never delivered — it
// looked like the mic had never recorded anything.
//
// These drive the real voiceController (with an injected recorder + stubbed
// upload), because the bug lives in the seam between it and the composer.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { startVoiceNote, __setRecorderFactoryForTests } from '../lib/voiceController.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';

describe('Composer — a voice note already in flight', () => {
  const clip = new Blob(['x'], { type: 'audio/wav' });
  let rec: {
    onLevel: (cb: (l: number) => void) => void;
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  let voiceNote: MockInstance<typeof api.voiceNote>;

  beforeEach(async () => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useVoiceStore.getState().endNote();
    useUiStore.getState().clearToasts();
    rec = {
      onLevel: () => {},
      stop: vi.fn(async () => clip),
      cancel: vi.fn(),
    };
    __setRecorderFactoryForTests(async () => rec as unknown as VoiceRecording);
    voiceNote = vi.spyOn(api, 'voiceNote').mockResolvedValue({
      ok: true,
      transcript: 'check on agent two',
      text: 'check on agent two',
    });
  });
  afterEach(() => {
    __setRecorderFactoryForTests(null);
    voiceNote.mockRestore();
    useVoiceStore.getState().endNote();
  });

  /** Mirror the new-chat flow: a toggle note is running, the chat composer is on
   *  screen in its normal (dictation) mode, and focus is in its textarea. */
  async function renderWithNoteInFlight(
    props: Partial<{
      onSend: (m: string) => void;
      recorderFactory: () => Promise<VoiceRecording>;
    }> = {},
  ) {
    const onSend = vi.fn();
    const view = render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={props.onSend ?? onSend}
        {...(props.recorderFactory ? { recorderFactory: props.recorderFactory } : {})}
      />,
    );
    await startVoiceNote('c1', 'toggle');
    expect(useVoiceStore.getState().note).not.toBeNull();
    return { ...view, onSend, input: screen.getByTestId('composer-input') as HTMLTextAreaElement };
  }

  it('esc in the composer cancels the note (no upload, mic released)', async () => {
    const { input } = await renderWithNoteInFlight();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(useVoiceStore.getState().note).toBeNull());
    expect(rec.cancel).toHaveBeenCalled();
    expect(voiceNote).not.toHaveBeenCalled();
  });

  it('⏎ in the composer commits the note instead of sending the typed text', async () => {
    const onSend = vi.fn();
    const { input } = await renderWithNoteInFlight({ onSend });
    fireEvent.change(input, { target: { value: 'half-typed thought' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(voiceNote).toHaveBeenCalledWith('c1', clip, ''));
    expect(onSend).not.toHaveBeenCalled();
    // The half-typed message is left exactly where it was.
    expect(input.value).toBe('half-typed thought');
    await waitFor(() => expect(useVoiceStore.getState().note).toBeNull());
  });

  it('⇧⏎ still types a newline — only a bare ⏎ commits the note', async () => {
    const { input } = await renderWithNoteInFlight();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(voiceNote).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().note).not.toBeNull();
    // Same for an IME composition commit (⏎ there picks a candidate).
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(voiceNote).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().note).not.toBeNull();
  });

  it('the mic button ends the note rather than opening a second recording', async () => {
    const recorderFactory = vi.fn(async () => rec as unknown as VoiceRecording);
    await renderWithNoteInFlight({ recorderFactory });
    fireEvent.mouseDown(screen.getByTestId('voice-note-btn'));
    await waitFor(() => expect(voiceNote).toHaveBeenCalledWith('c1', clip, ''));
    // No dictation session was started alongside the note.
    expect(recorderFactory).not.toHaveBeenCalled();
    await waitFor(() => expect(useVoiceStore.getState().note).toBeNull());
  });
});
