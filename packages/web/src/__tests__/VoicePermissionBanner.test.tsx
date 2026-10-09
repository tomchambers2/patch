// G5 — mid-voice permission prompt (spec/07 ## Permission prompts during
// voice). The banner only renders while a voice interaction is in flight, and
// offers Approve/Deny (tap) plus a "say yes / no" voice hint. Tapping a button
// emits the response via the injected handler.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VoicePermissionBanner } from '../components/VoicePermissionBanner.js';
import { useVoiceStore } from '../stores/voiceStore.js';

describe('VoicePermissionBanner', () => {
  beforeEach(() => {
    useVoiceStore.setState({ note: null, call: null, permission: null });
  });

  it('is hidden when there is no permission OR no active voice interaction', () => {
    const { rerender } = render(<VoicePermissionBanner onRespond={() => {}} />);
    // permission set but NOT in a voice session → still hidden.
    act(() => {
      useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'Run rm?' });
    });
    rerender(<VoicePermissionBanner onRespond={() => {}} />);
    expect(screen.queryByTestId('voice-permission')).toBeNull();
  });

  it('renders Approve/Deny + the say-yes/no hint while a voice note is active', () => {
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore
        .getState()
        .setPermission({ requestId: 'r1', chatId: 'c1', summary: 'Bash: rm -rf build' });
    });
    render(<VoicePermissionBanner onRespond={() => {}} />);
    expect(screen.getByTestId('voice-permission')).toBeInTheDocument();
    expect(screen.getByTestId('voice-permission-summary')).toHaveTextContent('rm -rf build');
    expect(screen.getByTestId('voice-permission-voicehint')).toHaveTextContent('yes');
    expect(screen.getByTestId('voice-permission-voicehint')).toHaveTextContent('no');
  });

  it('Approve tap emits approve and clears the banner', () => {
    const onRespond = vi.fn();
    act(() => {
      useVoiceStore.getState().startCall('c1');
      useVoiceStore.getState().setPermission({ requestId: 'r9', chatId: 'c1', summary: 'go?' });
    });
    render(<VoicePermissionBanner onRespond={onRespond} />);
    fireEvent.click(screen.getByTestId('voice-permission-approve'));
    expect(onRespond).toHaveBeenCalledWith('r9', true);
    expect(useVoiceStore.getState().permission).toBeNull();
  });

  it('Deny tap emits deny', () => {
    const onRespond = vi.fn();
    act(() => {
      useVoiceStore.getState().startCall('c1');
      useVoiceStore.getState().setPermission({ requestId: 'r9', chatId: 'c1', summary: 'go?' });
    });
    render(<VoicePermissionBanner onRespond={onRespond} />);
    fireEvent.click(screen.getByTestId('voice-permission-deny'));
    expect(onRespond).toHaveBeenCalledWith('r9', false);
  });

  it('pressing Y approves; pressing N denies', () => {
    const onRespond = vi.fn();
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'go?' });
    });
    render(<VoicePermissionBanner onRespond={onRespond} />);
    fireEvent.keyDown(window, { key: 'y' });
    expect(onRespond).toHaveBeenCalledWith('r1', true);
    expect(useVoiceStore.getState().permission).toBeNull();

    onRespond.mockClear();
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore.getState().setPermission({ requestId: 'r2', chatId: 'c1', summary: 'go?' });
    });
    fireEvent.keyDown(window, { key: 'N' });
    expect(onRespond).toHaveBeenCalledWith('r2', false);
  });

  it('ignores Y/N while typing in an input/textarea', () => {
    const onRespond = vi.fn();
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'go?' });
    });
    render(<VoicePermissionBanner onRespond={onRespond} />);
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }));
    expect(onRespond).not.toHaveBeenCalled();
    document.body.removeChild(textarea);
  });

  it('ignores unrelated keys', () => {
    const onRespond = vi.fn();
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'go?' });
    });
    render(<VoicePermissionBanner onRespond={onRespond} />);
    fireEvent.keyDown(window, { key: 'z' });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('does not register a keydown listener when not in a voice session (even with a pending permission)', () => {
    const onRespond = vi.fn();
    act(() => {
      useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'go?' });
    });
    render(<VoicePermissionBanner onRespond={onRespond} />);
    fireEvent.keyDown(window, { key: 'y' });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('removes the keydown listener once the permission clears', () => {
    const onRespond = vi.fn();
    act(() => {
      useVoiceStore.getState().startNote('c1', 'ptt');
      useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'go?' });
    });
    const { rerender } = render(<VoicePermissionBanner onRespond={onRespond} />);
    act(() => {
      useVoiceStore.getState().setPermission(null);
    });
    rerender(<VoicePermissionBanner onRespond={onRespond} />);
    fireEvent.keyDown(window, { key: 'y' });
    expect(onRespond).not.toHaveBeenCalled();
  });
});
