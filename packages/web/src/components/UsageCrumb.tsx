// UsageCrumb — the New chat header's usage bar (spec/14 § Chat panel header →
// New chat §8 New-chat setup row): how much of the account this chat will run
// on is left. No text, just a bar — the figures are one press away in the
// usage popover. Account-level, not chat-level, so it means something before
// the chat exists too, unlike the composer's context ring (which needs a
// measured chat and so has nothing to show pre-send) — the one place this
// still earns its keep now that a LIVE chat's header carries no usage bar of
// its own (that one relies on the composer's ring instead).

import { useRef, useState, type JSX } from 'react';
import { summariseUsage } from '../lib/usage.js';
import { UsagePopover } from './UsagePopover.js';
import type { ChatContextUsage } from '@patch/wire';

export function UsageCrumb({
  summary,
  context,
}: {
  summary: NonNullable<ReturnType<typeof summariseUsage>>;
  context: ChatContextUsage | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`chat-usage-crumb ${summary.level}`}
        data-testid="chat-usage"
        aria-label={summary.text}
        title={summary.title}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-usage-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(summary.fraction * 100)}%` }} />
        </span>
      </button>
      {open ? (
        <UsagePopover
          anchorRef={ref}
          direction="down"
          align="start"
          context={context}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
