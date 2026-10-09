// Preload for the first-run window (src/setup/setup.html): the page's whole
// connection to the shell. It can make one choice and be told how it is going;
// it can reach nothing else.

import { contextBridge, ipcRenderer } from 'electron';

type Choice = { kind: 'local' } | { kind: 'remote'; input: string };

contextBridge.exposeInMainWorld('patchSetup', {
  choose(choice: Choice): void {
    ipcRenderer.send('patch:setup:choose', choice);
  },
  onProgress(cb: (message: string) => void): void {
    ipcRenderer.on('patch:setup:progress', (_e, message: string) => cb(message));
  },
  onFail(cb: (message: string) => void): void {
    ipcRenderer.on('patch:setup:fail', (_e, message: string) => cb(message));
  },
});
