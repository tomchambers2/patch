// G5 — voice-note overlay (mode 1) rendering. Per spec/07 ## Voice-input modes
// this is JUST the live transcript, bottom-centred: no mic glyph, no
// name/LISTENING label, no waveform, no keyboard hint. The heavy capsule
// vocabulary belongs to the voice CALL overlay (mode 2) only.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { VoiceNoteOverlay } from '../components/VoiceNoteOverlay.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';

describe('VoiceNoteOverlay', () => {
  beforeEach(() => {
    useVoiceStore.setState({ note: null, call: null });
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'Manager',
        folder: 'm',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
  });

  it('is hidden when no note is in flight', () => {
    render(<VoiceNoteOverlay />);
    expect(screen.queryByTestId('voice-note-overlay')).toBeNull();
  });

  it('renders the live transcript', () => {
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore.getState().setNoteTranscript('check on agent two');
      useVoiceStore.getState().setNoteLevel(0.5);
    });
    render(<VoiceNoteOverlay />);
    expect(screen.getByTestId('voice-note-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('voice-note-transcript')).toHaveTextContent('check on agent two');
  });

  it('shows nothing but the transcript — no label, waveform or key hint', () => {
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore.getState().setNoteTranscript('check on agent two');
      useVoiceStore.getState().setNoteLevel(0.5);
    });
    render(<VoiceNoteOverlay />);
    expect(screen.queryByTestId('voice-note-label')).toBeNull();
    expect(screen.queryByTestId('voice-note-hint')).toBeNull();
    expect(screen.queryByTestId('waveform')).toBeNull();
    // No chat name, no state word, no key hints anywhere in the overlay.
    const overlay = screen.getByTestId('voice-note-overlay');
    expect(overlay.textContent).toBe('check on agent two');
    expect(overlay.querySelector('svg')).toBeNull();
  });

  it('marks the line as sending (dimmed) instead of a SENDING label', () => {
    act(() => {
      useVoiceStore.getState().startNote('c1', 'toggle');
      useVoiceStore.getState().setNoteTranscript('one moment');
      useVoiceStore.getState().setNoteSending(true);
    });
    render(<VoiceNoteOverlay />);
    const line = screen.getByTestId('voice-note-transcript');
    expect(line).toHaveAttribute('data-sending', 'true');
    expect(line).toHaveTextContent('one moment');
    expect(screen.getByTestId('voice-note-overlay').textContent).not.toContain('SENDING');
  });

  it('still renders for a chat with no hydrated row yet', () => {
    act(() => {
      useVoiceStore.getState().startNote('brand-new-unhydrated-chat', 'ptt');
    });
    render(<VoiceNoteOverlay />);
    expect(screen.getByTestId('voice-note-overlay')).toBeTruthy();
  });

  it('shows a placeholder ellipsis while the transcript is still empty', () => {
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
    });
    render(<VoiceNoteOverlay />);
    expect(screen.getByTestId('voice-note-transcript')).toHaveTextContent('…');
  });

  // Tom, patch/todo.md — "voice note … does not record". Web records the clip
  // and uploads it in one go, so no words come back until the note is committed:
  // a motionless `…` reads as a dead mic. Per spec/07 the placeholder tracks the
  // recorder's input level (bucketed) so the one line answers speech.
  it('tracks the mic level on the placeholder so a live mic is visible', () => {
    act(() => {
      useVoiceStore.getState().startNote('c1', 'toggle');
    });
    render(<VoiceNoteOverlay />);
    const line = screen.getByTestId('voice-note-transcript');
    expect(line).toHaveAttribute('data-level', '0');
    act(() => useVoiceStore.getState().setNoteLevel(0.6));
    expect(line).toHaveAttribute('data-level', '4');
    act(() => useVoiceStore.getState().setNoteLevel(0.12));
    expect(line).toHaveAttribute('data-level', '2');
    act(() => useVoiceStore.getState().setNoteLevel(0));
    expect(line).toHaveAttribute('data-level', '0');
  });

  it('stops tracking the level once real words are on screen', () => {
    act(() => {
      useVoiceStore.getState().startNote('c1', 'toggle');
      useVoiceStore.getState().setNoteLevel(0.6);
      useVoiceStore.getState().setNoteTranscript('check on agent two');
    });
    render(<VoiceNoteOverlay />);
    expect(screen.getByTestId('voice-note-transcript')).toHaveAttribute('data-level', '0');
  });
});
