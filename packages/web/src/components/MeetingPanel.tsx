// Meeting mode (right-hand panel + action cards above the composer). Pure view
// of the host's MeetingState; every control goes through lib/meetingControl.

import { useEffect, useMemo, useState } from 'react';
import { formatMeetingClock, meetingElapsedMs, type MeetingState } from '@patch/wire';
import {
  decideAction,
  endMeeting,
  listenHere,
  pauseMeeting,
  requestMeeting,
  resumeMeeting,
} from '../lib/meetingControl.js';
import { useMeetingStore } from '../stores/meetingStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { ReactNode } from 'react';

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [running]);
  return now;
}

export function MeetingPanel({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const capturing = useMeetingStore((s) => s.capturingChatId === chatId);
  const now = useNow(meeting.status === 'live');
  const [query, setQuery] = useState('');
  const elapsed = meetingElapsedMs(meeting, now);
  const topics = useMemo(() => [...meeting.topics].sort((a, b) => b.at - a.at), [meeting.topics]);
  const q = query.trim().toLowerCase();
  const lines = useMemo(
    () => meeting.transcript.filter((l) => q === '' || l.text.toLowerCase().includes(q)),
    [meeting.transcript, q],
  );
  const card = meeting.status === 'ended' ? meeting.summary : meeting.now;

  return (
    <aside className="mm-panel" data-testid="meeting-panel" data-status={meeting.status}>
      <div className="mm-head">
        {meeting.status === 'ended' ? (
          <span className="mm-pill ended" data-testid="meeting-pill">
            Ended · {Math.max(1, Math.round(elapsed / 60_000))} min
          </span>
        ) : (
          <span className="mm-pill" data-testid="meeting-pill">
            {meeting.status === 'live' ? <span className="mm-dot" /> : null}
            {meeting.status === 'live' ? 'Live' : 'Paused'} · {formatMeetingClock(elapsed)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {meeting.status === 'live' ? (
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-pause"
            onClick={() => pauseMeeting(chatId)}
          >
            Pause
          </button>
        ) : null}
        {meeting.status === 'paused' ? (
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-resume"
            onClick={() => resumeMeeting(chatId)}
          >
            Resume
          </button>
        ) : null}
        {meeting.status !== 'ended' ? (
          <button
            type="button"
            className="mm-end"
            data-testid="meeting-end"
            onClick={() => endMeeting(chatId)}
          >
            End
          </button>
        ) : null}
      </div>

      {meeting.error ? (
        <div className="mm-error" role="alert" data-testid="meeting-error">
          {meeting.error}
        </div>
      ) : null}
      {meeting.status === 'live' && !capturing ? (
        <div className="mm-error" data-testid="meeting-not-listening">
          This device is not listening.{' '}
          <button
            type="button"
            className="mm-btn"
            data-testid="meeting-listen-here"
            onClick={() => void listenHere(chatId)}
          >
            Listen here
          </button>
        </div>
      ) : null}

      <div className="mm-now" data-testid="meeting-now">
        <div className="mm-label">{meeting.status === 'ended' ? 'Summary' : 'Now'}</div>
        {card ? (
          <>
            <h4>{card.headline}</h4>
            <ul>
              {card.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            {'who' in card && card.who !== '' ? (
              <div className="mm-who">{String(card.who)}</div>
            ) : null}
          </>
        ) : (
          <h4 className="mm-wait">Listening…</h4>
        )}
      </div>

      {topics.length > 0 ? (
        <div>
          <div className="mm-label">Discussed</div>
          {topics.map((t) => (
            <div className="mm-topic" key={t.id} data-testid="meeting-topic">
              <div className="r">
                <span className="tm">{formatMeetingClock(t.at)}</span>
                <span className="nm">{t.title}</span>
                {t.decided ? <span className="mm-dec">Decided</span> : null}
              </div>
              <ul>
                {t.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      <details className="mm-tx" data-testid="meeting-transcript">
        <summary>Transcript</summary>
        <input
          className="mm-search"
          data-testid="meeting-search"
          aria-label="Search transcript"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ln">
          {lines.map((l, i) => (
            <div key={i} data-testid="meeting-line">
              <span>
                {formatMeetingClock(l.at)} {l.speaker === 'you' ? 'You' : 'Them'}
              </span>
              {l.text}
            </div>
          ))}
        </div>
      </details>
    </aside>
  );
}

export function MeetingActions({ chatId, meeting }: { chatId: string; meeting: MeetingState }) {
  const ordered = meeting.actions
    .filter((a) => a.status !== 'dismissed')
    .sort((a, b) => Number(a.status !== 'pending') - Number(b.status !== 'pending') || b.at - a.at);
  if (ordered.length === 0) return null;
  return (
    <div className="mm-actions" data-testid="meeting-actions">
      <div className="mm-actions-in">
        <div className="mm-label">Actions</div>
        {ordered.map((a) =>
          a.status === 'done' ? (
            <div
              className="mm-card done"
              key={a.id}
              data-testid="meeting-action"
              data-status="done"
            >
              <div className="w">
                <span className="tk">✓</span>
                {a.title}
              </div>
              <span className="y">
                {a.resolvedAt
                  ? new Date(a.resolvedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : ''}
              </span>
            </div>
          ) : (
            <div className="mm-card" key={a.id} data-testid="meeting-action" data-status="pending">
              <div className="w">
                <b>{a.title}</b>
                <div className="y">
                  {a.why} · {formatMeetingClock(a.at)}
                </div>
              </div>
              <button
                type="button"
                className="mm-do"
                data-testid="meeting-action-do"
                onClick={() => decideAction(chatId, a.id, 'do')}
              >
                Do it
              </button>
              <button
                type="button"
                className="mm-dis"
                data-testid="meeting-action-dismiss"
                onClick={() => decideAction(chatId, a.id, 'dismiss')}
              >
                Dismiss
              </button>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Wraps the chat's stream + composer. With a meeting it becomes a two-column
 * body with the panel on the right; without one it is `display: contents`, so
 * the wrapped tree never remounts when a meeting starts or ends.
 */
export function MeetingLayout({ chatId, children }: { chatId: string; children: ReactNode }) {
  const meeting = useMeetingStore((s) => s.byChat[chatId]);
  const connection = usePresenceStore((s) => s.connection);
  useEffect(() => {
    if (connection === 'connected') requestMeeting(chatId);
  }, [chatId, connection]);
  return (
    <div
      className={meeting ? 'mm-body' : 'mm-contents'}
      data-testid={meeting ? 'meeting-body' : undefined}
    >
      <div className={meeting ? 'mm-left' : 'mm-contents'}>{children}</div>
      {meeting ? <MeetingPanel chatId={chatId} meeting={meeting} /> : null}
    </div>
  );
}
