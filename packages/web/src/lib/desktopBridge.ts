// desktopBridge — typed accessor for the Electron preload surface
// (packages/desktop/src/preload.ts, exposed on window.patch). Returns
// undefined in the browser, where these hooks don't exist. NO FALLBACK: the
// browser surface simply has no desktop bridge, and callers no-op.

import { useEffect, useState } from 'react';
import type { NotifyActions, NotifyKind } from '@patch/wire';

/** What main asks the renderer to actually send (spec/09 § Notification actions). */
export type NotificationSendPayload = {
  requestId: string;
  chatId: string;
  intent:
    | { kind: 'reply'; text: string }
    | { kind: 'permission'; requestId: string; decision: 'approve' | 'deny' }
    | { kind: 'question_answer'; requestId: string; questionText: string; answer: string }
    | { kind: 'ignore' };
};

export interface PatchDesktopBridge {
  /**
   * spec/05 § Desktop packaging → Window chrome: true when the shell drew this
   * platform's document windows with NO native title bar, so the SPA runs to
   * the window's top edge and the macOS traffic lights float over its
   * top-left. The renderer reserves their strip and supplies a drag region —
   * see `lib/windowChrome.ts`. A plain value rather than an IPC call because
   * the layout needs it on the first paint. Undefined in a browser, which has
   * no shell and no window chrome to compensate for.
   */
  overlayTitleBar?: boolean;
  /**
   * spec/09 § `### desktop` — show a native OS toast. Only the main process can
   * reach Electron's Notification, so an inbound `notify { channel: 'desktop' }`
   * goes out through IPC. Undefined in a plain browser, which never receives
   * that frame anyway (it authenticates as a `web` surface).
   */
  notify?(payload: {
    title: string;
    body: string;
    chatId?: string;
    priority?: 'silent' | 'normal' | 'urgent';
    /** spec/09 § Batch check-in — `'batch'` lands the click on the batch view. */
    kind?: NotifyKind;
    actions?: NotifyActions;
  }): void;
  /**
   * spec/09 § Notification actions — main decided a Reply/Approve/Deny/
   * option/quickReply tap on a desktop toast means something, and hands it
   * here to actually send: this renderer owns the live WS and the
   * guaranteed-delivery trackers a background Electron process does not.
   * Undefined on a shell that predates it, and always in the browser (which
   * has no native toast to answer).
   */
  onNotificationSend?(cb: (payload: NotificationSendPayload) => void): () => void;
  /** The renderer's answer back — did the send actually go out. */
  notificationSendResult?(requestId: string, ok: boolean): void;
  openChat?(id: string): void;
  onNavigate?(cb: (e: { path: string }) => void): () => void;
  /** ⌃Space global hotkey → start a voice note (target thread). */
  onStartVoiceNote?(cb: (e: { thread: string }) => void): () => void;
  /** Menu-bar phone → start a voice call (target thread). */
  onStartVoiceCall?(cb: (e: { thread: string }) => void): () => void;
  /**
   * Meeting mode: the shell's native helper taps the system's audio (a Core
   * Audio tap, so no screen is shared) and streams it as 16 kHz mono PCM16.
   * `startSystemAudio` rejects, with the helper's own message, if it cannot
   * start (e.g. System Audio Recording not allowed). Absent on a shell that
   * predates it.
   */
  startSystemAudio?(): Promise<void>;
  stopSystemAudio?(): void;
  onSystemAudio?(cb: (pcm: Uint8Array) => void): () => void;
  /** The tap stopped without being asked to. */
  onSystemAudioFailed?(cb: (e: { message: string }) => void): () => void;
  /** The shell saw a calling app open (`started`) or let go of (`ended`) the mic. */
  onMeetingSignal?(cb: (e: { phase: 'started' | 'ended'; app: string }) => void): () => void;
  /**
   * spec/14 ## Manager incoming-call UX: raise the main window to the
   * foreground when a server-triggered call arrives. The renderer's
   * `window.focus()` does NOT foreground a backgrounded Electron window on
   * macOS — only the main process (BrowserWindow.show()+focus()+app.focus)
   * can. No-op in the browser.
   */
  requestRaise?(): void;
  /**
   * spec/11 § Version reporting — the desktop shell's own update state. Only the
   * main process can reach electron-updater, so the panel goes through IPC.
   * Undefined in a plain browser, where there is no shell to update; the panel
   * omits the shell row entirely rather than showing an empty one.
   */
  getUpdaterState?(): Promise<DesktopUpdaterState>;
  /**
   * spec/09 § Presence heuristic — milliseconds since the last input anywhere
   * on the machine. Absent on shells that predate it, and in a browser.
   */
  getSystemIdleMs?(): Promise<number>;
  /**
   * spec/02 § Desktop app and the local host — whether this Mac runs a
   * host, and installing one with a freshly minted pairing code. Absent in a
   * browser and on shells that predate it.
   */
  localDaemon?: {
    status(): Promise<{ installed: boolean; daemonId: string | null }>;
    install(code: string): Promise<{ ok: boolean; exitCode: number | null; output: string }>;
  };
  /** Run a check now and resolve with the resulting state. */
  checkForUpdates?(): Promise<DesktopUpdaterState>;
  /** Subscribe to state pushes from main (download progress, errors). */
  onUpdaterState?(cb: (state: DesktopUpdaterState) => void): () => void;
  /**
   * A deploy has just landed (liveUpdate.ts saw a new bundle hash): check the
   * shell's own feed NOW rather than leaving the shell up to an hour behind the
   * surface it is rendering. It DOWNLOADS only — the shell no longer restarts
   * itself, it raises a banner (see DesktopUpdateBanner) and waits to be asked.
   */
  checkForUpdateNow?(): void;
  /**
   * Quit, apply the staged update, relaunch. Reached only from a control the
   * user pressed.
   */
  installUpdate?(): void;
  /**
   * spec/14 § Links and the web panel — ask the shell to SHOW a page in the
   * right-docked web panel. This is Patch showing you something (an artifact, a
   * preview). A link the user clicks can land in the same panel, but it gets
   * there in the main process (the shell's own link policy decides from the
   * click's gesture), never through this bridge.
   */
  openPanel?(url: string): void;
  /**
   * spec/14 § Artifacts — ask the shell to CLOSE the right-docked web panel.
   * The panel shows the artifact belonging to the chat you are in, so opening a
   * chat that has none (or leaving the chat route) has to be able to put it
   * away again, not just replace its page.
   */
  closePanel?(): void;
  /**
   * Width (px) the web panel currently occupies, pushed by main whenever it
   * opens, resizes or closes (0 = closed). The app insets itself by exactly
   * that much so it is a SIDE panel, not an overlay.
   */
  onPanelInset?(cb: (e: { width: number }) => void): () => void;
  /**
   * spec/14 § Links and the web panel — the divider between the Patch UI and
   * the panel is being dragged to `width` px. Undefined in the browser, which
   * has no native panel to resize.
   */
  resizePanel?(width: number): void;
  /** Double-click on the panel divider: back to the default share. */
  resetPanelWidth?(): void;
  /**
   * spec/14 § New windows — open `path` (an in-app SPA route, e.g.
   * `/chats/<id>?sidebar=hidden` or `/sidebar-window`) in a NEW, independent
   * Electron window rather than navigating this one. Distinct from
   * `openPanel`: this is a real second window (own titlebar, own socket),
   * not a docked side panel. Undefined in a plain browser, where the caller
   * falls back to `window.open` — see `lib/newWindow.ts`. `size` asks for an
   * opening size (the detached sidebar wants a sidebar's width, not a
   * document's); omitted, the shell uses its ordinary window size.
   */
  openWindow?(path: string, size?: { width: number; height: number }): void;
}

/**
 * Mirror of the shell's UpdaterState (packages/desktop/src/updater.ts) as it
 * arrives over IPC.
 */
export interface DesktopUpdaterState {
  currentVersion: string;
  gitSha: string | null;
  builtAt: string | null;
  feedUrl: string | null;
  /** Non-null when the shell CANNOT update, with the specific reason why. */
  disabledReason: string | null;
  lastCheckedAt: string | null;
  lastResult: 'up-to-date' | 'update-available' | 'downloaded' | 'error' | null;
  lastError: string | null;
  availableVersion: string | null;
  downloaded: boolean;
  checking: boolean;
  /** When this shell first fell behind the feed — what the banner escalates on. */
  staleSince: string | null;
}

export function getDesktopBridge(): PatchDesktopBridge | undefined {
  /* v8 ignore next -- jsdom (the test environment) always defines `window`; this SSR/non-DOM guard cannot be exercised under vitest+jsdom. */
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { patch?: PatchDesktopBridge }).patch;
}

/**
 * The shell's own updater state, live. `null` in a browser (no bridge) and
 * until the first `getUpdaterState()` resolves.
 *
 * The ONE place that subscribes to shell updater state, so DesktopUpdateBanner
 * and WebUpdateBanner read the same value instead of each polling their own —
 * two independent reads of "has the shell finished downloading?" is how they
 * used to drift and show a Restart prompt and a Reload prompt for the same
 * deploy at once.
 */
export function useDesktopUpdaterState(): DesktopUpdaterState | null {
  const [state, setState] = useState<DesktopUpdaterState | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.getUpdaterState) return;
    let live = true;
    void bridge.getUpdaterState().then((s) => {
      if (live) setState(s);
    });
    const off = bridge.onUpdaterState?.((s) => setState(s));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return state;
}
