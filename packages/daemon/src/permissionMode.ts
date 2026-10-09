// spec/02 § Permission mode — the one-line record of a mid-conversation mode
// change, written once here so every surface words it identically (the same
// arrangement compaction.ts has for a compression boundary).

import type { PermissionMode } from '@patch/wire';

/**
 * The mode ids ARE the words shown, everywhere the choice is offered, because
 * the value is handed to the agent unchanged — a friendlier noun here would
 * name a mode the transcript says nobody picked.
 *
 * `automatic` marks the plan-mode exception (spec/02 § Permission mode):
 * Claude Code moved the chat there itself rather than the mode control, and
 * the line says so instead of reading as though a person had picked it.
 */
export function permissionModeChangeLine(mode: PermissionMode, automatic = false): string {
  return automatic ? `Permission mode → ${mode} (set by Claude Code)` : `Permission mode → ${mode}`;
}
