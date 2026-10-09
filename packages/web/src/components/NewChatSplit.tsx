// NewChatSplit — `+ New chat` and its caret as one segmented button (spec/14 §
// Sidebar §8, § New windows). The wide segment starts the chat in this window;
// the caret segment opens a one-item dropdown holding New chat in new window.

import { useEffect, useRef, useState, type JSX } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { shortcutLabel } from '../lib/shortcuts.js';

export function NewChatSplit({
  onNewChat,
  onNewWindow,
}: {
  onNewChat: () => void;
  onNewWindow: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useDismissOnClickOff(open, [menuRef, toggleRef], () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span className="new-chat-row" data-testid="new-chat-row">
      <button
        type="button"
        className="new-chat-fab"
        data-testid="new-chat-fab"
        title={shortcutLabel('⌘N')}
        onClick={onNewChat}
      >
        + New chat
      </button>
      <button
        type="button"
        ref={toggleRef}
        className="new-chat-split-toggle"
        data-testid="new-chat-split-toggle"
        aria-label="New chat options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="new-chat-split-menu"
          role="menu"
          data-testid="new-chat-split-menu"
        >
          <button
            type="button"
            role="menuitem"
            className="new-chat-split-item"
            data-testid="new-chat-in-new-window"
            onClick={() => {
              setOpen(false);
              onNewWindow();
            }}
          >
            <ExternalLink size={14} aria-hidden />
            New chat in new window
          </button>
        </div>
      ) : null}
    </span>
  );
}
