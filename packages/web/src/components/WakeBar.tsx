// WakeBar — shows the chat's pending self-wake above the transcript
// (patch/todo.md — "cron should be visible in a bar above the chat, showing how
// long until next wakeup and the prompt"; spec/02 § Self-wake, spec/14 § Main
// chat panel).
//
// The "cron" the user means is `patch_wake_me` / `patch_loop`: patch disallows
// Claude Code's CronCreate (it cannot fire in the host's SDK model) and owns
// the timer itself. A pending wake is a scheduled FUTURE TURN in this chat, so
// it must never be invisible — this bar is the readout: a live countdown to
// `fireAt` plus the message the wake will deliver.
//
// A plain one-shot wake stays READ-ONLY by design: the agent owns its own
// timer (it re-arms or stops on each fire), so there is no clear (×) for it —
// unlike the goal/reminder banners, which are user-owned state. A RECURRING
// loop (`pendingWake.every` set) is different: it is very often armed by the
// USER via `/loop`, so this bar shows a stop (×) control for it — stopping
// goes through the same `chat.loop_request`/`patch_cancel_wake` path either
// way, whichever surface armed it.

import { useEffect, useState, type JSX } from 'react';
import { AlarmClock, X } from 'lucide-react';
import { api } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';

/**
 * Humanise the wait until `fireAt`. Coarse-to-fine so the bar reads naturally at
 * any horizon: `3h 4m`, `9m`, `2m 5s`, `45s`. Seconds are shown only under an
 * hour (a 3-hour countdown ticking seconds is noise), and a wake whose time has
 * passed but whose turn hasn't landed yet reads `now` rather than a negative or
 * a stale number — the host delivers it imminently (or on the next boot).
 */
export function formatWakeCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'now';
  const totalSec = Math.ceil(msRemaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0 && s > 0) return `in ${m}m ${s}s`;
  if (m > 0) return `in ${m}m`;
  return `in ${s}s`;
}

/**
 * Humanise a recurring interval for the "loops every …" label: `5m`, `1h 30m`,
 * `45s`. Unlike `formatWakeCountdown` this has no "now"/"in" framing — it
 * names a fixed cadence, not a countdown — and always shows the coarsest two
 * units rather than dropping seconds only under an hour, since an interval
 * (unlike a one-off wait) is worth reading precisely at any size.
 */
export function formatEvery(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function WakeBar({ row }: { row: ChatRow }): JSX.Element | null {
  const wake = row.pendingWake;
  const fireAt = wake?.fireAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  const pushError = useUiStore((s) => s.pushError);

  // Tick every second so the countdown is live. Only while a wake is armed —
  // no timer runs for the (overwhelmingly common) chat with nothing pending.
  useEffect(() => {
    if (fireAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fireAt]);

  if (!wake) return null;

  const countdown = formatWakeCountdown(wake.fireAt - now);
  const isLoop = wake.every !== undefined;
  const waiting = wake.waiting === true;

  function stopLoop(): void {
    void api.setLoop(row.chatId, null).catch((err) => {
      pushError(failed('stopping loop'), undefined, (err as Error).message);
    });
  }

  return (
    <div className="wake-bar" data-testid="wake-bar" role="status">
      <span className="wake-bar-label">
        <AlarmClock size={14} aria-hidden />
        <span className="wake-bar-countdown" data-testid="wake-bar-countdown">
          {isLoop
            ? waiting
              ? `Loops every ${formatEvery(wake.every!)} · waiting for current turn`
              : `Loops every ${formatEvery(wake.every!)} · next ${countdown}`
            : `Wakes ${countdown}`}
        </span>
      </span>
      <span className="wake-bar-message" data-testid="wake-bar-message" title={wake.message}>
        {wake.message}
      </span>
      {isLoop && (
        <button
          type="button"
          className="wake-bar-stop-btn"
          data-testid="wake-bar-stop-btn"
          aria-label="Stop loop"
          title="Stop loop"
          onClick={stopLoop}
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
