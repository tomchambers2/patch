// G5 — Manager incoming-call banner (spec/14 ## Manager incoming-call UX):
// red "MANAGER IS CALLING" strip, green-ringed avatar with the chat name, and
// Dismiss | Accept buttons. ⏎ accepts, Esc dismisses. No timer text.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IncomingCallBanner } from '../components/IncomingCallBanner.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';

describe('IncomingCallBanner', () => {
  beforeEach(() => {
    useVoiceStore.setState({ incomingCall: null });
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
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

  function show(): void {
    useVoiceStore.getState().setIncoming({
      callId: 'call-1',
      chatId: 'thread_manager',
      message: 'I need a decision on the deploy',
      receivedAt: Date.now(),
    });
  }

  it('is hidden with no incoming call', () => {
    render(<IncomingCallBanner onAccept={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByTestId('incoming-call')).toBeNull();
  });

  it('shows the red strip, green-ringed avatar, chat name and both buttons', () => {
    show();
    render(<IncomingCallBanner onAccept={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId('incoming-call')).toBeInTheDocument();
    expect(screen.getByText('MANAGER IS CALLING')).toBeInTheDocument();
    expect(screen.getByTestId('incoming-call-avatar')).toBeInTheDocument();
    expect(screen.getByTestId('incoming-accept')).toBeInTheDocument();
    expect(screen.getByTestId('incoming-dismiss')).toBeInTheDocument();
    // No timer / countdown text (spec/14: "No timer, no countdown text").
    expect(screen.queryByTestId('voice-bar-timer')).toBeNull();
  });

  it('Accept fires onAccept with the call + chat id; ⏎ does the same', () => {
    show();
    const onAccept = vi.fn();
    render(<IncomingCallBanner onAccept={onAccept} onDismiss={() => {}} />);
    fireEvent.click(screen.getByTestId('incoming-accept'));
    expect(onAccept).toHaveBeenCalledWith('call-1', 'thread_manager');
    onAccept.mockClear();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAccept).toHaveBeenCalledWith('call-1', 'thread_manager');
  });

  it('Esc dismisses', () => {
    show();
    const onDismiss = vi.fn();
    render(<IncomingCallBanner onAccept={() => {}} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('call-1');
  });

  it('clicking the Dismiss button fires onDismiss with the call id', () => {
    show();
    const onDismiss = vi.fn();
    render(<IncomingCallBanner onAccept={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('incoming-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('call-1');
  });

  it('falls back to "M" for the avatar initial and omits the name row when the chat is unknown', () => {
    useVoiceStore.getState().setIncoming({
      callId: 'call-2',
      chatId: 'unknown-chat',
      message: undefined,
      receivedAt: Date.now(),
    });
    render(<IncomingCallBanner onAccept={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId('incoming-call-avatar').textContent).toBe('M');
    expect(screen.queryByText('Manager')).toBeNull();
  });

  it('omits the message row when the call carries no message', () => {
    useVoiceStore.getState().setIncoming({
      callId: 'call-3',
      chatId: 'thread_manager',
      message: undefined,
      receivedAt: Date.now(),
    });
    render(<IncomingCallBanner onAccept={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId('incoming-call')).toBeTruthy();
    expect(document.querySelector('.incoming-call-msg')).toBeNull();
  });

  it('ignores Enter/Escape while focus is inside an input/textarea', () => {
    show();
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(<IncomingCallBanner onAccept={onAccept} onDismiss={onDismiss} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('ignores unrelated keys', () => {
    show();
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(<IncomingCallBanner onAccept={onAccept} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: 'a' });
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('removes the keydown listener when the call clears (unmount-equivalent effect cleanup)', () => {
    show();
    const onAccept = vi.fn();
    const { rerender } = render(<IncomingCallBanner onAccept={onAccept} onDismiss={() => {}} />);
    useVoiceStore.setState({ incomingCall: null });
    rerender(<IncomingCallBanner onAccept={onAccept} onDismiss={() => {}} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('does not register a keydown listener at all when there is no call on mount', () => {
    const onAccept = vi.fn();
    render(<IncomingCallBanner onAccept={onAccept} onDismiss={() => {}} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAccept).not.toHaveBeenCalled();
  });
});
