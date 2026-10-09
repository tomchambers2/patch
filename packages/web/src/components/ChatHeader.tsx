// ChatHeader — three zones on one centre-line (spec/14 § Chat panel header):
// Back / Forward (far left), generated chat name + waiting pill + Open in new
// window (centre, folder · host in the title's tooltip), and the action icons (far
// right): Editor (merged Files/Open editor), Archive, then a ⋯ overflow menu
// holding Tools, Snooze, Move to… and Delete.
//
// Archive is the one reversible action left as a direct icon; Move and the
// destructive Delete sit behind the menu, same reasoning as before — the icon
// reached for by habit is the one that can be undone without a menu in the way.
//
// The action row also carries a SECOND rendering of the same actions, a
// hamburger dropdown (`.head-hamburger`), which `index.css`'s `@container`
// rule on `.chat-head-actions` swaps in for the icon rail once the row's own
// width can't fit every icon cleanly (Tom, App Updates: icons should collapse
// into a menu rather than scroll/shrink). Both renderings call the exact same
// handlers defined below — no logic is duplicated, only the JSX shape.

import { useEffect, useRef, useState, type JSX } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useChatStore, type DelegateUpdateInfo } from '../stores/chatStore.js';
import { clearComposerDraft } from '../stores/composerDraftStore.js';
import { api } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import type { ChatRow } from '../stores/types.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { isHidden } from '../stores/types.js';
import {
  Edit3,
  Archive,
  EyeOff,
  PackageOpen,
  MoreHorizontal,
  Menu,
  ExternalLink,
  Wrench,
  Frame,
  GitFork,
  Power,
  ArrowRightLeft,
  Eraser,
  Target,
} from 'lucide-react';
import { useSideThreadsStore } from '../stores/sideThreadsStore.js';
import { useLocation, useNavigate } from 'react-router-dom';
import { DeleteIcon } from './icons.js';
import { NavHistoryControls } from './NavHistoryControls.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { folderLabel } from '../lib/folderLabel.js';
import { navigateAfterArchive } from '../lib/archiveNav.js';
import { openChatInNewWindow } from '../lib/newWindow.js';
import { SnoozeMenu } from './SnoozeMenu.js';
import { MoveChatModal } from './MoveChatModal.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { shortcutTitle } from '../lib/shortcuts.js';
import { formatElapsed, formatTokenCount } from './GoalBanner.js';
import type { FinishedGoal } from '@patch/wire';
import { failed } from '../lib/errorCopy.js';
import { captureDocument } from '../lib/padCapture.js';
import { openPadBesideChat } from '../lib/openPad.js';

// Manager / Speakers occupy fixed slots and cannot be pinned or
// deleted; their crumb is suppressed (crumb == name would duplicate the word).
const SPECIAL_THREAD_ID_SET: ReadonlySet<string> = new Set(Object.values(SPECIAL_THREAD_IDS));

function specialThreadLabel(chatId: string): string | null {
  if (chatId === SPECIAL_THREAD_IDS.manager) return 'Manager';
  if (chatId === SPECIAL_THREAD_IDS.speakers) return 'Speakers';
  return null;
}

const ICON = 18;

/**
 * spec/04 § Goals — "A finished goal stays viewable from the chat header".
 * Shown once a goal resolves (met/impossible) or is cleared without a verdict
 * (in which case `lastGoal` still names whatever last ACTUALLY finished, per
 * `setGoal`'s own doc — a goal abandoned mid-run leaves no new entry here).
 * Replaced the moment a new goal starts (the bar above takes over instead).
 */
function FinishedGoalIndicator({ lastGoal }: { lastGoal: FinishedGoal }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = lastGoal.outcome === 'met' ? 'Goal met' : 'Goal impossible';
  return (
    <span className="finished-goal" data-testid="finished-goal-indicator">
      <button
        type="button"
        className="finished-goal-summary"
        data-testid="finished-goal-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Target size={12} aria-hidden />
        {label}
      </button>
      {open ? (
        <div className="finished-goal-detail" data-testid="finished-goal-detail">
          <div>{lastGoal.condition}</div>
          <div>
            {formatElapsed(lastGoal.endedAt - lastGoal.startedAt)} · {lastGoal.turns} turn
            {lastGoal.turns === 1 ? '' : 's'}
            {lastGoal.tokens > 0 ? ` · ${formatTokenCount(lastGoal.tokens)} tokens` : ''}
          </div>
          <div>{lastGoal.reason}</div>
        </div>
      ) : null}
    </span>
  );
}

const NO_DELEGATES: Record<string, DelegateUpdateInfo> = {};

/**
 * spec/14 § Chat panel header — Background workers: a count pill while any
 * `patch_delegate` subagent of this chat is running or awaiting permission,
 * so the work stays visible without scrolling to the strip above the composer.
 */
function WorkersIndicator({ chatId }: { chatId: string }): JSX.Element | null {
  const updates = useChatStore((s) => s.delegateUpdates[chatId] ?? NO_DELEGATES);
  const running = Object.values(updates).filter(
    (d) => d.status === 'running' || d.status === 'awaiting-permission',
  );
  if (running.length === 0) return null;
  return (
    <span
      className="workers-pill"
      data-testid="header-workers"
      title={running.map((d) => d.label).join('\n')}
    >
      {running.length} {running.length === 1 ? 'worker' : 'workers'}
    </span>
  );
}

export function ChatHeader({ row }: { row: ChatRow }): JSX.Element {
  const setDeleted = useChatStore((s) => s.setDeleted);
  const setArchived = useChatStore((s) => s.setArchived);
  const setHidden = useChatStore((s) => s.setHidden);
  const setDisabled = useChatStore((s) => s.setDisabled);
  const setName = useChatStore((s) => s.setName);
  const pushError = useUiStore((s) => s.pushError);
  const setToolsPanelChatId = useUiStore((s) => s.setToolsPanelChatId);
  const navigate = useNavigate();
  const location = useLocation();
  // spec/14 § Side threads panel — "A Threads icon in the chat header opens
  // the panel with all this chat's side threads." Shown only once the chat
  // actually has one (an empty panel with nothing to pick from is a dead end).
  const branchGraph = useChatStore((s) => s.branchGraphs[row.chatId]);
  const sideThreadBranches = (branchGraph?.branches ?? []).filter((b) => b.sideThread);
  const openThread = useSideThreadsStore((s) => s.openThread);
  const threadsActiveTab = useSideThreadsStore((s) => s.activeTabByChatId[row.chatId]);

  const isSpecial = SPECIAL_THREAD_ID_SET.has(row.chatId);
  // For a special thread the label is authoritative and shown once as the title.
  // Otherwise spec/04 § Name: the AI-generated title; until it lands, the folder
  // basename, then "New chat" — never the raw first message or ULID.
  const title = specialThreadLabel(row.chatId) ?? deriveChatTitle(row.name);
  // The machine this chat is pinned to, by its user-editable name. Falls back
  // to the raw daemonId only while that machine has yet to report a name —
  // shown rather than hidden, because "which machine is this running on" has no
  // safe default answer. An optimistically-seeded row has neither yet
  // (chatStore's `emptyRow` uses `daemonId: ''`), and there is nothing to draw.
  const hostReport = usePresenceStore((s) => s.hosts[row.daemonId]?.host ?? null);
  const hostLabel = (hostReport?.hostName ?? row.daemonId).trim();
  // spec/14 § Chat panel header — rename in place. `draft` non-null means the
  // title is currently a text field. It is seeded from the stored `row.name`,
  // NOT the displayed title: the derived folder label is a display fallback and
  // committing it would silently promote a folder basename into a real name.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // The ⋯ overflow menu (spec/14 § Chat panel header). Same dismissal contract
  // as every other anchored pop-up: click-off and Esc.
  const [menuOpen, setMenuOpen] = useState(false);
  // spec/04 § Moving a chat to another host — the Move dialog.
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  useDismissOnClickOff(menuOpen, [menuRef, menuTriggerRef], () => setMenuOpen(false));
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // The hamburger dropdown that replaces the whole icon rail at narrow widths
  // (see the file-header comment). Same anchored-pop-up dismissal contract as
  // every other menu here: click-off and Esc.
  const [hamburgerOpen, setHamburgerOpen] = useState(false);
  const hamburgerMenuRef = useRef<HTMLDivElement | null>(null);
  const hamburgerTriggerRef = useRef<HTMLButtonElement | null>(null);
  useDismissOnClickOff(hamburgerOpen, [hamburgerMenuRef, hamburgerTriggerRef], () =>
    setHamburgerOpen(false),
  );
  useEffect(() => {
    if (!hamburgerOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setHamburgerOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hamburgerOpen]);

  const archived = row.status === 'archived';

  function commitRename(): void {
    if (draft === null) return;
    const next = draft.trim() === '' ? null : draft.trim();
    setDraft(null);
    if (next === row.name) return;
    const previous = row.name;
    setName(row.chatId, next);
    void api.renameChat(row.chatId, next).catch((err: Error) => {
      setName(row.chatId, previous);
      pushError(failed('rename'), undefined, err.message);
    });
  }

  // "Design a change to Chat" (spec/14 § Pads — Starting a Pad, way (a)):
  // photograph this screen as it looks right now and open a Pad on that capture
  // beside this chat. The menu closes first and the frame repaints, so the
  // picture is the screen, not the menu on top of it.
  async function designChange(): Promise<void> {
    setMenuOpen(false);
    setHamburgerOpen(false);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    try {
      const html = await captureDocument();
      const pad = await api.createPad({
        name: deriveChatTitle(row.name),
        app: 'Patch',
        device: window.innerWidth < 760 ? 'phone' : 'desktop',
        chatId: row.chatId,
        screens: [{ name: 'Chat', html, width: window.innerWidth }],
      });
      openPadBesideChat(pad.id, row.chatId);
    } catch (err) {
      pushError('Could not start a Pad from this screen.', undefined, (err as Error).message);
    }
  }

  // Editor (spec/14 § Chat panel header): opens this chat's Files tab, or
  // focuses it if already open — a second click while it's the focused tab
  // closes it instead (`toggleTab`), the same action the tab bar's own ×
  // takes. A tool-call click in the stream / `⌘'` still reach a file's diff
  // directly, as their own file tab — this button is just the general entry
  // point into the tree.
  function toggleEditor(): void {
    useLayoutStore.getState().toggleTab({ kind: 'page', page: 'files', chatId: row.chatId });
  }

  // Archive / unarchive (spec/04 § Lifecycle) — the header's default way to
  // clear a finished chat off the active list. Optimistic flip, reverted with a
  // toast on failure (NO FALLBACK), exactly like pin. Archiving also moves you
  // on to the next chat in the list; the destination is resolved before the
  // flip, while this chat is still in it.
  async function toggleArchive(): Promise<void> {
    const next = !archived;
    if (next) navigateAfterArchive(navigate, [row.chatId]);
    setArchived(row.chatId, next);
    try {
      await api.archiveChat(row.chatId, next);
    } catch (err) {
      setArchived(row.chatId, !next);
      pushError(failed('archive'), undefined, (err as Error).message);
    }
  }

  // Hide (spec/04 § Hidden) — move a running chat out of the list. The chat
  // keeps running and the host tells the agent it is now in hidden mode.
  // Optimistic flip, reverting + toasting on failure (NO FALLBACK).
  async function hide(): Promise<void> {
    setHidden(row.chatId, true);
    try {
      await api.hideChat(row.chatId, true);
    } catch (err) {
      setHidden(row.chatId, false);
      pushError(failed('hide'), undefined, (err as Error).message);
    }
  }
  const canHide = !isSpecial && row.status === 'active' && !isHidden(row);

  // Disable / enable (spec/06 § Disabled) — the special-thread "off" switch,
  // since `toggleArchive` above is refused for them server-side. Same
  // optimistic-flip-with-revert shape as archive/pin, minus the navigate-away:
  // a disabled special thread stays right where it is, just greyed out.
  async function toggleDisabled(): Promise<void> {
    const next = !row.disabled;
    setDisabled(row.chatId, next);
    try {
      await api.disableChat(row.chatId, next);
    } catch (err) {
      setDisabled(row.chatId, !next);
      pushError(`${next ? 'disable' : 'enable'} failed: ${(err as Error).message}`);
    }
  }

  // Manual session rotation (spec/06 § Session rotation) — the on-demand
  // version of what ThreadRotator does overnight: retire the underlying
  // Claude session and start fresh, seeded with a handoff digest. Only
  // special threads accumulate the kind of ever-growing context this exists
  // to clear; an ordinary chat's equivalent is starting a new chat. No
  // optimistic flip (there's no boolean to show) — the host posts its own
  // "Session rotated" system message into the transcript once it happens, and
  // a refusal (mid-turn, digest failure) is logged server-side rather than
  // answered here (same NO FALLBACK contract as the scheduled rotation).
  async function clearContext(): Promise<void> {
    try {
      await api.rotateChat(row.chatId);
    } catch (err) {
      pushError(failed('clear context'), undefined, (err as Error).message);
    }
  }

  async function handleDelete(): Promise<void> {
    // Recoverable soft-delete (spec/04 § Lifecycle) — the chat moves to the
    // sidebar's Deleted section and can be restored. Custom modal, not native.
    setMenuOpen(false);
    const ok = await useUiStore.getState().confirm({
      title: 'Delete chat',
      message: `Delete chat "${title}"? It moves to Deleted and can be restored from the sidebar.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    // Optimistically flip to deleted; revert on failure (NO FALLBACK).
    setDeleted(row.chatId, true);
    try {
      await api.deleteChat(row.chatId);
      // Deleted for real — its unsent composer text goes with it (spec/14
      // § Composer). After the call, so a failed delete keeps what was typed.
      clearComposerDraft(row.chatId);
    } catch (err) {
      setDeleted(row.chatId, false);
      pushError(failed('delete'), undefined, (err as Error).message);
    }
  }

  // Folder and machine live in the title's hover tooltip (spec/14 § Chat panel
  // header), not on screen: the message already names them and a second line
  // cost the bar its height. Each part is included only where genuinely known,
  // so an optimistic row (no host, no folder) gets no tooltip rather than a
  // lone dot. Special threads have neither — their label is the whole story.
  const titleHover = isSpecial
    ? undefined
    : [folderLabel(row.folder), hostLabel !== '' ? hostLabel : null]
        .filter((p): p is string => p !== null)
        .join(' · ') || undefined;

  return (
    <>
      <header className="chat-head" data-testid="chat-head">
        {/* Far left: Back / Forward alone. Its own zone (spec/14 § Chat panel
          header) rather than a fourth flex child, because it is the zone that
          carries the flex share holding `.chat-head-title` on centre; a
          control outside it would push the title off centre by its own
          half-width. The folder/host crumb used to share this zone — it now
          sits under the title instead (below), so this zone is nav-only. */}
        <div className="chat-head-left">
          <NavHistoryControls />
        </div>

        {/* Centre: chat name (+ waiting pill) + Open in new window. Clicking the name renames in
          place (spec/14 § Chat panel header); a special thread's name is
          fixed. The title's tooltip is the folder · host line. */}
        <div className="chat-head-title">
          <div className="chat-head-title-row">
            {editing ? (
              <input
                ref={inputRef}
                className="chat-title display chat-title-input"
                data-testid="chat-title-input"
                aria-label="Chat name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  else if (e.key === 'Escape') setDraft(null);
                }}
              />
            ) : (
              <h1
                className={`chat-title display ${isSpecial ? '' : 'is-renameable'}`}
                data-testid="chat-title"
                title={titleHover}
                onClick={isSpecial ? undefined : () => setDraft(row.name ?? '')}
              >
                {title}
              </h1>
            )}
            {/* `working` used to carry a second orange dot here too, but an open
              running chat already shows that in two places at once — the
              sidebar row's badge and the transcript's own "Thinking…" dots at
              its foot — so a third copy right beside the title was one too
              many of the same signal on screen together. Dropped; `permission`
              keeps its pill since that's the only place it shows at all. */}
            {row.awaitingPermission ? (
              <span
                className="waiting-pill"
                data-testid="waiting-on-you"
                aria-label="waiting on you"
              >
                ! waiting on you
              </span>
            ) : null}
            <WorkersIndicator chatId={row.chatId} />
            {row.goal === null && row.lastGoal !== null ? (
              <FinishedGoalIndicator lastGoal={row.lastGoal} />
            ) : null}
            {/* Open in new window sits beside the title (spec/14 § Chat panel
              header) — shown for every chat including special threads. */}
            <button
              type="button"
              className="head-action chat-title-open-window"
              data-testid="action-open-window"
              aria-label="Open chat in new window"
              title="Open chat in new window"
              onClick={() => openChatInNewWindow(row.chatId, location.search)}
            >
              <ExternalLink size={16} aria-hidden />
            </button>
          </div>
        </div>

        {/* Far right: Editor, Archive, then the ⋯ overflow (spec/14 § Chat panel
          header). Each carries a hover tooltip NAMING it, and where the action
          has a chord the tooltip carries it too (spec/14 § Discoverability:
          "Hover tooltips also include the shortcut") — Tom, `patch/todo.md` —
          "header tooltips should show their shortcut". Actions with no chord
          show the bare name; a tooltip never explains what the button does. */}
        <div className="chat-head-actions" data-testid="chat-head-actions">
          <div className="head-action-rail" data-testid="head-action-rail">
            <button
              type="button"
              className="head-action"
              data-testid="action-editor"
              aria-label="Editor"
              title="Editor"
              onClick={toggleEditor}
            >
              <Edit3 size={ICON} aria-hidden />
            </button>
            {/* spec/14 § Side threads panel — "A Threads icon in the chat
              header opens the panel with all this chat's side threads."
              Absent until the chat actually has one. */}
            {sideThreadBranches.length > 0 ? (
              <button
                type="button"
                className="head-action"
                data-testid="action-threads"
                aria-label="Threads"
                title="Threads"
                onClick={() => {
                  const target =
                    threadsActiveTab !== undefined &&
                    sideThreadBranches.some((b) => b.branchId === threadsActiveTab)
                      ? threadsActiveTab
                      : sideThreadBranches[sideThreadBranches.length - 1]!.branchId;
                  openThread(row.chatId, target);
                }}
              >
                <GitFork size={ICON} aria-hidden />
              </button>
            ) : null}
            {/* Archive (spec/04 § Lifecycle) — the default single-click way to take
            a finished chat off the active list, and the way back. Special
            threads hold fixed slots and can't be archived. */}
            {isSpecial ? null : (
              <button
                type="button"
                className={`head-action ${archived ? 'is-archived' : ''}`}
                data-testid="action-archive"
                aria-label={archived ? 'Unarchive chat' : 'Archive chat'}
                aria-pressed={archived}
                title={shortcutTitle(archived ? 'Unarchive' : 'Archive', '⌘⌥A')}
                onClick={toggleArchive}
              >
                {archived ? (
                  <PackageOpen size={ICON} aria-hidden />
                ) : (
                  <Archive size={ICON} aria-hidden />
                )}
              </button>
            )}
            {/* Overflow — everything else: Tools and (regular chats) Snooze,
            Move to… and the destructive Delete; (special threads) Disable
            and Clear context. Kept off the rail so none of these is the icon
            next to the one reached for every day. */}
            <span className="head-menu-wrap">
              <button
                type="button"
                ref={menuTriggerRef}
                className="head-action"
                data-testid="action-more"
                aria-label="More actions"
                aria-expanded={menuOpen}
                title="More"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <MoreHorizontal size={ICON} aria-hidden />
              </button>
              {menuOpen ? (
                <div className="head-menu" data-testid="head-menu" role="menu" ref={menuRef}>
                  {/* Tools — opens the per-chat Tools sidebar on the right (§
                  Tools panel): what the agent can call, what each does, its
                  definition, and per-chat on/off switches. Every chat gets
                  it; a special thread runs an agent with tools like any
                  other. */}
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="action-tools"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setToolsPanelChatId(row.chatId);
                    }}
                  >
                    <Wrench size={14} aria-hidden />
                    Tools
                  </button>
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="action-design"
                    role="menuitem"
                    onClick={() => void designChange()}
                  >
                    <Frame size={14} aria-hidden />
                    Design a change to Chat
                  </button>
                  {isSpecial ? (
                    <>
                      {/* Disable (spec/06 § Disabled) — the special-thread "off"
                      switch, since these have no archive/snooze to reach for
                      instead. Manager especially: the watch loop stops
                      delivering it turns while disabled. */}
                      <button
                        type="button"
                        className="head-menu-item"
                        data-testid="action-disable"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          void toggleDisabled();
                        }}
                      >
                        <Power size={14} aria-hidden />
                        {row.disabled ? 'Enable' : 'Disable'}
                      </button>
                      {/* Clear context (spec/06 § Session rotation) — the manual
                      version of the overnight rotation: retire the
                      accumulated session and start fresh with a handoff
                      digest. Only special threads run long enough to need
                      this; an ordinary chat's equivalent is a new chat. */}
                      <button
                        type="button"
                        className="head-menu-item"
                        data-testid="action-clear-context"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          void clearContext();
                        }}
                      >
                        <Eraser size={14} aria-hidden />
                        Clear context
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Snooze (spec/04 § Snooze) — take the chat off the
                      active list until a chosen moment, then it comes back
                      on its own. */}
                      <div className="head-menu-snooze" data-testid="menu-snooze-row">
                        <SnoozeMenu row={row} iconSize={14} label="Snooze" />
                      </div>
                      {canHide ? (
                        <button
                          type="button"
                          className="head-menu-item"
                          data-testid="action-hide"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            void hide();
                          }}
                        >
                          <EyeOff size={14} aria-hidden />
                          Hide
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="head-menu-item"
                        data-testid="action-move"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setMoveOpen(true);
                        }}
                      >
                        <ArrowRightLeft size={14} aria-hidden />
                        Move to…
                      </button>
                      <button
                        type="button"
                        className="head-menu-item danger"
                        data-testid="action-delete"
                        role="menuitem"
                        onClick={handleDelete}
                      >
                        <DeleteIcon size={14} />
                        Delete
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </span>
          </div>
          {/* Hamburger — a second rendering of every action above as a labelled
          list, swapped in for `.head-action-rail` by the `@container` rule on
          `.chat-head-actions` (index.css) once the row's own width can't fit
          the icons cleanly. Hidden by default; CSS is what shows it. */}
          <div className="head-hamburger" data-testid="head-hamburger">
            <button
              type="button"
              ref={hamburgerTriggerRef}
              className="head-action"
              data-testid="action-hamburger"
              aria-label="Menu"
              aria-expanded={hamburgerOpen}
              title="Menu"
              onClick={() => setHamburgerOpen((v) => !v)}
            >
              <Menu size={ICON} aria-hidden />
            </button>
            {hamburgerOpen ? (
              <div
                className="head-menu head-hamburger-menu"
                data-testid="head-hamburger-menu"
                role="menu"
                ref={hamburgerMenuRef}
              >
                <button
                  type="button"
                  className="head-menu-item"
                  data-testid="hamburger-editor"
                  role="menuitem"
                  onClick={() => {
                    setHamburgerOpen(false);
                    toggleEditor();
                  }}
                >
                  <Edit3 size={14} aria-hidden />
                  Editor
                </button>
                <button
                  type="button"
                  className="head-menu-item"
                  data-testid="hamburger-tools"
                  role="menuitem"
                  onClick={() => {
                    setHamburgerOpen(false);
                    setToolsPanelChatId(row.chatId);
                  }}
                >
                  <Wrench size={14} aria-hidden />
                  Tools
                </button>
                <button
                  type="button"
                  className="head-menu-item"
                  data-testid="hamburger-design"
                  role="menuitem"
                  onClick={() => void designChange()}
                >
                  <Frame size={14} aria-hidden />
                  Design a change to Chat
                </button>
                {sideThreadBranches.length > 0 ? (
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="hamburger-threads"
                    role="menuitem"
                    onClick={() => {
                      setHamburgerOpen(false);
                      const target =
                        threadsActiveTab !== undefined &&
                        sideThreadBranches.some((b) => b.branchId === threadsActiveTab)
                          ? threadsActiveTab
                          : sideThreadBranches[sideThreadBranches.length - 1]!.branchId;
                      openThread(row.chatId, target);
                    }}
                  >
                    <GitFork size={14} aria-hidden />
                    Threads
                  </button>
                ) : null}
                {isSpecial ? null : (
                  <div className="head-menu-snooze" data-testid="hamburger-snooze-row">
                    <SnoozeMenu row={row} iconSize={14} label="Snooze" />
                  </div>
                )}
                {isSpecial ? null : (
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="hamburger-archive"
                    role="menuitem"
                    onClick={() => {
                      setHamburgerOpen(false);
                      void toggleArchive();
                    }}
                  >
                    {archived ? (
                      <PackageOpen size={14} aria-hidden />
                    ) : (
                      <Archive size={14} aria-hidden />
                    )}
                    {archived ? 'Unarchive' : 'Archive'}
                  </button>
                )}
                {canHide ? (
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="hamburger-hide"
                    role="menuitem"
                    onClick={() => {
                      setHamburgerOpen(false);
                      void hide();
                    }}
                  >
                    <EyeOff size={14} aria-hidden />
                    Hide
                  </button>
                ) : null}
                {isSpecial ? (
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="hamburger-disable"
                    role="menuitem"
                    onClick={() => {
                      setHamburgerOpen(false);
                      void toggleDisabled();
                    }}
                  >
                    <Power size={14} aria-hidden />
                    {row.disabled ? 'Enable' : 'Disable'}
                  </button>
                ) : null}
                {isSpecial ? (
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="hamburger-clear-context"
                    role="menuitem"
                    onClick={() => {
                      setHamburgerOpen(false);
                      void clearContext();
                    }}
                  >
                    <Eraser size={14} aria-hidden />
                    Clear context
                  </button>
                ) : null}
                {isSpecial ? null : (
                  <button
                    type="button"
                    className="head-menu-item"
                    data-testid="hamburger-move"
                    role="menuitem"
                    onClick={() => {
                      setHamburgerOpen(false);
                      setMoveOpen(true);
                    }}
                  >
                    <ArrowRightLeft size={14} aria-hidden />
                    Move to…
                  </button>
                )}
                {isSpecial ? null : (
                  <button
                    type="button"
                    className="head-menu-item danger"
                    data-testid="hamburger-delete"
                    role="menuitem"
                    onClick={() => {
                      setHamburgerOpen(false);
                      void handleDelete();
                    }}
                  >
                    <DeleteIcon size={14} />
                    Delete
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
        {moveOpen ? <MoveChatModal row={row} onClose={() => setMoveOpen(false)} /> : null}
      </header>
      {/* Files and Terminal links on their own strip just under the header's
        rule, so both are one click away without hunting for the Editor icon
        or remembering ⌃`. */}
      <nav className="chat-quicklinks" data-testid="chat-quicklinks">
        <button
          type="button"
          className="chat-quicklink"
          data-testid="quicklink-files"
          onClick={() =>
            useLayoutStore.getState().toggleTab({ kind: 'page', page: 'files', chatId: row.chatId })
          }
        >
          Files
        </button>
        <button
          type="button"
          className="chat-quicklink"
          data-testid="quicklink-terminal"
          onClick={() =>
            useLayoutStore.getState().toggleTab({ kind: 'terminal', chatId: row.chatId })
          }
        >
          Terminal
        </button>
      </nav>
    </>
  );
}
