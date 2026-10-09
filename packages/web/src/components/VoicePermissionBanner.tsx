// VoicePermissionBanner — mid-voice-session permission prompt (spec/07
// ## Permission prompts during voice). When `chat.permission_request` arrives
// while a voice note OR call is active, the surface shows a banner with
// Approve / Deny buttons PLUS a "say yes / no" voice hint. The spoken answer
// goes through the same Whisper path (the open audio session) and the host
// parses "yes"/"no" and emits `chat.permission_response`; tapping a button
// sends the response explicitly.
//
// Only rendered while a voice interaction is in flight — outside voice, file-
// edit permission requests open the diff rail (ws.ts dispatch) as before.

import type { JSX } from 'react';
import { useEffect } from 'react';
import { Check, X } from 'lucide-react';
import { useVoiceStore } from '../stores/voiceStore.js';

export interface VoicePermissionBannerProps {
  onRespond(requestId: string, approve: boolean): void;
}

export function VoicePermissionBanner({
  onRespond,
}: VoicePermissionBannerProps): JSX.Element | null {
  const permission = useVoiceStore((s) => s.permission);
  const inVoice = useVoiceStore((s) => s.note !== null || s.call !== null);
  const clear = useVoiceStore((s) => s.setPermission);

  // Keyboard parity with the voice answer: Y approves, N denies — same verbs
  // the host parses from the spoken Whisper transcript.
  useEffect(() => {
    if (!permission || !inVoice) return;
    function onKey(e: KeyboardEvent): void {
      /* v8 ignore next -- defensive only: this closure is torn down and rebuilt (via the `permission` effect dep) the instant `permission` changes, so `permission` is always truthy here whenever `onKey` can run (the outer `if (!permission || !inVoice) return` above already gates registration). */
      if (!permission) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        onRespond(permission.requestId, true);
        clear(null);
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        onRespond(permission.requestId, false);
        clear(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [permission, inVoice, onRespond, clear]);

  if (!permission || !inVoice) return null;

  return (
    <div
      className="voice-permission"
      data-testid="voice-permission"
      role="alertdialog"
      aria-label="voice permission request"
    >
      <div className="vp-summary" data-testid="voice-permission-summary">
        {permission.summary}
      </div>
      <div className="vp-voicehint" data-testid="voice-permission-voicehint">
        say <strong>yes</strong> / <strong>no</strong>
      </div>
      <div className="vp-buttons">
        <button
          type="button"
          className="vp-deny"
          data-testid="voice-permission-deny"
          onClick={() => {
            onRespond(permission.requestId, false);
            clear(null);
          }}
        >
          <X size={14} aria-hidden /> Deny
        </button>
        <button
          type="button"
          className="vp-approve"
          data-testid="voice-permission-approve"
          onClick={() => {
            onRespond(permission.requestId, true);
            clear(null);
          }}
        >
          <Check size={14} aria-hidden /> Approve
        </button>
      </div>
    </div>
  );
}
