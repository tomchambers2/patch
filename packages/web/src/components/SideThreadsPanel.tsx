// SideThreadsPanel — the Threads panel (spec/14 § Side threads panel).
//
// Docks on the right of the chat, like the Tools panel / editor rail, and is
// resizable on the same drag-resizable-divider convention as both (spec/14 §
// Layout). One tab per side thread of the chat on screen, each a small chat
// of its own: transcript from the fork point on, its own composer, stop,
// permissions, and a "Send back to chat" button. Side threads can branch
// again from inside here — the new one opens as another tab.
//
// A side branch's content is PULL-based, not push-based (spec/04 §
// Parallel branches — "no surface renders a second track" until this panel):
// nothing broadcasts it live, so each tab polls `GET /api/chats/:id/history`
// for its own branch while that branch is `running`, and once on open
// otherwise. The branch's `running`/name/sentBack fields DO arrive live on
// `chat.branches` — that is what drives the tab's status dot without polling.

import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { GitFork } from 'lucide-react';
import type { ChatBranch } from '@patch/wire';
import { useUiStore } from '../stores/uiStore.js';
import { activeChatOf, resolvePane, useLayoutStore } from '../stores/layoutStore.js';
import { useChatStore } from '../stores/chatStore.js';
import type { PendingPermission } from '../stores/types.js';
import {
  useSideThreadsStore,
  DRAFT_TAB_ID,
  orderTabs,
  type SideThreadDraft,
} from '../stores/sideThreadsStore.js';
import {
  startSideThread,
  sendToBranch,
  stopBranch,
  sendBackToChat,
  openSideThreadDraft,
} from '../lib/sideThreadActions.js';
import { getActiveWs } from '../api/ws.js';
import { api } from '../api/rest.js';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker.js';
import { ColumnDivider } from './ColumnDivider.js';
import { CloseIcon } from './icons.js';
import { Markdown } from './Markdown.js';
import { isSubmitChord } from '../lib/submitChord.js';

interface BranchHistoryEvent {
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const QUOTE_MAX = 90;
/** Not `text/plain`: a dragged tab must not drop as text into a composer. */
const STP_DRAG_TYPE = 'application/x-patch-side-thread-tab';

function tabKey(e: ReactKeyboardEvent, activate: () => void): void {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate();
  }
}
// A selector returning `x ?? []` hands `useSyncExternalStore` a FRESH array
// identity every render even when nothing changed, which never settles and
// re-renders forever — share one empty array instead (chatStore.ts's
// `sideThreadPermissions` is only ever reassigned wholesale by `set()`, so a
// missing key is stably absent, not stably a new array).
const EMPTY_PERMISSIONS: PendingPermission[] = [];

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** running / needs-you / idle — spec/14 § Side threads panel PANEL (tab status dot). */
function tabStatus(branch: ChatBranch, needsYou: boolean): 'running' | 'needs-you' | 'idle' {
  if (needsYou) return 'needs-you';
  if (branch.running) return 'running';
  return 'idle';
}

function StatusDot({ status }: { status: 'running' | 'needs-you' | 'idle' }): JSX.Element {
  return (
    <span className={`stp-dot stp-dot-${status}`} data-testid="stp-status-dot" aria-hidden="true" />
  );
}

export function SideThreadsPanel(): JSX.Element | null {
  const chatId = useSideThreadsStore((s) => s.panelChatId);
  const closePanel = useSideThreadsStore((s) => s.closePanel);
  const activeTabByChatId = useSideThreadsStore((s) => s.activeTabByChatId);
  const closedTabsByChatId = useSideThreadsStore((s) => s.closedTabsByChatId);
  const tabOrderByChatId = useSideThreadsStore((s) => s.tabOrderByChatId);
  const pendingNewTab = useSideThreadsStore((s) => s.pendingNewTab);
  const draftByChatId = useSideThreadsStore((s) => s.draftByChatId);
  const setActiveTab = useSideThreadsStore((s) => s.setActiveTab);
  const closeTab = useSideThreadsStore((s) => s.closeTab);
  const reorderTabs = useSideThreadsStore((s) => s.reorderTabs);
  const openThread = useSideThreadsStore((s) => s.openThread);
  const closeDraft = useSideThreadsStore((s) => s.closeDraft);

  const width = useUiStore((s) => s.threadsPanelWidth);
  const setWidth = useUiStore((s) => s.setThreadsPanelWidth);

  const branchGraph = useChatStore((s) => (chatId ? s.branchGraphs[chatId] : undefined));
  const sideThreadPermissions = useChatStore((s) => s.sideThreadPermissions);
  // The chat in the focused pane's active tab — what the panel docks beside.
  // Not the address bar: switching tabs or panes never moves the URL (spec/14
  // § Panes and tabs), so the URL names whichever chat was opened last, not
  // the one on screen.
  const focusedChatId = useLayoutStore((s) => activeChatOf(resolvePane(s.root, s.activePaneId)));

  // spec/14 § Side threads panel TRIGGER — the host mints the new branch's
  // id, so the trigger can only ARM an expectation (`pendingNewTab`); this
  // reconciler is what actually opens the panel once `chat.branches` reports
  // the real branch. `seenRef` guards against treating a chat's PRE-EXISTING
  // side threads as "new" the first time this mounts for it.
  const seenRef = useRef<Record<string, Set<string>>>({});
  useEffect(() => {
    if (!chatId || !branchGraph) return;
    const sideIds = branchGraph.branches.filter((b) => b.sideThread).map((b) => b.branchId);
    const seen = seenRef.current[chatId];
    const firstObservation = seen === undefined;
    seenRef.current[chatId] = new Set(sideIds);
    if (firstObservation || !pendingNewTab[chatId]) return;
    const newId = sideIds.find((id) => !seen.has(id));
    if (newId) openThread(chatId, newId);
  }, [chatId, branchGraph, pendingNewTab, openThread]);

  // Another chat having focus hides the panel rather than closing it: its
  // tabs and drafts are still there when the user comes back to this chat.
  if (chatId === null || chatId !== focusedChatId) return null;

  const draft = draftByChatId[chatId];
  const sideBranches = (branchGraph?.branches ?? []).filter((b) => b.sideThread);
  const closed = new Set(closedTabsByChatId[chatId] ?? []);
  const visibleIds = orderTabs(
    sideBranches.map((b) => b.branchId),
    tabOrderByChatId[chatId],
  ).filter((id) => !closed.has(id));

  if (visibleIds.length === 0 && !draft) return null;

  const tabIds = draft ? [...visibleIds, DRAFT_TAB_ID] : visibleIds;
  const requestedActive = activeTabByChatId[chatId];
  const activeTabId =
    requestedActive !== undefined && tabIds.includes(requestedActive)
      ? requestedActive
      : (tabIds[tabIds.length - 1] ?? null);
  const activeBranch = sideBranches.find((b) => b.branchId === activeTabId);

  return (
    <>
      <ColumnDivider side="right" width={width} onResize={setWidth} testId="side-threads-divider" />
      <section className="side-threads-panel" data-testid="side-threads-panel" style={{ width }}>
        <div
          className="pane-tab-bar stp-tabs"
          role="tablist"
          aria-label="Threads"
          data-testid="stp-tabs"
        >
          {tabIds.map((id) => {
            if (id === DRAFT_TAB_ID) {
              return (
                <div
                  key={DRAFT_TAB_ID}
                  role="tab"
                  tabIndex={0}
                  aria-selected={activeTabId === DRAFT_TAB_ID}
                  className={`pane-tab${activeTabId === DRAFT_TAB_ID ? ' active' : ''}`}
                  data-testid="stp-tab-draft"
                  onClick={() => setActiveTab(chatId, DRAFT_TAB_ID)}
                  onKeyDown={(e) => tabKey(e, () => setActiveTab(chatId, DRAFT_TAB_ID))}
                >
                  <span className="pane-tab-title">New thread</span>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="pane-tab-close"
                    aria-label="Close New thread tab"
                    title="Close tab"
                    data-testid="stp-tab-close-draft"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDraft(chatId);
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              );
            }
            const b = sideBranches.find((x) => x.branchId === id);
            if (!b) return null;
            const needsYou = (sideThreadPermissions[`${chatId}::${id}`]?.length ?? 0) > 0;
            return (
              <div
                key={id}
                role="tab"
                tabIndex={0}
                aria-selected={activeTabId === id}
                className={`pane-tab${activeTabId === id ? ' active' : ''}`}
                data-testid={`stp-tab-${id}`}
                title={b.name ?? b.label}
                draggable
                onClick={() => setActiveTab(chatId, id)}
                onKeyDown={(e) => tabKey(e, () => setActiveTab(chatId, id))}
                onDragStart={(e) => e.dataTransfer.setData(STP_DRAG_TYPE, id)}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(STP_DRAG_TYPE)) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const draggedId = e.dataTransfer.getData(STP_DRAG_TYPE);
                  if (!draggedId || draggedId === id) return;
                  const order = tabIds.filter((x) => x !== DRAFT_TAB_ID);
                  const from = order.indexOf(draggedId);
                  const to = order.indexOf(id);
                  if (from === -1 || to === -1) return;
                  order.splice(to, 0, ...order.splice(from, 1));
                  reorderTabs(chatId, order);
                }}
              >
                <StatusDot status={tabStatus(b, needsYou)} />
                <span className="pane-tab-title">{b.name ?? b.label}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  className="pane-tab-close"
                  aria-label={`Close ${b.name ?? b.label} tab`}
                  title="Close tab"
                  data-testid={`stp-tab-close-${id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(chatId, id);
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            );
          })}
          <div className="pane-tab-bar-fill" />
          <button
            type="button"
            className="stp-panel-close"
            aria-label="Close Threads panel"
            title="Close"
            data-testid="stp-panel-close"
            onClick={closePanel}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        {activeTabId === DRAFT_TAB_ID && draft ? (
          <DraftTab chatId={chatId} draft={draft} />
        ) : activeBranch ? (
          <SideThreadTab chatId={chatId} branch={activeBranch} />
        ) : null}
      </section>
    </>
  );
}

function DraftTab({ chatId, draft }: { chatId: string; draft: SideThreadDraft }): JSX.Element {
  const closeDraft = useSideThreadsStore((s) => s.closeDraft);
  const [text, setText] = useState('');
  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    startSideThread(getActiveWs(), chatId, draft.seq, trimmed, draft.fromBranchId);
  };
  return (
    <div className="stp-body" data-testid="stp-draft">
      <div className="stp-from">
        Off <q>{truncate(draft.quotedMessage, QUOTE_MAX)}</q>
      </div>
      <div className="stp-stream stp-stream-empty" />
      <div className="stp-composer">
        <textarea
          data-testid="stp-draft-composer"
          autoFocus
          value={text}
          placeholder="Ask a side question…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
            if (!isSubmitChord(e)) return;
            e.preventDefault();
            send();
          }}
        />
        <div className="stp-composer-row">
          <button type="button" className="stp-cancel" onClick={() => closeDraft(chatId)}>
            Cancel
          </button>
          <button type="button" className="stp-send" data-testid="stp-draft-send" onClick={send}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function SideThreadTab({ chatId, branch }: { chatId: string; branch: ChatBranch }): JSX.Element {
  const branchId = branch.branchId;
  const queryClient = useQueryClient();
  const mainTimeline = useChatStore((s) => s.timelines[chatId]);
  const branchGraph = useChatStore((s) => s.branchGraphs[chatId]);
  const permissions = useChatStore(
    (s) => s.sideThreadPermissions[`${chatId}::${branchId}`] ?? EMPTY_PERMISSIONS,
  );
  const resolveSideThreadPermission = useChatStore((s) => s.resolveSideThreadPermission);
  const [text, setText] = useState('');

  const { data } = useQuery({
    queryKey: ['side-thread-history', chatId, branchId],
    queryFn: () => api.getChatHistory(chatId, { branchId }),
    refetchInterval: branch.running ? 2000 : false,
    placeholderData: keepPreviousData,
  });
  const events = (data?.events ?? []) as unknown as BranchHistoryEvent[];

  const quoted = (() => {
    if (branch.forkFromSeq === null) return null;
    if (branch.parentBranchId === branchGraph?.activeBranchId) {
      return (mainTimeline ?? []).find((e) => e.seq === branch.forkFromSeq)?.content ?? null;
    }
    const parentData = queryClient.getQueryData<{ events: BranchHistoryEvent[] }>([
      'side-thread-history',
      chatId,
      branch.parentBranchId,
    ]);
    return parentData?.events.find((e) => e.seq === branch.forkFromSeq)?.content ?? null;
  })();

  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    sendToBranch(getActiveWs(), chatId, branchId, trimmed);
    setText('');
  };

  return (
    <div className="stp-body" data-testid={`stp-body-${branchId}`}>
      {quoted !== null ? (
        <div className="stp-from">
          Off <q>{truncate(quoted, QUOTE_MAX)}</q>
        </div>
      ) : null}
      <div className="stp-stream" data-testid={`stp-stream-${branchId}`}>
        {events.map((e) => (
          <div key={e.seq} className={`msg msg-${e.role}`} data-testid="stp-msg">
            <div className="content md">
              <Markdown content={e.content} />
            </div>
            <button
              type="button"
              className="stp-branch-again"
              title="Open side thread"
              aria-label="Open side thread"
              data-testid={`stp-branch-again-${e.seq}`}
              onClick={() => openSideThreadDraft(chatId, e.seq, e.content, branchId)}
            >
              <GitFork size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
        {permissions.map((p) => (
          <div className="stp-permission" key={p.requestId} data-testid="stp-permission-card">
            <div className="stp-permission-tool">{p.tool}</div>
            {p.description ? <div className="stp-permission-desc">{p.description}</div> : null}
            <div className="stp-permission-actions">
              <button
                type="button"
                data-testid="stp-permission-deny"
                onClick={() => {
                  permissionDeliveryTracker.send(
                    {
                      type: 'chat.permission_response',
                      chatId,
                      requestId: p.requestId,
                      approve: false,
                    },
                    (ev) => getActiveWs()?.send(ev),
                  );
                  resolveSideThreadPermission(chatId, branchId, p.requestId);
                }}
              >
                Deny
              </button>
              <button
                type="button"
                className="stp-approve"
                data-testid="stp-permission-approve"
                onClick={() => {
                  permissionDeliveryTracker.send(
                    {
                      type: 'chat.permission_response',
                      chatId,
                      requestId: p.requestId,
                      approve: true,
                    },
                    (ev) => getActiveWs()?.send(ev),
                  );
                  resolveSideThreadPermission(chatId, branchId, p.requestId);
                }}
              >
                Approve
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="stp-tfoot">
        {branch.running ? (
          <button
            type="button"
            className="stp-stop"
            data-testid="stp-stop"
            onClick={() => stopBranch(getActiveWs(), chatId, branchId)}
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="stp-send-back"
          data-testid="stp-send-back"
          disabled={branch.sentBack === true}
          onClick={() => sendBackToChat(getActiveWs(), chatId, branchId)}
        >
          {branch.sentBack ? 'Sent back' : 'Send back to chat'}
        </button>
      </div>
      <div className="stp-composer">
        <textarea
          data-testid={`stp-composer-${branchId}`}
          value={text}
          placeholder="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
            if (!isSubmitChord(e)) return;
            e.preventDefault();
            send();
          }}
        />
        <div className="stp-composer-row">
          <button
            type="button"
            className="stp-send"
            data-testid={`stp-send-${branchId}`}
            onClick={send}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
