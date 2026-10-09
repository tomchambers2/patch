// The pieces the Usage page's account lists share: the ranked, draggable list,
// the usage bars, and the ⋯ menu.
//
// An account list's ORDER is its priority (accountFailover.ts): under the
// priority strategy the first account with credit takes the turn. So the list
// is ranked, and dragging one row above another sends the whole new order to
// the server, which holds the accounts for every host (spec/01 § Settings).
// The order shown is always the committed one — a drag shows its result only
// until the server answers.

import type { JSX, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { rateLimitWindowBlocks, type RateLimitWindow } from '@patch/wire';
import {
  EXTRA_USAGE_OFF_TEXT,
  OVERAGE_DISABLED_REASON,
  formatReset,
  formatResetDetail,
  formatUntil,
  formatUtilization,
} from '../../lib/usage.js';

export interface RankedItem {
  id: string;
  render: (handle: ReactNode, rank: number) => ReactNode;
}

/**
 * A list whose order is the accounts' priority. `onCommit` writes a new order
 * and resolves once the server has answered, whatever it said; the list then
 * shows the committed order.
 */
export function RankedList({
  items,
  testid,
  onCommit,
}: {
  items: RankedItem[];
  testid: string;
  onCommit: (next: string[]) => Promise<boolean>;
}): JSX.Element {
  const reported = items.map((i) => i.id);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [pending, setPending] = useState<object | null>(null);
  const dragging = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const order = (draft ?? reported).filter((id) => reported.includes(id));
  const byId = new Map(items.map((i) => [i.id, i]));

  function commit(next: string[]): void {
    if (next.join('\n') === reported.join('\n')) {
      setDraft(null);
      return;
    }
    setDraft(next);
    setPending({});
    void onCommit(next).finally(() => {
      setPending(null);
      setDraft(null);
    });
  }

  function move(id: string, to: number): string[] {
    const without = order.filter((x) => x !== id);
    without.splice(Math.max(0, Math.min(to, without.length)), 0, id);
    return without;
  }

  return (
    <div className="set-ranked" data-testid={testid} data-pending={pending ? 'true' : undefined}>
      {order.map((id, index) => {
        const item = byId.get(id);
        if (!item) return null;
        const handle = (
          <button
            type="button"
            className="set-handle"
            aria-label={`Move ${index + 1} of ${order.length}`}
            title="Drag to reorder"
            data-testid={`${testid}-handle-${id}`}
            disabled={pending !== null}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              const to = e.key === 'ArrowUp' ? index - 1 : index + 1;
              if (to < 0 || to >= order.length) return;
              commit(move(id, to));
            }}
          >
            ⠿
          </button>
        );
        return (
          <div
            key={id}
            className={`set-ranked-item${draggingId === id ? ' dragging' : ''}`}
            draggable={pending === null}
            data-testid={`${testid}-item-${id}`}
            onDragStart={(e) => {
              dragging.current = id;
              setDraggingId(id);
              e.dataTransfer?.setData('text/plain', id);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              const from = dragging.current;
              if (from === null) return;
              e.preventDefault();
              if (from === id) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const before = e.clientY < rect.top + rect.height / 2;
              const current = draft ?? reported;
              const targetIndex = current.indexOf(id);
              const without = current.filter((x) => x !== from);
              const at = without.indexOf(id) + (before ? 0 : 1);
              without.splice(at, 0, from);
              if (targetIndex !== -1 && without.join('\n') !== current.join('\n'))
                setDraft(without);
            }}
            onDrop={(e) => e.preventDefault()}
            onDragEnd={() => {
              const was = dragging.current;
              dragging.current = null;
              setDraggingId(null);
              if (was === null) return;
              commit(draft ?? reported);
            }}
          >
            {item.render(handle, index + 1)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One account row: handle, rank, body, and a ⋯ that opens the row's actions
 * under it (inline, so the row is never covered and nothing is clipped).
 */
export function AccountRow({
  handle,
  rank,
  active,
  children,
  menu,
  menuLabel,
  menuTestid,
  testid,
}: {
  handle: ReactNode;
  rank: number;
  active: boolean;
  children: ReactNode;
  menu: MenuItem[];
  menuLabel: string;
  menuTestid: string;
  testid: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`set-acct${active ? ' active' : ''}`} data-testid={testid}>
      {handle}
      <span className="set-rank" aria-label={active ? `rank ${rank}, in use` : `rank ${rank}`}>
        {rank}
      </span>
      <div className="set-acct-body">{children}</div>
      {menu.length > 0 ? (
        <button
          type="button"
          className="set-btn ghost set-more"
          aria-label={`${menuLabel} actions`}
          aria-expanded={open}
          data-testid={menuTestid}
          onClick={() => setOpen((v) => !v)}
        >
          ⋯
        </button>
      ) : (
        <span />
      )}
      {open ? (
        <div className="set-acct-actions" role="menu">
          {menu.map((it) => (
            <button
              key={it.testid}
              type="button"
              role="menuitem"
              className={`set-btn${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              data-testid={it.testid}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  testid: string;
  danger?: boolean;
  disabled?: boolean;
}

type Scope = 'session' | 'week' | 'overage';
const SCOPE_LABELS: Record<Scope, string> = {
  session: '5-hour',
  week: 'Weekly',
  overage: 'Extra usage',
};

/**
 * Anthropic's reason code in words.
 *
 * `org_level_disabled_until` is the one that matters and the one that read as
 * an accusation: it does NOT mean money has been spent, and it does not mean
 * anyone switched anything off. Extra usage is a paid add-on, so an account
 * that never took it out reports this for ever. The sentence is shared with
 * the chat-transcript block, so patch says it one way. An unrecognised code is
 * shown raw rather than guessed at.
 */
function describeDisabledReason(reason: string): string {
  if (reason === OVERAGE_DISABLED_REASON) return EXTRA_USAGE_OFF_TEXT;
  return reason;
}

/**
 * An account's limit windows as bars: label, fill, percentage, reset.
 *
 * The same `rejected` means two different things. On the session or the week
 * it means work has stopped. On overage it means the extra-usage add-on was
 * never bought — permanently true of a healthy account — so it draws in
 * neutral styling and reads as off, not blocked. A window the host has not
 * reported draws nothing rather than an empty bar.
 */
export function UsageBars({
  usage,
  testId,
  testIdFor,
}: {
  usage:
    | { session?: RateLimitWindow; week?: RateLimitWindow; overage?: RateLimitWindow; at?: number }
    | undefined;
  testId: string;
  testIdFor: (scope: Scope) => string;
}): JSX.Element {
  if (usage === undefined) {
    return (
      <div className="set-bars" data-testid={testId}>
        <span className="set-sub set-bars-empty" data-testid={`${testId}-empty`}>
          Usage not read yet
        </span>
      </div>
    );
  }
  const reasons = (['session', 'week', 'overage'] as const)
    .map((s) => usage[s]?.disabledReason)
    .filter((r): r is string => r !== undefined);
  return (
    <div className="set-bars" data-testid={testId}>
      {(['session', 'week', 'overage'] as const).map((scope) => {
        const win = usage[scope];
        if (!win) return null;
        const blocked = rateLimitWindowBlocks(scope, win);
        const off = scope === 'overage' && win.status === 'rejected';
        const warn = !blocked && !off && (win.utilization ?? 0) >= 0.8;
        const cls = blocked ? ' blocked' : off ? ' off' : warn ? ' warn' : '';
        return (
          <div
            key={scope}
            className={`set-bar-row${cls}`}
            data-testid={testIdFor(scope)}
            title={
              win.resetsAt !== undefined
                ? `${win.status} · resets ${formatResetDetail(win.resetsAt)} (${formatUntil(win.resetsAt)})`
                : win.status
            }
          >
            <span className="set-bar-label">{SCOPE_LABELS[scope]}</span>
            <span className="set-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((win.utilization ?? 0) * 100)}%` }} />
            </span>
            <span className="set-bar-value">
              {off ? 'off' : formatUtilization(win)}
              {blocked ? ' · blocked' : ''}
            </span>
            <span className="set-bar-reset">
              {win.resetsAt !== undefined ? `resets ${formatReset(win.resetsAt)}` : ''}
            </span>
          </div>
        );
      })}
      {reasons.length > 0 ? (
        <span className="set-sub set-bars-reason">
          {[...new Set(reasons)].map(describeDisabledReason).join(' · ')}
        </span>
      ) : null}
    </div>
  );
}
