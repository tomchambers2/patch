// Menu-bar tray-popover route (/menubar) — loaded by the Electron tray window.
//
// Per spec/14 ## Menu bar surface + spec/05 ## Menu-bar surface +
// design/web-hi-fi-menubar.html. Deliberately stripped: NO connection-state
// header, NO section labels, NO "Open patch" link. Top→bottom:
//   1. Manager row (semibold) with phone (voice call) + mic (voice note) icons.
//   2. Five most-recent chats — status badge, name, folder + preview, relative
//      time, hover-revealed mic-btn. Clicking a row launches the full app
//      focused on that chat.
//   3. Manager text input at the bottom (placeholder "Manager…", ⏎ fires the
//      typed text as a user turn into Manager).
//
// surface.heartbeat is driven by document visibility (PatchWs): the Electron
// tray window hides when the dropdown closes → visibilitychange → backgrounded
// → heartbeat stops. So the menu-bar heartbeats only while open (spec/05).

import type { JSX } from 'react';
import { useState, useMemo, useEffect } from 'react';
import { Phone, Mic, Send } from 'lucide-react';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { startVoiceNote } from '../lib/voiceController.js';
import { useUiStore } from '../stores/uiStore.js';
import { getActiveWs } from '../api/ws.js';
import { failed } from '../lib/errorCopy.js';

/** Electron preload bridge (window.patch), present only in the desktop shell. */
interface MenubarBridge {
  onMenubarVisibility?: (cb: (e: { visible: boolean }) => void) => () => void;
}
function getMenubarBridge(): MenubarBridge | undefined {
  return (window as unknown as { patch?: MenubarBridge }).patch;
}

/** Launch the full patch app focused on a chat (Electron opens the main window;
 *  in a browser this just navigates). */
function launchFullApp(chatId: string): void {
  const bridge = (window as unknown as { patch?: { openChat?: (id: string) => void } }).patch;
  if (bridge?.openChat) {
    bridge.openChat(chatId);
    return;
  }
  // Browser fallback for the same SPA route (dev / non-Electron).
  window.location.assign(`${window.location.origin}${baseAppPath()}chats/${chatId}`);
}

function baseAppPath(): string {
  // The SPA mounts at /app/; the menubar route is /app/menubar.
  const m = window.location.pathname.match(/^(.*\/)menubar$/);
  return m ? m[1]! : '/app/';
}

/**
 * sessionStorage key the full-app AppShell reads on mount to auto-open a
 * voice call. Used by the browser menubar surface, where the `/app/menubar`
 * bare route does NOT mount the VoiceBar — the call must open in the
 * full app window. Survives the `window.location.assign` navigation (same tab)
 * that `launchFullApp` performs.
 */
export const AUTO_CALL_KEY = 'patch:auto-call-chat';

/**
 * Open a voice CALL on the Manager thread from the menu-bar phone control
 * (spec/07 ## Overlay surfaces). In Electron the menubar is a separate tray
 * window whose main window owns the overlay, so we fire IPC to it; in a plain
 * browser the bare `/app/menubar` route has no overlay, so we navigate the full
 * app to Manager and stash an auto-call intent the AppShell consumes on mount.
 */
function startManagerCall(managerId: string): void {
  const bridge = (window as unknown as { patch?: { startVoiceCall?: (thread: string) => void } })
    .patch;
  if (bridge?.startVoiceCall) {
    bridge.startVoiceCall('manager');
    return;
  }
  try {
    sessionStorage.setItem(AUTO_CALL_KEY, managerId);
  } catch {
    /* storage unavailable — the navigation below still focuses Manager */
  }
  window.location.assign(`${window.location.origin}${baseAppPath()}chats/${managerId}`);
}

export function MenubarRoute(): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  const addLocalMessage = useChatStore((s) => s.addLocalMessage);
  const pushError = useUiStore((s) => s.pushError);
  const [text, setText] = useState('');

  const managerId = SPECIAL_THREAD_IDS.manager;

  // spec/05 ## Menu-bar surface: heartbeat ONLY while the dropdown is open.
  // Electron's tray popover `.hide()` does NOT fire `visibilitychange`, so the
  // main process tells us via `patch:menubar-visibility`; we drive PatchWs
  // foreground/background directly. On hide → background (heartbeat stops); on
  // show → foreground (heartbeat resumes). In a plain browser this bridge is
  // absent and the document-visibility path in PatchWs governs as before.
  useEffect(() => {
    const bridge = getMenubarBridge();
    if (!bridge?.onMenubarVisibility) return;
    const off = bridge.onMenubarVisibility(({ visible }) => {
      const ws = getActiveWs();
      if (!ws) return;
      if (visible) ws.foreground();
      else ws.background();
    });
    return off;
  }, []);

  const recents = useMemo(
    () =>
      Object.values(chats)
        .filter((c) => c.chatId !== managerId && c.status !== 'archived')
        .sort((a, b) => b.lastUpdated - a.lastUpdated)
        .slice(0, 5),
    [chats, managerId],
  );

  function sendToManager(): void {
    const message = text.trim();
    if (!message) return;
    const ws = getActiveWs();
    if (!ws) {
      pushError('not connected to the server');
      return;
    }
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      ws.send({ type: 'chat.input', chatId: managerId, message, localId });
      addLocalMessage(managerId, message, localId);
      setText('');
    } catch (e) {
      pushError(failed('send'), undefined, (e as Error).message);
    }
  }

  return (
    <div className="menubar-popover" data-testid="menubar-popover">
      <button
        type="button"
        className="menubar-row manager"
        data-testid="menubar-manager-row"
        onClick={() => launchFullApp(managerId)}
      >
        <span className="menubar-name">Manager</span>
        <span className="menubar-tools">
          <span
            role="button"
            tabIndex={0}
            className="menubar-tool"
            aria-label="start voice call with Manager"
            data-testid="menubar-manager-call"
            onClick={(e) => {
              e.stopPropagation();
              // spec/07 ## Overlay surfaces: menu-bar dropdown phone icon on
              // the Manager row → voice-CALL overlay (target = Manager).
              startManagerCall(managerId);
            }}
          >
            <Phone size={12} aria-hidden />
          </span>
          <span
            role="button"
            tabIndex={0}
            className="menubar-tool"
            aria-label="hold to send voice note to Manager"
            data-testid="menubar-manager-mic"
            onClick={(e) => {
              e.stopPropagation();
              // Menu-bar dropdown mic on Manager → voice-NOTE (target = Manager).
              void startVoiceNote(managerId, 'toggle');
            }}
          >
            <Mic size={12} aria-hidden />
          </span>
        </span>
      </button>

      <div className="menubar-divider" />

      {recents.map((c) => (
        <div
          key={c.chatId}
          className="menubar-row menubar-recent"
          data-testid={`menubar-row-${c.chatId}`}
        >
          <button
            type="button"
            className="menubar-row-open"
            onClick={() => launchFullApp(c.chatId)}
            aria-label={`open ${deriveChatTitle(c.name)}`}
          >
            <span className={`menubar-status badge ${activityClass(c.activity)}`} />
            <span className="menubar-body">
              {/* Same placeholder as every other surface: an unnamed chat is
                  a "New chat", not an "Untitled" one (spec/04 § Name). */}
              <span className="menubar-name">{deriveChatTitle(c.name)}</span>
              <span className="menubar-preview">{c.folder}</span>
            </span>
            <span className="menubar-when">{relativeTime(c.lastUpdated)}</span>
          </button>
          <button
            type="button"
            className="menubar-mic-btn"
            aria-label={`voice note to ${c.name ?? 'chat'}`}
            data-testid={`menubar-mic-${c.chatId}`}
            onClick={() => void startVoiceNote(c.chatId, 'toggle')}
          >
            <Mic size={12} aria-hidden />
          </button>
        </div>
      ))}

      <div className="menubar-input-wrap">
        <div className="menubar-input-row">
          <input
            className="menubar-input"
            placeholder="Manager…"
            data-testid="menubar-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendToManager();
              }
            }}
          />
          <button
            type="button"
            className="menubar-send"
            data-testid="menubar-send"
            aria-label="send to Manager"
            onClick={sendToManager}
          >
            <Send size={13} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

// Namespaced to match `StatusBadge` — a bare `permission` here would pick up
// the transcript approval card's `.permission` padding and blow the 8px dot up
// into a 32px blob (see the `.badge` block in index.css).
function activityClass(activity: string): string {
  if (activity === 'awaiting-permission') return 'badge-permission';
  if (activity === 'running') return 'badge-working';
  return '';
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
