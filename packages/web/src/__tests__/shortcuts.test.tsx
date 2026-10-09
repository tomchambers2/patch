// G2 keyboard-shortcut wiring (spec/14 ## Keyboard shortcuts). Mounts the
// `useShortcuts` hook with spy handlers and dispatches real KeyboardEvents to
// prove each spec'd chord routes to the right action — with particular focus
// on the chords the G2 task calls out as required: ⌘⇧N, ⌘J, ⌘⇧↑/⌘⇧↓, and the
// shift-disambiguation of ⌘N / ⌘↑ / ⌘↓.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { JSX } from 'react';
import {
  useShortcuts,
  SHORTCUT_TABLE,
  isChatViewPath,
  shortcutScopeLabel,
  type ShortcutHandlers,
} from '../lib/shortcuts.js';
import { DEFAULT_DICTATE_CHORD } from '../lib/dictateChord.js';
import { useUiStore } from '../stores/uiStore.js';

function makeHandlers(): ShortcutHandlers {
  return {
    onSearch: vi.fn(),
    onNewChat: vi.fn(),
    onNewChatPicker: vi.fn(),
    onJumpOldestUnread: vi.fn(),
    onPrevFolder: vi.fn(),
    onNextFolder: vi.fn(),
    onJumpManager: vi.fn(),
    onArchiveCurrent: vi.fn(),
    onFilePicker: vi.fn(),
    onDiffViewer: vi.fn(),
    onFileBrowser: vi.fn(),
    onVoiceHoldStart: vi.fn(),
    onVoiceHoldEnd: vi.fn(),
    onGlobalVoiceStart: vi.fn(),
    onGlobalVoiceEnd: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleChannels: vi.fn(),
    onToggleArchived: vi.fn(),
    onPrevChat: vi.fn(),
    onNextChat: vi.fn(),
    onCheatSheet: vi.fn(),
    onToggleEditor: vi.fn(),
    onToggleTerminal: vi.fn(),
    onCloseTab: vi.fn(),
    onPrevTab: vi.fn(),
    onNextTab: vi.fn(),
    onSplitPane: vi.fn(),
  };
}

// Most of this suite exercises chords whose scope doesn't depend on the
// route (app-wide) or that explicitly set `isChatView` themselves — so the
// default here is the common case, a chat view showing.
function Harness({
  handlers,
  isChatView = true,
}: {
  handlers: ShortcutHandlers;
  isChatView?: boolean;
}): JSX.Element {
  useShortcuts(handlers, { isChatView });
  return <div />;
}

function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

/** Same, but hands back the event so a test can read `defaultPrevented` —
 *  the only way to tell "the app took this chord" from "the app let it
 *  through to the browser". */
function pressEvent(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(ev);
  return ev;
}

let handlers: ShortcutHandlers;

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ dictateChord: DEFAULT_DICTATE_CHORD });
  handlers = makeHandlers();
  render(<Harness handlers={handlers} />);
});

describe('useShortcuts — ⌘F focuses the page search field', () => {
  it('⌘F fires onSearch and preventDefaults when a search field took focus', () => {
    (handlers.onSearch as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const ev = pressEvent({ key: 'f', metaKey: true });
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    // Says which chord, so the global chat search can decline ⌘F.
    expect(handlers.onSearch).toHaveBeenCalledWith('f');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('⌘F does NOT preventDefault when the page has no search field', () => {
    // spec/14 § Reserved OS chords: with nothing to focus the chord must
    // reach the browser so its own find bar still opens.
    (handlers.onSearch as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const ev = pressEvent({ key: 'f', metaKey: true });
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('⌃F works too (Linux/Windows binary swaps ⌘→⌃)', () => {
    (handlers.onSearch as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const ev = pressEvent({ key: 'f', ctrlKey: true });
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a bare F, and ⌘⇧F, are left alone', () => {
    pressEvent({ key: 'f' });
    pressEvent({ key: 'F', metaKey: true, shiftKey: true });
    expect(handlers.onSearch).not.toHaveBeenCalled();
  });

  it('⌘K still fires onSearch, and takes the chord unconditionally', () => {
    // ⌘K is an app chord, not a reserved one: it is bound everywhere, so it
    // preventDefaults even where onSearch found nothing to focus.
    (handlers.onSearch as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const ev = pressEvent({ key: 'k', metaKey: true });
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    expect(handlers.onSearch).toHaveBeenCalledWith('k');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('is listed in the cheat-sheet table', () => {
    expect(SHORTCUT_TABLE.some((r) => r.keys === '⌘ F')).toBe(true);
  });
});

describe('useShortcuts — G2 required chords', () => {
  it('⌘N opens new chat; ⌘⇧N opens new chat with the folder picker', () => {
    press({ key: 'n', metaKey: true });
    expect(handlers.onNewChat).toHaveBeenCalledTimes(1);
    expect(handlers.onNewChatPicker).not.toHaveBeenCalled();

    press({ key: 'N', metaKey: true, shiftKey: true });
    expect(handlers.onNewChatPicker).toHaveBeenCalledTimes(1);
    // ⌘⇧N must NOT also fire the plain ⌘N handler.
    expect(handlers.onNewChat).toHaveBeenCalledTimes(1);
  });

  it('⌘J jumps to oldest unread', () => {
    press({ key: 'j', metaKey: true });
    expect(handlers.onJumpOldestUnread).toHaveBeenCalledTimes(1);
  });

  it('⌘↑/⌘↓ step chats; ⌘⇧↑/⌘⇧↓ jump folder sections', () => {
    press({ key: 'ArrowUp', metaKey: true });
    press({ key: 'ArrowDown', metaKey: true });
    expect(handlers.onPrevChat).toHaveBeenCalledTimes(1);
    expect(handlers.onNextChat).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevFolder).not.toHaveBeenCalled();
    expect(handlers.onNextFolder).not.toHaveBeenCalled();

    press({ key: 'ArrowUp', metaKey: true, shiftKey: true });
    press({ key: 'ArrowDown', metaKey: true, shiftKey: true });
    expect(handlers.onPrevFolder).toHaveBeenCalledTimes(1);
    expect(handlers.onNextFolder).toHaveBeenCalledTimes(1);
    // Shifted arrows must NOT also step chats.
    expect(handlers.onPrevChat).toHaveBeenCalledTimes(1);
    expect(handlers.onNextChat).toHaveBeenCalledTimes(1);
  });

  it('routes the rest of the core chords', () => {
    press({ key: '?', metaKey: true });
    expect(handlers.onCheatSheet).toHaveBeenCalledTimes(1);
    press({ key: 'k', metaKey: true });
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    press({ key: '/', metaKey: true });
    expect(handlers.onToggleSidebar).toHaveBeenCalledTimes(1);
    press({ key: '1', metaKey: true });
    expect(handlers.onJumpManager).toHaveBeenCalledTimes(1);
    press({ key: '2', metaKey: true });
    expect(handlers.onToggleChannels).toHaveBeenCalledTimes(1);
    press({ key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(handlers.onArchiveCurrent).toHaveBeenCalledTimes(1);
    press({ key: 'a', metaKey: true, shiftKey: true });
    expect(handlers.onToggleArchived).toHaveBeenCalledTimes(1);
    press({ key: 'p', metaKey: true });
    expect(handlers.onFilePicker).toHaveBeenCalledTimes(1);
  });

  it('Ctrl variants work too (Linux/Windows binary swaps ⌘→⌃)', () => {
    press({ key: 'n', ctrlKey: true });
    expect(handlers.onNewChat).toHaveBeenCalledTimes(1);
    press({ key: 'j', ctrlKey: true });
    expect(handlers.onJumpOldestUnread).toHaveBeenCalledTimes(1);
  });
});

// spec/14 § Panes and tabs — close/switch/split chords.
describe('useShortcuts — panes and tabs chords', () => {
  it('⌘W closes the active tab', () => {
    press({ key: 'w', metaKey: true });
    expect(handlers.onCloseTab).toHaveBeenCalledTimes(1);
  });

  it('⌘W is claimed unconditionally — a reserved chord like ⌘P, not a chat-view one — so it never falls through to the OS and closes the real window', () => {
    cleanup();
    handlers = makeHandlers();
    render(<Harness handlers={handlers} isChatView={false} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const ev = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'w',
      metaKey: true,
    });
    input.dispatchEvent(ev);
    expect(handlers.onCloseTab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    document.body.removeChild(input);
  });

  it('⌘⌥←/→ switch tabs, and do not also fire plain ⌘←/⌘→ nav or ⌘↑/⌘↓ chat-step', () => {
    press({ key: 'ArrowLeft', metaKey: true, altKey: true });
    press({ key: 'ArrowRight', metaKey: true, altKey: true });
    expect(handlers.onPrevTab).toHaveBeenCalledTimes(1);
    expect(handlers.onNextTab).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevChat).not.toHaveBeenCalled();
    expect(handlers.onNextChat).not.toHaveBeenCalled();
  });

  it('⌘\\ splits the active pane', () => {
    press({ key: '\\', metaKey: true });
    expect(handlers.onSplitPane).toHaveBeenCalledTimes(1);
  });

  it('all three are listed in the cheat-sheet table', () => {
    expect(SHORTCUT_TABLE.some((r) => r.keys === '⌘ W')).toBe(true);
    expect(SHORTCUT_TABLE.some((r) => r.keys === '⌘ ⌥ ← / ⌘ ⌥ →')).toBe(true);
    expect(SHORTCUT_TABLE.some((r) => r.keys === '⌘ \\')).toBe(true);
  });
});

// spec/14 § Discoverability — the chat-list chords fire only while a chat
// view is showing (Jobs, the job editor, Settings and the file editor get
// nothing special from them), and a text field keeps its native keys.
describe('useShortcuts — chat-view scope', () => {
  function fire(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  }

  /** Tears down the default (isChatView: true) render from `beforeEach` and
   *  replaces it with one carrying the scope this test needs — two mounted
   *  Harnesses would both answer the same keydown. */
  function renderWithScope(isChatView: boolean): void {
    cleanup();
    handlers = makeHandlers();
    render(<Harness handlers={handlers} isChatView={isChatView} />);
  }

  const CHAT_CHORDS: Array<{ name: keyof ShortcutHandlers; init: KeyboardEventInit }> = [
    { name: 'onPrevChat', init: { key: 'ArrowUp', metaKey: true } },
    { name: 'onNextChat', init: { key: 'ArrowDown', metaKey: true } },
    { name: 'onPrevFolder', init: { key: 'ArrowUp', metaKey: true, shiftKey: true } },
    { name: 'onNextFolder', init: { key: 'ArrowDown', metaKey: true, shiftKey: true } },
    { name: 'onJumpManager', init: { key: '1', metaKey: true } },
    { name: 'onToggleChannels', init: { key: '2', metaKey: true } },
    { name: 'onJumpOldestUnread', init: { key: 'j', metaKey: true } },
    { name: 'onToggleArchived', init: { key: 'a', metaKey: true, shiftKey: true } },
    { name: 'onArchiveCurrent', init: { key: 'å', code: 'KeyA', metaKey: true, altKey: true } },
  ];

  for (const chord of CHAT_CHORDS) {
    it(`${chord.name} fires while a chat view is showing`, () => {
      renderWithScope(true);
      fire(chord.init);
      expect(handlers[chord.name]).toHaveBeenCalledTimes(1);
    });

    it(`${chord.name} does NOT fire outside a chat view (Jobs, job editor, Settings, file editor)`, () => {
      renderWithScope(false);
      const ev = fire(chord.init);
      expect(handlers[chord.name]).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    });

    it(`${chord.name} does NOT fire from a non-composer text field, even in a chat view`, () => {
      renderWithScope(true);
      const input = document.createElement('input');
      document.body.appendChild(input);
      const ev = fire(chord.init, input);
      expect(handlers[chord.name]).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
      document.body.removeChild(input);
    });
  }

  // spec/14 § Panes and tabs — ⌘⌥←/→ and ⌘\ are chat-view scoped like the
  // chords above, but NOT ceded to a focused text field: opening a chat
  // focuses the composer by default (spec/14 § Composer), and none of these
  // collide with a field's own editing keys.
  const PANE_CHORDS_IGNORE_TEXT_FIELDS: Array<{
    name: keyof ShortcutHandlers;
    init: KeyboardEventInit;
  }> = [
    { name: 'onPrevTab', init: { key: 'ArrowLeft', metaKey: true, altKey: true } },
    { name: 'onNextTab', init: { key: 'ArrowRight', metaKey: true, altKey: true } },
    { name: 'onSplitPane', init: { key: '\\', metaKey: true } },
  ];

  for (const chord of PANE_CHORDS_IGNORE_TEXT_FIELDS) {
    it(`${chord.name} fires while a chat view is showing`, () => {
      renderWithScope(true);
      fire(chord.init);
      expect(handlers[chord.name]).toHaveBeenCalledTimes(1);
    });

    it(`${chord.name} does NOT fire outside a chat view`, () => {
      renderWithScope(false);
      const ev = fire(chord.init);
      expect(handlers[chord.name]).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    });

    it(`${chord.name} fires even from the composer (opening a chat focuses it by default)`, () => {
      renderWithScope(true);
      const composer = document.createElement('textarea');
      composer.setAttribute('data-testid', 'composer-input');
      document.body.appendChild(composer);
      const ev = fire(chord.init, composer);
      expect(handlers[chord.name]).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(true);
      document.body.removeChild(composer);
    });

    it(`${chord.name} fires even from an ordinary text field`, () => {
      renderWithScope(true);
      const input = document.createElement('input');
      document.body.appendChild(input);
      const ev = fire(chord.init, input);
      expect(handlers[chord.name]).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(true);
      document.body.removeChild(input);
    });
  }

  it('⌘↑/⌘↓ do NOT fire from the chat composer — the caret moves to start/end as in any text box', () => {
    renderWithScope(true);
    const composer = document.createElement('textarea');
    composer.setAttribute('data-testid', 'composer-input');
    document.body.appendChild(composer);
    const up = fire({ key: 'ArrowUp', metaKey: true }, composer);
    const down = fire({ key: 'ArrowDown', metaKey: true }, composer);
    expect(handlers.onPrevChat).not.toHaveBeenCalled();
    expect(handlers.onNextChat).not.toHaveBeenCalled();
    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    document.body.removeChild(composer);
  });

  it('⌘⇧↑ (folders) does NOT fire from the composer', () => {
    renderWithScope(true);
    const composer = document.createElement('textarea');
    composer.setAttribute('data-testid', 'composer-input');
    document.body.appendChild(composer);
    const ev = fire({ key: 'ArrowUp', metaKey: true, shiftKey: true }, composer);
    expect(handlers.onPrevFolder).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    document.body.removeChild(composer);
  });

  // The job editor's prompt field is a plain `<textarea>` on a non-chat
  // route — doubly excluded (wrong view AND a text field) — but the concrete
  // case Tom hit is enough on its own: ⌘↑ there must move the caret, not step
  // chats.
  it('⌘↑ in a job-editor-shaped prompt field moves the caret and does not navigate (not a chat view)', () => {
    renderWithScope(false);
    const prompt = document.createElement('textarea');
    prompt.setAttribute('data-testid', 'job-spawn-prompt');
    document.body.appendChild(prompt);
    const ev = fire({ key: 'ArrowUp', metaKey: true }, prompt);
    expect(handlers.onPrevChat).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    document.body.removeChild(prompt);
  });

  it('isChatViewPath: chat routes are true, everything else false', () => {
    expect(isChatViewPath('/')).toBe(true);
    expect(isChatViewPath('/chats/new')).toBe(true);
    expect(isChatViewPath('/chats/abc123')).toBe(true);
    expect(isChatViewPath('/chats/abc123/editor-window')).toBe(false);
    expect(isChatViewPath('/jobs')).toBe(false);
    expect(isChatViewPath('/jobs/abc')).toBe(false);
    expect(isChatViewPath('/settings')).toBe(false);
    expect(isChatViewPath('/settings/voice')).toBe(false);
  });

  it('the cheat sheet labels every chat-scoped row "Chat view"', () => {
    const chatViewRows = SHORTCUT_TABLE.filter((r) =>
      ['⌘ ↑ / ⌘ ↓', '⌘ ⇧ ↑ / ⌘ ⇧ ↓', '⌘ 1', '⌘ 2', '⌘ J', '⌘ ⌥ A', '⌘ ⇧ A'].includes(r.keys),
    );
    expect(chatViewRows).toHaveLength(7);
    for (const row of chatViewRows) {
      expect(shortcutScopeLabel(row.scope)).toBe('Chat view');
    }
  });
});

describe('useShortcuts — quote / voice / editor chords', () => {
  it("⌘' opens the diff viewer; ⌘⇧' opens the file browser", () => {
    press({ code: 'Quote', metaKey: true });
    expect(handlers.onDiffViewer).toHaveBeenCalledTimes(1);
    expect(handlers.onFileBrowser).not.toHaveBeenCalled();

    press({ code: 'Quote', metaKey: true, shiftKey: true });
    expect(handlers.onFileBrowser).toHaveBeenCalledTimes(1);
  });

  it("matches the quote key by e.key when e.code isn't 'Quote' (layout fallback)", () => {
    press({ key: "'", metaKey: true });
    expect(handlers.onDiffViewer).toHaveBeenCalledTimes(1);
    press({ key: '"', metaKey: true, shiftKey: true });
    expect(handlers.onFileBrowser).toHaveBeenCalledTimes(1);
  });

  it('⌘⇧D (hold) starts dictation; releasing D ends it', () => {
    press({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    expect(handlers.onVoiceHoldStart).toHaveBeenCalledTimes(1);
    // Holding the key down again (repeat) must not re-fire the start handler.
    press({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    expect(handlers.onVoiceHoldStart).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'D', code: 'KeyD', bubbles: true }));
    expect(handlers.onVoiceHoldEnd).toHaveBeenCalledTimes(1);
  });

  it('keyup for D when not held is a no-op', () => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'D', code: 'KeyD', bubbles: true }));
    expect(handlers.onVoiceHoldEnd).not.toHaveBeenCalled();
  });

  it('⌘; no longer dictates', () => {
    press({ key: ';', code: 'Semicolon', metaKey: true });
    expect(handlers.onVoiceHoldStart).not.toHaveBeenCalled();
  });

  it('⌘D without ⇧ is not the dictate chord', () => {
    press({ key: 'd', code: 'KeyD', metaKey: true });
    expect(handlers.onVoiceHoldStart).not.toHaveBeenCalled();
  });

  it('a rebound dictate chord takes over, even one a built-in shortcut uses', () => {
    useUiStore.getState().setDictateChord({ alt: false, shift: false, code: 'KeyK' });
    press({ key: 'k', code: 'KeyK', metaKey: true });
    expect(handlers.onVoiceHoldStart).toHaveBeenCalledTimes(1);
    expect(handlers.onSearch).not.toHaveBeenCalled();
    press({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    expect(handlers.onVoiceHoldStart).toHaveBeenCalledTimes(1);
  });

  it('⌃Space (hold) starts global voice; releasing Space ends it', () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, bubbles: true }),
    );
    expect(handlers.onGlobalVoiceStart).toHaveBeenCalledTimes(1);
    // Repeat keydown while held must not re-fire.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, bubbles: true }),
    );
    expect(handlers.onGlobalVoiceStart).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    expect(handlers.onGlobalVoiceEnd).toHaveBeenCalledTimes(1);
  });

  it('keyup for Space when not held is a no-op', () => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    expect(handlers.onGlobalVoiceEnd).not.toHaveBeenCalled();
  });

  // The end handlers report HOW LONG the key was held so the voice layer can
  // tell a chord tap from a genuine press-and-hold (spec/07 § mode 1).
  it('the voice end handlers report the held duration', () => {
    vi.useFakeTimers();
    try {
      press({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
      vi.advanceTimersByTime(900);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'D', code: 'KeyD', bubbles: true }));
      expect(handlers.onVoiceHoldEnd).toHaveBeenCalledWith(900);

      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, bubbles: true }),
      );
      vi.advanceTimersByTime(40);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
      expect(handlers.onGlobalVoiceEnd).toHaveBeenCalledWith(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // macOS does not deliver the keyup for a character key while ⌘ is still down,
  // so the modifier's own release is the end of the chord. Without this a ⌘⇧D
  // dictation would be left recording with no way to commit it.
  it('releasing the modifier ends a held voice chord', () => {
    press({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
    expect(handlers.onVoiceHoldEnd).toHaveBeenCalledTimes(1);
    // The lost D keyup arriving later must not end it a second time.
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'D', code: 'KeyD', bubbles: true }));
    expect(handlers.onVoiceHoldEnd).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, bubbles: true }),
    );
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    expect(handlers.onGlobalVoiceEnd).toHaveBeenCalledTimes(1);
  });

  it('⌥E (either case) toggles the editor rail, without requiring ⌘/⌃', () => {
    press({ key: 'e', altKey: true });
    expect(handlers.onToggleEditor).toHaveBeenCalledTimes(1);
    press({ key: 'E', altKey: true });
    expect(handlers.onToggleEditor).toHaveBeenCalledTimes(2);
  });

  // spec/14 § Reserved OS chords — ⌘A is select-all, everywhere.
  it('⌘A inside an editable element is left alone (native select-all)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    // Dispatch directly on the input so `e.target` is the input element (the
    // global window listener still receives it via bubbling).
    const evt = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(evt);
    expect(handlers.onArchiveCurrent).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
    document.body.removeChild(input);
  });

  it('⌘A over the transcript (non-editable) selects all text — it must NOT archive', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const evt = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    div.dispatchEvent(evt);
    expect(handlers.onArchiveCurrent).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
    document.body.removeChild(div);
  });

  it('⌃A (Linux/Windows select-all) is left alone too', () => {
    const evt = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(evt);
    expect(handlers.onArchiveCurrent).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  it('⌘⌥A archives the current chat (macOS reports ⌥A as "å", so match on e.code)', () => {
    press({ key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(handlers.onArchiveCurrent).toHaveBeenCalledTimes(1);
    // …and on layouts that report a plain 'a'.
    press({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true });
    expect(handlers.onArchiveCurrent).toHaveBeenCalledTimes(2);
  });

  it('removes both keydown and keyup listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Harness handlers={handlers} />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('keyup', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('an unhandled key combination does not call any handler', () => {
    press({ key: 'z' });
    for (const fn of Object.values(handlers)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('⌃` toggles the terminal drawer (spec/14 § Terminal)', () => {
    const h = makeHandlers();
    render(<Harness handlers={h} />);
    press({ key: '`', ctrlKey: true });
    expect(h.onToggleTerminal).toHaveBeenCalledTimes(1);
    // A bare backtick is just typing — it must not open a shell.
    press({ key: '`' });
    expect(h.onToggleTerminal).toHaveBeenCalledTimes(1);
  });
});

describe('SHORTCUT_TABLE — cheat-sheet coverage', () => {
  it('lists the G2-required chords for discoverability', () => {
    const keys = SHORTCUT_TABLE.map((e) => e.keys);
    expect(keys).toContain('⌘ ⇧ N');
    expect(keys).toContain('⌘ J');
    expect(keys).toContain('⌘ ⇧ ↑ / ⌘ ⇧ ↓');
    expect(keys).toContain('⌃ `');
  });
});
