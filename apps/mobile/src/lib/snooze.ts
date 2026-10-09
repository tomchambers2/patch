// Snooze primitives (spec/04 § Snooze) — shared by the row-actions sheet, the
// Snoozed section and the chat-detail banner.
//
// Most presets are a DELTA (e.g. "5 minutes"); two ("5pm", "Tomorrow 8am")
// are wall-clock targets. Both kinds resolve here, against the clock at the
// moment of choosing, to the SAME absolute timestamp the host stores: a
// delta sent as-is would drift by however long the request spends in flight,
// so "5 minutes" would mean something different at each end.
//
// There is no Custom entry on the phone — the surface has no date/time field
// to pick one in, so the ladder is the whole menu (spec/15 § Row tools).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SnoozePreset {
  id: string;
  label: string;
  resolve: () => number;
}

// Same "today at hour unless past, else tomorrow" / "tomorrow at hour,
// unconditionally" logic as packages/web/src/components/SnoozeMenu.tsx —
// duplicated rather than shared because web and mobile are separate
// packages with no existing shared util for this.
function resolveTodayAt(hour: number): number {
  const now = new Date(Date.now());
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function resolveTomorrowAt(hour: number): number {
  const at = new Date(Date.now());
  at.setDate(at.getDate() + 1);
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { id: '2-minutes', label: '2 minutes', resolve: () => Date.now() + 2 * MINUTE },
  { id: '5-minutes', label: '5 minutes', resolve: () => Date.now() + 5 * MINUTE },
  { id: '30-minutes', label: '30 minutes', resolve: () => Date.now() + 30 * MINUTE },
  { id: '1-hour', label: '1 hour', resolve: () => Date.now() + HOUR },
  { id: '5pm', label: '5pm', resolve: () => resolveTodayAt(17) },
  { id: 'tomorrow-8am', label: 'Tomorrow 8am', resolve: () => resolveTomorrowAt(8) },
  { id: '1-day', label: '1 day', resolve: () => Date.now() + DAY },
  { id: 'next-week', label: 'Next week', resolve: () => Date.now() + 7 * DAY },
];

/** Resolves a preset to the absolute ms-epoch `snoozedUntil` the host stores. */
export function resolvePreset(preset: SnoozePreset): number {
  return preset.resolve();
}

/** Wake time as a short local date+time, e.g. `09:30` today, `Tue 09:30` beyond. */
export function formatWakeTime(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/**
 * Wake time sized for a row's right-hand timestamp slot: `14:00` today, `Tue`
 * within the coming week, `30 Sep` beyond — a bare weekday a week out would
 * name today.
 */
export function formatWakeTimeCompact(at: number): string {
  const d = new Date(at);
  const now = new Date();
  if (now.toDateString() === d.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at - startOfToday.getTime() < 7 * DAY) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
