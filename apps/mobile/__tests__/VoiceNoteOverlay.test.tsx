// Voice-note overlay (spec/15 § Voice states) — dark capsule pinned at the
// bottom in three named states: `Recording… 0:05` (with a live timer),
// `Transcribing…`, then the full transcript (scrollable, never clipped),
// closing itself after a reading pause unless the user scrolls it.
//
// endVoiceNote is mocked so this file only asserts the OVERLAY — the
// record/upload lifecycle itself is voiceNote.test.ts's job.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findHost,
  byLabel,
  byTestId,
  hasText,
  queryHost,
  renderRN as renderRNRaw,
  update,
  actSync,
} from './testUtils/render';
import { useVoiceStore } from '../src/stores/voiceStore';

const { endVoiceNoteSpy } = vi.hoisted(() => ({
  endVoiceNoteSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/voiceNote', () => ({ endVoiceNote: endVoiceNoteSpy }));

import { VoiceNoteOverlay, noteReadingMs } from '../src/components/VoiceNoteOverlay';

// Every overlay mounted in a test is unmounted after it: a still-mounted one
// stays subscribed to the store and would arm its own auto-close timer when
// the next test drives the store into `done`.
const mounted: ReturnType<typeof renderRNRaw>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderRNRaw> {
  const r = renderRNRaw(el);
  mounted.push(r);
  return r;
}

const T0 = new Date('2026-09-24T10:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  endVoiceNoteSpy.mockClear();
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteTranscript: '',
    voiceNoteStartedAt: null,
  });
});

afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
  vi.useRealTimers();
});

function recording(extra: Partial<ReturnType<typeof useVoiceStore.getState>> = {}): void {
  useVoiceStore.setState({
    voiceNoteChatId: 'c1',
    voiceNoteState: 'recording',
    voiceNoteTranscript: '',
    voiceNoteStartedAt: T0,
    ...extra,
  });
}

describe('VoiceNoteOverlay — hidden state', () => {
  it('renders nothing while no voice note is active (voiceNoteChatId === null)', () => {
    const r = renderRN(<VoiceNoteOverlay />);
    expect(r.toJSON()).toBeNull();
  });
});

describe('VoiceNoteOverlay — recording', () => {
  it('reads "Recording… 0:00" with a timer that counts up while recording', () => {
    recording();
    const r = renderRN(<VoiceNoteOverlay />);
    expect(hasText(r.root, 'Recording… 0:00')).toBe(true);
    actSync(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(hasText(r.root, 'Recording… 0:05')).toBe(true);
    // No transcript area while recording — nothing has been recognised yet.
    expect(queryHost(r.root, byTestId('voice-note-transcript'))).toBeNull();
  });

  it('reads 0:00 when the start time is not known', () => {
    recording({ voiceNoteStartedAt: null });
    const r = renderRN(<VoiceNoteOverlay />);
    expect(hasText(r.root, 'Recording… 0:00')).toBe(true);
  });

  it('the × button calls endVoiceNote(false) — cancel, discard the clip', () => {
    recording();
    const r = renderRN(<VoiceNoteOverlay />);
    findHost(r.root, byLabel('Cancel voice note')).props['onPress']();
    expect(endVoiceNoteSpy).toHaveBeenCalledWith(false);
  });

  it('the Send button calls endVoiceNote(true) — stop + upload', () => {
    recording();
    const r = renderRN(<VoiceNoteOverlay />);
    findHost(r.root, byLabel('Send voice note')).props['onPress']();
    expect(endVoiceNoteSpy).toHaveBeenCalledWith(true);
  });
});

describe('VoiceNoteOverlay — transcribing', () => {
  it('reads "Transcribing…" while the clip uploads, with send/cancel disabled', () => {
    recording({ voiceNoteState: 'sending' });
    const r = renderRN(<VoiceNoteOverlay />);
    expect(hasText(r.root, 'Transcribing…')).toBe(true);
    expect(hasText(r.root, 'Recording…')).toBe(false);
    expect(findHost(r.root, byLabel('Send voice note')).props['disabled']).toBe(true);
    expect(findHost(r.root, byLabel('Cancel voice note')).props['disabled']).toBe(true);
  });
});

describe('VoiceNoteOverlay — finished transcript', () => {
  const LONG =
    'remind me to call the plumber about the leak under the sink tomorrow morning ' +
    'and also book the MOT for the car before the end of the month please';

  it('shows the WHOLE transcript in a scroll view — not clipped to two lines', () => {
    recording({ voiceNoteState: 'done', voiceNoteTranscript: LONG });
    const r = renderRN(<VoiceNoteOverlay />);
    const box = findHost(r.root, byTestId('voice-note-transcript'));
    expect(box.type).toBe('ScrollView');
    expect(hasText(box, LONG)).toBe(true);
    const clipped = r.root.findAll(
      (i) => typeof i.type === 'string' && i.props['numberOfLines'] !== undefined,
    );
    expect(clipped).toHaveLength(0);
    // Send/cancel are gone; only a close control remains.
    expect(queryHost(r.root, byLabel('Send voice note'))).toBeNull();
    expect(queryHost(r.root, byLabel('Close transcript'))).not.toBeNull();
  });

  it('closes itself after the reading pause', () => {
    recording({ voiceNoteState: 'done', voiceNoteTranscript: 'buy oat milk' });
    const r = renderRN(<VoiceNoteOverlay />);
    actSync(() => {
      vi.advanceTimersByTime(noteReadingMs('buy oat milk') - 1);
    });
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c1');
    actSync(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
    update(r, <VoiceNoteOverlay />);
    expect(r.toJSON()).toBeNull();
  });

  it('scrolling the transcript holds it open until the user closes it', () => {
    recording({ voiceNoteState: 'done', voiceNoteTranscript: LONG });
    const r = renderRN(<VoiceNoteOverlay />);
    actSync(() => {
      findHost(r.root, byTestId('voice-note-transcript')).props['onScrollBeginDrag']();
    });
    actSync(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(useVoiceStore.getState().voiceNoteState).toBe('done');
    actSync(() => {
      findHost(r.root, byLabel('Close transcript')).props['onPress']();
    });
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });

  it('a new recording after a held transcript starts with the auto-close armed again', () => {
    recording({ voiceNoteState: 'done', voiceNoteTranscript: LONG });
    const r = renderRN(<VoiceNoteOverlay />);
    actSync(() => {
      findHost(r.root, byTestId('voice-note-transcript')).props['onScrollBeginDrag']();
    });
    actSync(() => recording());
    actSync(() => useVoiceStore.setState({ voiceNoteState: 'done', voiceNoteTranscript: 'hi' }));
    actSync(() => {
      vi.advanceTimersByTime(noteReadingMs('hi'));
    });
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
    expect(r.toJSON()).toBeNull();
  });

  it('reading time scales with length, clamped to 4–15s', () => {
    expect(noteReadingMs('hi')).toBe(4_000);
    expect(noteReadingMs('')).toBe(4_000);
    expect(noteReadingMs('one two three four five six seven eight')).toBe(4_800);
    expect(noteReadingMs('word '.repeat(200))).toBe(15_000);
  });
});

describe('VoiceNoteOverlay — ripple loop lifecycle', () => {
  it('stops the ripple on the chatId→null transition without throwing', () => {
    recording();
    const r = renderRN(<VoiceNoteOverlay />);
    expect(r.toJSON()).not.toBeNull();
    useVoiceStore.setState({ voiceNoteChatId: null, voiceNoteState: 'idle' });
    expect(() => update(r, <VoiceNoteOverlay />)).not.toThrow();
    expect(r.toJSON()).toBeNull();
  });

  it('stops the loop on unmount without throwing', () => {
    recording();
    const r = renderRNRaw(<VoiceNoteOverlay />);
    expect(() => actSync(() => r.unmount())).not.toThrow();
  });
});
