// Turning an account's limit figures into something a person can read.
//
// One module, because the same three facts — which pool, how full, when it
// clears — have to read identically in Settings, above a blocked composer, and
// in the compact line beside the model name. When they were written separately
// they disagreed: the sidebar said "paused — resuming 10:40", Settings said
// "blocked, — · resets Wed 17:58", and the transcript said "your session limit
// resets 9:40am (UTC)", all about the same account at the same moment.
//
// TIME IS RENDERED IN THE READER'S ZONE, ALWAYS. Anthropic states resets in
// UTC prose; patch holds them as ms-epoch and formats locally, with the UTC
// alongside on hover. Two clocks in one sentence with neither labelled is how
// "9:40am" and "17:58" came to be on screen together with nothing saying that
// one of them was an hour out and the other five days stale. (The offset is
// not a constant to hard-code, either: British Summer Time ends on Sunday 25
// October 2026, after which the two agree.)

import { refusingRateLimitScope, type ChatContextUsage, type RateLimitWindow } from '@patch/wire';

export type UsageScope = 'session' | 'week' | 'overage';

export interface AccountUsage {
  session?: RateLimitWindow;
  week?: RateLimitWindow;
  overage?: RateLimitWindow;
  /** ms-epoch when the reading was taken. */
  at?: number;
}

/** What each pool is, in words a person uses rather than a header name. */
export const SCOPE_LABEL: Record<UsageScope, string> = {
  session: '5-hour',
  week: 'Weekly',
  overage: 'Extra usage',
};

export const SCOPE_ORDER: UsageScope[] = ['session', 'week', 'overage'];

/** `100%`, or `—` when Anthropic reported a status but no figure. */
export function formatUtilization(win: RateLimitWindow | undefined): string {
  if (!win || win.utilization === undefined) return '—';
  return `${Math.round(win.utilization * 100)}%`;
}

/**
 * A reset instant in the reader's own zone, with the weekday when it is not
 * today — `10:40`, or `Wed 17:58`.
 */
export function formatReset(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/**
 * The same instant spelled out for a tooltip: local zone named, then UTC.
 *
 * The zone NAME comes from the browser rather than a computed offset, so it
 * says "BST" today and "GMT" from 25 October without anything being changed.
 */
export function formatResetDetail(at: number): string {
  const d = new Date(at);
  const local = d.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const utc = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  return `${local} · ${utc}`;
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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How long until an instant, IN WORDS — `58 minutes`, `1 hour 3 minutes`.
 *
 * Separate from `formatUntil` on purpose. That one is chrome: it sits in a
 * settings row where `in 3 h` is fine because the row is already dense with
 * figures. This one is a sentence someone reads while they are stuck, and
 * `1 h` is a unit symbol, not something you say. Minutes are kept alongside
 * hours for the same reason — "1 hour" for anything between one and two hours
 * is a worse answer than the truth.
 */
export function formatDurationWords(ms: number): string {
  if (ms <= 0) return 'any moment now';
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) {
    // Under a minute is still a wait, and "0 minutes" is not a duration.
    return totalMinutes <= 1 ? 'less than a minute' : plural(totalMinutes, 'minute');
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours === 0
      ? plural(days, 'day')
      : `${plural(days, 'day')} ${plural(restHours, 'hour')}`;
  }
  return minutes === 0
    ? plural(hours, 'hour')
    : `${plural(hours, 'hour')} ${plural(minutes, 'minute')}`;
}

/** What a person calls each pool when told they have run out of it. */
export const LIMIT_NAME: Record<'session' | 'week' | 'unknown', string> = {
  session: 'session limit',
  week: 'weekly limit',
  unknown: 'usage limit',
};

/**
 * Where a person turns extra usage on.
 *
 * Patch cannot flip it — it is an Anthropic account setting, and pretending
 * otherwise would be a button that lies. This is the page Claude Code itself
 * points at in the message it prints when the overflow refuses.
 */
export const EXTRA_USAGE_URL = 'https://claude.ai/settings/usage';

/** Anthropic's reason code for an account that never bought the add-on. */
export const OVERAGE_DISABLED_REASON = 'org_level_disabled_until';

/**
 * Extra usage being off, in the ONE sentence patch uses for it everywhere.
 *
 * It is a setting nobody switched on, not a fault and not a spend: the account
 * is healthy and the overflow pool simply does not exist. Said once, here,
 * because it appears both in Settings and above a blocked composer, and two
 * different sentences for one state read as two different states. It does not
 * say "for this organisation" — Anthropic's code is org-scoped, but a personal
 * subscription has no organisation that did anything, and the sentence read as
 * an accusation about an account that was fine.
 */
export const EXTRA_USAGE_OFF_TEXT = 'extra usage is not enabled — nothing has been overspent';

/** The same wording as a standalone sentence, for a tooltip. */
export const EXTRA_USAGE_OFF_SENTENCE = `${EXTRA_USAGE_OFF_TEXT.charAt(0).toUpperCase()}${EXTRA_USAGE_OFF_TEXT.slice(1)}.`;

/**
 * The pool that RAN OUT, if one has.
 *
 * Only the session and the week are candidates. Overage is the overflow that
 * covers for those two, not something a person spends, so a rejected overage
 * on its own does not stop any work — it only means there is nothing to spill
 * into when one of the others empties. Blaming it produced the headline that
 * started this: "Extra usage limit on Default", which names a limit nobody
 * reached and suggests no action.
 */
export function blockingScope(usage: AccountUsage | undefined): UsageScope | undefined {
  return refusingRateLimitScope(usage);
}

/** True when any pool is refusing work. */
export function isBlocked(usage: AccountUsage | undefined): boolean {
  return blockingScope(usage) !== undefined;
}

/**
 * The single line that goes next to a chat — the fullest pool, or the refusal.
 *
 * Deliberately ONE line: it sits in chrome, and a reader glancing at it wants
 * "am I about to run out", not a table. Returns null when nothing has been
 * read yet, so the caller renders nothing rather than an empty gauge that
 * looks like zero usage.
 */
export function summariseUsage(
  usage: AccountUsage | undefined,
  now: number = Date.now(),
): { text: string; title: string; level: 'ok' | 'warn' | 'blocked'; fraction: number } | null {
  if (!usage) return null;
  const present = SCOPE_ORDER.filter((s) => usage[s] !== undefined);
  if (present.length === 0) return null;

  const blocking = blockingScope(usage);
  const detail = present
    .map((s) => {
      const w = usage[s]!;
      const reset = w.resetsAt !== undefined ? `, resets ${formatResetDetail(w.resetsAt)}` : '';
      return `${SCOPE_LABEL[s]} ${formatUtilization(w)} (${w.status})${reset}`;
    })
    .join('\n');

  if (blocking) {
    const w = usage[blocking]!;
    const reset =
      w.resetsAt !== undefined ? ` · back ${formatReset(w.resetsAt, now)}` : ' · no reset given';
    return {
      text: `${SCOPE_LABEL[blocking]} limit reached${reset}`,
      title: detail,
      level: 'blocked',
      fraction: 1,
    };
  }

  // Not blocked: report the pool closest to its limit, since that is the one
  // that will stop work first. A pool with no figure cannot be compared, so it
  // loses to one that has a figure rather than being treated as empty.
  const worst = present.reduce((acc, s) =>
    (usage[s]?.utilization ?? -1) > (usage[acc]?.utilization ?? -1) ? s : acc,
  );
  const w = usage[worst]!;
  const level = (w.utilization ?? 0) >= 0.8 ? 'warn' : 'ok';
  return {
    text: `${SCOPE_LABEL[worst]} ${formatUtilization(w)}`,
    title: detail,
    level,
    fraction: w.utilization ?? 0,
  };
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

/**
 * Every account is spent, or nothing is wrong enough to say so.
 *
 * The per-chat bubble speaks for ONE parked turn. This is the other question,
 * and it has a different answer: is there any credit left on this machine AT
 * ALL? When there is not, every chat on it is stuck — including the ones nobody
 * is looking at, and the jobs that will fire into it — and that is worth
 * interrupting for in a way a single parked turn is not.
 *
 * Returns null unless it is CERTAIN, and certainty needs a reading per account.
 * The three ways to be uncertain are all treated as "say nothing":
 *
 *   NO CONNECTED ACCOUNT      — that is the disconnected banner's business, and
 *                               two warnings about the same machine is noise.
 *   AN ACCOUNT WITH NO READING — unknown is not spent. At boot, before the
 *                               first probe lands, every account looks like
 *                               this; crying wolf on every cold start is how a
 *                               banner gets ignored on the day it is right.
 *   ANY ACCOUNT STILL USABLE  — one account with credit means work continues,
 *                               so there is nothing to warn about.
 */
export interface SpentAccount {
  id: string;
  label: string;
  /** Which pool ran out on this account. */
  scope: UsageScope;
  /** ms-epoch, when known. Absent when Anthropic named no reset. */
  resetsAt?: number;
}

export interface HostOutage {
  /** Every connected account, all of them spent, in the host's own order. */
  accounts: SpentAccount[];
  /** The first one to come back — what a person actually wants to know. */
  soonest?: SpentAccount;
}

export function hostOutage(
  accounts: readonly { id: string; label: string; connected: boolean; usage?: AccountUsage }[],
): HostOutage | null {
  const connected = accounts.filter((a) => a.connected);
  if (connected.length === 0) return null;

  const spent: SpentAccount[] = [];
  for (const a of connected) {
    const scope = blockingScope(a.usage);
    // No reading, or a reading that says this account is fine: either way we
    // cannot claim the machine is out.
    if (scope === undefined) return null;
    const window = a.usage?.[scope];
    spent.push({
      id: a.id,
      label: a.label,
      scope,
      ...(window?.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    });
  }

  const dated = spent.filter((s) => s.resetsAt !== undefined);
  const soonest =
    dated.length > 0 ? dated.reduce((a, b) => (a.resetsAt! <= b.resetsAt! ? a : b)) : undefined;
  return { accounts: spent, ...(soonest ? { soonest } : {}) };
}

/**
 * "work and Default", "work, Default and personal" — a list a person reads
 * rather than a comma-joined dump.
 */
export function listLabels(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]!}`;
}

/** `850`, `46k`, `1.2M` — a token count at a glance. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}

/**
 * A chat's context reading as the ring and the popover draw it.
 *
 * Null until the host has measured the chat — and also while it has a used
 * figure but no window: a fraction of an unknown whole is not a figure, and a
 * ring drawn against a guessed window would read as fact.
 */
export function summariseContext(ctx: ChatContextUsage | null | undefined): {
  fraction: number;
  percent: string;
  tokens: string;
  level: 'ok' | 'warn' | 'blocked' | 'unknown';
} | null {
  if (!ctx) return null;
  // Tokens measured but the window not yet named (it arrives with a turn's
  // result): say so rather than drawing nothing, or a full-looking ring.
  if (ctx.windowTokens === undefined) {
    return {
      fraction: 0,
      percent: '?',
      tokens: `${formatTokens(ctx.usedTokens)} / ?`,
      level: 'unknown',
    };
  }
  const fraction = Math.min(1, ctx.usedTokens / ctx.windowTokens);
  return {
    fraction,
    percent: `${Math.round(fraction * 100)}%`,
    tokens: `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.windowTokens)}`,
    level: fraction >= 0.9 ? 'blocked' : fraction >= 0.7 ? 'warn' : 'ok',
  };
}

const STRATEGY_NAME = {
  priority: 'Priority order',
  'round-robin': 'Round robin',
  'soonest-reset': 'Soonest reset',
  'least-used': 'Least used',
} as const;

/**
 * The account strategy and where the exhaustion has got, in one line:
 * "Round robin — all 3 accounts out, next resets 14:00 (personal)".
 */
export function routingSentence(
  r: {
    strategy: keyof typeof STRATEGY_NAME;
    accounts: number;
    exhausted: number;
    nextResetsAt?: number;
    nextLabel?: string;
  },
  now: number = Date.now(),
): string {
  const state =
    r.exhausted >= r.accounts
      ? r.accounts === 1
        ? 'the account is out'
        : `all ${r.accounts} accounts out`
      : `${r.exhausted} of ${r.accounts} accounts out`;
  const next =
    r.nextResetsAt === undefined
      ? ''
      : `, next resets ${formatReset(r.nextResetsAt, now)}${r.nextLabel ? ` (${r.nextLabel})` : ''}`;
  return `${STRATEGY_NAME[r.strategy]} — ${state}${next}`;
}

/**
 * A stored turn failure, for a person. The host writes "This turn failed: " in
 * front of the reason on replay, and spells a usage limit's reset as an ISO
 * instant in UTC (stored text the credit sweeps classify) — neither is how a
 * reader should meet it. Strips the prefix and restates the instant in the
 * reader's own zone.
 */
export function presentFailure(content: string, now: number = Date.now()): string {
  const body = content.replace(/^This turn failed:\s*/, '');
  if (!body.startsWith('Usage limit reached')) return body;
  return body.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, (iso) => {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? iso : formatReset(at, now);
  });
}
