import { describe, it, expect, beforeEach } from 'vitest';
import { useVoiceStore } from '../src/stores/voiceStore';

beforeEach(() => {
  useVoiceStore.setState({
    incomingCall: null,
    activeSession: null,
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteTranscript: '',
    callMuted: false,
  });
});

describe('voiceStore', () => {
  it('startVoiceNote → state goes to recording', () => {
    useVoiceStore.getState().startVoiceNote('c1', 'tap');
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c1');
    expect(useVoiceStore.getState().voiceNoteState).toBe('recording');
  });

  it('endVoiceNote clears the overlay', () => {
    useVoiceStore.getState().startVoiceNote('c1', 'tap');
    useVoiceStore.getState().endVoiceNote();
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
    expect(useVoiceStore.getState().voiceNoteState).toBe('idle');
  });

  it('setActive resets mute', () => {
    useVoiceStore.getState().setMuted(true);
    useVoiceStore.getState().setActive({
      sessionId: 's',
      chatId: 'c',
      audioUrl: 'wss://x/y',
      startedAt: 1,
    });
    expect(useVoiceStore.getState().callMuted).toBe(false);
    expect(useVoiceStore.getState().activeSession?.chatId).toBe('c');
  });

  it('setIncoming sets/clears the incoming-call request', () => {
    useVoiceStore
      .getState()
      .setIncoming({ callId: 'call1', chatId: 'c1', message: 'hi', receivedAt: 1 });
    expect(useVoiceStore.getState().incomingCall).toEqual({
      callId: 'call1',
      chatId: 'c1',
      message: 'hi',
      receivedAt: 1,
    });
    useVoiceStore.getState().setIncoming(null);
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('setError sets/clears the call error', () => {
    useVoiceStore.getState().setError('mic failed');
    expect(useVoiceStore.getState().callError).toBe('mic failed');
    useVoiceStore.getState().setError(null);
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('setCallPhase updates the live call phase', () => {
    useVoiceStore.getState().setCallPhase('thinking');
    expect(useVoiceStore.getState().callPhase).toBe('thinking');
  });

  it('setVoiceNoteState updates just the note state', () => {
    useVoiceStore.getState().setVoiceNoteState('sending');
    expect(useVoiceStore.getState().voiceNoteState).toBe('sending');
  });

  it('setVoiceNoteTranscript updates the live transcript', () => {
    useVoiceStore.getState().setVoiceNoteTranscript('hello world');
    expect(useVoiceStore.getState().voiceNoteTranscript).toBe('hello world');
  });

  it('setMuted toggles call mute', () => {
    useVoiceStore.getState().setMuted(true);
    expect(useVoiceStore.getState().callMuted).toBe(true);
    useVoiceStore.getState().setMuted(false);
    expect(useVoiceStore.getState().callMuted).toBe(false);
  });

  it('setCallTranscriptPartial updates the interim STT line', () => {
    useVoiceStore.getState().setCallTranscriptPartial('partial words');
    expect(useVoiceStore.getState().callTranscriptPartial).toBe('partial words');
  });

  it('startVoiceNote records the mode (hold vs tap)', () => {
    useVoiceStore.getState().startVoiceNote('c1', 'hold');
    expect(useVoiceStore.getState().voiceNoteMode).toBe('hold');
  });
});

describe('voiceStore — call clock and note timer', () => {
  it('the call clock starts on the first phase past connecting, and only then', () => {
    const st = useVoiceStore.getState();
    st.setActive({ sessionId: 's', chatId: 'c1', audioUrl: '/a', startedAt: 0 });
    expect(useVoiceStore.getState().callConnectedAt).toBeNull();
    st.setCallPhase('connecting');
    expect(useVoiceStore.getState().callConnectedAt).toBeNull();
    st.setCallPhase('listening');
    const at = useVoiceStore.getState().callConnectedAt;
    expect(at).not.toBeNull();
    st.setCallPhase('thinking');
    expect(useVoiceStore.getState().callConnectedAt).toBe(at);
    // A new session resets it.
    st.setActive({ sessionId: 's2', chatId: 'c1', audioUrl: '/a', startedAt: 0 });
    expect(useVoiceStore.getState().callConnectedAt).toBeNull();
  });

  it('a note records when it started, and clears it when it ends', () => {
    useVoiceStore.getState().startVoiceNote('c1', 'tap');
    expect(useVoiceStore.getState().voiceNoteStartedAt).toEqual(expect.any(Number));
    useVoiceStore.getState().endVoiceNote();
    expect(useVoiceStore.getState().voiceNoteStartedAt).toBeNull();
  });

  it('records the address word a call opened with', () => {
    useVoiceStore.getState().setCallAddressWord('jarvis');
    expect(useVoiceStore.getState().callAddressWord).toBe('jarvis');
  });
});
