// Account settings as the server's own features read them (spec/01 §
// Settings). The store is `SharedSettingsService`; this is the quiet-hours rule
// the Manager watch loop applies to it.

import { DEFAULT_SHARED_SETTINGS, type SharedSettings } from '@patch/wire';

export type AccountSettings = SharedSettings;
export const DEFAULT_SETTINGS: AccountSettings = DEFAULT_SHARED_SETTINGS;

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Whether `at` falls inside the quiet window. Handles the wrapping case
 * (22:00 → 07:00) as one window rather than two.
 */
export function inQuietHours(settings: AccountSettings, at: Date): boolean {
  const start = minutesOfDay(settings.quietHoursStart);
  const end = minutesOfDay(settings.quietHoursEnd);
  if (start === end) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}
