// Preload — bridges main-process Electron capabilities to the renderer
// (the web SPA) over the contextIsolation boundary. Group 19.
//
// What we expose:
//   - patch.notify({ title, body, chatId?, priority?, actions? }) → main shows a native toast
//   - patch.onNotificationSend(cb)            → main asks the renderer to actually
//                                               send a Reply/Approve/Deny/question answer
//   - patch.notificationSendResult(id, ok)    → the renderer's answer back
//   - patch.checkForUpdateNow()               → a deploy landed: check the feed now
//   - patch.installUpdate()                   → the user pressed Restart
//   - patch.onNavigate(cb)                    → main asks the renderer to navigate
//   - patch.onStartVoiceNote(cb)              → ⌃Space global hotkey hit
//   - patch.getDesktopEvents()                → test/inspection hook
//   - patch.localDaemon.status()/install()    → the host on this Mac
//   - patch.overlayTitleBar                   → this platform's windows have no
//                                               native title bar (spec/05
//                                               § Window chrome)
//
// NO FALLBACK: bridge methods throw if invoked outside Electron.

import { contextBridge, ipcRenderer } from 'electron';

/**
 * Mirrors packages/wire's `NotifyActions` shape. Not imported from
 * `@patch/wire`: this preload runs in a SANDBOXED renderer (see
 * `overlayTitleBar`'s own comment below on why a relative/package require
 * throws there and takes the whole bridge down with it), so every type here
 * is self-contained.
 */
interface NotifyActionsPayload {
  kind: 'message' | 'permission' | 'question';
  requestId?: string;
  questionText?: string;
  options?: string[];
  quickReplies?: string[];
}

interface NotifyPayload {
  title: string;
  body: string;
  chatId?: string;
  priority?: 'silent' | 'normal' | 'urgent';
  /** spec/09 § Batch check-in — `'batch'` means the click lands on the batch
   *  view, not a chat (`chatId` is a reserved non-chat sentinel on that one). */
  kind?: 'message' | 'call' | 'batch' | 'ask';
  actions?: NotifyActionsPayload;
}

/** What main asks the renderer to actually send (spec/09 § Notification actions). */
interface NotificationSendPayload {
  requestId: string;
  chatId: string;
  intent:
    | { kind: 'reply'; text: string }
    | { kind: 'permission'; requestId: string; decision: 'approve' | 'deny' }
    | { kind: 'question_answer'; requestId: string; questionText: string; answer: string }
    | { kind: 'ignore' };
}

contextBridge.exposeInMainWorld('patch', {
  // Whether the shell hid the title bar on this platform's document windows,
  // in which case the SPA has to keep its top-left clear of the traffic lights
  // and provide its own drag region. A plain value, not IPC: the renderer
  // needs it on the first paint, and an awaited answer would land a frame late
  // as a visible jump. Platform is fixed for the process, so the preload knows
  // it outright. The renderer still excludes the frameless popover windows
  // itself — see `lib/windowChrome.ts`; the preload cannot tell which window
  // it was injected into.
  //
  // The rule is DUPLICATED from `window-chrome.ts`'s overlayTitleBarSupported()
  // rather than imported, and must stay that way: this preload runs in a
  // SANDBOXED renderer, where `require` is a polyfill that resolves `electron`
  // and a few Node builtins and nothing else. A relative require throws there,
  // and the throw takes the WHOLE bridge down with it — `window.patch` is never
  // exposed at all, so native notifications, the voice hotkeys, "open in new
  // window" and the updater panel die together, silently. `window-chrome.test.ts`
  // is what keeps the two copies in agreement.
  overlayTitleBar: process.platform === 'darwin',
  notify(payload: NotifyPayload): void {
    ipcRenderer.send('patch:notify', payload);
  },
  // spec/09 § Notification actions — main decided a Reply/Approve/Deny/
  // option/quickReply tap means something and asks the renderer (which owns
  // the live WS + guaranteed-delivery trackers) to actually send it.
  onNotificationSend(cb: (payload: NotificationSendPayload) => void): () => void {
    const handler = (_: unknown, payload: NotificationSendPayload): void => cb(payload);
    ipcRenderer.on('patch:notification-send', handler);
    return () => ipcRenderer.removeListener('patch:notification-send', handler);
  },
  notificationSendResult(requestId: string, ok: boolean): void {
    ipcRenderer.send('patch:notification-send-result', { requestId, ok });
  },
  onNavigate(cb: (e: { path: string }) => void): () => void {
    const handler = (_: unknown, payload: { path: string }): void => cb(payload);
    ipcRenderer.on('patch:navigate', handler);
    return () => ipcRenderer.removeListener('patch:navigate', handler);
  },
  onStartVoiceNote(cb: (e: { thread: string }) => void): () => void {
    const handler = (_: unknown, payload: { thread: string }): void => cb(payload);
    ipcRenderer.on('patch:start-voice-note', handler);
    return () => ipcRenderer.removeListener('patch:start-voice-note', handler);
  },
  onStartVoiceCall(cb: (e: { thread: string }) => void): () => void {
    const handler = (_: unknown, payload: { thread: string }): void => cb(payload);
    ipcRenderer.on('patch:start-voice-call', handler);
    return () => ipcRenderer.removeListener('patch:start-voice-call', handler);
  },
  // Meeting mode: the native audio helper's system audio (16 kHz mono PCM16),
  // and the shell noticing a call app open/close the mic.
  async startSystemAudio(): Promise<void> {
    await ipcRenderer.invoke('patch:system-audio:start');
  },
  stopSystemAudio(): void {
    ipcRenderer.send('patch:system-audio:stop');
  },
  onSystemAudio(cb: (pcm: Uint8Array) => void): () => void {
    const handler = (_: unknown, pcm: Uint8Array): void => cb(pcm);
    ipcRenderer.on('patch:system-audio', handler);
    return () => ipcRenderer.removeListener('patch:system-audio', handler);
  },
  onSystemAudioFailed(cb: (e: { message: string }) => void): () => void {
    const handler = (_: unknown, payload: { message: string }): void => cb(payload);
    ipcRenderer.on('patch:system-audio-failed', handler);
    return () => ipcRenderer.removeListener('patch:system-audio-failed', handler);
  },
  onMeetingSignal(cb: (e: { phase: 'started' | 'ended'; app: string }) => void): () => void {
    const handler = (_: unknown, payload: { phase: 'started' | 'ended'; app: string }): void =>
      cb(payload);
    ipcRenderer.on('patch:meeting-signal', handler);
    return () => ipcRenderer.removeListener('patch:meeting-signal', handler);
  },
  // spec/14 ## Manager incoming-call UX: ask main to raise the main window to
  // the foreground (renderer window.focus() can't foreground a backgrounded
  // Electron window on macOS).
  requestRaise(): void {
    ipcRenderer.send('patch:request-raise');
  },
  // spec/05 ## Menu-bar surface: the tray popover's show/hide, sent from main
  // because Electron's `BrowserWindow.hide()` does NOT fire the renderer's
  // `visibilitychange`. The menu-bar surface uses this to start/stop its
  // surface.heartbeat so it beats only while the dropdown is open.
  onMenubarVisibility(cb: (e: { visible: boolean }) => void): () => void {
    const handler = (_: unknown, payload: { visible: boolean }): void => cb(payload);
    ipcRenderer.on('patch:menubar-visibility', handler);
    return () => ipcRenderer.removeListener('patch:menubar-visibility', handler);
  },
  // spec/14 § Links and the web panel: Patch asking to SHOW a page in the
  // right-docked web panel (an artifact, a preview). Links the user clicks do
  // NOT come through here — main sends those to the real browser.
  openPanel(url: string): void {
    ipcRenderer.send('patch:panel:open', { url });
  },
  // spec/14 § Artifacts: put the panel away. The panel shows the artifact of
  // the chat you are in, so the renderer needs a close of its own — distinct
  // from `patch:iab:close`, which is the panel toolbar's own × button.
  closePanel(): void {
    ipcRenderer.send('patch:panel:close');
  },
  // Width (px) the panel is occupying, so the app can inset itself by exactly
  // that much and stay usable beside it. 0 means the panel is closed.
  onPanelInset(cb: (e: { width: number }) => void): () => void {
    const handler = (_: unknown, payload: { width: number }): void => cb(payload);
    ipcRenderer.on('patch:panel-inset', handler);
    return () => ipcRenderer.removeListener('patch:panel-inset', handler);
  },
  // spec/14 § Links and the web panel: the divider is being dragged to `width`
  // px. Fired on every pointermove — main re-lays out the real views and
  // echoes `patch:panel-inset` so the page and the Patch UI follow live.
  resizePanel(width: number): void {
    ipcRenderer.send('patch:panel:resize', { width });
  },
  // Double-click on the divider: back to the default share.
  resetPanelWidth(): void {
    ipcRenderer.send('patch:panel:reset-width');
  },
  async getDesktopEvents(): Promise<unknown[]> {
    return (await ipcRenderer.invoke('patch:get-events')) as unknown[];
  },
  // spec/11 § Version reporting — the desktop half of the "Version & updates"
  // panel. The renderer can't reach electron-updater (main-process only), so it
  // reads state, triggers a check, and subscribes to changes over IPC.
  // spec/09 § Presence heuristic — milliseconds since the last keyboard or
  // mouse input anywhere on this machine, not just in Patch.
  async getSystemIdleMs(): Promise<number> {
    return (await ipcRenderer.invoke('patch:system-idle-ms')) as number;
  },
  // spec/02 § Desktop app and the local host.
  localDaemon: {
    status(): Promise<{ installed: boolean; daemonId: string | null }> {
      return ipcRenderer.invoke('patch:local-daemon:status') as Promise<{
        installed: boolean;
        daemonId: string | null;
      }>;
    },
    install(code: string): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
      return ipcRenderer.invoke('patch:local-daemon:install', { code }) as Promise<{
        ok: boolean;
        exitCode: number | null;
        output: string;
      }>;
    },
  },
  async getUpdaterState(): Promise<unknown> {
    return await ipcRenderer.invoke('patch:updater:get-state');
  },
  async checkForUpdates(): Promise<unknown> {
    return await ipcRenderer.invoke('patch:updater:check');
  },
  // A deploy just landed. Check the feed now instead of waiting for the hourly
  // check, so the pending-update banner appears promptly. Downloads only —
  // nothing restarts the shell without the user asking.
  checkForUpdateNow(): void {
    ipcRenderer.send('patch:updater:check-now');
  },
  // The user pressed Restart (banner or version panel): quit, swap the bundle,
  // relaunch. The only path that ends the process for an update.
  installUpdate(): void {
    ipcRenderer.send('patch:updater:install');
  },
  onUpdaterState(cb: (state: unknown) => void): () => void {
    const handler = (_: unknown, state: unknown): void => cb(state);
    ipcRenderer.on('patch:updater-state', handler);
    return () => ipcRenderer.removeListener('patch:updater-state', handler);
  },
  // spec/14 § New windows — open an in-app SPA route in a brand new,
  // independent Electron window rather than navigating this one. `size` is
  // the caller's opening size (the detached sidebar asks for a sidebar's
  // width); omitted, main opens its ordinary window.
  openWindow(path: string, size?: { width: number; height: number }): void {
    ipcRenderer.send('patch:window:open', { path, size });
  },
});

export {};
