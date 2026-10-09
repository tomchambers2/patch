// Global keyboard-shortcut wiring per spec/14 ## Keyboard shortcuts.
//
// In scope for the SPA today:
//   ⌘?   open the keyboard cheat-sheet
//   ⌘K   focus the page's search field (else the sidebar's chat search)
//   ⌘F   focus the page's search field (falls through to the browser's find
//        bar on a page that has no search field of its own)
//   ⌘/   toggle sidebar
//   ⌘N   new chat (FAB)
//   ⌘↑/⌘↓  prev/next chat in sidebar
//   ⌘←/⌘→  back/forward through nav history (handled by NavHistoryControls,
//          not this file — it owns the stack the chord walks)
//   ⌘1   jump to Manager
//   ⌘2   toggle Channels (expand/collapse)
//   ⌘⌥A  archive current chat (⌘A is left to the OS: select all)
//   ⌘⇧A  toggle archived view
//   ⌘P   open the editor rail's file picker
//   ⌘'   open the diff editor on the last agent edit
//   ⌘↵   send, same as ↵, in the composer (never interrupts a running turn)
//   ⌘↵   commit the field being typed in, everywhere else (lib/submitChord.ts)
//   ⌘⇧D  dictate (hold to talk; a tap opens a sustained session) — the
//        chord is set per machine in Settings → Voice (lib/dictateChord.ts)
//   ⌃Space  global voice to Manager (window-level handler)
//
// Component-local handlers (not registered here) live next to their
// owning components:
//   - ↵ / Esc on the IncomingCallBanner.
//   - 1 / 2 / 3 inside a focused permission card.

import { useEffect } from 'react';

import { useUiStore } from '../stores/uiStore.js';
import { matchesChord } from './dictateChord.js';
import { isMacKeyboard, type KeyboardPlatformProbe } from './sendChord.js';
import type { SearchChord } from './searchTarget.js';

export interface ShortcutHandlers {
  /** ⌘K / ⌘F — focus the page's search field. Returns false when the page has
   *  none, which is what lets ⌘F leave the chord to the browser. `chord` says
   *  which: only ⌘K may land on the sidebar's global chat search. */
  onSearch(chord: SearchChord): boolean;
  onNewChat(): void;
  /** ⌘⇧N — new chat with the folder picker focused (spec/14 keyboard table). */
  onNewChatPicker(): void;
  /** ⌘J — jump to the oldest unread chat (spec/14 keyboard table). */
  onJumpOldestUnread(): void;
  /** ⌘⇧↑ — jump to the previous folder section in the sidebar. */
  onPrevFolder(): void;
  /** ⌘⇧↓ — jump to the next folder section in the sidebar. */
  onNextFolder(): void;
  onJumpManager(): void;
  onArchiveCurrent(): void;
  onFilePicker(): void;
  onDiffViewer(): void;
  /** G3-8: ⌘⇧' opens the per-chat file browser. */
  onFileBrowser(): void;
  onVoiceHoldStart(): void;
  /** `heldMs` is how long the chord was down — a tap and a press-and-hold are
   *  different gestures (spec/07 ## Voice-input modes — mode 1). */
  onVoiceHoldEnd(heldMs: number): void;
  onGlobalVoiceStart(): void;
  onGlobalVoiceEnd(heldMs: number): void;
  onToggleSidebar(): void;
  onToggleChannels(): void;
  onToggleArchived(): void;
  onPrevChat(): void;
  onNextChat(): void;
  onCheatSheet(): void;
  /** Group 20 fix DX-6: ⌥E toggles the editor rail. */
  onToggleEditor(): void;
  /** ⌃` toggles the chat's terminal drawer (spec/14 § Terminal). */
  onToggleTerminal(): void;
  /** ⌘W — close the active pane's active tab (spec/14 § Panes and tabs). */
  onCloseTab(): void;
  /** ⌘⌥←/→ — switch tabs within the active pane. */
  onPrevTab(): void;
  onNextTab(): void;
  /** ⌘\ — split the active pane, moving its active tab into a new pane
   *  beside it. */
  onSplitPane(): void;
}

/** What each modifier glyph is called on a keyboard that does not print it. */
const MODIFIER_WORDS: Record<string, string> = {
  '⌘': 'Ctrl',
  '⌃': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift',
};

/** Glyph keys that have a name worth reading when the modifiers are words. */
const KEY_WORDS: Record<string, string> = { '↵': 'Enter', '↑': 'Up', '↓': 'Down' };

/**
 * The chord as this keyboard should see it (spec/14 § Discoverability).
 *
 * A chord is written once, in macOS glyphs — the notation `SHORTCUT_TABLE` and
 * spec/14's table use (`⌘⌥A`, `⌥E`, `⌃\``) — and every surface that draws one
 * comes through here, so no call site spells the glyphs out for itself and none
 * of them can disagree about what a chord is called.
 *
 * A Mac gets the glyphs verbatim, because they are printed on its keys. Nothing
 * else does: `⌃` and `⌥` are Apple's glyphs for keys a PC keyboard labels Ctrl
 * and Alt, so swapping one glyph for another there still names a key the user
 * cannot find. The modifiers become their own key's words instead, joined with
 * `+` the way every other app on those platforms writes a chord.
 */
export function shortcutLabel(chord: string, probe?: KeyboardPlatformProbe | null): string {
  if (isMacKeyboard(probe)) return chord;
  const mods: string[] = [];
  let key = '';
  for (const ch of chord) {
    if (/\s/.test(ch)) continue;
    const word = MODIFIER_WORDS[ch];
    // A modifier already named (⌘ and ⌃ both read Ctrl off-Mac) is not repeated.
    if (word !== undefined) {
      if (!mods.includes(word)) mods.push(word);
      continue;
    }
    key += KEY_WORDS[ch] ?? ch;
  }
  return [...mods, key].filter((part) => part !== '').join('+');
}

/**
 * The tooltip for a control that has a shortcut: its name, then the chord.
 *
 * `name` obeys spec/14 § Copy — no helper text (a few words naming the control,
 * never a sentence), and the chord is the discoverability the spec asks for on
 * top of it.
 */
export function shortcutTitle(
  name: string,
  chord: string,
  probe?: KeyboardPlatformProbe | null,
): string {
  return `${name} (${shortcutLabel(chord, probe)})`;
}

/**
 * A shortcut's scope, machine-checkable where this file itself dispatches the
 * chord (spec/14 § Discoverability — "each shortcut declares its scope in
 * code... the handler enforces it"):
 *
 *   - `anywhere`  — fires regardless of route or focus (the app-wide chords:
 *     search, new chat, sidebar, cheat-sheet, file picker).
 *   - `chat-view` — fires only while a chat view is showing (`/`, `/chats/new`,
 *     `/chats/:id` — NOT Jobs, the job editor, Settings, or a popped-out
 *     window), and only when no text field other than the composer owns the
 *     keystroke — a text field, the composer included, keeps its native
 *     keys (⌘↑/⌘↓ move the caret to the start/end of the text).
 *   - `{ other: '<label>' }` — scope this file does not itself check, because
 *     the chord is owned by a different component that is already scoped by
 *     its own mount/focus/open state (a banner, the composer, a permission
 *     card) or — for the editor's own chords — a scope step 2 enforces.
 */
export type ShortcutScope =
  | { kind: 'anywhere' }
  | { kind: 'chat-view' }
  | { kind: 'other'; label: string };

const ANYWHERE: ShortcutScope = { kind: 'anywhere' };
const CHAT_VIEW: ShortcutScope = { kind: 'chat-view' };
const other = (label: string): ShortcutScope => ({ kind: 'other', label });

/** The label the cheat-sheet renders — the ONE place `kind` becomes copy, so
 *  the table can never say something the handler doesn't do. */
export function shortcutScopeLabel(scope: ShortcutScope): string {
  switch (scope.kind) {
    case 'anywhere':
      return 'Anywhere';
    case 'chat-view':
      return 'Chat view';
    case 'other':
      return scope.label;
  }
}

export interface ShortcutEntry {
  keys: string;
  action: string;
  scope: ShortcutScope;
  /** The row's keys are the rebindable dictate chord, not `keys`. */
  dictate?: true;
}

/** Source-of-truth list rendered by the cheat-sheet modal. */
export const SHORTCUT_TABLE: ShortcutEntry[] = [
  { keys: '⌘ ?', action: 'Open keyboard cheat-sheet', scope: ANYWHERE },
  { keys: '⌘ K', action: 'Focus search', scope: ANYWHERE },
  { keys: '⌘ F', action: 'Focus search', scope: other('Page with a search field') },
  { keys: '⌘ /', action: 'Toggle sidebar', scope: ANYWHERE },
  { keys: '⌘ N', action: 'New chat', scope: ANYWHERE },
  { keys: '⌘ ⇧ N', action: 'New chat with folder picker', scope: ANYWHERE },
  { keys: '⌘ ↑ / ⌘ ↓', action: 'Prev / next chat', scope: CHAT_VIEW },
  { keys: '⌘ ⇧ ↑ / ⌘ ⇧ ↓', action: 'Prev / next folder section', scope: CHAT_VIEW },
  {
    keys: '⌘ ← / ⌘ →',
    action: 'Back / Forward through the navigation history',
    // Enforced by NavHistoryControls itself (mounted only on a chat view) —
    // not by this file's handler.
    scope: other('Chat panel shown, no field focused'),
  },
  { keys: '⌘ 1', action: 'Jump to Manager', scope: CHAT_VIEW },
  { keys: '⌘ 2', action: 'Toggle Channels', scope: CHAT_VIEW },
  { keys: '⌘ J', action: 'Jump to oldest unread chat', scope: CHAT_VIEW },
  { keys: '⌘ ⌥ A', action: 'Archive current chat', scope: CHAT_VIEW },
  { keys: '⌘ ⇧ A', action: 'Toggle archived view', scope: CHAT_VIEW },
  { keys: '⌘ ⇧ E', action: 'Toggle fullscreen editor', scope: other('Editor open') },
  { keys: "⌘ ⇧ '", action: 'Open file browser', scope: ANYWHERE },
  { keys: 'Esc', action: 'Exit fullscreen / cancel modal', scope: ANYWHERE },
  { keys: '⌥ E', action: 'Toggle editor rail', scope: other('Composer focused') },
  { keys: "⌘ '", action: 'Open diff for last edit', scope: other('Chat focused') },
  { keys: '⌃ `', action: 'Toggle terminal', scope: other('Chat focused') },
  { keys: '⌘ W', action: 'Close tab', scope: ANYWHERE },
  { keys: '⌘ ⌥ ← / ⌘ ⌥ →', action: 'Previous / next tab', scope: CHAT_VIEW },
  { keys: '⌘ \\', action: 'Split pane', scope: CHAT_VIEW },
  { keys: '⌘ P', action: 'File picker (project-wide)', scope: ANYWHERE },
  { keys: '⌘ S', action: 'Save the open file', scope: other('Editor showing a file') },
  // The rule the app used to state only for the composer (spec/14 § Keyboard
  // shortcuts): wherever a field has a save action, the chord runs it.
  {
    keys: '⌘ ↵',
    action: 'Save / commit the field',
    scope: other('Editable field with a save action'),
  },
  // The composer keys the user reaches for constantly. `↵` and `⇧↵` were both
  // missing (Tom, `patch/todo.md` — "nothing tells you enter sends. placeholder
  // + cheatsheet both miss it") — the cheat-sheet listed only the ⌘ variant, so
  // the PRIMARY send key and the newline key appeared nowhere in the UI at all.
  { keys: '↵', action: 'Send composer (queues while running)', scope: other('Composer focused') },
  { keys: '⇧ ↵', action: 'Newline in composer', scope: other('Composer focused') },
  { keys: 'Esc', action: 'Stop the running turn', scope: other('Composer focused') },
  {
    keys: '/',
    action: 'Skill autocomplete (↑↓ move · ⇥ completes)',
    scope: other('Composer focused'),
  },
  {
    keys: '⌘ ⇧ D',
    action: 'Dictate (hold to talk, tap to keep listening)',
    scope: other('Chat focused'),
    dictate: true,
  },
  {
    keys: '⌃ Space',
    action: 'Voice note to Manager (hold to talk, tap to keep listening)',
    scope: other('Menu-bar'),
  },
  { keys: '↵', action: 'Accept incoming call', scope: other('Incoming-call banner') },
  { keys: 'Esc', action: 'Dismiss incoming call', scope: other('Incoming-call banner') },
  {
    keys: '1 / 2 / 3',
    action: 'Approve / approve all outstanding / decline',
    scope: other('Permission card'),
  },
];

function isMod(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

/** A "chat view" is `/`, `/chats/new`, or `/chats/:chatId` — not its
 *  editor-window pop-out (`/chats/:chatId/editor-window`), which has no chat
 *  panel to navigate (spec/14 § Discoverability). */
export function isChatViewPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/chats/new' || /^\/chats\/[^/]+$/.test(pathname);
}

/** What the caller currently shows — the one fact `chat-view` scope needs. */
export interface ShortcutScopeState {
  isChatView: boolean;
}

function isTextFieldTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** Enforces `scope` (spec/14 § Discoverability): `anywhere` always passes;
 *  `chat-view` needs a chat view on screen AND no text field (the composer
 *  included) in the way, so a field keeps its native keys. */
function scopeAllows(scope: ShortcutScope, e: KeyboardEvent, state: ShortcutScopeState): boolean {
  if (scope.kind !== 'chat-view') return true;
  if (!state.isChatView) return false;
  return !isTextFieldTarget(e);
}

export function useShortcuts(handlers: ShortcutHandlers, scope: ShortcutScopeState): void {
  useEffect(() => {
    // Null when the chord is up; otherwise the moment it went down, so the
    // release can report how long it was held.
    const dictateHeld: { at: number | null; code: string } = { at: null, code: '' };
    const ctrlSpaceHeld: { at: number | null } = { at: null };

    function down(e: KeyboardEvent): void {
      // First, so a chord the user picked is never shadowed by a built-in one.
      const dictate = useUiStore.getState().dictateChord;
      if (matchesChord(e, dictate)) {
        e.preventDefault();
        if (dictateHeld.at !== null) return; // key repeat
        dictateHeld.at = Date.now();
        dictateHeld.code = dictate.code;
        handlers.onVoiceHoldStart();
        return;
      }
      if (isMod(e) && e.key === '?') {
        e.preventDefault();
        handlers.onCheatSheet();
        return;
      }
      if (isMod(e) && e.key === 'k') {
        e.preventDefault();
        handlers.onSearch('k');
        return;
      }
      // ⌘F is a reserved OS chord (spec/14 § Reserved OS chords), carved out
      // ONLY for a page that has its own search field. So the preventDefault is
      // conditional on `onSearch()` reporting that it actually took focus: with
      // no search field on the page the chord is untouched and the browser's
      // own find bar opens, exactly as before.
      if (isMod(e) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        if (handlers.onSearch('f')) e.preventDefault();
        return;
      }
      if (isMod(e) && e.key === '/') {
        e.preventDefault();
        handlers.onToggleSidebar();
        return;
      }
      // ⌘⇧N must be checked before plain ⌘N (the bare check would swallow it).
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handlers.onNewChatPicker();
        return;
      }
      if (isMod(e) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handlers.onNewChat();
        return;
      }
      // Arrow chords: ⌘⇧↑/↓ jump folder sections, ⌘↑/↓ step chat rows. Both are
      // `chat-view` scoped (spec/14 § Discoverability): a text field keeps them.
      if (isMod(e) && e.key === 'ArrowUp') {
        if (e.shiftKey) {
          if (!scopeAllows(CHAT_VIEW, e, scope)) return;
          e.preventDefault();
          handlers.onPrevFolder();
        } else {
          if (!scopeAllows(CHAT_VIEW, e, scope)) return;
          e.preventDefault();
          handlers.onPrevChat();
        }
        return;
      }
      if (isMod(e) && e.key === 'ArrowDown') {
        if (e.shiftKey) {
          if (!scopeAllows(CHAT_VIEW, e, scope)) return;
          e.preventDefault();
          handlers.onNextFolder();
        } else {
          if (!scopeAllows(CHAT_VIEW, e, scope)) return;
          e.preventDefault();
          handlers.onNextChat();
        }
        return;
      }
      if (isMod(e) && e.key === '1') {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onJumpManager();
        return;
      }
      if (isMod(e) && e.key === '2') {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onToggleChannels();
        return;
      }
      if (isMod(e) && !e.shiftKey && e.key.toLowerCase() === 'j') {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onJumpOldestUnread();
        return;
      }
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === 'a') {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onToggleArchived();
        return;
      }
      // Archive lives on ⌘⌥A, NOT ⌘A (spec/14 § Reserved OS chords). ⌘A is
      // select-all everywhere — including over the transcript, where selecting
      // the whole conversation to copy it is exactly what the user means. So
      // this handler must never fire on a bare ⌘A, in or out of a text field.
      // macOS reports ⌥A as 'å', so match the physical key.
      if (isMod(e) && e.altKey && (e.code === 'KeyA' || e.key.toLowerCase() === 'a')) {
        if (!scopeAllows(CHAT_VIEW, e, scope)) return;
        e.preventDefault();
        handlers.onArchiveCurrent();
        return;
      }
      if (isMod(e) && e.key === 'p') {
        e.preventDefault();
        handlers.onFilePicker();
        return;
      }
      // The `'` key shortcuts: ⌘' opens the last-edit diff, ⌘⇧' opens the file
      // browser. Match on the physical key (`e.code === 'Quote'`) so we stay
      // layout-independent and don't depend on whether the shifted character is
      // reported as `'` or `"` — then disambiguate purely on `e.shiftKey`.
      if (isMod(e) && (e.code === 'Quote' || e.key === "'" || e.key === '"')) {
        e.preventDefault();
        if (e.shiftKey) handlers.onFileBrowser();
        else handlers.onDiffViewer();
        return;
      }
      // ⌃` — the terminal drawer, on the key every terminal-bearing app uses.
      // Checked before the ⌃Space voice hold so neither swallows the other.
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        handlers.onToggleTerminal();
        return;
      }
      if (e.altKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        handlers.onToggleEditor();
        return;
      }
      if (e.ctrlKey && e.code === 'Space' && ctrlSpaceHeld.at === null) {
        e.preventDefault();
        ctrlSpaceHeld.at = Date.now();
        handlers.onGlobalVoiceStart();
        return;
      }
      // Panes and tabs (spec/14 § Keyboard shortcuts): ⌘⌥←/→ switch tabs,
      // ⌘W closes one, ⌘\ splits the active pane. Scoped to a chat view, but
      // — unlike the chat-list chords above — NOT ceded to a focused text
      // field: `scopeAllows`'s text-field exception exists so a field keeps
      // its native editing keys, and none of these four collide with one —
      // no field anywhere binds ⌘-plus-⌥-plus-arrow or ⌘\. Going through it
      // anyway would mean never firing in the ordinary case, since opening a
      // chat puts the cursor straight into the composer (spec/14 § Composer).
      if (isMod(e) && e.altKey && e.key === 'ArrowLeft') {
        if (!scope.isChatView) return;
        e.preventDefault();
        handlers.onPrevTab();
        return;
      }
      if (isMod(e) && e.altKey && e.key === 'ArrowRight') {
        if (!scope.isChatView) return;
        e.preventDefault();
        handlers.onNextTab();
        return;
      }
      // ⌘W is claimed unconditionally — not even gated on `isChatView` — like
      // ⌘P/⌘K/⌘/ above: never left to fall through to the OS, which would
      // close the real browser tab/window rather than the app's own one.
      if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        handlers.onCloseTab();
        return;
      }
      if (isMod(e) && (e.code === 'Backslash' || e.key === '\\')) {
        if (!scope.isChatView) return;
        e.preventDefault();
        handlers.onSplitPane();
        return;
      }
    }

    function up(e: KeyboardEvent): void {
      // macOS suppresses the keyup for a character key while ⌘ is held, so the
      // modifier's own release has to count as the end of the chord too —
      // otherwise a dictation is left recording with no release to commit it.
      const modUp = e.key === 'Meta' || e.key === 'Control';
      if ((e.code === dictateHeld.code || modUp) && dictateHeld.at !== null) {
        const held = Date.now() - dictateHeld.at;
        dictateHeld.at = null;
        handlers.onVoiceHoldEnd(held);
      }
      if ((e.code === 'Space' || modUp) && ctrlSpaceHeld.at !== null) {
        const held = Date.now() - ctrlSpaceHeld.at;
        ctrlSpaceHeld.at = null;
        handlers.onGlobalVoiceEnd(held);
      }
    }

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [handlers, scope.isChatView]);
}
