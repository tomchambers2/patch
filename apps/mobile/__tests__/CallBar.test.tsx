// In-chat call bar + CallDock (spec/15 § Voice states — Voice call). The call
// is not a full-screen layer: the chat's stream is the transcript and this bar
// docks above the composer with the phase, the clock, the live words, the
// hands-free hint, mute, the plainly-named mode switch and end. Connecting is
// neutral and distinct from listening; a failure shows its reason and Retry.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actSync,
  byLabel,
  byTestId,
  findHost,
  hasText,
  queryHost,
  renderRN as renderRNRaw,
  textOf,
} from './testUtils/render';
import { useVoiceStore } from '../src/stores/voiceStore';
import { lightColors as colors } from '../src/lib/theme';

const { endVoiceCallSpy, retrySpy, setCallModeSpy, setCallMutedSpy } = vi.hoisted(() => ({
  endVoiceCallSpy: vi.fn().mockResolvedValue(undefined),
  retrySpy: vi.fn().mockResolvedValue(undefined),
  setCallModeSpy: vi.fn(),
  setCallMutedSpy: vi.fn(),
}));
vi.mock('../src/lib/voiceCall', () => ({
  endVoiceCall: endVoiceCallSpy,
  retryVoiceCall: retrySpy,
  setCallMode: setCallModeSpy,
  setCallMuted: setCallMutedSpy,
}));

import { CallBar, CallDock } from '../src/components/CallBar';

const T0 = new Date('2026-09-24T10:00:00Z').getTime();
const mounted: ReturnType<typeof renderRNRaw>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderRNRaw> {
  const r = renderRNRaw(el);
  mounted.push(r);
  return r;
}

function call(extra: Partial<ReturnType<typeof useVoiceStore.getState>> = {}): void {
  useVoiceStore.setState({
    activeSession: { sessionId: 'sess-1', chatId: 'thread_manager', audioUrl: '/a', startedAt: T0 },
    callMuted: false,
    callError: null,
    callPhase: 'listening',
    callTranscriptPartial: '',
    callMode: 'call',
    callUnaddressed: null,
    callConnectedAt: T0,
    callAddressWord: 'patch',
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  useVoiceStore.setState({ activeSession: null, callError: null, callConnectedAt: null });
});

afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
  vi.useRealTimers();
});

const dotColor = (r: ReturnType<typeof renderRN>): unknown =>
  (findHost(r.root, byTestId('call-status-dot')).props['style'] as { backgroundColor: string })
    .backgroundColor;

describe('CallBar — no call', () => {
  it('renders nothing', () => {
    expect(renderRN(<CallBar />).toJSON()).toBeNull();
  });
});

describe('CallBar — connecting is its own state', () => {
  it('reads "Connecting" with counting dots in the NEUTRAL ink, no clock, no "Listening"', () => {
    call({ callPhase: 'connecting', callConnectedAt: null });
    const r = renderRN(<CallBar />);
    const label = findHost(r.root, byTestId('call-connecting'));
    expect(textOf(label)).toBe('Connecting.');
    expect((label.props['style'] as { color: string }).color).toBe(colors.ink3);
    expect(dotColor(r)).toBe(colors.ink3);
    expect(hasText(r.root, 'Listening')).toBe(false);
    expect(queryHost(r.root, byTestId('call-timer'))).toBeNull();
    actSync(() => {
      vi.advanceTimersByTime(400);
    });
    expect(textOf(findHost(r.root, byTestId('call-connecting')))).toBe('Connecting..');
    actSync(() => {
      vi.advanceTimersByTime(800);
    });
    expect(textOf(findHost(r.root, byTestId('call-connecting')))).toBe('Connecting.');
  });

  it('a failed connect shows "Could not connect", the reason and a Retry', () => {
    call({
      callPhase: 'connecting',
      callConnectedAt: null,
      callError: 'Could not connect — no answer from the host after 15s',
    });
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('Could not connect');
    expect(textOf(findHost(r.root, byTestId('call-error')))).toContain('no answer from the host');
    expect(dotColor(r)).toBe(colors.red);
    findHost(r.root, byLabel('Retry call')).props['onPress']();
    expect(retrySpy).toHaveBeenCalledTimes(1);
    // End still works on a failed call.
    findHost(r.root, byLabel('End call')).props['onPress']();
    expect(endVoiceCallSpy).toHaveBeenCalledTimes(1);
  });

  it('a mid-call failure reads "Call problem" and hides the live lines', () => {
    call({
      callError: 'Call dropped — the audio connection closed',
      callTranscriptPartial: 'half a sen',
      callMode: 'hands-free',
    });
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('Call problem');
    expect(queryHost(r.root, byTestId('call-partial'))).toBeNull();
    expect(queryHost(r.root, byTestId('call-hint'))).toBeNull();
    expect(findHost(r.root, byLabel('Mute')).props['disabled']).toBe(true);
  });
});

describe('CallBar — live states', () => {
  it('names the phase and runs the clock from connection', () => {
    call();
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('Listening');
    expect(dotColor(r)).toBe(colors.leaf);
    expect(textOf(findHost(r.root, byTestId('call-timer')))).toBe('0:00');
    actSync(() => {
      vi.advanceTimersByTime(83_000);
    });
    expect(textOf(findHost(r.root, byTestId('call-timer')))).toBe('1:23');
  });

  it.each([
    ['transcribing', 'Hearing you', 'leaf'],
    ['thinking', 'Thinking', 'amber'],
    ['speaking', 'Speaking', 'leaf'],
  ] as const)('%s reads "%s"', (phase, label, colour) => {
    call({ callPhase: phase });
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe(label);
    expect(dotColor(r)).toBe(colors[colour]);
  });

  it('muted reads "Muted" with a still, neutral dot', () => {
    call({ callMuted: true });
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('Muted');
    expect(dotColor(r)).toBe(colors.ink3);
    findHost(r.root, byLabel('Unmute')).props['onPress']();
    expect(setCallMutedSpy).toHaveBeenCalledWith(false);
  });

  it('the live words are legible (full ink), prefixed You:', () => {
    call({ callPhase: 'transcribing', callTranscriptPartial: 'turn the kitchen lights' });
    const r = renderRN(<CallBar />);
    const line = findHost(r.root, byTestId('call-partial'));
    const [prefix, words] = line.children;
    expect(textOf(prefix as never)).toBe('You: ');
    expect(words).toBe('turn the kitchen lights');
    expect((line.props['style'] as { color: string }).color).toBe(colors.ink);
  });

  it('an unaddressed hands-free utterance is shown as heard but not sent', () => {
    call({ callMode: 'hands-free', callUnaddressed: 'pass the plaster' });
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-unaddressed')))).toBe(
      'Heard “pass the plaster” — not addressed, so not sent',
    );
  });

  it('the live words win over a stale unaddressed line', () => {
    call({ callMode: 'hands-free', callUnaddressed: 'old', callTranscriptPartial: 'patch hi' });
    const r = renderRN(<CallBar />);
    expect(queryHost(r.root, byTestId('call-unaddressed'))).toBeNull();
  });
});

describe('CallBar — mode switch and hint', () => {
  it('names both modes plainly and marks the one in force', () => {
    call();
    const r = renderRN(<CallBar />);
    const sw = findHost(r.root, byTestId('call-mode-switch'));
    expect(hasText(sw, 'Call')).toBe(true);
    expect(hasText(sw, 'Hands-free')).toBe(true);
    expect(findHost(r.root, byLabel('Call (on)')).props['accessibilityState']).toEqual({
      selected: true,
    });
    findHost(r.root, byLabel('Switch to Hands-free')).props['onPress']();
    expect(setCallModeSpy).toHaveBeenCalledWith('hands-free');
  });

  it('a call carries no hint; hands-free names the address word from the preference', () => {
    call();
    const r = renderRN(<CallBar />);
    expect(queryHost(r.root, byTestId('call-hint'))).toBeNull();

    actSync(() => useVoiceStore.setState({ callMode: 'hands-free' }));
    expect(textOf(findHost(r.root, byTestId('call-hint')))).toBe(
      'Start with “patch” — or reply within 30s of it speaking',
    );
    findHost(r.root, byLabel('Switch to Call')).props['onPress']();
    expect(setCallModeSpy).toHaveBeenCalledWith('call');
  });

  it('mute and end are wired', () => {
    call();
    const r = renderRN(<CallBar />);
    findHost(r.root, byLabel('Mute')).props['onPress']();
    expect(setCallMutedSpy).toHaveBeenCalledWith(true);
    findHost(r.root, byLabel('End call')).props['onPress']();
    expect(endVoiceCallSpy).toHaveBeenCalled();
  });
});

describe('CallDock', () => {
  it('nothing when there is no call', () => {
    expect(renderRN(<CallDock chatId="thread_manager" />).toJSON()).toBeNull();
  });

  it('the full bar in the call’s own chat', () => {
    call();
    const r = renderRN(<CallDock chatId="thread_manager" />);
    expect(queryHost(r.root, byTestId('call-bar'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('call-pill'))).toBeNull();
  });

  it('the on-call pill in any other chat', () => {
    call();
    const r = renderRN(<CallDock chatId="c-other" />);
    expect(queryHost(r.root, byTestId('call-bar'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('call-pill-label')))).toBe('On call · Manager · 0:00');
  });
});

describe('CallBar — pressed feedback', () => {
  const bg = (r: ReturnType<typeof renderRN>, label: string): unknown =>
    findHost(r.root, byLabel(label)).props['style'] as {
      backgroundColor?: string;
      opacity?: number;
    };

  it('Retry, Mute and End each show a pressed state', () => {
    call({ callError: 'Call dropped' });
    const r = renderRN(<CallBar />);
    actSync(() => findHost(r.root, byLabel('Retry call')).props['onPressIn']());
    expect(bg(r, 'Retry call')).toMatchObject({ backgroundColor: colors.leafSoft });
    actSync(() => findHost(r.root, byLabel('End call')).props['onPressIn']());
    expect(bg(r, 'End call')).toMatchObject({ opacity: 0.7 });

    actSync(() => useVoiceStore.setState({ callError: null }));
    actSync(() => findHost(r.root, byLabel('Mute')).props['onPressIn']());
    expect(bg(r, 'Mute')).toMatchObject({ backgroundColor: colors.divider });
  });
});

describe('CallBar — voice engine (spec/07 § Voice — a config matrix)', () => {
  it('names a hosted engine beside the clock', () => {
    call({ callEngine: 'OpenAI Realtime · heavy' });
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-engine')))).toBe('OpenAI Realtime · heavy');
  });

  it('names nothing on the local pipeline', () => {
    call({ callEngine: null });
    const r = renderRN(<CallBar />);
    expect(queryHost(r.root, byTestId('call-engine'))).toBeNull();
  });

  it('a hosted engine failure reads as a call problem naming the engine, with Retry', () => {
    call({
      callEngine: 'Gemini Live · light',
      callError: 'Gemini Live failed — Gemini Live closed the session (code 1011)',
    });
    const r = renderRN(<CallBar />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('Call problem');
    expect(textOf(findHost(r.root, byTestId('call-error')))).toContain('Gemini Live failed');
    expect(queryHost(r.root, byLabel('Retry call'))).not.toBeNull();
  });
});
