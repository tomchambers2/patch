// SidebarViewMenu — the sidebar's ONE view dropdown (spec/14 § Sidebar §1b),
// directly under the brand row. Replaces three former controls: the Chats/
// Batch tab switch, the state-filter select, and the Needs attention toggle
// — each of which owned one piece of "what does the list show" and competed
// for the same strip of fixed-band height. Picking an option here filters
// the list to exactly one thing; the Unread option keeps the old Needs
// attention toggle's behaviour (including holding the chat you're looking
// at — Sidebar.tsx owns that, unchanged, off the same `attentionOnly` flag).
//
// A pill + pop-up control, the same shape as the folder/model pickers
// (spec/14 § New-chat setup row → folder picker, § Model selector) rather
// than a native `<select>`: Batch needs to carry its member count the way its
// old tab did, which a `<select>`'s plain-text options can't draw.

import { useEffect, useRef, useState, type JSX } from 'react';
import { ChevronDown } from 'lucide-react';
import { useBatchStore } from '../stores/batchStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { CHAT_SORTS, type ChatSort } from '../lib/chatGroups.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import {
  applySidebarView,
  sidebarViewFrom,
  sidebarViewTriggerLabel,
  SIDEBAR_VIEW_OPTIONS,
  type SidebarView,
} from '../lib/sidebarView.js';

export function SidebarViewMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const mode = useBatchStore((s) => s.mode);
  const setMode = useBatchStore((s) => s.setMode);
  // spec/14 § Batch mode: "the count on the `Batch` option reflects the
  // current size" — the server's own membership count, the same the batch
  // view lists.
  const memberCount = useBatchStore((s) => s.batch?.members.length ?? 0);

  const attentionOnly = useUiStore((s) => s.attentionOnly);
  const setAttentionOnly = useUiStore((s) => s.setAttentionOnly);
  const stateFilter = useUiStore((s) => s.stateFilter);
  const setStateFilter = useUiStore((s) => s.setStateFilter);

  const chatSort = useUiStore((s) => s.chatSort);
  const setChatSort = useUiStore((s) => s.setChatSort);
  const groupSort = useUiStore((s) => s.groupSort);
  const setGroupSort = useUiStore((s) => s.setGroupSort);

  const view = sidebarViewFrom(mode === 'batch', attentionOnly, stateFilter);

  useDismissOnClickOff(open, [menuRef, triggerRef], () => setOpen(false));

  // Esc closes the menu (spec/14 § Dismissing pop-ups (click-off)).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function choose(next: SidebarView): void {
    applySidebarView(next, {
      setBatchMode: (on) => setMode(on ? 'batch' : 'regular'),
      setAttentionOnly,
      setStateFilter,
    });
    setOpen(false);
  }

  return (
    <div className="sidebar-view-menu" data-testid="sidebar-view-menu">
      <button
        type="button"
        ref={triggerRef}
        className={`sidebar-view-trigger ${view !== 'all' ? 'active' : ''}`}
        data-testid="sidebar-view-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sidebar-view-trigger-label">{sidebarViewTriggerLabel(view)}</span>
        <ChevronDown size={14} aria-hidden className="sidebar-view-caret" />
      </button>
      {open ? (
        <div
          className="sidebar-view-popup"
          data-testid="sidebar-view-popup"
          role="listbox"
          aria-label="Sidebar view"
          ref={menuRef}
        >
          {SIDEBAR_VIEW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === view}
              className={`sidebar-view-option ${opt.value === view ? 'selected' : ''}`}
              data-testid={`sidebar-view-option-${opt.value}`}
              onClick={() => choose(opt.value)}
            >
              <span className="sidebar-view-option-label">{opt.label}</span>
              {opt.value === 'batch' && memberCount > 0 ? (
                <span className="sidebar-view-option-count" data-testid="sidebar-view-batch-count">
                  {memberCount}
                </span>
              ) : null}
              {opt.value === view ? (
                <span className="sidebar-view-option-check" aria-hidden>
                  ✓
                </span>
              ) : null}
            </button>
          ))}
          <SortGroup id="chat-sort" title="Sort chats by" value={chatSort} onPick={setChatSort} />
          <SortGroup
            id="group-sort"
            title="Sort projects by"
            value={groupSort}
            onPick={setGroupSort}
          />
        </div>
      ) : null}
    </div>
  );
}

function SortGroup(props: {
  id: string;
  title: string;
  value: ChatSort;
  onPick(v: ChatSort): void;
}): JSX.Element {
  return (
    <div role="group" aria-label={props.title} data-testid={`sidebar-${props.id}`}>
      <div className="sidebar-view-option-label" style={{ opacity: 0.6, padding: '6px 10px 2px' }}>
        {props.title}
      </div>
      {CHAT_SORTS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="option"
          aria-selected={opt.value === props.value}
          className={`sidebar-view-option ${opt.value === props.value ? 'selected' : ''}`}
          data-testid={`sidebar-${props.id}-${opt.value}`}
          onClick={() => props.onPick(opt.value)}
        >
          <span className="sidebar-view-option-label">{opt.label}</span>
          {opt.value === props.value ? (
            <span className="sidebar-view-option-check" aria-hidden>
              ✓
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
