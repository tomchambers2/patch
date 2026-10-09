// openPadBesideChat — open a Pad in the pane directly to the left of its owning
// chat (spec/14 § Pads — "A Pad opens beside its chat"), so Tom edits the design
// with the conversation that will act on it in view. The chat is opened first if
// it is not already in the layout; a Pad that is already open is only focused.

import { useLayoutStore, type TabDescriptor } from '../stores/layoutStore.js';

export function openPadBesideChat(padId: string, chatId: string): void {
  const store = useLayoutStore.getState();
  const padTab: TabDescriptor = { kind: 'page', page: 'pad', padId };
  if (store.findTab(padTab)) {
    store.openTab(padTab);
    return;
  }
  const chatTab: TabDescriptor = { kind: 'chat', chatId };
  let chat = store.findTab(chatTab);
  if (!chat) {
    store.openTab(chatTab);
    chat = useLayoutStore.getState().findTab(chatTab);
  }
  if (chat) {
    useLayoutStore
      .getState()
      .openTab(padTab, { paneId: chat.pane.id, placement: 'split', edge: 'left' });
  } else {
    useLayoutStore.getState().openTab(padTab);
  }
}
