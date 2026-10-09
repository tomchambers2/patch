import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { VoiceOverlayRoute } from '../routes/VoiceOverlayRoute.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';

const cancelVoiceNote = vi.fn();
const sendVoiceNote = vi.fn();
const startVoiceNote = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../lib/voiceController.js', () => ({
  cancelVoiceNote: (...args: unknown[]) => cancelVoiceNote(...args),
  sendVoiceNote: (...args: unknown[]) => sendVoiceNote(...args),
  startVoiceNote: (...args: unknown[]) => startVoiceNote(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useVoiceStore.setState({ note: null });
  useChatStore.setState({ chats: {} });
  delete (window as unknown as { patch?: unknown }).patch;
});

describe('VoiceOverlayRoute', () => {
  it('renders the idle "Hold to speak…" placeholder for Manager when there is no note', () => {
    render(<VoiceOverlayRoute />);
    expect(screen.getByTestId('voice-overlay-route')).toBeTruthy();
    expect(screen.getByText(/Manager/)).toBeTruthy();
    expect(screen.getByText('Hold to speak…')).toBeTruthy();
    expect(screen.getByText(/paused/)).toBeTruthy();
  });

  it('renders live transcript + LISTENING state, and the chat name when known', () => {
    useChatStore.setState({
      chats: {
        'chat-1': {
          pendingWake: null,
          todos: [],
          snoozedUntil: null,
          chatId: 'chat-1',
          daemonId: 'd1',
          permissionMode: 'bypassPermissions' as const,
          name: 'Kitchen',
          folder: '/tmp',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          disabled: false,
          lastUpdated: Date.now(),
          lastUserActivity: Date.now(),
          awaitingPermission: false,
          lastReadSeq: -1,
          preview: null,
          goal: null,
          goalProgress: null,
          lastGoal: null,
          reminder: null,
          statusSummary: null,
          statusKind: null,
          statusDeclared: null,
          pendingPermissions: [],
          lastSeq: 0,
          jobId: null,
          model: null,
          rateLimitResumingAt: null,
          resumeKind: null,
        },
      },
    });
    useVoiceStore.setState({
      note: {
        chatId: 'chat-1',
        gesture: 'toggle',
        transcript: 'hello there',
        level: 0.5,
        sending: false,
        prefix: '',
      },
    });
    render(<VoiceOverlayRoute />);
    expect(screen.getByText(/Kitchen/)).toBeTruthy();
    expect(screen.getByText(/LISTENING/)).toBeTruthy();
    expect(screen.getByTestId('voice-overlay-transcript').textContent).toBe('hello there');
  });

  it('falls back to the raw chatId when the chat name is unknown', () => {
    useVoiceStore.setState({
      note: {
        chatId: 'unknown-id',
        gesture: 'toggle',
        transcript: '',
        level: 0,
        sending: false,
        prefix: '',
      },
    });
    render(<VoiceOverlayRoute />);
    expect(screen.getByText(/unknown-id/)).toBeTruthy();
  });

  it('shows "paused" while sending even though a note is active', () => {
    useVoiceStore.setState({
      note: {
        chatId: 'chat-1',
        gesture: 'toggle',
        transcript: 'x',
        level: 0,
        sending: true,
        prefix: '',
      },
    });
    render(<VoiceOverlayRoute />);
    expect(screen.getByText(/paused/)).toBeTruthy();
  });

  it('Escape cancels the note and closes the window when window.close exists', () => {
    const closeSpy = vi.fn();
    Object.defineProperty(window, 'close', { value: closeSpy, configurable: true });
    render(<VoiceOverlayRoute />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelVoiceNote).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('Escape cancels without throwing when window.close is not a function', () => {
    Object.defineProperty(window, 'close', { value: undefined, configurable: true });
    render(<VoiceOverlayRoute />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelVoiceNote).toHaveBeenCalled();
  });

  it('Enter commits the voice note', () => {
    render(<VoiceOverlayRoute />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(sendVoiceNote).toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    render(<VoiceOverlayRoute />);
    fireEvent.keyDown(window, { key: 'a' });
    expect(cancelVoiceNote).not.toHaveBeenCalled();
    expect(sendVoiceNote).not.toHaveBeenCalled();
  });

  it('does nothing extra when there is no desktop bridge (browser)', () => {
    render(<VoiceOverlayRoute />);
    // No window.patch set — the onStartVoiceNote effect should just bail.
    expect(screen.getByTestId('voice-overlay-route')).toBeTruthy();
  });

  it('wires onStartVoiceNote from the desktop bridge for the "manager" thread', () => {
    let captured: ((e: { thread: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    (window as unknown as { patch?: unknown }).patch = {
      onStartVoiceNote: (cb: (e: { thread: string }) => void) => {
        captured = cb;
        return unsubscribe;
      },
    };
    const { unmount } = render(<VoiceOverlayRoute />);
    expect(captured).toBeTypeOf('function');
    captured!({ thread: 'manager' });
    expect(startVoiceNote).toHaveBeenCalledWith(SPECIAL_THREAD_IDS.manager, 'toggle');
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('wires onStartVoiceNote for a known non-manager chat id', () => {
    useChatStore.setState({
      chats: {
        'chat-9': {
          pendingWake: null,
          todos: [],
          snoozedUntil: null,
          chatId: 'chat-9',
          daemonId: 'd1',
          permissionMode: 'bypassPermissions' as const,
          name: 'Foo',
          folder: '/tmp',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          disabled: false,
          lastUpdated: Date.now(),
          lastUserActivity: Date.now(),
          awaitingPermission: false,
          lastReadSeq: -1,
          preview: null,
          goal: null,
          goalProgress: null,
          lastGoal: null,
          reminder: null,
          statusSummary: null,
          statusKind: null,
          statusDeclared: null,
          pendingPermissions: [],
          lastSeq: 0,
          jobId: null,
          model: null,
          rateLimitResumingAt: null,
          resumeKind: null,
        },
      },
    });
    let captured: ((e: { thread: string }) => void) | undefined;
    (window as unknown as { patch?: unknown }).patch = {
      onStartVoiceNote: (cb: (e: { thread: string }) => void) => {
        captured = cb;
        return () => {};
      },
    };
    render(<VoiceOverlayRoute />);
    captured!({ thread: 'chat-9' });
    expect(startVoiceNote).toHaveBeenCalledWith('chat-9', 'toggle');
  });

  it('falls back to manager for an unknown non-manager thread id', () => {
    let captured: ((e: { thread: string }) => void) | undefined;
    (window as unknown as { patch?: unknown }).patch = {
      onStartVoiceNote: (cb: (e: { thread: string }) => void) => {
        captured = cb;
        return () => {};
      },
    };
    render(<VoiceOverlayRoute />);
    captured!({ thread: 'nonexistent' });
    expect(startVoiceNote).toHaveBeenCalledWith(SPECIAL_THREAD_IDS.manager, 'toggle');
  });
});
