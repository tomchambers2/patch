// ContextRing — how full the open chat's context window is, as a ring just left
// of Send (spec/14 § Composer — context ring). Pressing it opens the usage
// popover. Drawn only once the host has measured the chat: an empty ring
// would read as an empty window, which nobody has measured.

import { useRef, useState, type JSX } from 'react';
import { useChatStore } from '../stores/chatStore.js';
import { summariseContext } from '../lib/usage.js';
import { UsagePopover } from './UsagePopover.js';

const R = 8;
const C = 2 * Math.PI * R;

export function ContextRing({ chatId }: { chatId: string }): JSX.Element | null {
  const context = useChatStore((s) => s.chats[chatId]?.context ?? null);
  const ctx = summariseContext(context);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!ctx) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`context-ring ${ctx.level}`}
        data-testid="context-ring"
        aria-label={`Context ${ctx.percent}`}
        aria-expanded={open}
        title={`Context ${ctx.percent} · ${ctx.tokens}`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
          <circle className="context-ring-track" cx="11" cy="11" r={R} />
          <circle
            className="context-ring-fill"
            cx="11"
            cy="11"
            r={R}
            strokeDasharray={C}
            strokeDashoffset={C * (1 - ctx.fraction)}
            transform="rotate(-90 11 11)"
          />
        </svg>
      </button>
      {open ? (
        <UsagePopover
          anchorRef={ref}
          direction="up"
          align="end"
          context={context}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
