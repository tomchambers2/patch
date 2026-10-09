// ProjectSnoozeMenu — the folder header's "Snooze all in project" control
// (spec/04 § Snooze, spec/14 § Sidebar → Folders). Todoist: "patch ability to
// snooze a whole workspace" — the project-wide sibling of SnoozeMenu's
// per-chat control, sharing its preset list and wake-time formatting
// (`../lib/snoozePresets.js`) so the two can never disagree about what "5pm"
// or "next week" means.
//
// Unlike the folder header's two archive buttons, snooze has only ONE
// variant: archive splits "as listed" from "all in project" because a chat
// can survive archiving-as-listed by living in the Pinned/Snoozed sections —
// leaving it out reads as the archive having silently failed. Snoozing an
// already-snoozed chat is not a bug the same way, and "whole workspace" is
// what was asked for, so this reaches every chat `archiveAllInProject` would:
// `chatsInProject` (folder match, non-special, not already archived/deleted).
import { useEffect, useRef, useState, type JSX } from 'react';
import { Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { chatsInProject } from '../lib/chatGroups.js';
import { SNOOZE_PRESETS } from '../lib/snoozePresets.js';
import { failed } from '../lib/errorCopy.js';
import { navigateAfterArchive } from '../lib/archiveNav.js';

export function ProjectSnoozeMenu({ folder, name }: { folder: string; name: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pushError = useUiStore((s) => s.pushError);
  const navigate = useNavigate();

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

  /** Optimistic flip + REST per chat, each reverting on its own failure (NO
   * FALLBACK) — the same shape `archiveAllInProject` applies across a project. */
  function apply(snoozedUntil: number): void {
    close();
    const targets = chatsInProject(Object.values(useChatStore.getState().chats), folder);
    const store = useChatStore.getState();
    navigateAfterArchive(
      navigate,
      targets.map((c) => c.chatId),
    );
    for (const c of targets) {
      const previous = c.snoozedUntil;
      store.setSnoozed(c.chatId, snoozedUntil);
      void api.snoozeChat(c.chatId, snoozedUntil).catch((err) => {
        useChatStore.getState().setSnoozed(c.chatId, previous);
        pushError(failed('snooze'), undefined, (err as Error).message);
      });
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
    apply(at);
  }

  return (
    <span className="snooze-wrap">
      <button
        type="button"
        ref={triggerRef}
        className="folder-archive-btn"
        data-testid={`folder-snooze-${folder}`}
        title="Snooze all"
        aria-label={`snooze all in project ${name}`}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Clock size={13} aria-hidden />
      </button>
      {open ? (
        <div className="snooze-menu" data-testid="project-snooze-menu" role="menu" ref={menuRef}>
          {SNOOZE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="snooze-option"
              data-testid={`project-snooze-preset-${p.id}`}
              role="menuitem"
              onClick={() => apply(p.resolve())}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="snooze-option"
            data-testid="project-snooze-preset-custom"
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
                data-testid="project-snooze-custom-input"
                aria-label="snooze all until"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
              />
              <button
                type="button"
                className="snooze-custom-submit"
                data-testid="project-snooze-custom-submit"
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
