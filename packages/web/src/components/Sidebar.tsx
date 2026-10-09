// Sidebar — three-column shell's left rail.
//
// Sections (top → bottom) per spec/14 ## Sidebar:
//   1. Brand row (`patch` Fraunces italic) + its superscript connection dot.
//   2. Manager (always pinned top).
//   3. Pinned chats (sorted by pinnedAt desc).
//   4. Folders (collapsible, ordered by recent activity).
//   5. Channels box (collapsed default — Speakers).
//   6. Archived row (collapsed default).
//   7. Bottom nav: Jobs + Settings.
// The + New chat button leads the fixed top band, directly under the brand row
// (spec/14 § Sidebar §8) — starting a chat is the most-reached-for action.

import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Pin,
  Mic,
  Plus,
  Archive,
  PackageOpen,
  Boxes,
  Calendar,
  Settings,
  RotateCcw,
  FolderPlus,
  FileText,
  Compass,
  Check,
  MessageCircleQuestion,
  Info,
  Clock,
  Eye,
  EyeOff,
  Zap,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Maximize2,
  Ear,
  Phone,
  SquarePlus,
  PanelRightOpen,
  Target,
  Layers,
  Bell,
} from 'lucide-react';
import { CloseIcon, DeleteIcon } from './icons.js';
import {
  SPECIAL_THREAD_IDS,
  folderLabels,
  type PermissionMode,
  type StatusKind,
} from '@patch/wire';
import { StatusBadge } from './StatusBadge.js';
import { ProjectSnoozeMenu } from './ProjectSnoozeMenu.js';
import { SidebarViewMenu } from './SidebarViewMenu.js';
import { BatchPanel } from './BatchPanel.js';
import { deriveBadge, useChatStore } from '../stores/chatStore.js';
import { clearComposerDraft } from '../stores/composerDraftStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useBatchStore } from '../stores/batchStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useDraftStore } from '../stores/draftStore.js';
import { hasDraftText } from '../lib/draftText.js';
import { api, ApiError } from '../api/rest.js';
import type { ChatRow, DisplayBadge, SectionCounts } from '../stores/types.js';
import { formatWakeTime } from './SnoozeMenu.js';
import { SNOOZE_PRESETS } from '../lib/snoozePresets.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { stripMarkdown } from '../lib/stripMarkdown.js';
import {
  chatsInProject,
  groupChats,
  needsAttention,
  matchesStateFilter,
  sortAttentionQueue,
  type Grouped,
} from '../lib/chatGroups.js';
import { navigateAfterArchive } from '../lib/archiveNav.js';
import { isNearScrollBottom } from '../lib/scrollPaging.js';
import { searchableQuery } from '../lib/chatSearch.js';
import { ChatSearchField, ChatSearchResults } from './ChatSearch.js';
import { newChatPath } from '../lib/newChat.js';
import {
  openChatInNewWindow,
  openNewChatInNewWindow,
  openSidebarInNewWindow,
} from '../lib/newWindow.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import {
  startVoiceNote,
  sendVoiceNote,
  promoteNoteToToggle,
  startVoiceCall,
  endVoiceCall,
} from '../lib/voiceController.js';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { DevSourceBadge } from './DevSourceBadge.js';
import { NotificationBell } from './NotificationBell.js';
import { useChatHasUnread } from '../stores/notificationsStore.js';
import { shortcutLabel, shortcutTitle } from '../lib/shortcuts.js';
import { NewChatSplit } from './NewChatSplit.js';
import { failed } from '../lib/errorCopy.js';
import { startPadsPolling, usePadsStore } from '../stores/padsStore.js';

// How long a row's badge must be QUIET before we show its new value.
const BADGE_SETTLE_MS = 250;

// The cold-storage icon row's tooltip (spec/14 § Sidebar §6): an icon-only
// button carries its label and count as its one hover/focus tooltip, same
// rule as any other icon-only control (spec/14 § Copy). `null` is "not known
// yet" and draws no count segment at all — the boot fetch hasn't landed, or
// it failed — never a `0`, which would misreport an empty section as unknown
// or vice versa.
function lifecycleTitle(label: string, count: number | null, chord?: string): string {
  const withCount = count === null ? label : `${label} · ${count}`;
  return chord ? shortcutTitle(withCount, chord) : withCount;
}

// Settle the derived badge. On reconnect (WS replay + the `['chats']` React
// Query refetch racing each other) a row's `activity` can flip through a
// stale/transient value before landing on its real one — the badge would
// otherwise visibly flick, e.g. through `working`, on every reconnect even
// though nothing the user cares about changed. Hold the displayed badge
// steady until it has been quiet for BADGE_SETTLE_MS, same approach as
// mobile's `useSettledPreview` (apps/mobile/src/components/ChatRow.tsx) for
// the analogous reconnect-replay flicker on message previews.
function useSettledBadge(row: ChatRow): DisplayBadge {
  const target = deriveBadge(row);
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (target === shown) return;
    const t = setTimeout(() => setShown(target), BADGE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [target, shown]);
  return shown;
}

export function Sidebar({ standalone = false }: { standalone?: boolean } = {}): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  const hydrated = useChatStore((s) => s.hydrated);
  // Before the cold-start `GET /api/chats` lands (or a live reload — every
  // deploy reloads the SPA, see liveUpdate.ts), `chats` is genuinely empty —
  // not because there are no chats, but because none have arrived yet. A
  // `chat.state`/`mergeChats` row can land over the WS before that fetch
  // resolves though (a real chat, just not from `hydrate`), so the gate is on
  // having nothing to show, not merely on the flag: showing the skeleton over
  // actual rows would be its own glitch. Gates the pinned/folder rows below
  // from flashing their RESOLVED-EMPTY shape (spec/14 § "loading is drawn, not
  // implied").
  const showSidebarSkeleton = !hydrated && Object.keys(chats).length === 0;
  const activeChatId = useChatStore((s) => s.activeChatId);
  // `activeChatId` also gets set while parked on a non-chat route (e.g. the
  // Jobs skill-edit link opens a chat in the editor rail without leaving
  // `/jobs/:id`), so a row highlight driven by it alone would stay lit after
  // navigating to Jobs/Settings (spec/14 § Sidebar §7 — the bottom nav row
  // for the page you're actually on gets `active`, not a stale chat row).
  // Gate the highlight on actually being on a chat route.
  const location = useLocation();
  const highlightedChatId = location.pathname.startsWith('/chats/') ? activeChatId : null;
  // Which draft (if any) the new-chat route is currently showing — highlights
  // its row in the Drafts section (spec/14 § New chat drafts).
  const [routeSearch] = useSearchParams();
  const activeDraftId = routeSearch.get('draft');
  const connection = usePresenceStore((s) => s.connection);
  const daemonOnline = usePresenceStore((s) => s.daemonOnline);
  const connectedAndOnline = connection === 'connected' && daemonOnline;
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const channelsOpen = useUiStore((s) => s.channelsOpen);
  const setChannelsOpen = useUiStore((s) => s.setChannelsOpen);
  const hiddenOpen = useUiStore((s) => s.hiddenOpen);
  const setHiddenOpen = useUiStore((s) => s.setHiddenOpen);
  const archivedOpen = useUiStore((s) => s.archivedOpen);
  const setArchivedOpen = useUiStore((s) => s.setArchivedOpen);
  const deletedOpen = useUiStore((s) => s.deletedOpen);
  const setDeletedOpen = useUiStore((s) => s.setDeletedOpen);
  const snoozedOpen = useUiStore((s) => s.snoozedOpen);
  const setSnoozedOpen = useUiStore((s) => s.setSnoozedOpen);
  const automationsOpen = useUiStore((s) => s.automationsOpen);
  const setAutomationsOpen = useUiStore((s) => s.setAutomationsOpen);
  const attentionOnly = useUiStore((s) => s.attentionOnly);
  const forgottenFolders = useUiStore((s) => s.forgottenFolders);
  const forgetFolder = useUiStore((s) => s.forgetFolder);
  const collapsedFolders = useUiStore((s) => s.collapsedFolders);
  const toggleFolderCollapsed = useUiStore((s) => s.toggleFolderCollapsed);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const stateFilter = useUiStore((s) => s.stateFilter);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const activeDevices = useVoiceStore((s) => s.activeDevices);
  // Batch mode (patch/todo.md § Features to add). The tab at the top switches
  // between the normal chat list and the batch review view. The Manager is not
  // a sidebar view — it is a chat, with everything it watches beneath it
  // (spec/14 § Manager view).
  const batchMode = useBatchStore((s) => s.mode) === 'batch';
  const navigate = useNavigate();

  // The folder roster seeds Recent projects with folders whose chats are all
  // archived — after a reload those chats are absent from `chats` entirely
  // (spec/04 § Folders → Folder roster).
  const folderRoster = useChatStore((s) => s.folderRoster);
  // Section counts (spec/04 § Section counts) — what the collapsed lifecycle
  // rows show. `null` until the boot fetch lands (or if it failed), which draws
  // no badge; see the group's own comment below.
  const sectionCounts = useChatStore((s) => s.sectionCounts);
  const chatSort = useUiStore((s) => s.chatSort);
  const groupSort = useUiStore((s) => s.groupSort);
  const grouped = useMemo(
    () => groupChats(Object.values(chats), folderRoster, { chatSort, groupSort }),
    [chats, folderRoster, chatSort, groupSort],
  );

  // Opening a row in needs-attention mode marks it read, which would
  // otherwise drop it out of the filter the instant you click it — the row
  // you're looking at vanishes under the pointer. Instead it's HELD: kept in
  // the filtered list (greyed like any other read row) for as long as it's
  // the chat you're actually looking at (Todoist: "a chat you are looking at
  // should show in the needs attention view, even if you clicked a
  // notification etc").
  //
  // This used to be detected by diffing needs-attention membership across
  // renders — hold it only if THIS chat was seen falling out of the filter
  // this session. That missed every path that lands on the chat already
  // read: a notification click, a deep link, a fresh page load straight into
  // `/chats/:id`. Those all route through the same `setActiveChat`
  // (ChatRoute.tsx) which marks the row read as part of activating it, so by
  // the time this component ever renders, the row was already gone from the
  // filter — there was no earlier render with it still "needing attention"
  // to diff against. Keying directly off `activeChatId` instead needs no
  // history: whatever chat is open right now is held, full stop, regardless
  // of how you got there.
  //
  // The hold still ends when you REPLY, not only when you navigate away.
  // Waiting for `activeChatId` to change meant the last chat in the queue
  // could never leave it: you answered it, it went back to `working`, and it
  // sat there as the only row with nothing to replace it (Tom, Patch
  // Updates — "it should auto hide the current chat if you send a message
  // and it no longer passes filter. otherwise its stuck there as last
  // chat"). A send puts the chat into `running` (badge `working`), which is
  // the one state that is unambiguously "handed back to the agent" — the row
  // has stopped waiting on you, so the reason for holding it under the
  // pointer is gone.
  const activeIsWorking = activeChatId !== null && chats[activeChatId]?.activity === 'running';
  const heldChatId = activeIsWorking ? null : activeChatId;

  // "Needs attention" mode: filter the active chat list to only chats that
  // need you — `done` (finished, unread) or `permission` (paused) — dropping
  // `working` + `read`. Empty folders fall away. The other-chats sections
  // (Drafts, Recent folders, Channels, Archived, Deleted) are hidden entirely
  // in this mode so the list is JUST what needs attention. The Manager control
  // row is unaffected.
  //
  // Rows are then re-sorted into a FIFO queue (sortAttentionQueue) rather than
  // kept in groupChats's recency order: the queue is worked through front to
  // back, so a row that updates again while still in it rejoins the BACK of
  // the queue instead of jumping back to the front (Todoist: "needs attention
  // queue - updated things should be at the bottom of the queue").
  const view = useMemo(() => {
    // The state filter is applied FIRST and independently of attention mode:
    // "show me what failed" has to work whether or not the queue is on, and a
    // failed chat is in the attention queue anyway.
    const stateFiltered =
      stateFilter === 'all'
        ? grouped
        : {
            ...grouped,
            pinned: grouped.pinned.filter((c) => matchesStateFilter(c, stateFilter)),
            folders: grouped.folders
              .map(({ folder, rows }) => ({
                folder,
                rows: rows.filter((c) => matchesStateFilter(c, stateFilter)),
              }))
              .filter((f) => f.rows.length > 0),
          };
    if (!attentionOnly) return stateFiltered;
    const matches = (c: ChatRow): boolean => needsAttention(c) || c.chatId === heldChatId;
    const pinned = sortAttentionQueue(stateFiltered.pinned.filter(matches));
    const folders = stateFiltered.folders
      .map(({ folder, rows }) => ({ folder, rows: sortAttentionQueue(rows.filter(matches)) }))
      .filter((f) => f.rows.length > 0);
    return { ...stateFiltered, pinned, folders };
  }, [grouped, attentionOnly, heldChatId, stateFilter]);
  const attentionEmpty = attentionOnly && view.pinned.length === 0 && view.folders.length === 0;

  // Collapsed projects (spec/14 § Sidebar §4). Needs-attention mode and the
  // state filter both narrow the list to a set the user has just asked for, so
  // a collapsed project that folded one of those matches away would read as the
  // filter having missed it. Collapse is SUSPENDED while either is on rather
  // than cleared, so the folds come back when the filter comes off. Memoised
  // for a stable identity — the drawn order below is published to the selection
  // store from an effect keyed on it.
  const effectiveCollapsed = useMemo(
    () => (attentionOnly || stateFilter !== 'all' ? [] : collapsedFolders),
    [attentionOnly, stateFilter, collapsedFolders],
  );

  return (
    <aside
      className="sb"
      data-testid="sidebar"
      style={{ width: standalone ? '100%' : sidebarWidth }}
    >
      <header className="sb-brand">
        <span className="brand-row">
          {/* Wordmark + its status light as one lockup (spec/14 § Sidebar §1):
              the dot rides the wordmark's ascender as a superscript, so the row
              reads as one mark with a state rather than two separate objects.
              Single status light: green = connected AND the daemon reachable,
              amber/grey otherwise. A connected WS with every daemon offline is
              not "connected" here — spec/12 § Surface connection state model:
              "There is no window where the UI says connected while the agent
              is actually unreachable." */}
          <span className="brand-lockup">
            <span className="brand-mark">patch</span>
            <span
              className={`conn-dot ${connectedAndOnline ? '' : 'offline'}`}
              aria-label={`connection: ${connection === 'connected' ? (daemonOnline ? 'connected' : 'daemon-offline') : connection}`}
              title={
                connection !== 'connected'
                  ? 'Reconnecting…'
                  : daemonOnline
                    ? 'Connected'
                    : 'Agent offline'
              }
              data-testid="conn-dot"
            />
          </span>
          <DevSourceBadge />
        </span>
        <span className="sb-brand-right">
          <NotificationBell />
          {/* Opens the sidebar in its own detached window (spec/14 § Sidebar
              §1, § New windows). Not shown in a window that IS that detached
              sidebar already — opening a sidebar-window from a sidebar-window
              would just chain them. */}
          {standalone ? null : (
            <button
              type="button"
              className="sidebar-collapse-btn"
              data-testid="sidebar-open-window"
              aria-label="Open sidebar in new window"
              title="Open sidebar in new window"
              onClick={() => openSidebarInNewWindow()}
            >
              <ExternalLink size={16} aria-hidden />
            </button>
          )}
          {/* Collapses the sidebar (spec/14 § Sidebar §1, ⌘/'s click equivalent).
              The whole `aside` unmounts once collapsed — SidebarExpandButton is
              the only way back. Not offered on a standalone sidebar window: it
              has nothing to collapse back into. */}
          {standalone ? null : (
            <button
              type="button"
              className="sidebar-collapse-btn"
              data-testid="sidebar-collapse"
              aria-label="Collapse sidebar"
              title={shortcutTitle('Collapse sidebar', '⌘/')}
              onClick={() => setSidebarCollapsed(true)}
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
          )}
        </span>
      </header>

      {/* + New chat — the first control under the brand row, in every view
          (spec/14 § Sidebar §8). Shared behaviour with the chat header's
          top-right New chat icon (lib/newChat: mint a fresh draft, purge blanks).
          A segmented split button (spec/14 § New windows): the wide segment
          starts the chat in this window, the caret opens a dropdown holding
          New chat in new window. */}
      <NewChatSplit
        onNewChat={() => {
          navigate(newChatPath());
        }}
        onNewWindow={() => openNewChatInNewWindow()}
      />

      {/* The sidebar's one view dropdown (spec/14 § Sidebar §1b). */}
      <SidebarViewMenu />

      {batchMode ? (
        <>
          {/* Manager stays reachable from its top slot even in batch view. */}
          <ManagerRow row={grouped.manager} active={highlightedChatId} />
          <div className="sb-scroll" data-testid="sb-scroll">
            <BatchPanel />
          </div>
          <BottomNav />
        </>
      ) : (
        <RegularSidebar
          showSidebarSkeleton={showSidebarSkeleton}
          view={view}
          grouped={grouped}
          activeChatId={highlightedChatId}
          activeDraftId={activeDraftId}
          attentionOnly={attentionOnly}
          attentionEmpty={attentionEmpty}
          channelsOpen={channelsOpen}
          setChannelsOpen={setChannelsOpen}
          hiddenOpen={hiddenOpen}
          setHiddenOpen={setHiddenOpen}
          archivedOpen={archivedOpen}
          setArchivedOpen={setArchivedOpen}
          deletedOpen={deletedOpen}
          setDeletedOpen={setDeletedOpen}
          snoozedOpen={snoozedOpen}
          setSnoozedOpen={setSnoozedOpen}
          automationsOpen={automationsOpen}
          setAutomationsOpen={setAutomationsOpen}
          forgottenFolders={forgottenFolders}
          forgetFolder={forgetFolder}
          collapsedFolders={effectiveCollapsed}
          toggleFolderCollapsed={toggleFolderCollapsed}
          searchQuery={searchQuery}
          activeDevices={activeDevices}
          sectionCounts={sectionCounts}
        />
      )}
    </aside>
  );
}

/**
 * The regular (non-batch) sidebar body — Manager, pinned, drafts, folders,
 * recent folders, channels, the Archived/Deleted lifecycle group, and the
 * bottom nav. Extracted so the batch view can cleanly replace it.
 */
function RegularSidebar({
  showSidebarSkeleton,
  view,
  grouped,
  activeChatId,
  activeDraftId,
  attentionOnly,
  attentionEmpty,
  channelsOpen,
  setChannelsOpen,
  hiddenOpen,
  setHiddenOpen,
  archivedOpen,
  setArchivedOpen,
  deletedOpen,
  setDeletedOpen,
  snoozedOpen,
  setSnoozedOpen,
  automationsOpen,
  setAutomationsOpen,
  forgottenFolders,
  forgetFolder,
  collapsedFolders,
  toggleFolderCollapsed,
  searchQuery,
  activeDevices,
  sectionCounts,
}: {
  showSidebarSkeleton: boolean;
  view: Grouped;
  grouped: Grouped;
  activeChatId: string | null;
  activeDraftId: string | null;
  attentionOnly: boolean;
  attentionEmpty: boolean;
  channelsOpen: boolean;
  setChannelsOpen: (v: boolean) => void;
  hiddenOpen: boolean;
  setHiddenOpen: (v: boolean) => void;
  archivedOpen: boolean;
  setArchivedOpen: (v: boolean) => void;
  deletedOpen: boolean;
  setDeletedOpen: (v: boolean) => void;
  snoozedOpen: boolean;
  setSnoozedOpen: (v: boolean) => void;
  automationsOpen: boolean;
  setAutomationsOpen: (v: boolean) => void;
  forgottenFolders: string[];
  forgetFolder: (folder: string) => void;
  collapsedFolders: string[];
  toggleFolderCollapsed: (folder: string) => void;
  searchQuery: string;
  activeDevices: Record<string, string>;
  sectionCounts: SectionCounts | null;
}): JSX.Element {
  const navigate = useNavigate();
  const bumpLifecycleScrollTick = useUiStore((s) => s.bumpLifecycleScrollTick);
  // Global chat search (spec/03 § Chat search): once the trimmed query is long
  // enough to send, the scrolling band shows results instead of the chat list.
  const activeSearch = searchableQuery(searchQuery);
  // The Channels rows as data — one entry per row the section draws, so the
  // toggle's count is `channelRows.length` rather than a hand-kept literal.
  const channelRows = useMemo(
    () => [
      {
        chatId: SPECIAL_THREAD_IDS.speakers,
        label: 'Speakers',
        row: grouped.speakers,
        deviceNames: Object.values(activeDevices),
      },
    ],
    [grouped.speakers, activeDevices],
  );
  // Multi-select (spec/14 § Sidebar → Selecting multiple rows): publish the
  // DRAWN order of the selectable rows — pinned first, then each folder group,
  // top to bottom — so a shift-click resolves a range the user can actually
  // see. Anything that leaves the list leaves the selection with it.
  // While search results replace the list there are no selectable rows drawn.
  const selectableOrder = useMemo(
    () =>
      activeSearch !== null
        ? []
        : [
            ...view.pinned,
            ...view.folders.flatMap((f) => (collapsedFolders.includes(f.folder) ? [] : f.rows)),
          ].map((c) => c.chatId),
    [view, collapsedFolders, activeSearch],
  );
  useEffect(() => {
    useSelectionStore.getState().setOrder(selectableOrder);
  }, [selectableOrder]);

  // Expanding Channels has to SHOW the channels (spec/14 § Sidebar → Scroll
  // regions). The section is the last thing in the scrolling band, so the rows
  // it reveals routinely render below the band's fold and the section reads as
  // empty. The browser's own focus scrolling is not enough — it brings the
  // TOGGLE into view on click, which it then parks flush against the bottom
  // edge with the list it just opened entirely underneath.
  const channelsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!channelsOpen) return;
    channelsRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [channelsOpen]);

  return (
    <>
      {/* The chat search field (spec/14 § Chat search). Filtering to only
          chats needing attention is the sidebar view dropdown's Unread option
          now (spec/14 § Sidebar §1b) — the `attentionOnly` prop threaded
          through below still drives the filtering, set from there. */}
      <div className="sb-top-row" data-testid="sb-top-row">
        <ChatSearchField />
      </div>

      {/* Manager — always-visible top slot. */}
      <ManagerRow row={grouped.manager} active={activeChatId} />

      {/* Bulk actions for a shift-click selection (spec/14 § Sidebar →
          Selecting multiple rows). Absent while nothing is selected. Part of
          the FIXED band, not the list: a range routinely runs past the rows on
          screen, so a bar inside the scroll region would offer archive and
          delete for chats the user can't see and then scroll out of reach
          itself. */}
      <SelectionBar />

      {/* The scrolling middle band (spec/14 § Sidebar → Scroll regions). ONLY
          the chat list scrolls: everything above (brand, tabs, needs-attention,
          Manager, the selection bar) and below (Archived/Deleted, nav, + New
          chat) is fixed, so those controls never scroll out of reach however
          many chats there are. */}
      <div className="sb-scroll" data-testid="sb-scroll">
        {activeSearch !== null ? (
          <ChatSearchResults query={activeSearch} activeChatId={activeChatId} />
        ) : (
          <>
            {/* Pinned chats — sorted by pinnedAt desc. */}
            {!showSidebarSkeleton && view.pinned.length > 0 ? (
              <section className="sb-pinned" data-testid="pinned-section">
                {view.pinned.map((c) => (
                  <ChatRowView key={c.chatId} row={c} active={activeChatId} pinned />
                ))}
                <div className="pinned-div" />
              </section>
            ) : null}

            {/* Drafts — unsent new chats (spec/14 § New chat drafts). Switchable.
          Hidden in needs-attention mode (drafts aren't finished chats). */}
            {attentionOnly ? null : <DraftsSection activeDraftId={activeDraftId} />}

            {/* First-load skeleton (spec/14 § "loading is drawn, not implied") —
          the pinned/folder rows below would otherwise flash empty, then pop in
          once GET /api/chats resolves. Every deploy triggers this: the SPA
          reloads itself on the new bundle hash (liveUpdate.ts), which re-runs
          this fetch from cold on an otherwise-populated sidebar. */}
            {showSidebarSkeleton ? <SidebarSkeleton /> : null}

            {/* Empty state for needs-attention mode when nothing matches. */}
            {!showSidebarSkeleton && attentionEmpty ? (
              <div className="empty-hint" data-testid="attention-empty">
                Nothing needs attention.
              </div>
            ) : null}

            {/* Folders. A group whose folder is EMPTY has no project name to head
          it with, and a folder header is only ever the name of a project: an
          empty one drew a nameless heading over the rows, with two archive
          buttons that would have archived "project ''". `chatStore`'s
          optimistic seed gives a row `folder: ''` until `chat.spawned` names
          one, so this is reachable in normal use, not only from a bad row —
          those rows are still listed (hiding a chat is worse), just unheaded
          until the folder is known. */}
            {!showSidebarSkeleton &&
              view.folders.map(({ folder, rows }) => {
                const collapsed = collapsedFolders.includes(folder);
                return folderBasename(folder) === '' ? (
                  <section key={folder} className="sb-folder" data-testid="folder-section-unfiled">
                    {rows.map((c) => (
                      <ChatRowView key={c.chatId} row={c} active={activeChatId} />
                    ))}
                  </section>
                ) : (
                  <section key={folder} className="sb-folder">
                    {/* Header shows the project NAME (basename); full path on hover.
              Two hover-revealed archive buttons: the first archives the project
              AS LISTED (these rows), the second archives ALL in the project —
              including the pinned and snoozed chats that are drawn in their own
              sections and so survive the first one. A third control, the snooze
              clock (ProjectSnoozeMenu), reaches that same "all in project" set —
              there's no "as listed" snooze, since "whole workspace" is the whole
              point (Todoist: "patch ability to snooze a whole workspace"). */}
                    <div className="folder-head" title={folder}>
                      {/* The project name IS the disclosure control (spec/14 §4) —
                  a chevron plus the label, so the whole name is the hit area
                  rather than a 13px glyph beside it. A button, not the head
                  div, because the head already carries two buttons of its
                  own and a button cannot nest. */}
                      <button
                        type="button"
                        className="folder-head-toggle"
                        data-testid={`folder-collapse-${folder}`}
                        aria-expanded={!collapsed}
                        aria-label={`${collapsed ? 'Expand' : 'Collapse'} project ${folderBasename(folder)}`}
                        onClick={() => toggleFolderCollapsed(folder)}
                      >
                        {collapsed ? (
                          <ChevronRight size={13} aria-hidden className="folder-head-chev" />
                        ) : (
                          <ChevronDown size={13} aria-hidden className="folder-head-chev" />
                        )}
                        <span className="folder-head-label">{folderBasename(folder)}</span>
                      </button>
                      {/* How many rows the fold is hiding — the header is otherwise
                  identical collapsed or open. */}
                      {collapsed ? (
                        <span className="folder-head-count" data-testid={`folder-count-${folder}`}>
                          {rows.length}
                        </span>
                      ) : null}
                      <span className="folder-head-actions">
                        <button
                          type="button"
                          className="folder-archive-btn"
                          data-testid={`folder-new-chat-${folder}`}
                          title={`New chat in ${folder}`}
                          aria-label={`New chat in project ${folderBasename(folder)}`}
                          onClick={() =>
                            navigate(`/chats/new?folder=${encodeURIComponent(folder)}`)
                          }
                        >
                          <Plus size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="folder-archive-btn"
                          data-testid={`folder-archive-${folder}`}
                          title="Archive listed"
                          aria-label={`archive project ${folderBasename(folder)}`}
                          onClick={() => archiveProject(folderBasename(folder), rows, navigate)}
                        >
                          <Archive size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="folder-archive-btn"
                          data-testid={`folder-archive-all-${folder}`}
                          title="Archive all"
                          aria-label={`archive all in project ${folderBasename(folder)}`}
                          onClick={() =>
                            archiveAllInProject(folderBasename(folder), folder, navigate)
                          }
                        >
                          <Boxes size={13} aria-hidden />
                        </button>
                        <ProjectSnoozeMenu folder={folder} name={folderBasename(folder)} />
                      </span>
                    </div>
                    {collapsed
                      ? null
                      : rows.map((c) => (
                          <ChatRowView key={c.chatId} row={c} active={activeChatId} />
                        ))}
                  </section>
                );
              })}

            {/* The remaining collections (Recent folders, Channels, Archived,
          Deleted) are "other chats" — hidden entirely in needs-attention mode
          so the sidebar shows JUST what needs attention. */}
            {attentionOnly ? null : (
              <>
                {/* Recent folders (spec/14 § Sidebar → Recent folders, E6): every folder
          that has a chat — INCLUDING folders whose chats are all archived, so
          they stay reachable as an entry point to start a new chat. Special
          threads are excluded (Manager lives in its own top slot — E2). Each
          row starts a new chat in that folder; the × forgets it. */}
                <RecentFolders
                  folders={grouped.recentFolders.filter((f) => !forgottenFolders.includes(f))}
                  onForget={forgetFolder}
                />

                {/* Channels box — Speakers special thread (collapsed
              default). The rows are listed as data rather than written out
              twice so the toggle's count (spec/14 §5) is the length of the very
              array that renders them, and cannot drift from what expanding
              actually shows. Unlike the lifecycle sections below, this one needs
              no server count: special threads are fixed UI surfaces that are
              always listed, and `ChannelRow` draws a link even before the daemon
              has registered the thread — so the section's size is known here. */}
                <div ref={channelsRef} className={`channels ${channelsOpen ? 'open' : ''}`}>
                  <button
                    type="button"
                    className="ch-toggle"
                    data-testid="channels-toggle"
                    title={shortcutLabel('⌘2')}
                    onClick={() => setChannelsOpen(!channelsOpen)}
                  >
                    <svg viewBox="0 0 16 16" className="ch-chev" aria-hidden>
                      <path d="M5 3l5 5-5 5" />
                    </svg>
                    Channels
                    <span className="ch-count" data-testid="channels-count">
                      {channelRows.length}
                    </span>
                  </button>
                  {channelsOpen ? (
                    <div className="ch-list" data-testid="channels-list">
                      {channelRows.map((c) => (
                        <ChannelRow
                          key={c.chatId}
                          row={c.row}
                          label={c.label}
                          active={activeChatId}
                          chatId={c.chatId}
                          {...(c.deviceNames ? { deviceNames: c.deviceNames } : {})}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Hidden, Archived, Snoozed, Deleted, Automations — the lifecycle "cold
          storage" controls, one icon-only row (spec/14 §6, "single icon
          buttons on a bottom row" — App Updates: "patch hidden archived etc").
          Sitting AFTER the scroll region — which grows to absorb the free
          vertical space — pins the group to the bottom, directly over the
          nav, rather than floating in the middle after the folders when the
          list is short. A hairline (`.sb-lifecycle`'s own border-top) is the
          divider that marks it off from the chat list above, on top of the
          space that already separated them — the group reads as its own
          bottom-of-window strip, not a continuation of the list. Hidden in
          needs-attention mode along with the other "other chats".

          Each icon carries its label and count as a tooltip (native `title`,
          same mechanism every other icon-only control in the sidebar uses —
          spec/14 § Copy), shown on hover/focus rather than drawn on the row:
          five always-on text rows cost more of the sidebar's fixed bottom
          band than a row of icons does, and the size of a section only
          matters at the moment you're deciding whether to open it. The count
          in the tooltip is the server's own total (spec/04 § Section counts),
          NOT `grouped.<section>.length`: these lists lazy-load on expand, so
          before a section has been opened the store holds none of its rows
          and a locally-derived count would confidently read `0`.

          A `null` count draws no count segment at all (lifecycleTitle) — the
          boot fetch has not landed, or it failed (which raises a toast). NOT
          a `0`: the count doubles as the entire empty state, since an empty
          section renders no body at all, so a placeholder zero would read as
          a definitive "nothing in there". */}
      {attentionOnly ? null : (
        <div
          className="sb-lifecycle"
          data-testid="sb-lifecycle"
          onScroll={(e) => {
            // Every open section re-checks itself on a bump (§ useLifecyclePaging
            // above) — this band can hold more than one at once, and it's simpler
            // for each to no-op when it isn't the one near the bottom than for
            // this handler to work out which is.
            if (isNearScrollBottom(e.currentTarget)) bumpLifecycleScrollTick();
          }}
        >
          <div className="sb-lifecycle-icons" data-testid="sb-lifecycle-icons">
            {/* Hidden (spec/04 § Hidden). Chats running out of the way —
            usually a job's runs whose action sets `startHidden`. Collapsed by
            default; expanding lazily loads them, as they're absent from the
            active `GET /api/chats` snapshot. Each row can be shown. */}
            <button
              type="button"
              className={`arch-toggle${hiddenOpen ? ' active' : ''}`}
              data-testid="hidden-toggle"
              title={lifecycleTitle('Hidden', sectionCounts === null ? null : sectionCounts.hidden)}
              aria-pressed={hiddenOpen}
              onClick={() => setHiddenOpen(!hiddenOpen)}
            >
              <EyeOff size={18} aria-hidden className="arch-icon" />
            </button>

            {/* Archived. */}
            <button
              type="button"
              className={`arch-toggle${archivedOpen ? ' active' : ''}`}
              data-testid="archived-toggle"
              title={lifecycleTitle(
                'Archived',
                sectionCounts === null ? null : sectionCounts.archived,
                '⌘⇧A',
              )}
              aria-pressed={archivedOpen}
              onClick={() => setArchivedOpen(!archivedOpen)}
            >
              <Archive size={18} aria-hidden className="arch-icon" />
            </button>

            {/* Snoozed (spec/04 § Snooze). Collapsed by default; expanding
            lazily loads chats that are snoozed into the future — they're
            absent from the active `GET /api/chats` snapshot. Each row shows
            its wake time and can be unsnoozed. */}
            <button
              type="button"
              className={`arch-toggle${snoozedOpen ? ' active' : ''}`}
              data-testid="snoozed-toggle"
              title={lifecycleTitle(
                'Snoozed',
                sectionCounts === null ? null : sectionCounts.snoozed,
              )}
              aria-pressed={snoozedOpen}
              onClick={() => setSnoozedOpen(!snoozedOpen)}
            >
              <Clock size={18} aria-hidden className="arch-icon" />
            </button>

            {/* Deleted (soft-delete, spec/04 § Lifecycle → E5). Collapsed by
            default; expanding lazily loads soft-deleted chats. Each row can be
            restored. */}
            <button
              type="button"
              className={`arch-toggle${deletedOpen ? ' active' : ''}`}
              data-testid="deleted-toggle"
              title={lifecycleTitle(
                'Deleted',
                sectionCounts === null ? null : sectionCounts.deleted,
              )}
              aria-pressed={deletedOpen}
              onClick={() => setDeletedOpen(!deletedOpen)}
            >
              <DeleteIcon size={18} className="arch-icon" />
            </button>

            {/* Automations (spec/08 § Action, spec/14 § Sidebar). Every chat a
            job's `spawn` action created, FIFO oldest-first (a run updating
            settles at the bottom instead of jumping the whole list down) — an
            ADDITIONAL always-current view, independent of the chat's own
            hidden/archived/snoozed state (a job's chat often starts hidden,
            so without this row its progress is invisible until you think to
            check Hidden). Collapsed by default; expanding lazily loads
            job-spawned chats the active snapshot excludes. */}
            <button
              type="button"
              className={`arch-toggle${automationsOpen ? ' active' : ''}`}
              data-testid="automations-toggle"
              title={lifecycleTitle(
                'Automations',
                sectionCounts === null ? null : sectionCounts.automations,
              )}
              aria-pressed={automationsOpen}
              onClick={() => setAutomationsOpen(!automationsOpen)}
            >
              <Zap size={18} aria-hidden className="arch-icon" />
            </button>
          </div>

          {hiddenOpen ? (
            <LifecyclePanel
              kind="hidden"
              label="Hidden"
              count={sectionCounts === null ? null : sectionCounts.hidden}
            >
              <HiddenSection hidden={grouped.hidden} activeChatId={activeChatId} />
            </LifecyclePanel>
          ) : null}
          {archivedOpen ? (
            <LifecyclePanel
              kind="archived"
              label="Archived"
              count={sectionCounts === null ? null : sectionCounts.archived}
            >
              <ArchivedSection archived={grouped.archived} activeChatId={activeChatId} />
            </LifecyclePanel>
          ) : null}
          {snoozedOpen ? (
            <LifecyclePanel
              kind="snoozed"
              label="Snoozed"
              count={sectionCounts === null ? null : sectionCounts.snoozed}
            >
              <SnoozedSection snoozed={grouped.snoozed} activeChatId={activeChatId} />
            </LifecyclePanel>
          ) : null}
          {deletedOpen ? (
            <LifecyclePanel
              kind="deleted"
              label="Deleted"
              count={sectionCounts === null ? null : sectionCounts.deleted}
            >
              <DeletedSection deleted={grouped.deleted} activeChatId={activeChatId} />
            </LifecyclePanel>
          ) : null}
          {automationsOpen ? (
            <LifecyclePanel
              kind="automations"
              label="Automations"
              count={sectionCounts === null ? null : sectionCounts.automations}
            >
              <AutomationsSection automations={grouped.automations} activeChatId={activeChatId} />
            </LifecyclePanel>
          ) : null}
        </div>
      )}

      {/* Bottom nav. */}
      <BottomNav />
    </>
  );
}

/** Bottom nav — Jobs / Settings links. Shared by the regular and batch
 *  sidebar bodies. (+ New chat lives at the TOP — spec/14 § Sidebar §8.)
 *  The active page (e.g. on `/settings`) gets the `active` class with the
 *  accent-tint background (spec/14 § Sidebar §7). */
function BottomNav(): JSX.Element {
  const location = useLocation();
  const onPads = location.pathname.startsWith('/pads');
  // Changes Tom has made on Pads and not yet sent — what the row's count shows.
  const pads = usePadsStore((s) => s.pads);
  useEffect(() => startPadsPolling(15_000), []);
  const pending = (pads ?? []).reduce((n, p) => n + p.pending, 0);
  const onJobs = location.pathname.startsWith('/jobs');
  const onSettings = location.pathname.startsWith('/settings');
  return (
    <nav className="sb-bottom" data-testid="bottom-nav">
      <Link to="/pads" className={`nav-row ${onPads ? 'active' : ''}`} data-testid="nav-pads">
        <Layers size={16} aria-hidden className="nav-icon" /> Pads
        {pending > 0 ? (
          <span className="pads-navcount" data-testid="nav-pads-count">
            {pending}
          </span>
        ) : null}
      </Link>
      <Link to="/jobs" className={`nav-row ${onJobs ? 'active' : ''}`} data-testid="nav-jobs">
        <Calendar size={16} aria-hidden className="nav-icon" /> Jobs
      </Link>
      <Link
        to="/settings"
        className={`nav-row ${onSettings ? 'active' : ''}`}
        data-testid="nav-settings"
      >
        <Settings size={16} aria-hidden className="nav-icon" /> Settings
      </Link>
    </nav>
  );
}

type LifecycleKind = 'hidden' | 'archived' | 'snoozed' | 'deleted' | 'automations';

/**
 * Wraps an opened cold-storage list (spec/14 §6) with a small head carrying
 * its label and a link to the same section at `/lifecycle/:kind` — the
 * sidebar's cramped fixed-bottom band is fine for a quick check, but browsing
 * a long Archived list wants the main panel's room (App Updates: "can also
 * open in main window"). Withheld while the section is empty or its count
 * isn't known yet: there's nothing a bigger view would show that the row's
 * own tooltip hasn't already said, and always drawing it would put a second
 * "nothing here" line back into the fixed band the collapsed-empty-count rule
 * (spec/04 § Section counts) exists to keep out of it.
 */
function LifecyclePanel({
  kind,
  label,
  count,
  children,
}: {
  kind: LifecycleKind;
  label: string;
  count: number | null;
  children: JSX.Element;
}): JSX.Element {
  const [filter, setFilter] = useState('');
  return (
    <div className="arch-panel" data-testid={`${kind}-panel`}>
      {count !== null && count > 0 ? (
        <div className="arch-panel-head">
          <span className="arch-panel-label">{label}</span>
          <input
            type="search"
            className="arch-panel-filter"
            data-testid={`${kind}-filter`}
            placeholder={`Filter ${label.toLowerCase()}…`}
            aria-label={`Filter ${label.toLowerCase()}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter !== '') {
                e.preventDefault();
                e.stopPropagation();
                setFilter('');
              }
            }}
          />
          <Link
            to={`/lifecycle/${kind}`}
            className="arch-panel-expand"
            data-testid={`${kind}-open-main`}
            title="Open in main window"
          >
            <Maximize2 size={14} aria-hidden />
          </Link>
        </div>
      ) : null}
      <LifecycleFilterContext.Provider value={filter.trim()}>
        {children}
      </LifecycleFilterContext.Provider>
    </div>
  );
}

/**
 * The text typed into the enclosing LifecyclePanel's filter box ('' = none, and
 * the default outside a panel, e.g. `/lifecycle/:kind`). Read by the sections
 * below rather than passed as a prop so each one stays a drop-in child.
 */
const LifecycleFilterContext = createContext('');

/** Case-insensitive match on a row's name and first-message preview. */
function matchesLifecycleFilter(row: ChatRow, filter: string): boolean {
  if (filter === '') return true;
  const f = filter.toLowerCase();
  return (
    (row.name ?? '').toLowerCase().includes(f) || (row.preview ?? '').toLowerCase().includes(f)
  );
}

/** One page's worth of rows at a time (spec/14 § Sidebar item 6: "load a
 *  limited number... then load more on scroll"). */
const LIFECYCLE_PAGE_SIZE = 30;

/**
 * Shared pagination scaffolding for the five lifecycle sections below. Loads
 * one page on mount — each of these components only mounts once its panel is
 * expanded, so "mount" already means "just opened" — then loads the next page
 * whenever the shared scroll region (the sidebar's `.sb-lifecycle` band, or
 * `/lifecycle/:kind`'s own `.lifecycle-route`) reports it neared its bottom
 * via `uiStore.lifecycleScrollTick`. That tick is a single shared counter
 * rather than a per-section flag: more than one panel can be open in the same
 * band at once, and it's cheaper for every mounted section to just re-check
 * itself on a bump than for the scroll host to work out which one the bump
 * was actually about — a section that has nothing left to fetch, or is mid-page
 * already, simply no-ops.
 *
 * `fetchPage` and `fold` are the only section-specific parts: which endpoint
 * to page through, and how to map its rows into the store.
 */
function useLifecyclePaging(
  fetchPage: (opts: {
    limit: number;
    offset: number;
  }) => Promise<{ chats: unknown[]; nextOffset: number | null }>,
  fold: (chats: unknown[]) => void,
  label: string,
): { error: string | null } {
  const [error, setError] = useState<string | null>(null);
  // `undefined` = first page not back yet; `null` = nothing further to fetch;
  // a number = the offset the next page starts at.
  const nextOffsetRef = useRef<number | null | undefined>(undefined);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const foldRef = useRef(fold);
  foldRef.current = fold;
  const tick = useUiStore((s) => s.lifecycleScrollTick);
  // A filter only sees the rows already loaded, so while one is typed the
  // remaining pages are pulled in without waiting for a scroll — otherwise a
  // match further down the list would silently not show.
  const filtering = useContext(LifecycleFilterContext) !== '';
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;
  // Baselined to whatever the tick already was, so a bump from a DIFFERENT
  // section that happened before this one ever mounted doesn't read as "the
  // scroll region just moved" on this section's very first render.
  const seenTickRef = useRef(tick);

  const load = useCallback(
    (offset: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      fetchRef.current({ limit: LIFECYCLE_PAGE_SIZE, offset }).then(
        (r) => {
          loadingRef.current = false;
          if (!mountedRef.current) return;
          foldRef.current(r.chats);
          nextOffsetRef.current = r.nextOffset;
          setError(null);
          if (filteringRef.current && r.nextOffset !== null) load(r.nextOffset);
        },
        (e: unknown) => {
          loadingRef.current = false;
          if (!mountedRef.current) return;
          setError(`Failed to load ${label}: ${(e as Error).message}`);
        },
      );
    },
    [label],
  );

  useEffect(() => {
    if (!filtering) return;
    const next = nextOffsetRef.current;
    if (next === null || next === undefined) return;
    load(next);
  }, [filtering, load]);

  useEffect(() => {
    mountedRef.current = true;
    nextOffsetRef.current = undefined;
    load(0);
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (tick === seenTickRef.current) return;
    seenTickRef.current = tick;
    const next = nextOffsetRef.current;
    if (next === null || next === undefined) return;
    load(next);
  }, [tick, load]);

  return { error };
}

/**
 * The archived list. Searching archived chats is the sidebar's global chat
 * search (components/ChatSearch.tsx), which covers every section.
 */
export function ArchivedSection({
  archived,
  activeChatId,
}: {
  archived: ChatRow[];
  activeChatId: string | null;
}): JSX.Element {
  const mergeChats = useChatStore((s) => s.mergeChats);
  const filter = useContext(LifecycleFilterContext);

  // Lazily fold the archived chats into the store a page at a time, starting
  // when the section is first expanded (this component only mounts when
  // open). The cold-start roster (GET /api/chats) excludes archived to keep
  // the active inbox snapshot small; these rows are what the archived list
  // reads. NO FALLBACK: a load failure surfaces as an error.
  const { error } = useLifecyclePaging(
    (opts) => api.listChatsArchived(opts),
    (chats) => {
      const rows = (
        chats as Array<{
          chatId: string;
          name: string | null;
          preview: string | null;
          folder: string;
          activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
          status: 'active' | 'archived' | 'errored';
          pinned: boolean;
          pinnedAt: number | null;
          lastUpdated: number;
          daemonId: string;
          permissionMode: PermissionMode;
          jobId: string | null;
          statusSummary: string | null;
          statusKind: StatusKind | null;
          hidden?: boolean;
        }>
      ).map((c) => ({
        chatId: c.chatId,
        name: c.name,
        // G2-d4: carry the first-message preview so archived rows are labelled
        // distinctly even when several chats share a folder basename.
        preview: c.preview,
        daemonId: c.daemonId,
        permissionMode: c.permissionMode,
        folder: c.folder,
        activity: c.activity,
        status: c.status,
        pinned: c.pinned,
        pinnedAt: c.pinnedAt,
        // Always false here: this endpoint lists ARCHIVED chats, and a
        // special thread (the only kind that can be `disabled`) can never
        // be archived (spec/06 § Disabled).
        disabled: false,
        lastUpdated: c.lastUpdated,
        jobId: c.jobId,
        // The server has always sent these; this mapper picked the response
        // apart field by field and left them behind, so every row in the one
        // section that holds job-spawned chats arrived with no status at all.
        statusSummary: c.statusSummary,
        statusKind: c.statusKind,
        // spec/04 § Hidden — an archived chat may keep the flag; it is where a
        // machine message starting the chat again returns it to.
        hidden: c.hidden,
      }));
      mergeChats(rows);
    },
    'archived chats',
  );

  return (
    <section className="sb-archived" data-testid="archived-section">
      {error ? (
        <div className="empty-hint" data-testid="archived-load-error">
          {error}
        </div>
      ) : (
        archived
          .filter((c) => matchesLifecycleFilter(c, filter))
          .map((c) => <ChatRowView key={c.chatId} row={c} active={activeChatId} archived />)
      )}
    </section>
  );
}

const SIDEBAR_SKELETON_WIDTHS = [62, 84, 48, 70, 56];

// The cold-start / post-deploy-reload placeholder for the pinned + folder
// rows below the fixed band — grey bars at row height, no copy, so the gap
// before `GET /api/chats` resolves reads as "arriving" rather than "you have
// no chats" (spec/14 § "loading is drawn, not implied").
function SidebarSkeleton(): JSX.Element {
  return (
    <div className="browse-skeleton" data-testid="sidebar-skeleton">
      {SIDEBAR_SKELETON_WIDTHS.map((w, i) => (
        <span key={i} className="browse-skeleton-line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

// The Manager row carries no explainer tooltip (spec/14 § Copy — no helper
// text): it has a visible label, and what Manager IS belongs in the thread, not
// in a two-sentence hover. Like every other row it falls back to its own full
// title as the tooltip, which is the one tooltip a clipped name must have.
function ManagerRow({ row, active }: { row: ChatRow | null; active: string | null }): JSX.Element {
  if (!row) {
    return (
      <div className="sb-row special" data-testid="manager-row-empty" title="Manager">
        <Compass className="manager-glyph" data-testid="manager-glyph" size={16} aria-hidden />
        <span className="name">Manager</span>
      </div>
    );
  }
  return <ChatRowView row={row} active={active} special />;
}

/**
 * A Channels-section row for a passive-mirror special thread (Speakers).
 * Renders a link to the thread when it exists; falls back to a
 * static label before the host has registered it. Uses a fixed label (not
 * the host's lowercase folder name) per spec/06 ## Sidebar placement.
 */
function ChannelRow({
  row,
  label,
  active,
  chatId,
  deviceNames,
}: {
  row: ChatRow | null;
  label: string;
  active: string | null;
  chatId: string;
  /**
   * For the Speakers row only: user-given names of any voice devices currently
   * mid-session. Each renders a "🎙 <name>" pill on the right (spec/14 ## Sidebar).
   */
  deviceNames?: string[];
}): JSX.Element {
  const pill =
    deviceNames && deviceNames.length > 0 ? (
      <span className="ch-meta" data-testid={`channel-device-pill-${chatId}`}>
        {deviceNames.map((name) => (
          <span key={name} className="device-pill">
            🎙 {name}
          </span>
        ))}
      </span>
    ) : null;
  if (!row) {
    // Special threads always exist host-side; the row may just not have
    // loaded yet. Still render a LINK to the known stable chatId so the channel
    // is clickable rather than dead text.
    return (
      <Link
        to={`/chats/${chatId}`}
        className={`ch-row ${active === chatId ? 'active' : ''}`}
        data-testid={`channel-row-${chatId}`}
      >
        <span className="ch-name">{label}</span>
        {pill}
      </Link>
    );
  }
  const badge = deriveBadge(row);
  const cls = [
    'ch-row',
    active === row.chatId ? 'active' : '',
    badge === 'read' ? 'is-read' : '',
    row.disabled ? 'is-thread-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Link to={`/chats/${row.chatId}`} className={cls} data-testid={`channel-row-${chatId}`}>
      <StatusBadge badge={badge} pendingWake={row.pendingWake} />
      <span className="ch-name">{label}</span>
      {pill}
    </Link>
  );
}

/**
 * Recent folders (spec/14 § Sidebar → Recent folders, E6). Each row is an entry
 * point to start a new chat in that folder — clicking navigates to the new-chat
 * view with the folder preselected. The × forgets the folder (removes it from
 * the list). Folders whose chats are all archived still appear here.
 */
function RecentFolders({
  folders,
  onForget,
}: {
  folders: string[];
  onForget: (folder: string) => void;
}): JSX.Element | null {
  const navigate = useNavigate();
  // Show just the folder NAME; only two recents that share a basename grow a
  // disambiguating parent segment (spec/14 § Recent folders — todo "recent
  // should just show folder name, extra only if needed for disambiguation").
  const labels = folderLabels(folders);
  if (folders.length === 0) return null;
  return (
    <section className="sb-recent-folders" data-testid="recent-folders">
      {/* User-facing copy calls a folder a PROJECT (spec/14 §4b) — the heading is
          "Recent projects", never "Recent folders". */}
      <div className="folder-head">Recent projects</div>
      {folders.map((folder, i) => (
        <div className="recent-folder-row" data-testid={`recent-folder-${folder}`} key={folder}>
          <button
            type="button"
            className="recent-folder-start"
            data-testid={`recent-folder-start-${folder}`}
            title={`New chat in ${folder}`}
            onClick={() => navigate(`/chats/new?folder=${encodeURIComponent(folder)}`)}
          >
            <FolderPlus size={14} aria-hidden />
            <span className="recent-folder-name">{labels[i]}</span>
          </button>
          <button
            type="button"
            className="recent-folder-forget"
            data-testid={`recent-folder-forget-${folder}`}
            aria-label={`forget folder ${folder}`}
            title="Forget this folder"
            onClick={() => onForget(folder)}
          >
            <CloseIcon size={16} />
          </button>
        </div>
      ))}
    </section>
  );
}

/**
 * Deleted (soft-delete) list (spec/04 § Lifecycle → E5). Lazily folds the
 * soft-deleted chats into the store the first time it opens (the cold-start
 * roster excludes them). Each row can be restored back to the active list.
 */
export function DeletedSection({
  deleted,
  activeChatId,
}: {
  deleted: ChatRow[];
  activeChatId: string | null;
}): JSX.Element {
  const mergeChats = useChatStore((s) => s.mergeChats);
  const filter = useContext(LifecycleFilterContext);

  const { error } = useLifecyclePaging(
    (opts) => api.listChatsDeleted(opts),
    (chats) => {
      const rows = (
        chats as Array<{
          chatId: string;
          name: string | null;
          preview: string | null;
          folder: string;
          activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
          status: 'active' | 'archived' | 'errored' | 'deleted';
          pinned: boolean;
          pinnedAt: number | null;
          lastUpdated: number;
          daemonId: string;
          permissionMode: PermissionMode;
          jobId: string | null;
        }>
      ).map((c) => ({
        chatId: c.chatId,
        name: c.name,
        preview: c.preview,
        daemonId: c.daemonId,
        permissionMode: c.permissionMode,
        folder: c.folder,
        activity: c.activity,
        status: c.status,
        pinned: c.pinned,
        pinnedAt: c.pinnedAt,
        disabled: false,
        lastUpdated: c.lastUpdated,
        jobId: c.jobId,
      }));
      mergeChats(rows);
    },
    'deleted chats',
  );

  return (
    <section className="sb-deleted" data-testid="deleted-section">
      {error ? (
        <div className="empty-hint" data-testid="deleted-load-error">
          {error}
        </div>
      ) : (
        // Nothing deleted renders nothing — the toggle's own `0` is the empty
        // state (spec/14 §6).
        deleted
          .filter((c) => matchesLifecycleFilter(c, filter))
          .map((c) => <ChatRowView key={c.chatId} row={c} active={activeChatId} deleted />)
      )}
    </section>
  );
}

/**
 * Hidden section (spec/04 § Hidden, spec/14 § Sidebar item 6). The active-inbox
 * snapshot excludes hidden chats, so expanding the section folds them into the
 * store on demand — the same lazy-load shape as Snoozed. After that `chat.state`
 * keeps it live: a chat that is shown leaves, one that is hidden joins.
 */
export function HiddenSection({
  hidden,
  activeChatId,
}: {
  hidden: ChatRow[];
  activeChatId: string | null;
}): JSX.Element {
  const mergeChats = useChatStore((s) => s.mergeChats);
  const filter = useContext(LifecycleFilterContext);

  const { error } = useLifecyclePaging(
    (opts) => api.listChatsHidden(opts),
    (chats) => {
      const rows = (
        chats as Array<{
          chatId: string;
          name: string | null;
          preview: string | null;
          folder: string;
          activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
          status: 'active' | 'archived' | 'errored' | 'deleted';
          pinned: boolean;
          pinnedAt: number | null;
          snoozedUntil: number | null;
          hidden: boolean;
          lastUpdated: number;
          daemonId: string;
          permissionMode: PermissionMode;
          jobId: string | null;
          statusSummary: string | null;
          statusKind: StatusKind | null;
          backgroundTasks?: number | null;
        }>
      ).map((c) => ({
        chatId: c.chatId,
        name: c.name,
        preview: c.preview,
        daemonId: c.daemonId,
        permissionMode: c.permissionMode,
        folder: c.folder,
        activity: c.activity,
        status: c.status,
        pinned: c.pinned,
        pinnedAt: c.pinnedAt,
        disabled: false,
        snoozedUntil: c.snoozedUntil,
        hidden: c.hidden,
        lastUpdated: c.lastUpdated,
        jobId: c.jobId,
        // A hidden chat is expected to be doing something, so the row's badge
        // is the point of the section — carry what it is drawn from.
        statusSummary: c.statusSummary,
        statusKind: c.statusKind,
        backgroundTasks: c.backgroundTasks,
      }));
      mergeChats(rows);
    },
    'hidden chats',
  );

  return (
    <section className="sb-hidden" data-testid="hidden-section">
      {error ? (
        <div className="empty-hint" data-testid="hidden-load-error">
          {error}
        </div>
      ) : (
        // Nothing hidden renders nothing — the toggle's own `0` is the empty
        // state (spec/14 §6).
        hidden
          .filter((c) => matchesLifecycleFilter(c, filter))
          .map((c) => <ChatRowView key={c.chatId} row={c} active={activeChatId} hidden />)
      )}
    </section>
  );
}

/**
 * Snoozed section (spec/04 § Snooze, spec/14 § Chat lifecycle → Snooze). The
 * active-inbox snapshot excludes snoozed chats, so expanding the section folds
 * them into the store on demand — the same lazy-load shape the Archived and
 * Deleted sections use.
 */
export function SnoozedSection({
  snoozed,
  activeChatId,
}: {
  snoozed: ChatRow[];
  activeChatId: string | null;
}): JSX.Element {
  const mergeChats = useChatStore((s) => s.mergeChats);
  const filter = useContext(LifecycleFilterContext);

  const { error } = useLifecyclePaging(
    (opts) => api.listChatsSnoozed(opts),
    (chats) => {
      const rows = (
        chats as Array<{
          chatId: string;
          name: string | null;
          preview: string | null;
          folder: string;
          activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
          status: 'active' | 'archived' | 'errored' | 'deleted';
          pinned: boolean;
          pinnedAt: number | null;
          snoozedUntil: number | null;
          hidden?: boolean;
          lastUpdated: number;
          daemonId: string;
          permissionMode: PermissionMode;
          jobId: string | null;
        }>
      ).map((c) => ({
        chatId: c.chatId,
        name: c.name,
        preview: c.preview,
        daemonId: c.daemonId,
        permissionMode: c.permissionMode,
        folder: c.folder,
        activity: c.activity,
        status: c.status,
        pinned: c.pinned,
        pinnedAt: c.pinnedAt,
        disabled: false,
        snoozedUntil: c.snoozedUntil,
        hidden: c.hidden,
        lastUpdated: c.lastUpdated,
        jobId: c.jobId,
      }));
      mergeChats(rows);
    },
    'snoozed chats',
  );

  return (
    <section className="sb-snoozed" data-testid="snoozed-section">
      {error ? (
        <div className="empty-hint" data-testid="snoozed-load-error">
          {error}
        </div>
      ) : (
        // Nothing snoozed renders nothing — the toggle's own `0` is the empty
        // state (spec/14 §6).
        snoozed
          .filter((c) => matchesLifecycleFilter(c, filter))
          .map((c) => <ChatRowView key={c.chatId} row={c} active={activeChatId} snoozed />)
      )}
    </section>
  );
}

/**
 * Automations section (spec/08 § Action, spec/14 § Sidebar). Every chat a
 * job's `spawn` action created — most-recently-active first, independent of
 * the chat's own archived/active/snoozed state — lazily loaded the same way
 * Archived/Snoozed/Deleted are: `GET /api/chats?automations=only` returns the
 * full always-current set, merged into the store on expand. This is a
 * DUPLICATE view, not a distinct list — a row here also lives in whichever
 * other section it belongs to.
 */
export function AutomationsSection({
  automations,
  activeChatId,
}: {
  automations: ChatRow[];
  activeChatId: string | null;
}): JSX.Element {
  const mergeChats = useChatStore((s) => s.mergeChats);
  const filter = useContext(LifecycleFilterContext);

  const { error } = useLifecyclePaging(
    (opts) => api.listChatsAutomations(opts),
    (chats) => {
      const rows = (
        chats as Array<{
          chatId: string;
          name: string | null;
          preview: string | null;
          folder: string;
          activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
          status: 'active' | 'archived' | 'errored' | 'deleted';
          pinned: boolean;
          pinnedAt: number | null;
          snoozedUntil: number | null;
          /**
           * spec/04 § Hidden. This list includes a job's hidden runs, so a row
           * that arrived without the flag would land in the active list.
           * Absent from an older server, which `mergeChats` reads as unknown.
           */
          hidden?: boolean;
          lastUpdated: number;
          daemonId: string;
          permissionMode: PermissionMode;
          jobId: string | null;
          /**
           * spec/02 § Background task completions. Absent from an older
           * server's response, which `mergeChats` reads as "unknown, keep
           * what you know" rather than as none running.
           */
          backgroundTasks?: number | null;
        }>
      ).map((c) => ({
        chatId: c.chatId,
        name: c.name,
        preview: c.preview,
        daemonId: c.daemonId,
        permissionMode: c.permissionMode,
        folder: c.folder,
        activity: c.activity,
        status: c.status,
        pinned: c.pinned,
        pinnedAt: c.pinnedAt,
        disabled: false,
        snoozedUntil: c.snoozedUntil,
        hidden: c.hidden,
        lastUpdated: c.lastUpdated,
        jobId: c.jobId,
        // This section exists to report whether a job-spawned chat is still
        // working, and a job whose whole payload is a backgrounded build is
        // exactly the case the badge was getting wrong.
        backgroundTasks: c.backgroundTasks,
      }));
      mergeChats(rows);
    },
    'automations',
  );

  return (
    <section className="sb-automations" data-testid="automations-section">
      {error ? (
        <div className="empty-hint" data-testid="automations-load-error">
          {error}
        </div>
      ) : (
        // No automations renders nothing — the toggle's own `0` is the empty
        // state (spec/14 §6).
        automations
          .filter((c) => matchesLifecycleFilter(c, filter))
          .map((c) => <ChatRowView key={c.chatId} row={c} active={activeChatId} automations />)
      )}
    </section>
  );
}

/**
 * Drafts section (spec/14 § New chat drafts) — unsent new chats the user has
 * text in but hasn't sent. Only drafts with actual text show (a blank just-
 * opened draft isn't clutter). Clicking a row reopens that draft; × discards.
 */
function DraftsSection({ activeDraftId }: { activeDraftId: string | null }): JSX.Element | null {
  const drafts = useDraftStore((s) => s.drafts);
  const order = useDraftStore((s) => s.order);
  const removeDraft = useDraftStore((s) => s.remove);
  const rows = order
    .map((id) => drafts[id])
    .filter((d): d is NonNullable<typeof d> => !!d && hasDraftText(d.text));

  // A saved draft appears without the user expanding anything, and the band it
  // appears in may well be scrolled away from its top (opening Channels leaves
  // it there), which put the new row above the fold — indistinguishable from
  // the draft not having saved. Bring it into view when — and only when — a
  // draft id that wasn't listed before shows up: this section re-renders on
  // every keystroke, and none of those may move the list.
  //
  // The HEADER is the anchor, not the section: enough drafts and the section is
  // taller than the band, so scrolling the section can only ever align one of
  // its edges. A new draft leads the list (`draftStore.create` prepends), so
  // the header's edge is the one that puts both it and the new row on screen.
  const headRef = useRef<HTMLDivElement>(null);
  const listedRef = useRef<string[] | null>(null);
  const listed = rows.map((d) => d.id).join('\u0000');
  useEffect(() => {
    const ids = listed === '' ? [] : listed.split('\u0000');
    const before = listedRef.current;
    listedRef.current = ids;
    // First render lists what was already there — nothing has "appeared".
    if (before === null) return;
    if (!ids.some((id) => !before.includes(id))) return;
    headRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [listed]);

  if (rows.length === 0) return null;
  return (
    <section className="sb-folder" data-testid="drafts-section">
      <div className="folder-head" ref={headRef}>
        Drafts
      </div>
      {rows.map((d) => {
        const text = d.text.trim();
        const title = text.length > 42 ? `${text.slice(0, 42)}…` : text;
        return (
          <Link
            key={d.id}
            to={`/chats/new?draft=${encodeURIComponent(d.id)}`}
            className={`sb-row draft-row ${activeDraftId === d.id ? 'active' : ''}`}
            data-testid={`draft-row-${d.id}`}
          >
            <FileText size={14} aria-hidden className="draft-glyph" />
            <span className="name">{title}</span>
            {d.folder ? (
              <span className="preview">{d.folder.split('/').filter(Boolean).slice(-1)[0]}</span>
            ) : null}
            <span className="row-when">
              <button
                type="button"
                className="pin-btn draft-discard"
                data-testid={`draft-discard-${d.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeDraft(d.id);
                }}
                title="Discard draft"
                aria-label="Discard draft"
              >
                <CloseIcon size={16} />
              </button>
            </span>
          </Link>
        );
      })}
    </section>
  );
}

function ChatRowView({
  row,
  active,
  pinned,
  special,
  archived,
  deleted,
  snoozed,
  hidden,
  automations,
}: {
  row: ChatRow;
  active: string | null;
  pinned?: boolean;
  special?: boolean;
  /** Expanded archived rows are NOT greyed (spec/14 ## Greying rules). */
  archived?: boolean;
  /** Rows in the Deleted section — show a Restore action instead of archive. */
  deleted?: boolean;
  /** Rows in the Snoozed section — show the wake time + an Unsnooze control. */
  snoozed?: boolean;
  /** Rows in the Hidden section — show an Unhide control (spec/04 § Hidden). */
  hidden?: boolean;
  /**
   * Rows in the Automations section (spec/14 § Sidebar) — a duplicate view of
   * a chat that also lives elsewhere (often Hidden), not a distinct list
   * of its own, so it never takes part in multi-select.
   */
  automations?: boolean;
}): JSX.Element {
  const badge = useSettledBadge(row);
  const hasUnreadNotif = useChatHasUnread(row.chatId);
  const navigate = useNavigate();
  const menu = useContextMenu();
  // Multi-select (spec/14 § Sidebar → Selecting multiple rows). Only ordinary
  // list rows take part: special threads, and the Archived/Deleted/Automations
  // sections, aren't things you bulk-archive.
  const selectable = !special && !archived && !deleted && !snoozed && !hidden && !automations;
  // A working-mode session open ON THIS ROW's chat — the control then ends it.
  const handsFreeOpen = useVoiceStore(
    (s) => s.call !== null && s.call.chatId === row.chatId && s.call.mode === 'hands-free',
  );
  const isSelected = useSelectionStore((s) => s.selected.includes(row.chatId));
  // spec/04 § Name: title is the AI-generated name; until it lands, the folder
  // basename, then "New chat" (never the raw ULID or first message).
  // The sidebar shows PLAIN text — strip markdown so a reply full of `**`, `|`,
  // `#` etc. doesn't render as raw syntax in the title/preview.
  // The Manager special row always reads as a clean, capitalized "Manager"
  // rather than the host's lowercase folder-name, so its identity is legible.
  const title = special ? 'Manager' : stripMarkdown(deriveChatTitle(row.name));
  // Updates/todo: the message-snippet preview is dropped from the main chat
  // list — ordinary rows read as the AI title alone. The snippet is only kept
  // where a row would otherwise be unidentifiable: archived rows, which have no
  // live title and which the archived filter matches on. Everywhere else there
  // is no secondary line.
  const rawPreview = archived ? row.preview : null;
  const preview = rawPreview ? stripMarkdown(rawPreview) : null;
  const cls = [
    'sb-row',
    pinned ? 'pinned' : '',
    special ? 'special' : '',
    // spec/06 § Disabled — a turned-off special thread greys out in the
    // sidebar the same way an archived row does, so it reads as "off" at a
    // glance rather than looking like every other live thread.
    row.disabled ? 'is-thread-disabled' : '',
    // A deleted row has no `.row-tools` (its only action is the inline Restore
    // inside `.row-when`), so it opts OUT of the hover overlay that hides the
    // time under the tools — spec/14 § Row tools.
    deleted || snoozed || hidden ? 'deleted' : '',
    active === row.chatId ? 'active' : '',
    isSelected ? 'selected' : '',
    badge === 'read' && !archived ? 'is-read' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Voice-note gesture disambiguation (spec/07 ## Voice-input modes — mode 1):
  // a quick TAP and a press-and-HOLD share the same control but mean different
  // things. We start a PTT note on press; on release within TAP_MS it was a tap
  // → promote to a sustained toggle session (⏎ sends / Esc cancels). A longer
  // hold stays PTT → release sends. A second tap while already in a toggle
  // session sends it.
  const TAP_MS = 250;
  const pressAt = useRef<number | null>(null);

  // The row's management actions. Each is a plain no-argument function so the
  // hover tool and the right-click menu item run exactly the same code — the
  // two affordances can never drift apart into two behaviours.
  function applyArchive(): void {
    const next = !archived; // archived rows un-archive; active rows archive.
    if (next) navigateAfterArchive(navigate, [row.chatId]);
    useChatStore.getState().setArchived(row.chatId, next);
    void api.archiveChat(row.chatId, next).catch((err) => {
      // A 404 means the server holds no such chat: the row is a ghost drawn
      // from a stray event (e.g. a chat.error for an id that never existed).
      // Reverting would leave it stuck in the sidebar forever; drop it.
      if (err instanceof ApiError && err.status === 404) {
        useChatStore.getState().retractChat(row.chatId);
        return;
      }
      useChatStore.getState().setArchived(row.chatId, !next);
      useUiStore.getState().pushError(failed('archive'), undefined, (err as Error).message);
    });
  }

  function handleArchive(e: ReactMouseEvent): void {
    // Don't navigate into the chat — this is a sidebar-only management action.
    e.preventDefault();
    e.stopPropagation();
    applyArchive();
  }

  // E4: the sidebar pin control toggles pinned state — optimistic flip + REST
  // POST (fires `chat.pin_request` host-side), reverting on failure. This is
  // the same wire path the chat-header kebab uses; the sidebar affordance was
  // previously a dead marker.
  function applyPin(): void {
    const was = row.pinned;
    useChatStore.getState().setPinned(row.chatId, !was);
    void api.pinChat(row.chatId, !was).catch((err) => {
      useChatStore.getState().setPinned(row.chatId, was);
      useUiStore.getState().pushError(failed('pin'), undefined, (err as Error).message);
    });
  }

  function handlePin(e: ReactMouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    applyPin();
  }

  // E5: restore a soft-deleted chat back to the active list.
  function applyRestore(): void {
    useChatStore.getState().setDeleted(row.chatId, false);
    void api.restoreChat(row.chatId).catch((err) => {
      useChatStore.getState().setDeleted(row.chatId, true);
      useUiStore.getState().pushError(failed('restore'), undefined, (err as Error).message);
    });
  }

  function handleRestore(e: ReactMouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    applyRestore();
  }

  // spec/04 § Snooze: bring a snoozed chat back now. Optimistic clear + POST,
  // reverting on failure (NO FALLBACK) — same shape as archive/pin/restore.
  function applyUnsnooze(): void {
    const was = row.snoozedUntil;
    useChatStore.getState().setSnoozed(row.chatId, null);
    void api.snoozeChat(row.chatId, null).catch((err) => {
      useChatStore.getState().setSnoozed(row.chatId, was);
      useUiStore.getState().pushError(failed('unsnooze'), undefined, (err as Error).message);
    });
  }

  function applySnoozeUntil(snoozedUntil: number): void {
    const was = row.snoozedUntil;
    navigateAfterArchive(navigate, [row.chatId]);
    useChatStore.getState().setSnoozed(row.chatId, snoozedUntil);
    void api.snoozeChat(row.chatId, snoozedUntil).catch((err) => {
      useChatStore.getState().setSnoozed(row.chatId, was);
      useUiStore.getState().pushError(failed('snooze'), undefined, (err as Error).message);
    });
  }

  function handleUnsnooze(e: ReactMouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    applyUnsnooze();
  }

  // spec/04 § Hidden: Unhide — move a hidden chat into the active list without
  // sending anything. Optimistic clear + POST, reverting on failure (NO
  // FALLBACK) — same shape as unsnooze.
  function applyShow(): void {
    useChatStore.getState().setHidden(row.chatId, false);
    void api.hideChat(row.chatId, false).catch((err) => {
      useChatStore.getState().setHidden(row.chatId, true);
      useUiStore.getState().pushError(failed('show'), undefined, (err as Error).message);
    });
  }

  function handleShow(e: ReactMouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    applyShow();
  }

  // Recoverable soft-delete (spec/04 § Lifecycle) behind the same confirm the
  // chat header asks for — the chat moves to Deleted and can be restored.
  async function applyDelete(): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: 'Delete chat',
      message: `Delete chat "${title}"? It moves to Deleted and can be restored from the sidebar.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    useChatStore.getState().setDeleted(row.chatId, true);
    void api.deleteChat(row.chatId).catch((err) => {
      useChatStore.getState().setDeleted(row.chatId, false);
      useUiStore.getState().pushError(failed('delete'), undefined, (err as Error).message);
    });
  }

  // spec/14 § Row context menu — the row's actions at the pointer. Deliberately
  // the actions that already exist on the row or in the chat header, so the
  // menu is a way of REACHING them on a chat you have not opened rather than a
  // second set of behaviours.
  function contextItems(): ContextMenuItem[] {
    if (deleted) {
      return [
        {
          id: 'restore',
          label: 'Restore',
          icon: <RotateCcw size={14} aria-hidden />,
          run: applyRestore,
        },
      ];
    }
    const items: ContextMenuItem[] = [];
    if (hidden) {
      items.push({
        id: 'show',
        label: 'Unhide',
        icon: <Eye size={14} aria-hidden />,
        run: applyShow,
      });
    }
    if (snoozed) {
      items.push({
        id: 'unsnooze',
        label: 'Unsnooze',
        icon: <Clock size={14} aria-hidden />,
        run: applyUnsnooze,
      });
    }
    items.push(
      {
        id: 'open-new-tab',
        label: 'Open in new tab',
        icon: <SquarePlus size={14} aria-hidden />,
        run: () =>
          useLayoutStore
            .getState()
            .openTab({ kind: 'chat', chatId: row.chatId }, { placement: 'tab' }),
      },
      {
        id: 'open-to-the-side',
        label: 'Open to the side',
        icon: <PanelRightOpen size={14} aria-hidden />,
        run: () =>
          useLayoutStore
            .getState()
            .openTab({ kind: 'chat', chatId: row.chatId }, { placement: 'split', edge: 'right' }),
      },
      {
        id: 'open-new-window',
        label: 'Open in new window',
        icon: <ExternalLink size={14} aria-hidden />,
        run: () => openChatInNewWindow(row.chatId),
      },
      {
        id: 'pin',
        label: row.pinned ? 'Unpin' : 'Pin',
        icon: <Pin size={14} aria-hidden />,
        run: applyPin,
      },
      {
        id: 'snooze',
        label: 'Snooze',
        icon: <Clock size={14} aria-hidden />,
        run: () => undefined,
        submenu: SNOOZE_PRESETS.map((p) => ({
          id: `snooze-${p.id}`,
          label: p.label,
          icon: <Clock size={14} aria-hidden />,
          run: () => applySnoozeUntil(p.resolve()),
        })),
      },
      {
        id: 'archive',
        label: archived ? 'Unarchive' : 'Archive',
        icon: archived ? <PackageOpen size={14} aria-hidden /> : <Archive size={14} aria-hidden />,
        run: applyArchive,
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <DeleteIcon size={14} />,
        danger: true,
        run: () => void applyDelete(),
      },
    );
    return items;
  }

  // Row click — plain vs shift (spec/14 § Sidebar → Selecting multiple rows).
  // A plain click navigates as ever AND becomes the selection anchor, clearing
  // any selection. A shift-click never navigates: it range-selects from the
  // anchor. `preventDefault` here is what stops the router (and, without the
  // app-wide guard, the browser's own same-origin page load) acting on it.
  function handleRowClick(e: ReactMouseEvent): void {
    if (e.shiftKey) {
      e.preventDefault();
      if (selectable) useSelectionStore.getState().extendTo(row.chatId);
      return;
    }
    if (selectable) useSelectionStore.getState().anchorAt(row.chatId);
    else useSelectionStore.getState().clear();
    // Opens in the active pane, replacing its current tab (spec/14 § Opening
    // things) — called directly rather than left to the `<Link>` the row
    // already is, because react-router only re-runs `ChatPaneRoute`'s own
    // open-on-navigate effect when the PATH actually changes. Something else
    // (a tab click, a middle-click open elsewhere) can leave a DIFFERENT chat
    // focused while the URL still names this one; clicking it again would
    // then be a navigation to the path already showing — a no-op React
    // Router does not fire a transition for — and the chat would never
    // re-focus. Calling it here makes the open unconditional on what the URL
    // happens to say.
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: row.chatId });
  }

  // Middle-click opens the chat as a new tab in the active pane (spec/14 §
  // Panes and tabs), instead of the browser's own default of a new window/tab
  // on the anchor's href.
  function handleRowAuxClick(e: ReactMouseEvent): void {
    if (e.button !== 1) return;
    e.preventDefault();
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: row.chatId }, { placement: 'tab' });
  }

  // spec/14 § Copy: the row name ellipsises at rest and clips harder still while
  // hovered (the row tools take the slot), so the full title is always carried
  // as the row's tooltip. That is a VALUE, not an explanation, and it is the
  // only tooltip a row gets.
  return (
    <>
      <Link
        to={`/chats/${row.chatId}`}
        className={cls}
        data-testid={`chat-row-${row.chatId}`}
        onClick={handleRowClick}
        onAuxClick={handleRowAuxClick}
        {...(selectable ? { 'aria-selected': isSelected } : {})}
        {...(special ? {} : { onContextMenu: menu.openAt })}
        title={title}
      >
        {special ? (
          <Compass className="manager-glyph" data-testid="manager-glyph" size={16} aria-hidden />
        ) : (
          <StatusBadge badge={badge} pendingWake={row.pendingWake} />
        )}
        {/* spec/04 § Goals, spec/14 § Sidebar — a chat working toward a goal
          carries a marker beside its badge, not instead of it: the badge
          still says what the TURN is doing, this says the chat is
          additionally being held to a condition across turns. Purely
          informational — it never affects sort or filter.

          A pinned row carries its state as a glyph beside the title too
          (spec/14 § Sidebar §3). Both marks have to render INSIDE `.name`'s
          own cell: the row is a 3-column grid (badge · name · top-right
          slot) with no column reserved for an extra sibling, so a marker
          rendered as a sibling of `.name` has nowhere of its own to go —
          grid auto-placement drops it into the name's cell and shoves
          `.name` itself into an implicit next row, cramming the title into
          the 18px badge column (it read as "H…"). The tools stay
          hover-only, as on every other row, so the title keeps its full
          width and the relative time stays readable. Only a pinned-or-goal
          row takes the nested shape — an ordinary row keeps the plain text
          node. */}
        {pinned || row.goal !== null || hasUnreadNotif ? (
          <span className="name has-marks">
            {hasUnreadNotif && (
              <Bell
                className="name-bell"
                data-testid={`name-bell-${row.chatId}`}
                size={11}
                aria-label="unread notification"
              />
            )}
            {pinned && (
              <Pin
                className="name-pin"
                data-testid={`name-pin-${row.chatId}`}
                size={11}
                aria-label="pinned"
              />
            )}
            {row.goal !== null && (
              <span
                className="goal-marker"
                data-testid={`goal-marker-${row.chatId}`}
                title={`Goal: ${row.goal}`}
              >
                <Target size={11} aria-label="working toward a goal" />
              </span>
            )}
            <span className="name-text">{title}</span>
          </span>
        ) : (
          <span className="name">{title}</span>
        )}
        {preview ? (
          <span className="preview" data-testid={`row-preview-${row.chatId}`}>
            {preview}
          </span>
        ) : null}
        {/* Current status (spec/04 § Current status): what this chat is to the
            user, nested UNDER the row. `question` (blocked on you), `report` (the
            agent elected to say this one is worth seeing) and `complete` (nothing
            for you) each read differently — icon, colour, aria label.

            ARCHIVED ROWS CARRY IT TOO. They used to be excluded, and archived is
            exactly where job-spawned chats live ("an automation chat is usually
            archived", chat-registry.ts), so the one line that says what an
            overnight run actually did was hidden on every row most likely to have
            one. Special and deleted rows still don't: a channel has no status of
            its own, and a deleted row shows Restore instead. */}
        {!special && !deleted && row.statusSummary && row.statusKind
          ? // A `question` generated by the one-shot summariser rather than
            // DECLARED by the agent's own `patch_ask_human` call is a frequent
            // false positive (any reply with a `?` can trip it) — it must not
            // draw with the same "needs you" urgency as a real one, so it
            // renders as `complete` instead (spec/14 § Status badges).
            (() => {
              const displayKind =
                row.statusKind === 'question' && !row.statusDeclared ? 'complete' : row.statusKind;
              return (
                <span
                  className={`status-summary is-${displayKind}`}
                  data-testid={`status-summary-${row.chatId}`}
                  data-kind={displayKind}
                >
                  {displayKind === 'question' ? (
                    <MessageCircleQuestion
                      size={13}
                      aria-label="needs you"
                      className="status-summary-icon"
                    />
                  ) : displayKind === 'report' ? (
                    <Info size={13} aria-label="worth seeing" className="status-summary-icon" />
                  ) : (
                    <Check size={11} aria-label="complete" className="status-summary-icon" />
                  )}
                  <span className="status-summary-text">{stripMarkdown(row.statusSummary)}</span>
                </span>
              );
            })()
          : null}
        {/* Deleted rows show a Restore action; every other non-special row shows
          the relative time that swaps to an archive button on hover
          (spec/14 ## Chat lifecycle → Manual archive). */}
        {snoozed ? (
          <span className="row-when" data-testid={`row-when-${row.chatId}`}>
            <span className="when-time mono" data-testid={`snooze-when-${row.chatId}`}>
              {row.snoozedUntil === null ? '' : formatWakeTime(row.snoozedUntil)}
            </span>
            <button
              type="button"
              className="restore-btn"
              data-testid={`unsnooze-btn-${row.chatId}`}
              onClick={handleUnsnooze}
              title="Unsnooze"
              aria-label="Unsnooze chat"
            >
              <Clock size={14} aria-hidden />
            </button>
          </span>
        ) : hidden ? (
          <span className="row-when" data-testid={`row-when-${row.chatId}`}>
            <span className="when-time mono">{formatWhen(row.lastUpdated)}</span>
            <button
              type="button"
              className="restore-btn"
              data-testid={`show-btn-${row.chatId}`}
              onClick={handleShow}
              title="Unhide"
              aria-label="Unhide chat"
            >
              <Eye size={14} aria-hidden />
            </button>
          </span>
        ) : deleted ? (
          <span className="row-when" data-testid={`row-when-${row.chatId}`}>
            <span className="when-time mono">{formatWhen(row.lastUpdated)}</span>
            <button
              type="button"
              className="restore-btn"
              data-testid={`restore-btn-${row.chatId}`}
              onClick={handleRestore}
              title="Restore"
              aria-label="Restore chat"
            >
              <RotateCcw size={14} aria-hidden />
            </button>
          </span>
        ) : !special ? (
          <span className="row-when" data-testid={`row-when-${row.chatId}`}>
            <span className="when-time mono">{formatWhen(row.lastUpdated)}</span>
          </span>
        ) : null}
        {deleted || snoozed || hidden ? null : (
          <span className="row-tools">
            {/* Archive (spec/14 ## Chat lifecycle → Manual archive). Grouped with
            the other row actions top-right; special threads can't be archived. */}
            {special ? null : (
              <button
                type="button"
                className="pin-btn archive-btn"
                data-testid={`archive-btn-${row.chatId}`}
                onClick={handleArchive}
                title={archived ? 'Unarchive' : 'Archive'}
                aria-label={archived ? 'Unarchive chat' : 'Archive chat'}
              >
                {archived ? (
                  <PackageOpen size={14} aria-hidden />
                ) : (
                  <Archive size={14} aria-hidden />
                )}
              </button>
            )}
            {/* E4: pin/unpin toggle. Special threads have fixed slots and can't be
            pinned (spec/04 § Pinning), so the control is hidden for them. */}
            {special ? null : (
              <button
                type="button"
                className={`pin-btn ${row.pinned ? 'is-pinned' : ''}`}
                data-testid={`pin-btn-${row.chatId}`}
                onClick={handlePin}
                title={row.pinned ? 'Unpin' : 'Pin'}
                aria-label={row.pinned ? 'Unpin chat' : 'Pin chat'}
                aria-pressed={row.pinned}
              >
                <Pin size={14} aria-hidden />
              </button>
            )}
            {/* spec/06 ## Voice-note shortcuts on every chat row: press-and-hold
            the mic to open the voice-note overlay targeted at THIS row's chat
            (without opening it); release sends. A bare click must not navigate
            into the chat. */}
            <button
              type="button"
              // On the Manager row this sits in a trio with Call and Hands-free
              // (spec/14 § Manager) — same accent-tinted, always-visible size as
              // those two, rather than the small grey hover-tool ordinary rows use.
              className={`mic-btn${special ? ' mic-btn--manager-ctl' : ''}`}
              title="Voice note"
              aria-label="voice note"
              data-testid={`row-mic-${row.chatId}`}
              onMouseDown={(e) => {
                // Left button only: a right-click on the mic is a request for the
                // row's context menu, and starting a recording from it would be a
                // hidden side effect of opening a menu.
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                const note = useVoiceStore.getState().note;
                // Second tap while already in a sustained toggle session → send.
                if (note && note.chatId === row.chatId && note.gesture === 'toggle') {
                  sendVoiceNote();
                  pressAt.current = null;
                  return;
                }
                pressAt.current = Date.now();
                void startVoiceNote(row.chatId, 'ptt');
              }}
              onMouseUp={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const started = pressAt.current;
                pressAt.current = null;
                if (started === null) return; // release of the send-tap above
                const note = useVoiceStore.getState().note;
                if (!note || note.gesture !== 'ptt') return;
                if (Date.now() - started < TAP_MS) {
                  // Tap, not hold → enter persistent Superwhisper-style toggle mode.
                  promoteNoteToToggle();
                } else {
                  sendVoiceNote();
                }
              }}
              onMouseLeave={() => {
                // Pointer left while holding: commit the PTT note (it was a hold,
                // not a tap). A toggle session is unaffected — it persists.
                const started = pressAt.current;
                if (started === null) return;
                pressAt.current = null;
                const note = useVoiceStore.getState().note;
                if (note && note.gesture === 'ptt' && Date.now() - started >= TAP_MS) {
                  sendVoiceNote();
                } else if (note && note.gesture === 'ptt') {
                  // Left before the tap threshold elapsed — treat as a tap.
                  promoteNoteToToggle();
                }
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <Mic size={14} aria-hidden />
            </button>
            {/* Call — a live voice call with the Manager (spec/07 § Session modes,
              mode 'call'). Same control, icon and behaviour as the composer's own
              Call button (Composer.tsx `call-btn`, spec/14 § Composer): it opens
              the session; ending it is the open session's own control (VoiceBar),
              not a toggle here. Manager-only — ordinary rows reach calls by
              opening the chat. */}
            {special ? (
              <button
                type="button"
                className="mic-btn mic-btn--manager-ctl"
                title="Call"
                aria-label="call"
                data-testid="row-call"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void startVoiceCall(row.chatId);
                }}
              >
                <Phone size={14} aria-hidden />
              </button>
            ) : null}
            {/* Hands-free — the same sustained session as Call, opened in
              continuous mode (spec/07 § Session modes, mode 'hands-free'). It sits
              open for hours while the user is plastering a wall or driving, and
              only speaks when the Manager decides something is worth the
              interruption. Clicking it while one is open ends it, so a single
              control both starts and stops. */}
            {special ? (
              <button
                type="button"
                className={`mic-btn mic-btn--manager-ctl${handsFreeOpen ? ' active' : ''}`}
                title={handsFreeOpen ? 'End hands-free session' : 'Hands-free'}
                aria-label={handsFreeOpen ? 'end hands-free session' : 'start hands-free session'}
                data-testid="row-handsfree"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (handsFreeOpen) {
                    endVoiceCall();
                    return;
                  }
                  void startVoiceCall(row.chatId, 'hands-free');
                }}
              >
                <Ear size={14} aria-hidden />
              </button>
            ) : null}
          </span>
        )}
      </Link>
      {/* spec/14 § Row context menu. Portalled to the body, so it is drawn
          outside the row's clipped, scrolling ancestors — and rendered as the
          row's SIBLING, not its child: a portal still bubbles its events
          through the REACT tree, so a menu item inside the <Link> would reach
          the row's own click handler and navigate into the chat. Special
          threads get no menu at all — none of its actions applies to them, so
          the browser keeps its own. */}
      {special ? null : (
        <ContextMenu
          anchor={menu.anchor}
          items={menu.anchor === null ? [] : contextItems()}
          onClose={menu.close}
          label="Chat actions"
          testId={`chat-context-menu-${row.chatId}`}
        />
      )}
    </>
  );
}

/** Compact relative time for sidebar rows (e.g. `2m`, `3h`, `5d`). */
function formatWhen(ms: number): string {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Folder-group header label. Full POSIX paths overflow and ellipsis truncates
 * the END — hiding the project name (the part that matters). Show the last two
 * segments with a leading ellipsis so the meaningful tail stays visible; the
 * full path is on the `title` tooltip.
 */
/** Last path segment (the folder's basename) — the folder-head + Recent label. */
function folderBasename(folder: string): string {
  const segs = folder.split('/').filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1]! : folder;
}

/**
 * Archive a WHOLE project — every chat in the folder — at once (spec/14 §
 * Folders). Each archive is the same reversible per-chat soft-archive (restore
 * individually from Archived); once all are archived the folder drops out of the
 * active list. Confirmed first since it moves many chats. NO FALLBACK: a failed
 * archive reverts that chat and surfaces the error.
 */
/**
 * The bulk-action bar for a shift-click selection (spec/14 § Sidebar →
 * Selecting multiple rows). `N selected` plus archive / delete / clear — icons
 * with tooltips, no explainer copy (§ Copy — no helper text). It renders only
 * while a selection exists, and Esc clears it.
 */
function SelectionBar(): JSX.Element | null {
  const selected = useSelectionStore((s) => s.selected);
  const navigate = useNavigate();

  useEffect(() => {
    if (selected.length === 0) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') useSelectionStore.getState().clear();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.length]);

  if (selected.length === 0) return null;

  return (
    <div className="sb-selection" data-testid="selection-bar">
      <span className="sel-count" data-testid="selection-count">
        {selected.length} selected
      </span>
      <button
        type="button"
        className="pin-btn"
        data-testid="selection-archive"
        onClick={() => archiveSelected(selected, navigate)}
        title="Archive selected"
        aria-label={`archive ${selected.length} selected chats`}
      >
        <Archive size={14} aria-hidden />
      </button>
      <button
        type="button"
        className="pin-btn danger"
        data-testid="selection-delete"
        onClick={() => deleteSelected(selected)}
        title="Delete selected"
        aria-label={`delete ${selected.length} selected chats`}
      >
        <DeleteIcon size={14} aria-hidden />
      </button>
      <button
        type="button"
        className="pin-btn"
        data-testid="selection-clear"
        onClick={() => useSelectionStore.getState().clear()}
        title="Clear selection"
        aria-label="Clear selection"
      >
        <CloseIcon size={14} aria-hidden />
      </button>
    </div>
  );
}

/**
 * Archive every selected chat, after ONE confirm naming the count (the app's
 * own modal, never `window.confirm`) — the same ask the folder header's
 * archive buttons make, since this too moves many chats on a single click.
 * On confirm it is the row's own archive action applied across the selection:
 * optimistic flip + REST, each row reverting on its own failure (NO FALLBACK —
 * a failure is toasted, never swallowed).
 */
function archiveSelected(chatIds: string[], navigate: (to: string) => void): void {
  if (chatIds.length === 0) return;
  const ui = useUiStore.getState();
  void ui
    .confirm({
      title: 'Archive chats',
      message: `Archive ${chatIds.length} selected chat${chatIds.length === 1 ? '' : 's'}? They move to Archived (restore any of them individually).`,
      confirmLabel: 'Archive',
    })
    .then((ok) => {
      if (!ok) return;
      const store = useChatStore.getState();
      navigateAfterArchive(navigate, chatIds);
      for (const chatId of chatIds) {
        store.setArchived(chatId, true);
        void api.archiveChat(chatId, true).catch((err) => {
          useChatStore.getState().setArchived(chatId, false);
          ui.pushError(failed('archive'), undefined, (err as Error).message);
        });
      }
      useSelectionStore.getState().clear();
    });
}

/**
 * Soft-delete every selected chat, after ONE confirm naming the count (the
 * app's own modal, never `window.confirm`). Recoverable from the Deleted
 * section, exactly like a single-chat delete.
 */
function deleteSelected(chatIds: string[]): void {
  if (chatIds.length === 0) return;
  const ui = useUiStore.getState();
  void ui
    .confirm({
      title: 'Delete chats',
      message: `Delete ${chatIds.length} selected chat${chatIds.length === 1 ? '' : 's'}? They move to Deleted and can be restored.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    .then((ok) => {
      if (!ok) return;
      for (const chatId of chatIds) {
        useChatStore.getState().setDeleted(chatId, true);
        void api
          .deleteChat(chatId)
          // Deleted for real — its unsent composer text goes with it (spec/14
          // § Composer). A failed delete keeps what was typed.
          .then(() => clearComposerDraft(chatId))
          .catch((err) => {
            useChatStore.getState().setDeleted(chatId, false);
            ui.pushError(failed('delete'), undefined, (err as Error).message);
          });
      }
      useSelectionStore.getState().clear();
    });
}

function archiveProject(name: string, rows: ChatRow[], navigate: (to: string) => void): void {
  if (rows.length === 0) return;
  const ui = useUiStore.getState();
  void ui
    .confirm({
      title: 'Archive project',
      message: `Archive the "${name}" project? Its ${rows.length} chat${rows.length === 1 ? '' : 's'} move to Archived (restore any of them individually).`,
      confirmLabel: 'Archive',
    })
    .then((ok) => {
      if (!ok) return;
      const store = useChatStore.getState();
      navigateAfterArchive(
        navigate,
        rows.map((c) => c.chatId),
      );
      for (const c of rows) {
        store.setArchived(c.chatId, true);
        void api.archiveChat(c.chatId, true).catch((err) => {
          store.setArchived(c.chatId, false);
          ui.pushError(failed('archive'), undefined, (err as Error).message);
        });
      }
    });
}

/**
 * "Archive all in project" — the wider of the folder header's two archive
 * buttons (spec/14 § Sidebar → Folders). `archiveProject` above moves only the
 * rows DRAWN under the header; this moves every chat in the folder, including
 * the pinned and snoozed ones that live in their own sections.
 */
function archiveAllInProject(name: string, folder: string, navigate: (to: string) => void): void {
  const rows = chatsInProject(Object.values(useChatStore.getState().chats), folder);
  if (rows.length === 0) return;
  const ui = useUiStore.getState();
  void ui
    .confirm({
      title: 'Archive all in project',
      message: `Archive ALL ${rows.length} chat${rows.length === 1 ? '' : 's'} in "${name}", including any pinned and snoozed ones? They move to Archived (restore any of them individually).`,
      confirmLabel: 'Archive all',
    })
    .then((ok) => {
      if (!ok) return;
      const store = useChatStore.getState();
      navigateAfterArchive(
        navigate,
        rows.map((c) => c.chatId),
      );
      for (const c of rows) {
        store.setArchived(c.chatId, true);
        void api.archiveChat(c.chatId, true).catch((err) => {
          store.setArchived(c.chatId, false);
          ui.pushError(failed('archive'), undefined, (err as Error).message);
        });
      }
    });
}
