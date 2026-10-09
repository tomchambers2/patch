// Deciding what a tray-icon click should do — the menu-bar open/close toggle.
//
// The tray popover auto-hides when it loses focus (main.ts wires a `blur`
// handler with a short grace timer). Clicking the tray icon while the popover
// is open ALSO blurs it, so a naive `isVisible() ? hide() : show()` toggle
// races: the blur-driven hide can land just before OR just after the click
// handler reads isVisible(). When it lands first, isVisible() is already false
// and the click RE-SHOWS a popover the user was trying to close — the reported
// "Second click of Patch menu bar opens it" bug (patch/todo.md).
//
// The fix is to treat a click that arrives while the popover is visible, OR
// within a short window of it being hidden, as "the user is closing it". This
// decision is a pure function of the current state so it can be unit-tested
// WITHOUT booting Electron (see tray-toggle.test.ts); main.ts feeds it the live
// isVisible()/hiddenAt and acts on the result.

export type TrayClickAction = 'show' | 'hide' | 'noop';

export interface TrayClickState {
  /** Is the popover currently visible? */
  visible: boolean;
  /** Date.now() at the last hide (0 if it has never been hidden). */
  hiddenAt: number;
  /** Current time (Date.now()). */
  now: number;
  /**
   * How long after a hide a tray click still counts as "closing" rather than
   * "reopening". Must exceed the blur grace period (200ms in main.ts) so the
   * hide caused by THIS click can never be mistaken for the user reopening.
   * Defaults to 300ms.
   */
  recentHideMs?: number;
}

/**
 * Decide whether a tray-icon click should show, hide, or do nothing.
 *
 *  - visible                          → 'hide'  (close it)
 *  - hidden, but hidden <recentHideMs ago → 'noop' (this click's own blur
 *                                            already closed it — don't reopen)
 *  - hidden, hidden long ago / never  → 'show'  (open it)
 */
export function decideTrayClick(state: TrayClickState): TrayClickAction {
  const recentHideMs = state.recentHideMs ?? 300;
  if (state.visible) return 'hide';
  if (state.hiddenAt > 0 && state.now - state.hiddenAt < recentHideMs) {
    return 'noop';
  }
  return 'show';
}
