// The sound a native toast is shown with, per notification rung.

export type NotifyPriority = 'silent' | 'normal' | 'urgent';

/**
 * macOS system sound an urgent toast plays instead of the default one (spec/09
 * § Reaching the user — urgent is normal with a more urgent sound).
 */
export const URGENT_TOAST_SOUND = 'Sosumi';

/** The sound options a toast at `priority` is shown with. */
export function toastSound(priority: NotifyPriority | undefined): {
  silent: boolean;
  sound?: string;
} {
  if (priority === 'silent') return { silent: true };
  if (priority === 'urgent') return { silent: false, sound: URGENT_TOAST_SOUND };
  return { silent: false };
}
