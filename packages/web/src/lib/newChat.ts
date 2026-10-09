// Starting a new chat (spec/14 § Sidebar §8 `+ New chat` / § New chat drafts).
//
// There is MORE THAN ONE entry point — the sidebar FAB (bottom-left) and the
// chat header's top-right New chat icon (patch/todo.md: "need a new chat button
// visible somewhere, like top right?") — and they must behave identically, so
// the behaviour lives here rather than being copied per button.

import { useDraftStore } from '../stores/draftStore.js';

/**
 * Mint a FRESH draft and return the route to open it.
 *
 * Blank drafts are purged first so repeated clicks don't accumulate empties;
 * a draft with text is left intact and switchable from the sidebar's Drafts
 * section.
 */
export function newChatPath(): string {
  const st = useDraftStore.getState();
  st.pruneBlank();
  const id = st.create();
  return `/chats/new?draft=${id}`;
}
