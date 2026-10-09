// SnoozeMenu — the chat header's snooze control (spec/04 § Snooze, spec/14
// § Chat panel header → Snooze). patch/todo.md: "ability to snooze a chat for
// 2, 5, 30, 1 hour, 1 day, next week or custom amount of time, like in gmail".
//
// A clock icon opening an anchored menu of wake times. Most presets are a
// delta ("5 minutes"); two ("5pm", "Tomorrow 8am") are wall-clock targets.
// Every preset is resolved into an absolute timestamp at the moment it's
// chosen (`../lib/snoozePresets.js`, shared with ProjectSnoozeMenu) — the
// host only ever stores an absolute `snoozedUntil`, so a slow request can't
// drift the wake time. The flip is optimistic and reverts on failure with a
// toast (NO FALLBACK).

import { useEffect, useRef, useState, type JSX } from 'react';
import { Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { isSnoozed } from '../stores/types.js';
import type { ChatRow } from '../stores/types.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { SNOOZE_PRESETS as PRESETS, formatWakeTime } from '../lib/snoozePresets.js';
import { failed } from '../lib/errorCopy.js';
import { navigateAfterArchive } from '../lib/archiveNav.js';

export { formatWakeTime };

// With `label`, the trigger is a whole-row menu item (icon + text, the same
// `.head-menu-item` its siblings in the ⋯ / hamburger menus use) so the word
// is as clickable as the clock; without it, the icon-only header button.
export function SnoozeMenu({
  row,
  iconSize,
  label,
}: {
  row: ChatRow;
  iconSize: number;
  label?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const setSnoozed = useChatStore((s) => s.setSnoozed);
  const pushError = useUiStore((s) => s.pushError);
  const navigate = useNavigate();
  const snoozed = isSnoozed(row);

  useDismissOnClickOff(open, [menuRef, triggerRef], () => close());

  // Esc closes the menu, wherever focus is (spec/14 § Dismissing pop-ups).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      setOpen(false);
      setCustomOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function close(): void {
    setOpen(false);
    setCustomOpen(false);
  }

  async function apply(snoozedUntil: number | null): Promise<void> {
    const previous = row.snoozedUntil;
    close();
    // Snoozing takes the chat off the list, so move on like archive does —
    // resolved before the flip, while this chat is still in the list.
    if (snoozedUntil !== null) navigateAfterArchive(navigate, [row.chatId]);
    setSnoozed(row.chatId, snoozedUntil);
    try {
      await api.snoozeChat(row.chatId, snoozedUntil);
    } catch (err) {
      setSnoozed(row.chatId, previous);
      pushError(failed('snooze'), undefined, (err as Error).message);
    }
  }

  function submitCustom(): void {
    // `datetime-local` gives a LOCAL wall-clock string; Date parses it in the
    // user's own zone, which is what "snooze until 9am" means to them.
    const at = new Date(customValue).getTime();
    if (Number.isNaN(at)) {
      pushError('snooze: pick a date and time');
      return;
    }
    if (at <= Date.now()) {
      // NO FALLBACK — a past time is not quietly rounded up to "now".
      pushError('snooze: pick a time in the future');
      return;
    }
    void apply(at);
  }

  return (
    <span className={label ? 'snooze-wrap snooze-wrap-row' : 'snooze-wrap'}>
      <button
        type="button"
        ref={triggerRef}
        className={`${label ? 'head-menu-item' : 'head-action'} ${snoozed ? 'is-snoozed' : ''}`}
        role={label ? 'menuitem' : undefined}
        data-testid="action-snooze"
        aria-label={snoozed ? 'Snoozed' : 'Snooze chat'}
        aria-expanded={open}
        title={snoozed ? `Snoozed until ${formatWakeTime(row.snoozedUntil!)}` : 'Snooze'}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Clock size={iconSize} aria-hidden />
        {label}
      </button>
      {open ? (
        <div className="snooze-menu" data-testid="snooze-menu" role="menu" ref={menuRef}>
          {snoozed ? (
            <button
              type="button"
              className="snooze-option"
              data-testid="snooze-unsnooze"
              role="menuitem"
              onClick={() => void apply(null)}
            >
              Unsnooze
            </button>
          ) : null}
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="snooze-option"
              data-testid={`snooze-preset-${p.id}`}
              role="menuitem"
              onClick={() => void apply(p.resolve())}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="snooze-option"
            data-testid="snooze-preset-custom"
            role="menuitem"
            onClick={() => setCustomOpen(true)}
          >
            Custom…
          </button>
          {customOpen ? (
            <div className="snooze-custom">
              <input
                type="datetime-local"
                className="snooze-custom-input"
                data-testid="snooze-custom-input"
                aria-label="snooze until"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
              />
              <button
                type="button"
                className="snooze-custom-submit"
                data-testid="snooze-custom-submit"
                onClick={submitCustom}
              >
                Snooze
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
