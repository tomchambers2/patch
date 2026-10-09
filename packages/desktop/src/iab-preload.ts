// Preload for the in-app browser TOOLBAR view (in-app-browser.ts). Bridges the
// toolbar's HTML buttons to the main process over contextIsolation. Separate
// from the main preload because the toolbar is its own WebContentsView with a
// tiny, purpose-built surface (`window.iab`) — the page view below it gets NO
// preload at all (it hosts untrusted remote sites).
//
// NO FALLBACK: these throw if invoked outside Electron.

import { contextBridge, ipcRenderer } from 'electron';

interface IabState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

contextBridge.exposeInMainWorld('iab', {
  back(): void {
    ipcRenderer.send('patch:iab:back');
  },
  forward(): void {
    ipcRenderer.send('patch:iab:forward');
  },
  reload(): void {
    ipcRenderer.send('patch:iab:reload');
  },
  close(): void {
    ipcRenderer.send('patch:iab:close');
  },
  openExternal(): void {
    ipcRenderer.send('patch:iab:open-external');
  },
  onState(cb: (s: IabState) => void): () => void {
    const handler = (_: unknown, s: IabState): void => cb(s);
    ipcRenderer.on('patch:iab:state', handler);
    return () => ipcRenderer.removeListener('patch:iab:state', handler);
  },
});

export {};
