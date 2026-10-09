// The Manager view's slim sweep-status line (spec/06 § Sweep — "Visible"):
// "Last sweep 14:30 · nudged 2 · flagged 1", expandable to what it did to
// which chat, plus a "Check now" button. Local component state — one
// account, one sweep loop, nothing else on the page needs this.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SweepRun } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import { failed } from '../lib/errorCopy.js';

function summarize(run: SweepRun): string {
  const counts: Record<string, number> = {};
  for (const a of run.actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  const parts: string[] = [];
  if (counts['nudge']) parts.push(`nudged ${counts['nudge']}`);
  if (counts['wake']) parts.push(`woke ${counts['wake']}`);
  if (counts['flag']) parts.push(`flagged ${counts['flag']}`);
  if (parts.length === 0) return 'nothing to do';
  return parts.join(' · ');
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function SweepStatusLine(): JSX.Element {
  const [last, setLast] = useState<SweepRun | null | undefined>(undefined); // undefined = loading
  const [expanded, setExpanded] = useState(false);
  const [checking, setChecking] = useState(false);
  const pushError = useUiStore((s) => s.pushError);
  const navigate = useNavigate();

  const load = (): void => {
    void api
      .getSweepRuns(1)
      .then((res) => setLast(res.runs[0] ?? null))
      .catch((e: Error) => pushError(failed('sweep status'), undefined, e.message));
  };

  useEffect(load, []);

  const checkNow = (): void => {
    setChecking(true);
    void api
      .checkSweepNow()
      .then(() => load())
      .catch((e: Error) => pushError(failed('check now'), undefined, e.message))
      .finally(() => setChecking(false));
  };

  return (
    <div className="sweep-status" data-testid="sweep-status">
      <button
        type="button"
        className="sweep-status-summary"
        data-testid="sweep-status-summary"
        onClick={() => setExpanded((v) => !v)}
        disabled={last === undefined || last === null}
      >
        {last === undefined
          ? 'Sweep —'
          : last === null
            ? 'No sweeps yet'
            : `Last sweep ${hhmm(last.at)} · ${summarize(last)}${last.error ? ' · failed' : ''}`}
      </button>
      <button
        type="button"
        className="sweep-status-check-now"
        data-testid="sweep-check-now"
        onClick={checkNow}
        disabled={checking}
      >
        Check now
      </button>
      {expanded && last ? (
        <div className="sweep-status-detail" data-testid="sweep-status-detail">
          {last.error ? (
            <div className="sweep-status-error">{last.error}</div>
          ) : last.actions.length === 0 ? (
            <div className="sweep-status-empty">Nothing changed.</div>
          ) : (
            last.actions.map((a) => (
              <button
                type="button"
                key={a.chatId}
                className="sweep-status-row"
                data-testid={`sweep-status-row-${a.chatId}`}
                onClick={() => navigate(`/chats/${a.chatId}`)}
              >
                {a.action} · {a.chatId}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
