// uiStore — UI state that doesn't naturally fit chat/voice/presence.
//
// - Sidebar sections (Channels, Archived) collapse state. Defaults per spec/14.
// - Search query for the AI-archived search.
// - Sidebar / editor column widths (resizable per spec).
// - Toast / error-banner queue. Per portfolio CLAUDE.md "no fallbacks":
//   failed REST calls surface in the banner queue rather than vanishing.

import { create } from 'zustand';
import {
  CHAT_SORTS,
  CHAT_STATE_FILTERS,
  DEFAULT_CHAT_SORT,
  type ChatSort,
  type ChatStateFilter,
} from '../lib/chatGroups.js';
import { DEFAULT_JOB_SORT, type JobSort } from '../lib/jobSort.js';
import { NO_JOB_FILTER, type JobFilter } from '../lib/jobFilter.js';
import { loadDictateChord, saveDictateChord, type DictateChord } from '../lib/dictateChord.js';
import type { SettingsPageId } from '../routes/settings/pages.js';
import { useLayoutStore } from './layoutStore.js';

// Column widths persist per-user across reloads (spec/14 ## Layout: "State
// persists per-user"). localStorage is the surface-local store. NO FALLBACK
// that hides a corrupt value — a bad parse just falls back to the default
// width, which is a legitimate first-run state, not a silenced error.
const SIDEBAR_W_KEY = 'patch.layout.sidebarWidth';
// spec/14 § Side threads panel — docks on the right like the file browser
// page, resizable on the same drag-resizable-divider convention.
const THREADS_PANEL_W_KEY = 'patch.layout.threadsPanelWidth';
const DEFAULT_THREADS_PANEL_W = 420;
// The Tools panel's column, same convention (spec/14 § Layout).
const TOOLS_PANEL_W_KEY = 'patch.layout.toolsPanelWidth';
const DEFAULT_TOOLS_PANEL_W = 320;
// F1 (desktop review 2026-07-14): the file browser's directory tree is a
// resizable + collapsible column. Its width and collapsed state persist
// per-user across reloads (spec/14 ## Layout: "State persists per-user"), just
// like the sidebar's width.
const BROWSE_TREE_W_KEY = 'patch.layout.browseTreeWidth';
const BROWSE_TREE_COLLAPSED_KEY = 'patch.browse.treeCollapsed';
const DEFAULT_SIDEBAR_W = 280;
// Mini sidebar: a rail of status dots. Dragging the sidebar narrower than this
// (it can't go below 200 as a full sidebar) switches to it; dragging back out
// restores the full sidebar at the width it last had.
const SIDEBAR_MINI_KEY = 'patch.layout.sidebarMini';
export const SIDEBAR_MINI_BELOW = 140;
export const SIDEBAR_MINI_WIDTH = 52;
const DEFAULT_BROWSE_TREE_W = 280;

// Recent folders the user has explicitly "forgotten" from the sidebar's Recent
// folders list (spec/14 § Sidebar → Recent folders, E6). Persisted so a forget
// survives reloads. NO FALLBACK that hides a corrupt value — a bad parse just
// resets to the empty set, a legitimate first-run state.
const FORGOTTEN_FOLDERS_KEY = 'patch.sidebar.forgottenFolders';

function loadForgottenFolders(): string[] {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(FORGOTTEN_FOLDERS_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function persistForgottenFolders(folders: string[]): void {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(FORGOTTEN_FOLDERS_KEY, JSON.stringify(folders));
}

// Projects the user has collapsed in the sidebar's Folders list (spec/14
// § Sidebar §4). Keyed on the folder's FULL PATH — two projects can share a
// basename, and collapsing one must not fold the other. Same shape and same
// no-fallback rule as the forgotten folders above.
const COLLAPSED_FOLDERS_KEY = 'patch.sidebar.collapsedFolders';

function loadCollapsedFolders(): string[] {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(COLLAPSED_FOLDERS_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function persistCollapsedFolders(folders: string[]): void {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(folders));
}

// The sidebar's single view dropdown (spec/14 § Sidebar §1b) drives both of
// these. Persisted — picking Unread/Working/Waiting on you/Failed is a
// standing choice about what the sidebar shows, the same as Batch's own
// `patch.batch.mode` (stores/batchStore.ts) already is; a reload reopening on
// a silently-cleared filter read as the app forgetting what was asked for.
const ATTENTION_ONLY_KEY = 'patch.sidebar.attentionOnly';
const STATE_FILTER_KEY = 'patch.sidebar.stateFilter';

function loadStateFilter(): ChatStateFilter {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return 'all';
  const raw = localStorage.getItem(STATE_FILTER_KEY);
  // A missing or garbled value is a legitimate first run — not a swallowed
  // error — and falls back to 'all', same as every other no-fallback loader
  // in this file.
  return CHAT_STATE_FILTERS.includes(raw as ChatStateFilter) ? (raw as ChatStateFilter) : 'all';
}

// Sidebar ordering (spec/14 § Sidebar ordering): how chats order within a
// project and how projects order. Persisted — a standing choice, and a reload
// reopening on a different order read as the list flipping around.
const CHAT_SORT_KEY = 'patch.sidebar.chatSort';
const GROUP_SORT_KEY = 'patch.sidebar.groupSort';

function loadSort(key: string): ChatSort {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return DEFAULT_CHAT_SORT;
  const raw = localStorage.getItem(key);
  // Missing or garbled is a first run, not a swallowed error.
  return CHAT_SORTS.some((o) => o.value === raw) ? (raw as ChatSort) : DEFAULT_CHAT_SORT;
}

function persistSort(key: string, v: ChatSort): void {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, v);
}

function persistStateFilter(v: ChatStateFilter): void {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STATE_FILTER_KEY, v);
}

// Whether the chat panel's background-task stack is folded to its one-line
// summary (spec/14 § Main chat panel — Background task bar). This is a per-user
// display preference rather than per-chat state: the stack only exists while
// something of that chat is running, and keying it on chat id would grow a list
// in localStorage that is never pruned. Expanded is the default — a missing or
// garbled value reads as expanded, a legitimate first run and not a swallowed
// error (`loadBool` below).
const BACKGROUND_TASKS_COLLAPSED_KEY = 'patch.chat.backgroundTasksCollapsed';

// Whether that stack also lists the chat's ENDED background tasks, struck
// through under the running ones (spec/14 § Main chat panel — Background task
// bar). Same kind of preference as the fold, stored the same way, and off by
// default: the bar is a readout of work in flight, and what has already
// finished is the answer to a question the reader has to ask.
const BACKGROUND_TASKS_SHOW_ALL_KEY = 'patch.chat.backgroundTasksShowAll';

function loadWidth(key: string, fallback: number): number {
  /* v8 ignore next -- jsdom (the test environment) always defines `localStorage`; this SSR/non-DOM guard cannot be exercised under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function persistWidth(key: string, value: number): void {
  /* v8 ignore next -- jsdom (the test environment) always defines `localStorage`; this SSR/non-DOM guard cannot be exercised under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, String(value));
}

// F1: load/persist the browse-tree collapsed flag. A missing/garbled value is a
// legitimate first-run "expanded" default — no fallback hides a real error.
function loadBool(key: string): boolean {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(key) === 'true';
}

function persistBool(key: string, value: boolean): void {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, String(value));
}

// spec/14 § File browser — the browser reopens where it was left. Closing the
// rail must not throw away the file that was open, the directory the tree was
// parked in or the filter that was typed, and neither must a reload. Keyed per
// chat: the browser is rooted at the chat's folder, so a path carries no meaning
// without the chat it is relative to, and two chats are two different trees.
//
// Bounded to the most recently used chats. Unbounded, this map gains a row for
// every chat whose files were ever browsed and never loses one, in a store with
// a few megabytes for the whole app.
const BROWSE_STATE_KEY = 'patch.browse.byChat.v1';
const BROWSE_STATE_MAX = 12;

// spec/14 § New windows: a window opened via one of the explicit "open in new
// window" actions (lib/newWindow.ts) carries `?sidebar=hidden` and starts with
// its OWN sidebar collapsed — read once from the URL at boot (not persisted:
// a normal window/reload never carries the param, so it keeps defaulting to
// visible) rather than toggled after mount, which would show the sidebar for
// one frame before collapsing it.
function loadSidebarHiddenParam(): boolean {
  /* v8 ignore next -- jsdom always defines `window`; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('sidebar') === 'hidden';
}

/**
 * Pending diff currently shown in the Monaco editor rail. Set when a
 * `chat.permission_request` for a file-edit tool arrives; cleared when the
 * user approves/denies. Group 19.
 */
export interface PendingDiff {
  requestId: string;
  /** Owning chat — used to scope the diff to the active chat (group 20 fix DX-9). */
  chatId: string;
  tool: string;
  filePath: string;
  original: string;
  modified: string;
  description?: string;
}

/**
 * G3 (spec/14-design-web.md § Diff editor): a diff editor opened from an
 * agent edit. Unlike `PendingDiff` (which is tied to a `chat.permission_request`
 * and answered with `chat.permission_response`), a `FileDiff` represents an
 * already-applied agent edit that the user can tweak and re-commit to disk via
 * a `file.write` wire event. It carries the whole "change set" — every file in
 * the same edit — so the fullscreen takeover can navigate between files.
 */
export interface FileDiffEntry {
  /** Path relative to the chat folder. */
  path: string;
  /** Left side of the unified diff — the original (e.g. on-disk before edit, or HEAD). */
  original: string;
  /** Right side — the agent's edited content (the editable side). */
  modified: string;
}

export interface FileDiff {
  /** Owning chat — saves emit `file.write` for this chat. */
  chatId: string;
  /** All files in the same edit, for the change-set rail. */
  changeSet: FileDiffEntry[];
  /** Index into `changeSet` currently shown. */
  activeIndex: number;
}

/**
 * Where one chat's file browser was left (spec/14 § File browser). Restored
 * when the rail is reopened, and reloaded from localStorage on a cold start.
 */
export interface BrowseChatState {
  /**
   * Editor overhaul: the tree is now hierarchical (expand/collapse at any
   * depth) instead of one directory shown at a time, so there is no more
   * "current directory" to remember — this is the set of directories
   * (full paths relative to the chat folder) the user has expanded, as an
   * array (Zustand/localStorage-friendly; the component holds it as a Set).
   * Top-level entries are always shown regardless of this list — there is no
   * row for the root itself to expand/collapse.
   */
  expandedDirs: string[];
  /** The file the editor pane is showing, or null when nothing is open. */
  openFile: { name: string; path: string } | null;
  /**
   * The tree's filter. Narrows the WHOLE tree now (every depth), not just one
   * directory — a match's ancestor directories stay visible (and effectively
   * expanded) so the match itself is reachable. Distinct from ⌘P, which is
   * the project-wide fuzzy jump-to-file.
   */
  filter: string;
  /**
   * Unsaved edits to `openFile`, or null when the pane still matches what was
   * loaded. IN MEMORY ONLY — `persistBrowseState` strips it, deliberately:
   * a file's whole content in localStorage would blow the few-megabyte budget
   * on one large file and take the rest of the map down with it, and a draft
   * restored after a restart is an edit against a file the host may have
   * changed since, which Save would then write over without anyone having
   * compared the two. Within a session the draft outlives closing the rail,
   * which is where an unsaved edit actually gets lost.
   */
  draft: string | null;
  /**
   * Save-conflict check (spec/14 § File browser — save conflicts, Zed-style):
   * the on-disk content `draft` was FIRST typed against — captured once, the
   * moment `draft` transitions from null to non-null (the first keystroke),
   * not read fresh on every render. Distinct from the live `file-content`
   * query on purpose: that query can be invalidated and refetched out from
   * under an open draft (the live `patch.file_changed` push, or simply a
   * stale-cache refetch), and if the baseline were just "whatever
   * `fileContent.content` currently says" it would silently follow that
   * refetch too — hiding the very edit-since-open a conflict check exists to
   * catch. `null` whenever `draft` is null (nothing to have a baseline for).
   * IN MEMORY ONLY, same reasoning as `draft` below.
   */
  draftBaseline: string | null;
  /**
   * Editor overhaul (inline create): where a newly created "untitled" file/
   * folder lands. Tracked as the directory of the last row the user
   * interacted with (a directory row → itself; a file row, or the root → the
   * root), '' by default. Simplest sensible default now that there is no
   * single "current directory" — see `createEntry` in EditorRail.tsx.
   */
  lastActiveDir: string;
  /**
   * The entry an inline create/rename is editing, or null when nothing is
   * mid-rename. Lives here rather than in `FilesPage`'s own `useState`
   * because a freshly split pane's lazy-Monaco Suspense boundary trips a
   * (benign, zustand-state-safe) React-internal consistency check that
   * discards local component state on its way to recovering — a `FilesPage`
   * `useState` loses the row it just put into rename mode the instant
   * "New file" also opens the file in a split; a zustand field does not,
   * same as `expandedDirs`/`filter` already don't. IN MEMORY ONLY, same
   * reasoning as `draft` below — a rename mid-type has no business surviving
   * a restart.
   */
  renamingPath: string | null;
  /** The in-progress value of the `renamingPath` row's rename field. */
  renameValue: string;
  /** Recency stamp — which entries survive the `BROWSE_STATE_MAX` bound. */
  touch: number;
}

export const EMPTY_BROWSE_STATE: BrowseChatState = {
  expandedDirs: [],
  openFile: null,
  filter: '',
  draft: null,
  draftBaseline: null,
  lastActiveDir: '',
  renamingPath: null,
  renameValue: '',
  touch: 0,
};

// Monotonic within a session and carried through localStorage, so a restored
// map keeps the order it was saved in rather than restarting from zero and
// evicting the entries it just loaded.
let browseTouchSeq = 0;
function nextBrowseTouch(): number {
  browseTouchSeq += 1;
  return browseTouchSeq;
}

// spec/14 § File browser — live updates: a local counter for `lastFileChanged`
// entries (see its doc comment on the store field) — session-only, never
// persisted, since the push it stamps is itself never persisted.
let fileChangedSeq = 0;
function nextFileChangedSeq(): number {
  fileChangedSeq += 1;
  return fileChangedSeq;
}

/**
 * Drop all but the `BROWSE_STATE_MAX` most recently touched chats. Exported so
 * the bound is testable without reaching through localStorage.
 */
export function trimBrowseState(
  map: Record<string, BrowseChatState>,
): Record<string, BrowseChatState> {
  const keys = Object.keys(map);
  if (keys.length <= BROWSE_STATE_MAX) return map;
  const keep = keys
    .sort((a, b) => (map[b]?.touch ?? 0) - (map[a]?.touch ?? 0))
    .slice(0, BROWSE_STATE_MAX);
  const out: Record<string, BrowseChatState> = {};
  for (const k of keep) out[k] = map[k] as BrowseChatState;
  return out;
}

/**
 * Read the persisted map back. Exported so the parsing rules are testable on
 * their own — the store itself only reads it once, at module load.
 */
export function loadBrowseState(): Record<string, BrowseChatState> {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(BROWSE_STATE_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, BrowseChatState> = {};
    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const filter = typeof v['filter'] === 'string' ? v['filter'] : '';
      const lastActiveDir = typeof v['lastActiveDir'] === 'string' ? v['lastActiveDir'] : '';
      const rawExpanded = v['expandedDirs'];
      const expandedDirs = Array.isArray(rawExpanded)
        ? rawExpanded.filter((p): p is string => typeof p === 'string')
        : [];
      const of = v['openFile'];
      let openFile: BrowseChatState['openFile'] = null;
      if (typeof of === 'object' && of !== null) {
        const o = of as Record<string, unknown>;
        if (typeof o['name'] === 'string' && typeof o['path'] === 'string') {
          openFile = { name: o['name'], path: o['path'] };
        }
      }
      const touch = typeof v['touch'] === 'number' ? v['touch'] : 0;
      browseTouchSeq = Math.max(browseTouchSeq, touch);
      out[chatId] = {
        expandedDirs,
        openFile,
        filter,
        draft: null,
        draftBaseline: null,
        lastActiveDir,
        renamingPath: null,
        renameValue: '',
        touch,
      };
    }
    return trimBrowseState(out);
  } catch {
    // A garbled value is a first run, not a swallowed error: there is nothing to
    // report to the user about a preference that failed to parse, and the
    // browser simply opens at the chat's root.
    return {};
  }
}

function persistBrowseState(map: Record<string, BrowseChatState>): void {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  const out: Record<
    string,
    Omit<BrowseChatState, 'draft' | 'draftBaseline' | 'renamingPath' | 'renameValue'>
  > = {};
  for (const [chatId, v] of Object.entries(map)) {
    out[chatId] = {
      expandedDirs: v.expandedDirs,
      openFile: v.openFile,
      filter: v.filter,
      lastActiveDir: v.lastActiveDir,
      touch: v.touch,
    };
  }
  localStorage.setItem(BROWSE_STATE_KEY, JSON.stringify(out));
}

/**
 * A request to open one specific file in the file browser, made from outside
 * the rail — today the job editor's Edit-skill link (spec/14 § Jobs view).
 * The browser tracks its own open file (`BrowseChatState`), so this is the
 * only way to point it somewhere; `BrowsePanel` consumes the request, records
 * it as that chat's place and clears it.
 *
 * `chatId` is which chat's folder the path is rooted in: the file API is
 * chat-scoped, so a path means nothing without one. The requester is
 * responsible for making that chat active — the rail only ever renders one.
 */
export interface BrowseRequest {
  /** The chat whose folder `path` is relative to. */
  chatId: string;
  /** Path relative to that chat's folder. */
  path: string;
  /** Display name for the editor tab (the file's basename). */
  name: string;
}

/**
 * A pending confirmation shown in the app's own custom modal (spec/patch todo:
 * "Use a custom modal for delete + all other modals. Not Mac native.").
 * Replaces the OS-native `window.confirm()` so confirmations look like the rest
 * of the app on every surface (web / desktop / menu-bar).
 */
export interface ConfirmDialog {
  id: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Render the confirm button in the danger style (destructive actions). */
  danger: boolean;
}

/**
 * An in-app text prompt, replacing `window.prompt()`.
 *
 * Electron does not implement `window.prompt` — it THROWS
 * `prompt() is not supported.` So a Settings button that called it did nothing at
 * all in the desktop app: the exception escaped the click handler. (Verified with a
 * real Electron renderer, not assumed.)
 */
export interface PromptDialog {
  id: string;
  title: string;
  message: string;
  placeholder: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** Options a caller passes to `prompt()`. `message` is optional; none renders no paragraph. */
export interface PromptOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** Options a caller passes to `confirm()`. Only `message` is required. */
export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** A named control on a toast — the label is the button's text. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ErrorToast {
  id: string;
  message: string;
  /** Severity — `error` (red) vs `info` (neutral success/notice). */
  level: 'error' | 'info';
  retry: (() => void) | null;
  /**
   * An optional "take me there" control, rendered as a named button beside
   * Dismiss. A notice that reports something happening SOMEWHERE ELSE (the
   * batch landing while you sit in a chat) is otherwise a dead end — you are
   * told, and then left to find it yourself. Distinct from `retry`, which
   * re-runs the failed thing rather than navigating to it.
   */
  action: ToastAction | null;
  /**
   * The original machine-readable code + message behind `message`, shown in a
   * collapsed disclosure (`lib/errorCopy.ts`). Null when the sentence is all
   * there is.
   */
  detail: string | null;
  /**
   * Set while the user has that disclosure open — auto-dismiss must not pull
   * the toast out from under something being read.
   */
  held: boolean;
  /** ms timestamp. */
  at: number;
}

// Toasts are transient: they auto-dismiss after this many ms so a stale error
// does not linger across route navigations until manually dismissed
// (spec/12 — errors are surfaced, not pinned forever).
const TOAST_TTL_MS = 6000;

interface UiState {
  codexSignInHost: string | null;
  setCodexSignInHost(daemonId: string | null): void;
  channelsOpen: boolean;
  /** Hidden section expanded? Collapsed by default (spec/04 § Hidden). */
  hiddenOpen: boolean;
  archivedOpen: boolean;
  /** Deleted (soft-delete) section expanded? Collapsed by default (spec/14). */
  deletedOpen: boolean;
  /** Snoozed section expanded? Collapsed by default (spec/04 § Snooze). */
  snoozedOpen: boolean;
  /** Automations section expanded? Collapsed by default (spec/14 § Sidebar). */
  automationsOpen: boolean;
  /**
   * Bumped once per near-bottom scroll of a lifecycle list's scroll region —
   * the sidebar's shared `.sb-lifecycle` band (every open cold-storage panel)
   * or `/lifecycle/:kind`'s `.lifecycle-route` (spec/14 § Sidebar item 6:
   * "load a limited number... then load more on scroll"). A plain counter
   * rather than a per-section flag: several panels can be open in the same
   * shared band at once, and it's simpler for every open section's own
   * pagination hook to just re-check itself on any bump than to work out
   * which one the user was actually looking at.
   */
  lifecycleScrollTick: number;
  bumpLifecycleScrollTick(): void;
  /**
   * Jobs view's expired one-off section expanded? Collapsed by default
   * (spec/14 § Jobs view) — retired jobs are kept for their history and would
   * otherwise crowd out the jobs that still run.
   */
  expiredJobsOpen: boolean;
  /**
   * Jobs view's archived section expanded? Collapsed by default (spec/14
   * § Jobs view) — an archived job is one the user has put away, and the
   * count on the header is the whole answer to "anything in there?".
   */
  archivedJobsOpen: boolean;
  /**
   * How the Jobs view orders each section (spec/14 § Jobs view). Held for the
   * session like the two fold states above, so leaving the page and coming
   * back does not put the list back the way it was.
   */
  jobsSort: JobSort;
  /**
   * How the Jobs view narrows the list on status and trigger type (spec/14
   * § Jobs view). Session state for the same reason as `jobsSort`.
   */
  jobsFilter: JobFilter;
  /**
   * The sidebar view dropdown's Unread option (spec/14 § Sidebar §1b, §
   * Chat lifecycle → Needs attention toggle). When on, the sidebar filters
   * the active chat list to only chats needing attention — `done` (finished,
   * unread) or `permission` (paused, needs yes/no) — hiding `working` (still
   * going) and `read` (already seen) chats along with the other-chats
   * sections. Off by default; persisted across reloads.
   */
  attentionOnly: boolean;
  /**
   * The sidebar view dropdown's Working/Waiting on you/Failed options
   * (spec/14 § Sidebar §1b). `'all'` — the default — filters nothing.
   *
   * Separate from `attentionOnly`, which is a curated queue of several states;
   * this answers "show me only what failed" (or only what is working), which is
   * the question there was no way to ask while a failed chat looked finished.
   * Persisted across reloads, same as `attentionOnly` and batch mode
   * (`stores/batchStore.ts`'s `mode`) — the dropdown is one choice, so all
   * three pieces it drives are remembered the same way.
   */
  stateFilter: ChatStateFilter;
  /** Order of chats within a project (spec/14 § Sidebar ordering). */
  chatSort: ChatSort;
  /** Order of the projects themselves. */
  groupSort: ChatSort;
  sidebarCollapsed: boolean;
  /** Sidebar drawn as a rail of status dots (spec/14 § Mini sidebar). */
  sidebarMini: boolean;
  setSidebarMini(v: boolean): void;
  cheatSheetOpen: boolean;
  /**
   * Connection diagnostics screen opened on demand from a banner's Diagnose
   * action (spec/12 § Connection diagnostics screen). The BLOCKING variant is
   * derived from presence state, not this flag.
   */
  diagnosticsOpen: boolean;
  /**
   * The user has closed the BLOCKING diagnostics takeover (spec/12 §
   * Connection diagnostics screen). Latched for the session so a surface that
   * has still never connected does not have the window taken back off the user
   * on the next failed attempt; the banners' Diagnose action is how it returns.
   */
  diagnosticsBlockingClosed: boolean;
  /**
   * The sidebar's global chat search query (components/ChatSearch.tsx), as
   * typed — untrimmed. Search is on while the trimmed text is at least
   * `CHAT_SEARCH_MIN_QUERY` long; then the chat list shows server results.
   * Held here, not in the field, so it survives opening a result.
   */
  searchQuery: string;
  /**
   * Whether the sidebar search also reads message text (true) or matches chat
   * names only (false, the default). Ticking the results band's "Full text" box.
   */
  searchFullText: boolean;
  sidebarWidth: number;
  /** spec/14 § Side threads panel — resizable right-docked column width (px). */
  threadsPanelWidth: number;
  /** spec/14 § Layout — resizable Tools panel column width (px). */
  toolsPanelWidth: number;
  /** Double-click on the Tools divider: back to the default width. */
  resetToolsPanelWidth(): void;
  /** The dictate shortcut on this machine (lib/dictateChord.ts). */
  dictateChord: DictateChord;
  /** F1: width (px) of the file-browser directory tree column (resizable). */
  browseTreeWidth: number;
  /** F1: whether the file-browser directory tree is collapsed to a thin strip. */
  browseTreeCollapsed: boolean;
  /** Background-task stack folded to its one-line count summary? */
  backgroundTasksCollapsed: boolean;
  /** Background-task stack also listing this chat's ended tasks? */
  backgroundTasksShowAll: boolean;
  /**
   * Group 19/20: pending diffs keyed by chatId. spec/14 § Panes and tabs: a
   * `FileEditorTab` reads its OWN chat's entry directly — there is no more
   * single docked rail to need a convenience "the active one" getter for.
   */
  pendingDiffByChat: Record<string, PendingDiff>;
  /**
   * G3: the file diff currently shown in the diff editor (opened from an
   * agent edit / file-browser meta strip). Saved via `file.write`. Null when
   * the rail is in browse mode or no edit is selected.
   */
  fileDiff: FileDiff | null;
  /**
   * spec/14 § Panes and tabs: a banner/link elsewhere asking Settings to open
   * on a specific sub-page — there is no more `/settings/<page>` route to
   * deep-link to (Settings is one pane tab now; see `routes/SettingsRoute.tsx`).
   * Consumed once by the Settings tab, then cleared.
   */
  settingsPageRequest: SettingsPageId | null;
  /**
   * Where each chat's file tree was left (spec/14 § File browser) — tree
   * position only now (expanded dirs, filter, last-active dir); the open
   * file and its draft moved to `FileEditorTab`'s own per-tab state.
   */
  browseByChat: Record<string, BrowseChatState>;
  /**
   * spec/14 § File browser — live updates: the most recent `patch.file_changed`
   * push per chat (`ws.ts`'s dispatch records it here — a plain store write,
   * no TanStack Query import needed at that layer). `seq` is a LOCAL,
   * monotonically-increasing counter, not the wire protocol's per-chat seq
   * (this event carries none) — it exists only so a `BrowsePanel` effect keyed
   * on this value can tell "a new push just arrived" apart from "the chat
   * re-rendered for an unrelated reason" even when two pushes in a row name
   * the exact same path.
   */
  lastFileChanged: Record<string, { path: string; seq: number }>;
  /** Group 20 fix DX-8: global flag — when true the editor rail's file
   *  picker opens immediately (regardless of the rail's current mode). */
  filePickerOpen: boolean;
  /**
   * patch/todo.md — "Show the tools in the chat … allow the user to turn them on
   * and off". The chatId whose Tools panel is open (a modal listing every tool,
   * what it does, its definition, and an on/off switch), or null when closed.
   */
  toolsPanelChatId: string | null;
  errors: ErrorToast[];
  /**
   * The confirmation currently shown in the custom modal, or null when none is
   * open. Set by `confirm()`, cleared by `resolveConfirm()`.
   */
  confirmDialog: ConfirmDialog | null;
  promptDialog: PromptDialog | null;
  /** Folders the user has forgotten from the Recent folders list (E6). */
  forgottenFolders: string[];
  /** Projects collapsed in the sidebar's Folders list, by full path (§4). */
  collapsedFolders: string[];
  setChannelsOpen(v: boolean): void;
  setHiddenOpen(v: boolean): void;
  setArchivedOpen(v: boolean): void;
  setDeletedOpen(v: boolean): void;
  setSnoozedOpen(v: boolean): void;
  setAutomationsOpen(v: boolean): void;
  setExpiredJobsOpen(v: boolean): void;
  setArchivedJobsOpen(v: boolean): void;
  setJobsSort(v: JobSort): void;
  setJobsFilter(v: JobFilter): void;
  /** Toggle the "needs attention" filter mode. */
  setAttentionOnly(v: boolean): void;
  setStateFilter(v: ChatStateFilter): void;
  setChatSort(v: ChatSort): void;
  setGroupSort(v: ChatSort): void;
  /** Forget a recent folder — removes it from the Recent folders list. */
  forgetFolder(folder: string): void;
  /** Fold a project's rows away in the sidebar, or unfold them again. */
  toggleFolderCollapsed(folder: string): void;
  setSidebarCollapsed(v: boolean): void;
  setCheatSheetOpen(v: boolean): void;
  setDiagnosticsOpen(v: boolean): void;
  closeDiagnosticsBlocking(): void;
  setSearchQuery(q: string): void;
  setSearchFullText(v: boolean): void;
  setSidebarWidth(w: number): void;
  setThreadsPanelWidth(w: number): void;
  setToolsPanelWidth(w: number): void;
  /** Rebind the dictate shortcut (persisted per machine). */
  setDictateChord(chord: DictateChord): void;
  /** F1: set the browse-tree width (clamped + persisted). */
  setBrowseTreeWidth(w: number): void;
  /** F1: collapse/expand the browse-tree column (persisted). */
  setBrowseTreeCollapsed(v: boolean): void;
  /** Fold the chat's background-task bars to one summary line, or unfold (persisted). */
  setBackgroundTasksCollapsed(v: boolean): void;
  setBackgroundTasksShowAll(v: boolean): void;
  /** Record a pending permission diff for `d.chatId`. */
  setPendingDiff(d: PendingDiff): void;
  /**
   * Clear `chatId`'s pending diff — but only if it is still the SAME request
   * (`requestId`): resolving an inline card must not clear a diff a NEWER
   * permission request has since replaced for that chat.
   */
  clearPendingDiffForChat(chatId: string, requestId: string): void;
  /**
   * G3: open the diff editor on a change set (agent edit / meta-strip link).
   * Also opens each file in the change set as its own tab (spec/14 § Panes
   * and tabs — "one tab per file").
   */
  openFileDiff(d: FileDiff): void;
  /** G3: navigate the change-set rail to a different file in the same edit. */
  setFileDiffIndex(i: number): void;
  /** G3: clear the file diff (e.g. after save or close). */
  clearFileDiff(): void;
  /**
   * Open one file as its own tab (spec/14 § Panes and tabs) — the job
   * editor's Edit-skill link (spec/14 § Jobs view).
   */
  openFileInBrowser(r: BrowseRequest): void;
  /**
   * Record where a chat's file browser is now. Merges into that chat's entry,
   * marks it most-recently-used and persists the bounded map.
   */
  setBrowseState(chatId: string, patch: Partial<Omit<BrowseChatState, 'touch'>>): void;
  /**
   * spec/14 § File browser — live updates: record a `patch.file_changed` push
   * for `chatId`. Called from `ws.ts`'s dispatch on every inbound frame of
   * that type — never called with intent to "clear" it, so there is no
   * companion clear/reset; the record is just superseded by the next push.
   */
  recordFileChanged(chatId: string, path: string): void;
  requestSettingsPage(page: SettingsPageId): void;
  clearSettingsPageRequest(): void;
  /** Group 20 fix DX-8: open/close the ⌘P file-picker modal. */
  setFilePickerOpen(v: boolean): void;
  /** Open the Tools panel for a chat (pass null to close). */
  setToolsPanelChatId(chatId: string | null): void;
  /**
   * Open the custom confirm modal and resolve to the user's choice (true =
   * confirmed, false = cancelled/dismissed). Replaces `window.confirm()`.
   * Only one confirm can be open at a time — opening a new one auto-cancels
   * (resolves false) any still-pending prior confirm.
   */
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** Answer the open confirm modal and close it. No-op when none is open. */
  resolveConfirm(result: boolean): void;
  /**
   * Ask for a line of text. Resolves to the entered string, or null when
   * cancelled — same contract as `window.prompt`, so call sites read the same.
   */
  prompt(opts: PromptOptions): Promise<string | null>;
  resolvePrompt(value: string | null): void;
  /**
   * `message` is what the user reads — one plain sentence. `detail` is the
   * machine-readable original (code + message) kept behind the toast's
   * collapsed Details disclosure.
   */
  pushError(message: string, retry?: (() => void) | undefined, detail?: string): void;
  /** Surface a neutral, auto-dismissing success/notice toast. `action` adds a
   *  single named button that takes the user to whatever the notice is about. */
  pushNotice(message: string, action?: ToastAction | undefined): void;
  /** Stop a toast auto-dismissing (its Details disclosure is open). */
  holdError(id: string): void;
  dismissError(id: string): void;
  /** Clear every toast — called on route navigation so errors don't persist. */
  clearToasts(): void;
}

// The pending `confirm()` promise resolver, held at module scope (a function
// isn't part of the serialisable store state). At most one confirm is open at a
// time; opening another cancels the previous one.
let pendingConfirmResolve: ((result: boolean) => void) | null = null;
let pendingPromptResolve: ((value: string | null) => void) | null = null;

export const useUiStore = create<UiState>((set, get) => ({
  codexSignInHost: null,
  setCodexSignInHost: (daemonId) => set({ codexSignInHost: daemonId }),
  channelsOpen: false,
  hiddenOpen: false,
  archivedOpen: false,
  deletedOpen: false,
  snoozedOpen: false,
  automationsOpen: false,
  lifecycleScrollTick: 0,
  bumpLifecycleScrollTick: () => set({ lifecycleScrollTick: get().lifecycleScrollTick + 1 }),
  expiredJobsOpen: false,
  archivedJobsOpen: false,
  jobsSort: DEFAULT_JOB_SORT,
  jobsFilter: NO_JOB_FILTER,
  attentionOnly: loadBool(ATTENTION_ONLY_KEY),
  stateFilter: loadStateFilter(),
  chatSort: loadSort(CHAT_SORT_KEY),
  groupSort: loadSort(GROUP_SORT_KEY),
  forgottenFolders: loadForgottenFolders(),
  collapsedFolders: loadCollapsedFolders(),
  sidebarCollapsed: loadSidebarHiddenParam(),
  sidebarMini: loadBool(SIDEBAR_MINI_KEY),
  cheatSheetOpen: false,
  diagnosticsOpen: false,
  diagnosticsBlockingClosed: false,
  searchQuery: '',
  searchFullText: false,
  sidebarWidth: loadWidth(SIDEBAR_W_KEY, DEFAULT_SIDEBAR_W),
  threadsPanelWidth: loadWidth(THREADS_PANEL_W_KEY, DEFAULT_THREADS_PANEL_W),
  toolsPanelWidth: loadWidth(TOOLS_PANEL_W_KEY, DEFAULT_TOOLS_PANEL_W),
  dictateChord: loadDictateChord(),
  browseTreeWidth: loadWidth(BROWSE_TREE_W_KEY, DEFAULT_BROWSE_TREE_W),
  browseTreeCollapsed: loadBool(BROWSE_TREE_COLLAPSED_KEY),
  backgroundTasksCollapsed: loadBool(BACKGROUND_TASKS_COLLAPSED_KEY),
  backgroundTasksShowAll: loadBool(BACKGROUND_TASKS_SHOW_ALL_KEY),
  pendingDiffByChat: {},
  fileDiff: null,
  settingsPageRequest: null,
  browseByChat: loadBrowseState(),
  lastFileChanged: {},
  filePickerOpen: false,
  toolsPanelChatId: null,
  errors: [],
  confirmDialog: null,
  promptDialog: null,
  setChannelsOpen(v) {
    set({ channelsOpen: v });
  },
  setArchivedOpen(v) {
    set({ archivedOpen: v });
  },
  setDeletedOpen(v) {
    set({ deletedOpen: v });
  },
  setSnoozedOpen(v) {
    set({ snoozedOpen: v });
  },
  setHiddenOpen(v) {
    set({ hiddenOpen: v });
  },
  setAutomationsOpen(v) {
    set({ automationsOpen: v });
  },
  setExpiredJobsOpen(v) {
    set({ expiredJobsOpen: v });
  },
  setArchivedJobsOpen(v) {
    set({ archivedJobsOpen: v });
  },
  setJobsSort(v) {
    set({ jobsSort: v });
  },
  setJobsFilter(v) {
    set({ jobsFilter: v });
  },
  setAttentionOnly(v) {
    persistBool(ATTENTION_ONLY_KEY, v);
    set({ attentionOnly: v });
  },
  setChatSort(v) {
    persistSort(CHAT_SORT_KEY, v);
    set({ chatSort: v });
  },
  setGroupSort(v) {
    persistSort(GROUP_SORT_KEY, v);
    set({ groupSort: v });
  },
  setStateFilter(v) {
    persistStateFilter(v);
    set({ stateFilter: v });
  },
  forgetFolder(folder) {
    const cur = get().forgottenFolders;
    if (cur.includes(folder)) return;
    const next = [...cur, folder];
    persistForgottenFolders(next);
    set({ forgottenFolders: next });
  },
  toggleFolderCollapsed(folder) {
    const cur = get().collapsedFolders;
    const next = cur.includes(folder) ? cur.filter((f) => f !== folder) : [...cur, folder];
    persistCollapsedFolders(next);
    set({ collapsedFolders: next });
  },
  setSidebarCollapsed(v) {
    set({ sidebarCollapsed: v });
  },
  setCheatSheetOpen(v) {
    set({ cheatSheetOpen: v });
  },
  setDiagnosticsOpen(v) {
    set({ diagnosticsOpen: v });
  },
  closeDiagnosticsBlocking() {
    set({ diagnosticsBlockingClosed: true });
  },
  setSearchQuery(q) {
    set({ searchQuery: q });
  },
  setSearchFullText(v) {
    set({ searchFullText: v });
  },
  setSidebarMini(v) {
    persistBool(SIDEBAR_MINI_KEY, v);
    set({ sidebarMini: v });
  },
  setSidebarWidth(w) {
    if (w < SIDEBAR_MINI_BELOW) {
      persistBool(SIDEBAR_MINI_KEY, true);
      set({ sidebarMini: true });
      return;
    }
    persistBool(SIDEBAR_MINI_KEY, false);
    const clamped = Math.max(200, Math.min(600, w));
    persistWidth(SIDEBAR_W_KEY, clamped);
    set({ sidebarWidth: clamped, sidebarMini: false });
  },
  setThreadsPanelWidth(w) {
    // Same ceiling convention as the editor rail/web panel (§ Layout, §
    // Links and the web panel): floored at 360px, capped viewport-relative so
    // the chat stays usable beside it.
    /* v8 ignore next -- jsdom always defines `window`; this SSR guard cannot be exercised. */
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const clamped = Math.max(360, Math.min(Math.max(600, vw - 320), w));
    persistWidth(THREADS_PANEL_W_KEY, clamped);
    set({ threadsPanelWidth: clamped });
  },
  setToolsPanelWidth(w) {
    // Floored at the old fixed width; capped viewport-relative so the chat
    // stays usable beside it.
    /* v8 ignore next -- jsdom always defines `window`; this SSR guard cannot be exercised. */
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const clamped = Math.max(DEFAULT_TOOLS_PANEL_W, Math.min(Math.max(600, vw - 320), w));
    persistWidth(TOOLS_PANEL_W_KEY, clamped);
    set({ toolsPanelWidth: clamped });
  },
  resetToolsPanelWidth() {
    persistWidth(TOOLS_PANEL_W_KEY, DEFAULT_TOOLS_PANEL_W);
    set({ toolsPanelWidth: DEFAULT_TOOLS_PANEL_W });
  },
  setDictateChord(chord) {
    saveDictateChord(chord);
    set({ dictateChord: chord });
  },
  setBrowseTreeWidth(w) {
    // Clamp to a usable range: wide enough to read filenames, capped so the
    // editor pane always keeps room. Persisted so the width survives reload.
    const clamped = Math.max(140, Math.min(560, w));
    persistWidth(BROWSE_TREE_W_KEY, clamped);
    set({ browseTreeWidth: clamped });
  },
  setBrowseTreeCollapsed(v) {
    persistBool(BROWSE_TREE_COLLAPSED_KEY, v);
    set({ browseTreeCollapsed: v });
  },
  setBackgroundTasksCollapsed(v) {
    persistBool(BACKGROUND_TASKS_COLLAPSED_KEY, v);
    set({ backgroundTasksCollapsed: v });
  },
  setBackgroundTasksShowAll(v) {
    persistBool(BACKGROUND_TASKS_SHOW_ALL_KEY, v);
    set({ backgroundTasksShowAll: v });
  },
  setPendingDiff(d) {
    const next = { ...get().pendingDiffByChat, [d.chatId]: d };
    set({ pendingDiffByChat: next });
  },
  clearPendingDiffForChat(chatId, requestId) {
    const cur = get().pendingDiffByChat[chatId];
    if (!cur || cur.requestId !== requestId) return;
    const next = { ...get().pendingDiffByChat };
    delete next[chatId];
    set({ pendingDiffByChat: next });
  },
  openFileDiff(d) {
    set({
      fileDiff: { ...d, activeIndex: Math.max(0, Math.min(d.activeIndex, d.changeSet.length - 1)) },
    });
    // spec/14 § Panes and tabs: a file-edit tool-call click / ⌘' opens each
    // file in the change set as its OWN tab ("one tab per file") — the old
    // docked rail's change-set rail (navigating between them without leaving
    // the rail) is superseded by the tab bar itself. `placement: 'tab'` on
    // every one of them: the default ('active') replaces whichever tab is
    // active in the target pane, so opening a SECOND file in the same set
    // would silently replace the first instead of sitting beside it. The
    // clicked file (`activeIndex`) opens LAST so it is the one left focused,
    // regardless of the change set's own order.
    const clampedIndex = Math.max(0, Math.min(d.activeIndex, d.changeSet.length - 1));
    const ordered = d.changeSet.filter((_, i) => i !== clampedIndex);
    const clicked = d.changeSet[clampedIndex];
    if (clicked) ordered.push(clicked);
    for (const entry of ordered) {
      useLayoutStore
        .getState()
        .openTab({ kind: 'file', chatId: d.chatId, path: entry.path }, { placement: 'tab' });
    }
  },
  setFileDiffIndex(i) {
    const cur = get().fileDiff;
    if (!cur) return;
    const clamped = Math.max(0, Math.min(i, cur.changeSet.length - 1));
    set({ fileDiff: { ...cur, activeIndex: clamped } });
  },
  clearFileDiff() {
    set({ fileDiff: null });
  },
  openFileInBrowser(r) {
    // spec/14 § Panes and tabs: a file tab, not the old docked rail.
    useLayoutStore.getState().openTab({ kind: 'file', chatId: r.chatId, path: r.path });
  },
  requestSettingsPage(p) {
    set({ settingsPageRequest: p });
  },
  clearSettingsPageRequest() {
    set({ settingsPageRequest: null });
  },
  setBrowseState(chatId, patch) {
    const cur = get().browseByChat[chatId] ?? EMPTY_BROWSE_STATE;
    const next: BrowseChatState = { ...cur, ...patch, touch: nextBrowseTouch() };
    const merged = trimBrowseState({ ...get().browseByChat, [chatId]: next });
    persistBrowseState(merged);
    set({ browseByChat: merged });
  },
  recordFileChanged(chatId, path) {
    set({
      lastFileChanged: {
        ...get().lastFileChanged,
        [chatId]: { path, seq: nextFileChangedSeq() },
      },
    });
  },
  setFilePickerOpen(v) {
    set({ filePickerOpen: v });
  },
  setToolsPanelChatId(chatId) {
    set({ toolsPanelChatId: chatId });
  },
  confirm(opts) {
    // Only one confirm at a time: if one is still pending, cancel it (false)
    // before showing the new one, so no resolver is ever leaked.
    if (pendingConfirmResolve) {
      const prev = pendingConfirmResolve;
      pendingConfirmResolve = null;
      prev(false);
    }
    return new Promise<boolean>((resolve) => {
      pendingConfirmResolve = resolve;
      set({
        confirmDialog: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: opts.title ?? 'Confirm',
          message: opts.message,
          confirmLabel: opts.confirmLabel ?? 'Confirm',
          cancelLabel: opts.cancelLabel ?? 'Cancel',
          danger: opts.danger ?? false,
        },
      });
    });
  },
  prompt(opts) {
    // One at a time, cancelling any pending one, mirroring confirm().
    if (pendingPromptResolve) {
      const prev = pendingPromptResolve;
      pendingPromptResolve = null;
      prev(null);
    }
    return new Promise<string | null>((resolve) => {
      pendingPromptResolve = resolve;
      set({
        promptDialog: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: opts.title ?? 'Enter a value',
          message: opts.message ?? '',
          placeholder: opts.placeholder ?? '',
          confirmLabel: opts.confirmLabel ?? 'OK',
          cancelLabel: opts.cancelLabel ?? 'Cancel',
        },
      });
    });
  },
  resolvePrompt(value) {
    const resolve = pendingPromptResolve;
    pendingPromptResolve = null;
    if (get().promptDialog !== null) set({ promptDialog: null });
    if (resolve) resolve(value);
  },
  resolveConfirm(result) {
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    if (get().confirmDialog !== null) set({ confirmDialog: null });
    if (resolve) resolve(result);
  },
  pushError(message, retry, detail) {
    // Dedupe identical errors: a flapping WS reconnect (e.g. an expired
    // credential) fires the same message repeatedly — without this they pile
    // up as a stack of identical toasts. Refresh the existing toast's
    // auto-dismiss timer instead of adding a duplicate. Two failures that
    // humanise to the same sentence but carry DIFFERENT details are two
    // failures, so the detail is part of the identity.
    const existing = get().errors.find(
      (e) => e.level === 'error' && e.message === message && (e.detail ?? '') === (detail ?? ''),
    );
    if (existing) {
      scheduleAutoDismiss(existing.id, get, set);
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set({
      errors: [
        ...get().errors,
        {
          id,
          message,
          level: 'error',
          retry: retry ?? null,
          action: null,
          detail: detail !== undefined && detail !== '' ? detail : null,
          held: false,
          at: Date.now(),
        },
      ],
    });
    scheduleAutoDismiss(id, get, set);
  },
  pushNotice(message, action) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set({
      errors: [
        ...get().errors,
        {
          id,
          message,
          level: 'info',
          retry: null,
          action: action ?? null,
          detail: null,
          held: false,
          at: Date.now(),
        },
      ],
    });
    scheduleAutoDismiss(id, get, set);
  },
  holdError(id) {
    set({ errors: get().errors.map((e) => (e.id === id ? { ...e, held: true } : e)) });
  },
  dismissError(id) {
    set({ errors: get().errors.filter((e) => e.id !== id) });
  },
  clearToasts() {
    set({ errors: [] });
  },
}));

// Auto-dismiss a toast after the TTL so it can't linger across navigations.
// `setTimeout` is a no-op-safe in jsdom/tests; the dismiss is idempotent.
function scheduleAutoDismiss(
  id: string,
  get: () => UiState,
  set: (partial: Partial<UiState>) => void,
): void {
  /* v8 ignore next -- jsdom (the test environment) always defines `setTimeout`; this guard cannot be exercised under vitest+jsdom. */
  if (typeof setTimeout === 'undefined') return;
  setTimeout(() => {
    // Held = its Details disclosure is open. Keep it until dismissed by hand.
    if (get().errors.find((e) => e.id === id)?.held === true) return;
    set({ errors: get().errors.filter((e) => e.id !== id) });
  }, TOAST_TTL_MS);
}
