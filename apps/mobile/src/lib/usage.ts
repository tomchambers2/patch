// An account's limit figures in words a person reads — the phone's copy of
// packages/web/src/lib/usage.ts, so Settings → Credit sources says the same
// thing on both surfaces (spec/10 § Surface in Settings — Usage).
//
// Times are formatted by hand rather than with toLocale*, which is unreliable
// under Hermes; they are always in the phone's own zone.

import type { RateLimitWindow } from '@patch/wire';

export type UsageScope = 'session' | 'week' | 'overage';

export interface AccountUsage {
  session?: RateLimitWindow;
  week?: RateLimitWindow;
  overage?: RateLimitWindow;
  /** ms-epoch when the reading was taken. */
  at?: number;
}

/** What each pool is called — the same words web uses. */
export const SCOPE_LABEL: Record<UsageScope, string> = {
  session: '5-hour',
  week: 'Weekly',
  overage: 'Extra usage',
};

export const SCOPE_ORDER: UsageScope[] = ['session', 'week', 'overage'];

/** Anthropic's reason code for an account that never bought the add-on. */
export const OVERAGE_DISABLED_REASON = 'org_level_disabled_until';

/** Extra usage being off, in the one sentence patch uses for it everywhere. */
export const EXTRA_USAGE_OFF_TEXT = 'extra usage is not enabled — nothing has been overspent';

/** `100%`, or `—` when Anthropic reported a status but no figure. */
export function formatUtilization(win: RateLimitWindow | undefined): string {
  if (!win || win.utilization === undefined) return '—';
  return `${Math.round(win.utilization * 100)}%`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** A reset instant in the phone's zone — `10:40`, or `Wed 17:58` when not today. */
export function formatReset(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${WEEKDAYS[d.getDay()]} ${time}`;
}

/** How long until an instant, coarsely — `in 28 min`, `in 3 h`, `now`. */
export function formatUntil(at: number, now: number = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `in ${Math.round(hours)} h`;
  return `in ${Math.round(hours / 24)} d`;
}

/** `read 2 min ago` — so a stale figure cannot pass for a live one. */
export function formatReadAt(at: number | undefined, now: number = Date.now()): string | null {
  if (at === undefined || at === 0) return null;
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return 'read just now';
  if (min < 60) return `read ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `read ${h} h ago`;
  return `read ${Math.floor(h / 24)} d ago`;
}

/** Anthropic's reason code in words; an unrecognised code is shown raw. */
export function describeDisabledReason(reason: string): string {
  return reason === OVERAGE_DISABLED_REASON ? EXTRA_USAGE_OFF_TEXT : reason;
}

/**
 * A stored turn failure, for a person: drops the host's "This turn failed: "
 * replay prefix and restates a usage limit's UTC ISO reset in the device's own
 * zone (same rule as the web surface).
 */
export function presentFailure(content: string, now: number = Date.now()): string {
  const body = content.replace(/^This turn failed:\s*/, '');
  if (!body.startsWith('Usage limit reached')) return body;
  return body.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, (iso) => {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? iso : formatReset(at, now);
  });
}
