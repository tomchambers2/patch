// InlineEditText — click-to-edit single-line text (spec/14 § Main chat panel).
// Used by the goal bar and by every row of the task bar, which share one set of
// rules: click the text to edit it, Enter (or blurring away) commits, Escape
// reverts. Empty or unchanged text commits nothing — clearing is a separate,
// explicit control (the × on the row), never a side effect of deleting text.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';

export function InlineEditText({
  value,
  onCommit,
  className,
  editLabel,
  testId,
}: {
  value: string;
  /** Called with the new text. Only fires when it actually changed. */
  onCommit: (next: string) => void;
  className: string;
  /** Accessible name for the read-mode button and the input. */
  editLabel: string;
  testId: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Escape must revert, but it also blurs the input — without this the blur
  // handler would commit the very text Escape just discarded.
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function start(): void {
    setDraft(value);
    cancelled.current = false;
    setEditing(true);
  }

  function commit(): void {
    setEditing(false);
    if (cancelled.current) return;
    const next = draft.trim();
    if (next === '' || next === value) return;
    onCommit(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelled.current = true;
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`${className} inline-edit-input`}
        data-testid={`${testId}-input`}
        aria-label={editLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    );
  }

  return (
    <button
      type="button"
      className={`${className} inline-edit-read`}
      data-testid={testId}
      aria-label={editLabel}
      title={editLabel}
      onClick={start}
    >
      {value}
    </button>
  );
}
