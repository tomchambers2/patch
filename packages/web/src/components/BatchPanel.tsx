// BatchPanel — the batch-mode sidebar body (spec/14 § Batch mode).
//
// The batch itself is server-owned (`batchStore` is a thin poll of
// `GET /api/batch`); this just renders whatever it last fetched. Before
// check-in, members are drawn "waiting" only — no status badge — since the
// whole point is not to watch them one at a time. From check-in on, real
// status badges show, done first.

import type { JSX } from 'react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CloseIcon } from './icons.js';
import { StatusBadge } from './StatusBadge.js';
import { deriveBadge, useChatStore } from '../stores/chatStore.js';
import { useBatchStore } from '../stores/batchStore.js';
import { useUiStore } from '../stores/uiStore.js';
import type { BatchCheckInChoice } from '../api/rest.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { failed } from '../lib/errorCopy.js';

const CHECK_IN_CHOICES: { label: string; choice: BatchCheckInChoice }[] = [
  { label: '15 min', choice: { type: 'time', minutes: 15 } },
  { label: '20 min', choice: { type: 'time', minutes: 20 } },
  { label: '30 min', choice: { type: 'time', minutes: 30 } },
  { label: 'When all done', choice: { type: 'all-done' } },
];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function BatchPanel(): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const batch = useBatchStore((s) => s.batch);
  const removeMember = useBatchStore((s) => s.removeMember);
  const checkInNow = useBatchStore((s) => s.checkInNow);
  const start = useBatchStore((s) => s.start);
  const pushError = useUiStore((s) => s.pushError);

  const rows = useMemo(() => {
    if (!batch) return [];
    const withRow = batch.members.map((chatId) => ({ chatId, row: chats[chatId] }));
    if (!batch.checkedIn) return withRow;
    // Done first (spec/14 § Batch mode).
    return [...withRow].sort((a, b) => {
      const aWorking = a.row ? deriveBadge(a.row) === 'working' : false;
      const bWorking = b.row ? deriveBadge(b.row) === 'working' : false;
      return aWorking === bWorking ? 0 : aWorking ? 1 : -1;
    });
  }, [batch, chats]);

  if (!batch) {
    return (
      <section className="batch-panel" data-testid="batch-panel">
        <div className="batch-empty empty-hint" data-testid="batch-empty">
          Nothing batched — press Batch to start one.
        </div>
        <div className="batch-start" data-testid="batch-start">
          {CHECK_IN_CHOICES.map(({ label, choice }) => (
            <button
              key={label}
              type="button"
              className="batch-start-btn"
              data-testid={`batch-start-${choice.type === 'time' ? choice.minutes : 'all-done'}`}
              onClick={() =>
                void start(choice).catch((err: unknown) =>
                  pushError(failed('starting batch'), undefined, (err as Error).message),
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    );
  }

  const checkInLabel =
    batch.checkIn.type === 'all-done'
      ? `Check in when all done (by ${formatTime(batch.checkInAt)})`
      : `Check in at ${formatTime(batch.checkInAt)}`;

  return (
    <section className="batch-panel" data-testid="batch-panel">
      <div className="batch-checkin" data-testid="batch-checkin-time">
        {batch.checkedIn ? `Checked in — ${checkInLabel}` : checkInLabel}
      </div>
      {!batch.checkedIn ? (
        <button
          type="button"
          className="batch-checkin-now-btn"
          data-testid="batch-checkin-now"
          onClick={() =>
            void checkInNow().catch((err: unknown) =>
              pushError(failed('check-in'), undefined, (err as Error).message),
            )
          }
        >
          Check in now
        </button>
      ) : null}
      {rows.map(({ chatId, row }) => (
        <div
          key={chatId}
          className={`batch-row ${activeChatId === chatId ? 'active' : ''}`}
          data-testid={`batch-row-${chatId}`}
        >
          <Link to={`/chats/${chatId}`} className="batch-row-link">
            {batch.checkedIn && row ? (
              <StatusBadge badge={deriveBadge(row)} pendingWake={row.pendingWake} />
            ) : null}
            <span className="name">{deriveChatTitle(row?.name ?? null)}</span>
            {!batch.checkedIn ? <span className="batch-waiting">waiting</span> : null}
          </Link>
          <button
            type="button"
            className="batch-remove-btn"
            data-testid={`batch-remove-${chatId}`}
            aria-label="remove from batch"
            title="Remove from batch"
            onClick={() =>
              void removeMember(chatId).catch((err: unknown) =>
                pushError(failed('removing from batch'), undefined, (err as Error).message),
              )
            }
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </section>
  );
}
