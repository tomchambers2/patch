// VoiceOverlayRoute — Electron's frameless overlay window loads /app/voice-
// overlay when the global hotkey fires. It renders the SAME voice-note overlay
// vocabulary as the in-app capsule (design/web-hi-fi-menubar.html frame 2):
// red ripple-mic, LISTENING label, live transcript (italic), waveform, and the
// `⏎ send · esc cancel` hint. The frameless window fills the overlay; the
// AppShell elides Sidebar/EditorRail for this bare route.
//
// Reads live state from voiceStore.note. ESC cancels (closes the Electron
// window); ⏎ commits the toggle session.

import type { JSX } from 'react';
import { useEffect } from 'react';
import { Mic } from 'lucide-react';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { Waveform } from '../components/Waveform.js';
import { startVoiceNote, sendVoiceNote, cancelVoiceNote } from '../lib/voiceController.js';
import { getDesktopBridge } from '../lib/desktopBridge.js';

export function VoiceOverlayRoute(): JSX.Element {
  const note = useVoiceStore((s) => s.note);
  const chats = useChatStore((s) => s.chats);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        cancelVoiceNote();
        if (typeof window.close === 'function') window.close();
      }
      if (e.key === 'Enter') {
        sendVoiceNote();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // In the Electron frameless overlay window, the ⌃Space hotkey IPC starts the
  // note here (this window has its own renderer + store). target thread →
  // Manager (spec/07 ## Overlay surfaces).
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onStartVoiceNote) return;
    return bridge.onStartVoiceNote(({ thread }) => {
      const id =
        thread === 'manager'
          ? SPECIAL_THREAD_IDS.manager
          : useChatStore.getState().chats[thread]
            ? thread
            : SPECIAL_THREAD_IDS.manager;
      void startVoiceNote(id, 'toggle');
    });
  }, []);

  const name = note ? (chats[note.chatId]?.name ?? note.chatId) : 'Manager';
  const transcript = note?.transcript ?? '';
  const level = note?.level ?? 0;
  const listening = note !== null && !note.sending;

  return (
    <div className="voice-overlay-route" data-testid="voice-overlay-route">
      <span className={`voice-overlay-mic ${listening ? 'listening' : ''}`} aria-hidden>
        <Mic size={16} />
      </span>
      <div className="voice-overlay-body">
        <div className="voice-overlay-label">
          {name} · {listening ? 'LISTENING' : 'paused'}
        </div>
        <div className="voice-overlay-text" data-testid="voice-overlay-transcript">
          {transcript || 'Hold to speak…'}
        </div>
      </div>
      <Waveform level={level} bars={10} className="voice-overlay-wave" />
      <div className="voice-overlay-hint">⏎ send · esc cancel</div>
    </div>
  );
}
