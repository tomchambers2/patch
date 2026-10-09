// openArtifact — show a published artifact page (spec/14 § Artifacts).
//
// On the desktop shell this is exactly the "page PATCH wants to show you" case,
// so it goes to the right-docked web panel, and the page becomes the OPENING
// chat's artifact: `artifactPanel.ts` keeps it with that chat so it follows it.
// In a plain browser there is no panel, so the page opens in a new tab and
// nothing is remembered. NO FALLBACK beyond that: the URL is always the
// server-served artifact URL, never something reconstructed locally.

import { getDesktopBridge } from './desktopBridge.js';
import { rememberArtifact } from './artifactPanel.js';
import { openPadBesideChat } from './openPad.js';

export function openArtifact(url: string, chatId: string): void {
  // A Pad card is a `chat.artifact` whose url is the Pad's own route: it opens
  // beside its chat in a pane, not in the web panel (spec/14 § Pads).
  const pad = /^\/pads\/([^/?#]+)$/.exec(url);
  if (pad) {
    openPadBesideChat(decodeURIComponent(pad[1] as string), chatId);
    return;
  }
  const absolute = new URL(url, window.location.origin).toString();
  const bridge = getDesktopBridge();
  if (bridge?.openPanel) {
    rememberArtifact(chatId, absolute);
    bridge.openPanel(absolute);
    return;
  }
  window.open(absolute, '_blank', 'noopener');
}
