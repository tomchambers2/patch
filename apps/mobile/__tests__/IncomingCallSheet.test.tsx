// Render coverage for the foreground-only incoming-call surface (dev/JS
// fallback for when CallKeep's native UI isn't driving the call). Mounted at
// the root layout, it renders ONLY when the voice store has an incomingCall
// AND no activeSession is already underway. Accept/decline both best-effort
// send a wire response and clear the incoming call; a failed send must be
// surfaced via uiStore.pushError rather than swallowed (NO FALLBACK).
//
// getWs() is mocked (no real WS in the test runner); startVoiceCall is mocked
// too so accept() doesn't reach into the real voice-call pipeline (network
// token mint) — this file only pins IncomingCallSheet's own render/handler
// logic, not the call-setup pipeline (that's voiceCall's own concern).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, byLabel, hasText } from './testUtils/render';
import { IncomingCallSheet } from '../src/components/IncomingCallSheet';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';
import { getWs } from '../src/api/ws';
import { startVoiceCall } from '../src/lib/voiceCall';

vi.mock('../src/api/ws', () => ({
  getWs: vi.fn(),
}));
vi.mock('../src/lib/voiceCall', () => ({
  startVoiceCall: vi.fn(),
}));

const send = vi.fn();

beforeEach(() => {
  useVoiceStore.setState({ incomingCall: null, activeSession: null });
  useUiStore.setState({ errors: [] });
  send.mockReset();
  vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
  vi.mocked(startVoiceCall).mockClear();
});

describe('IncomingCallSheet — mount gating', () => {
  it('renders nothing when there is no incoming call', () => {
    const r = renderRN(<IncomingCallSheet />);
    expect(r.toJSON()).toBeNull();
  });

  it('renders nothing when a call is already active (even with an incoming call queued)', () => {
    useVoiceStore.setState({
      incomingCall: {
        callId: 'c1',
        chatId: 'thread_manager',
        message: undefined,
        receivedAt: Date.now(),
      },
      activeSession: {
        sessionId: 's1',
        chatId: 'thread_manager',
        audioUrl: '/audio/s1',
        startedAt: Date.now(),
      },
    });
    const r = renderRN(<IncomingCallSheet />);
    expect(r.toJSON()).toBeNull();
  });
});

describe('IncomingCallSheet — rendering the incoming call', () => {
  it('shows the caption and the message body when a message is present', () => {
    useVoiceStore.setState({
      incomingCall: {
        callId: 'c1',
        chatId: 'thread_manager',
        message: 'Quick check-in?',
        receivedAt: Date.now(),
      },
    });
    const r = renderRN(<IncomingCallSheet />);
    expect(hasText(r.root, 'Manager is calling')).toBe(true);
    expect(hasText(r.root, 'Quick check-in?')).toBe(true);
  });

  it('omits the message line when there is no message', () => {
    useVoiceStore.setState({
      incomingCall: {
        callId: 'c1',
        chatId: 'thread_manager',
        message: undefined,
        receivedAt: Date.now(),
      },
    });
    const r = renderRN(<IncomingCallSheet />);
    expect(hasText(r.root, 'Manager is calling')).toBe(true);
    expect(hasText(r.root, 'Quick check-in?')).toBe(false);
  });
});

describe('IncomingCallSheet — accept', () => {
  it('sends the accept response, starts the voice call, and clears the incoming call', () => {
    useVoiceStore.setState({
      incomingCall: {
        callId: 'c1',
        chatId: 'thread_manager',
        message: undefined,
        receivedAt: Date.now(),
      },
    });
    const r = renderRN(<IncomingCallSheet />);
    findHost(r.root, byLabel('Accept call')).props.onPress();
    expect(send).toHaveBeenCalledWith({
      type: 'chat.call_response',
      callId: 'c1',
      response: 'accept',
    });
    expect(startVoiceCall).toHaveBeenCalledWith('thread_manager');
    expect(useVoiceStore.getState().incomingCall).toBeNull();
    expect(useUiStore.getState().errors).toEqual([]);
  });

  it('surfaces a pushError (does not throw) when the send fails, but still starts the call', () => {
    useVoiceStore.setState({
      incomingCall: {
        callId: 'c1',
        chatId: 'thread_manager',
        message: undefined,
        receivedAt: Date.now(),
      },
    });
    send.mockImplementation(() => {
      throw new Error('socket not open');
    });
    const r = renderRN(<IncomingCallSheet />);
    expect(() => findHost(r.root, byLabel('Accept call')).props.onPress()).not.toThrow();
    expect(useUiStore.getState().errors[0]?.message).toContain(
      'failed to send call response — retry: socket not open',
    );
    expect(startVoiceCall).toHaveBeenCalledWith('thread_manager');
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });
});

describe('IncomingCallSheet — decline', () => {
  it('sends the decline response and clears the incoming call, without starting a call', () => {
    useVoiceStore.setState({
      incomingCall: {
        callId: 'c2',
        chatId: 'thread_manager',
        message: undefined,
        receivedAt: Date.now(),
      },
    });
    const r = renderRN(<IncomingCallSheet />);
    findHost(r.root, byLabel('Decline call')).props.onPress();
    expect(send).toHaveBeenCalledWith({
      type: 'chat.call_response',
      callId: 'c2',
      response: 'decline',
    });
    expect(startVoiceCall).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('surfaces a pushError when the decline send fails', () => {
    useVoiceStore.setState({
      incomingCall: {
        callId: 'c2',
        chatId: 'thread_manager',
        message: undefined,
        receivedAt: Date.now(),
      },
    });
    send.mockImplementation(() => {
      throw new Error('socket not open');
    });
    const r = renderRN(<IncomingCallSheet />);
    findHost(r.root, byLabel('Decline call')).props.onPress();
    expect(useUiStore.getState().errors[0]?.message).toContain(
      'failed to send call response — retry: socket not open',
    );
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });
});
