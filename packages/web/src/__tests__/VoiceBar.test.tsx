// spec/07 § Session modes — the voice bar, which is the whole surface of a
// sustained session in both modes (there is no floating call capsule).
//
// The bug it was built for: a hands-free session dropped every unaddressed
// utterance at the host and the surface said nothing about it, so an open,
// working line looked like a broken call. The bar must always state what the
// line is doing, and in hands-free must name the word that wakes it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { VoiceBar, describeLine, HEARD_LINGER_MS } from '../components/VoiceBar.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import * as voiceController from '../lib/voiceController.js';
import type { AudioSessionMode } from '@patch/wire/audio';

function base(mode: AudioSessionMode) {
  return {
    chatId: 'thread_manager',
    startedAt: Date.now(),
    muted: false,
    lastLine: '',
    speaker: 'YOU' as const,
    agentSpeaking: false,
    transcript: '',
    level: 0,
    mode,
    unaddressed: null as string | null,
    phase: 'listening' as const,
  };
}

function open(mode: AudioSessionMode, over: Partial<ReturnType<typeof base>> = {}): void {
  useVoiceStore.setState({ call: { ...base(mode), ...over } });
}

const line = (): string => screen.getByTestId('voice-bar-line').textContent ?? '';
const state = (): string | undefined => screen.getByTestId('voice-bar').dataset.state;

describe('voice bar', () => {
  beforeEach(() => {
    useVoiceStore.setState({ call: null });
    useChatStore.setState({
      chats: { thread_manager: { id: 'thread_manager', name: 'Manager' } },
    } as never);
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is absent with no session', () => {
    render(<VoiceBar />);
    expect(screen.queryByTestId('voice-bar')).toBeNull();
  });

  it('names the mode and the chat, in both modes', () => {
    open('call');
    const { rerender } = render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-head').textContent).toContain('ON CALL');
    expect(screen.getByTestId('voice-bar-chat').textContent).toBe('Manager');
    open('hands-free');
    rerender(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-head').textContent).toContain('HANDS-FREE');
  });

  it('hands-free says what it is waiting for, naming the account address word', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, addressWord: 'jarvis' },
      loaded: true,
    });
    open('hands-free');
    render(<VoiceBar />);
    expect(line()).toBe('Waiting for you to say “jarvis”');
    expect(state()).toBe('waiting');
  });

  it('a call at rest says the line is open — it never asks for an address word', () => {
    open('call');
    render(<VoiceBar />);
    expect(line()).toBe('Listening');
  });

  it('says it is hearing the user, leaving the words themselves to the chat', () => {
    open('hands-free', { transcript: 'patch what is agent two' });
    render(<VoiceBar />);
    expect(state()).toBe('hearing');
    expect(line()).toBe('Hearing you');
  });

  it('shows a dropped utterance as heard-not-sent, then returns to waiting', () => {
    vi.useFakeTimers();
    open('hands-free', { unaddressed: 'hello, hello, how is it going' });
    render(<VoiceBar />);
    expect(state()).toBe('heard');
    expect(line()).toContain('not addressed, so not sent');
    act(() => {
      vi.advanceTimersByTime(HEARD_LINGER_MS + 10);
    });
    expect(useVoiceStore.getState().call?.unaddressed).toBeNull();
    expect(state()).toBe('waiting');
  });

  it('runs a mm:ss timer off the session start', () => {
    vi.useFakeTimers();
    open('call', { startedAt: Date.now() });
    const { rerender } = render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-timer').textContent).toBe('00:00');
    act(() => {
      vi.advanceTimersByTime(62_000);
    });
    rerender(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-timer').textContent).toBe('01:02');
  });

  it('mute, mode switch and end all reach the live session', () => {
    const mute = vi.spyOn(voiceController, 'toggleCallMute').mockImplementation(() => {});
    const mode = vi.spyOn(voiceController, 'setCallMode').mockImplementation(() => {});
    const end = vi.spyOn(voiceController, 'endVoiceCall').mockImplementation(() => {});
    open('hands-free');
    render(<VoiceBar />);
    fireEvent.click(screen.getByTestId('voice-bar-mute'));
    fireEvent.click(screen.getByTestId('voice-bar-mode'));
    fireEvent.click(screen.getByTestId('voice-bar-end'));
    expect(mute).toHaveBeenCalled();
    // Hands-free switches to a call, and vice versa.
    expect(mode).toHaveBeenCalledWith('call');
    expect(end).toHaveBeenCalled();
  });

  it('names a chat it has no title for "New chat", never its id', () => {
    open('call', { chatId: 'unknown-chat-id' });
    render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-chat').textContent).toBe('New chat');
  });

  it('reports the turn cycle: thinking, then speaking — the reply itself streams into the chat', () => {
    const rest = {
      mode: 'call' as const,
      transcript: '',
      unaddressed: null,
      lastLine: '',
      agentSpeaking: false,
    };
    expect(describeLine({ ...rest, phase: 'thinking' }, 'Manager', 'patch').state).toBe('thinking');
    const speaking = describeLine(
      { ...rest, phase: 'speaking', lastLine: 'agent two is deploying' },
      'Manager',
      'patch',
    );
    expect(speaking.state).toBe('speaking');
    expect(speaking.text).toBe('Speaking');
  });

  it('a live transcript wins over the last dropped utterance', () => {
    const l = describeLine(
      {
        mode: 'hands-free',
        phase: 'transcribing',
        agentSpeaking: false,
        transcript: 'patch stop',
        unaddressed: 'earlier chatter',
        lastLine: '',
      },
      'Manager',
      'patch',
    );
    expect(l.state).toBe('hearing');
    expect(l.text).toBe('Hearing you');
  });
});
