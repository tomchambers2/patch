// permissionModeLabel — how a permission mode is written on screen.
//
// The value itself is the agent SDK's own `permissionMode` and is passed
// through verbatim (spec/02 § Permission mode), so the label must be the SAME
// WORDS as the id — only cased and spaced for reading. `bypassPermissions`
// becomes "Bypass permissions", not "YOLO": an invented word would mean the
// user picks one thing and the model is told another, which is why the earlier
// friendly names were removed (ab57424). This is the readable middle ground
// Tom asked for ("have nice names for bypassPermissions, like Bypass
// permissions etc") — nothing here renames a mode, it just stops shouting
// camelCase at him.

import type { PermissionMode } from '@patch/wire';

const LABELS: Record<string, string> = {
  auto: 'Auto',
  default: 'Default',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'Bypass permissions',
  plan: 'Plan',
};

/**
 * The on-screen label for a mode. An unknown mode (a newer SDK's, reaching an
 * older surface) is split on its camelCase humps and sentence-cased by the same
 * rule, rather than falling back to something that hides what it actually is.
 */
export function permissionModeLabel(mode: PermissionMode | string): string {
  const known = LABELS[mode];
  if (known !== undefined) return known;
  const spaced = mode.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
