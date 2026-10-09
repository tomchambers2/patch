// openBeside — open a chat in the pane directly to the right of a job's page
// (spec/14 § Panes and tabs § Opening things — "Runs open beside the job").
//
// The target is read off the layout tree rather than remembered: if the job's
// pane sits in a row split and the next sibling is a pane whose active tab is a
// chat, that pane is the run pane and the chat replaces its tab; otherwise a
// new pane is split to the right of the job. Reading the tree is what keeps
// this right after a reload and after the user drags things around.

import {
  findPane,
  useLayoutStore,
  type LeafPane,
  type PaneNode,
  type TabDescriptor,
} from '../stores/layoutStore.js';

function parentOf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') return null;
  for (const child of node.children) {
    if (child.pane.id === paneId) return node;
    const found = parentOf(child.pane, paneId);
    if (found) return found;
  }
  return null;
}

function holdsTab(node: PaneNode, key: string): LeafPane | null {
  if (node.type === 'leaf') return node.tabs.some((t) => t.id === key) ? node : null;
  for (const c of node.children) {
    const hit = holdsTab(c.pane, key);
    if (hit) return hit;
  }
  return null;
}

export function openChatBesideJob(jobId: string, chatId: string): void {
  const store = useLayoutStore.getState();
  const jobTab: TabDescriptor = { kind: 'page', page: 'job', jobId };
  const chatTab: TabDescriptor = { kind: 'chat', chatId };
  const jobFound = store.findTab(jobTab);
  if (!jobFound) {
    // The job page is not in the tree (a detached window): nothing to sit
    // beside, so it is an ordinary open.
    store.openTab(chatTab);
    return;
  }
  const jobPane = jobFound.pane;
  const parent = parentOf(store.root, jobPane.id);
  if (parent && parent.type === 'split' && parent.direction === 'row') {
    const idx = parent.children.findIndex((c) => holdsTab(c.pane, jobFound.tab.id) !== null);
    const next = parent.children[idx + 1]?.pane;
    if (next && next.type === 'leaf') {
      const active = next.tabs.find((t) => t.id === next.activeTabId);
      if (active?.descriptor.kind === 'chat') {
        store.openTab(chatTab, { paneId: next.id, placement: 'active' });
        return;
      }
    }
  }
  if (findPane(store.root, jobPane.id)) {
    store.openTab(chatTab, { paneId: jobPane.id, placement: 'split', edge: 'right' });
  }
}

/** Middle-click: a new tab in the active pane, the same as a sidebar row. */
export function openChatInNewTab(chatId: string): void {
  useLayoutStore.getState().openTab({ kind: 'chat', chatId }, { placement: 'tab' });
}
