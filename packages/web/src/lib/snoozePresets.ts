// Shared snooze vocabulary (spec/04 § Snooze) — the Gmail-shaped preset list
// and wake-time formatting, factored out so the per-chat control (SnoozeMenu)
// and the whole-project control (ProjectSnoozeMenu) can never drift apart on
// what "5pm" or "next week" means. Every preset resolves itself against the
// clock at the moment of choosing into an absolute timestamp — the host
// only ever stores that, so a slow request can't drift the wake time.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Today at `hour`:00 local time, pushed to tomorrow if that has already passed. */
function resolveTodayAt(hour: number): number {
  const now = new Date(Date.now());
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** Tomorrow at `hour`:00 local time, unconditionally. */
function resolveTomorrowAt(hour: number): number {
  const at = new Date(Date.now());
  at.setDate(at.getDate() + 1);
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

export interface SnoozePreset {
  id: string;
  label: string;
  resolve: () => number;
}

/** The Gmail-shaped presets, in menu order (spec/14 § Chat panel header). */
export const SNOOZE_PRESETS: ReadonlyArray<SnoozePreset> = [
  { id: '2-minutes', label: '2 minutes', resolve: () => Date.now() + 2 * MINUTE },
  { id: '5-minutes', label: '5 minutes', resolve: () => Date.now() + 5 * MINUTE },
  { id: '30-minutes', label: '30 minutes', resolve: () => Date.now() + 30 * MINUTE },
  { id: '1-hour', label: '1 hour', resolve: () => Date.now() + HOUR },
  { id: '5pm', label: '5pm', resolve: () => resolveTodayAt(17) },
  { id: 'tomorrow-8am', label: 'Tomorrow 8am', resolve: () => resolveTomorrowAt(8) },
  { id: '1-day', label: '1 day', resolve: () => Date.now() + DAY },
  { id: 'next-week', label: 'Next week', resolve: () => Date.now() + 7 * DAY },
];

/** Wake time as a short local date+time, e.g. `Tue 09:30`. */
export function formatWakeTime(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
