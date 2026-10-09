// The composer padlock's permission modes (spec/15 § Composer — Permission
// mode padlock): the order the list shows them in, the friendly name each is
// shown under, and which of them the chat's model can actually run.
//
// The VALUE sent on `chat.settings` is still the agent SDK's own mode id
// (spec/02 § Permission mode) — only the words on screen are friendlier, as
// Tom asked for on the phone. Each name says what the mode does to the next
// turn, so the list reads as a choice rather than a glossary.

import { permissionModesFor, type PermissionMode } from '@patch/wire';

/** The list order: the everyday modes first, the dangerous one last. */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
];

const LABELS: Record<PermissionMode, string> = {
  default: 'Ask before acting',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan only',
  auto: 'Auto',
  bypassPermissions: 'Bypass — no checks',
};

/**
 * The on-screen name for a mode. A mode this build has never heard of (a newer
 * SDK's) reads as its own id rather than being dressed up as a known one.
 */
export function permissionModeLabel(mode: string): string {
  return (LABELS as Record<string, string>)[mode] ?? mode;
}

/**
 * Which modes the chat's model can run — the same rule web's composer uses
 * (`permissionModesFor`): `auto` needs a model that supports it, and Claude
 * Code silently substitutes `default` where it does not. An unknown model
 * (`null`) offers everything, since there is nothing to judge it by.
 */
export function offeredPermissionModes(model: string | null | undefined): PermissionMode[] {
  return model === null || model === undefined
    ? [...PERMISSION_MODE_ORDER]
    : permissionModesFor(model);
}
