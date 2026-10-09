// IncomingCallBanner — red header strip + Accept / Dismiss buttons per
// spec/14 ## Manager incoming-call UX. Window-raise + chime are handled in
// ws.ts dispatch; this component renders the visible UI.

import type { JSX } from 'react';
import { useEffect } from 'react';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';

export interface IncomingCallBannerProps {
  onAccept(callId: string, chatId: string): void;
  onDismiss(callId: string): void;
}

export function IncomingCallBanner({
  onAccept,
  onDismiss,
}: IncomingCallBannerProps): JSX.Element | null {
  const call = useVoiceStore((s) => s.incomingCall);
  const chatName = useChatStore((s) => (call ? (s.chats[call.chatId]?.name ?? null) : null));

  useEffect(() => {
    if (!call) return;
    function onKey(e: KeyboardEvent): void {
      /* v8 ignore next -- defensive only: this closure is torn down and rebuilt (via the `call` effect dep) the instant `call` changes, so `call` is always truthy here whenever `onKey` can run (the outer `if (!call) return` above already gates registration). */
      if (!call) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      // Ignore when typing in input/textarea so the keystroke still flows
      // into the composer or other text fields.
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Enter') {
        e.preventDefault();
        onAccept(call.callId, call.chatId);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss(call.callId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [call, onAccept, onDismiss]);

  if (!call) return null;
  return (
    <div
      className="incoming-call"
      data-testid="incoming-call"
      role="dialog"
      aria-label="incoming call"
    >
      <div className="incoming-call-strip">MANAGER IS CALLING</div>
      <div className="incoming-call-avatar" data-testid="incoming-call-avatar" aria-hidden>
        <span className="ica-ring" />
        <span className="ica-initial">{(chatName ?? 'Manager').slice(0, 1).toUpperCase()}</span>
      </div>
      {chatName ? <div className="incoming-call-name">{chatName}</div> : null}
      {call.message ? <div className="incoming-call-msg">{call.message}</div> : null}
      <div className="incoming-call-buttons">
        <button
          type="button"
          className="dismiss"
          data-testid="incoming-dismiss"
          onClick={() => onDismiss(call.callId)}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="accept"
          data-testid="incoming-accept"
          onClick={() => onAccept(call.callId, call.chatId)}
        >
          Accept
        </button>
      </div>
    </div>
  );
}
