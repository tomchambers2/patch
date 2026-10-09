// Direct coverage for voiceStore setters not otherwise exercised via the
// overlay component tests (setCallTranscript / setCallLevel, including their
// no-op-when-no-call branches).

import { describe, it, expect, afterEach } from 'vitest';
import { useVoiceStore } from '../stores/voiceStore.js';

afterEach(() => {
  useVoiceStore.setState({ call: null, note: null });
});

describe('voiceStore call transcript/level setters', () => {
  it('setCallTranscript is a no-op when there is no active call', () => {
    useVoiceStore.getState().setCallTranscript('hello');
    expect(useVoiceStore.getState().call).toBeNull();
  });

  it('setCallTranscript updates the live transcript of an active call', () => {
    useVoiceStore.getState().startCall('chat-1');
    useVoiceStore.getState().setCallTranscript('partial words');
    expect(useVoiceStore.getState().call?.transcript).toBe('partial words');
  });

  it('setCallLevel is a no-op when there is no active call', () => {
    useVoiceStore.getState().setCallLevel(0.8);
    expect(useVoiceStore.getState().call).toBeNull();
  });

  it('setCallLevel updates the waveform level of an active call', () => {
    useVoiceStore.getState().startCall('chat-1');
    useVoiceStore.getState().setCallLevel(0.42);
    expect(useVoiceStore.getState().call?.level).toBe(0.42);
  });
});

describe('voiceStore note-setter no-ops when there is no active note', () => {
  it('setNoteGesture/setNoteTranscript/setNoteLevel/setNoteSending are no-ops with no note', () => {
    useVoiceStore.getState().setNoteGesture('toggle');
    useVoiceStore.getState().setNoteTranscript('x');
    useVoiceStore.getState().setNoteLevel(0.5);
    useVoiceStore.getState().setNoteSending(true);
    expect(useVoiceStore.getState().note).toBeNull();
  });
});

describe('voiceStore call-setter no-ops when there is no active call', () => {
  it('setCallChat/setCallMuted are no-ops with no call', () => {
    useVoiceStore.getState().setCallChat('chat-2');
    useVoiceStore.getState().setCallMuted(true);
    expect(useVoiceStore.getState().call).toBeNull();
  });
});

describe('voiceStore permission + device-session', () => {
  afterEach(() => {
    useVoiceStore.setState({ permission: null, activeDevices: {} });
  });

  it('setPermission sets and clears the mid-voice permission prompt', () => {
    useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'read file' });
    expect(useVoiceStore.getState().permission).toEqual({
      requestId: 'r1',
      chatId: 'c1',
      summary: 'read file',
    });
    useVoiceStore.getState().setPermission(null);
    expect(useVoiceStore.getState().permission).toBeNull();
  });

  it('setDeviceSession adds an active device and removes it when it ends', () => {
    useVoiceStore.getState().setDeviceSession('dev-1', 'kitchen', true);
    expect(useVoiceStore.getState().activeDevices).toEqual({ 'dev-1': 'kitchen' });
    useVoiceStore.getState().setDeviceSession('dev-1', 'kitchen', false);
    expect(useVoiceStore.getState().activeDevices).toEqual({});
  });
});
