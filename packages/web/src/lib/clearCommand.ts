// `/clear` slash command — clears the current chat's visible timeline from the
// UI without touching server-side history. The chat history stays on the host;
// `/clear` is a "fresh-screen" UX affordance so the view feels uncluttered after
// a long conversation.
//
// This is a BUILT-IN slash command, not a skill: it is always available in any
// chat regardless of folder, and it appears in the slash-command dropdown
// alongside skills.

/**
 * Parse a composer message. Returns `true` when the message is the `/clear`
 * command; `false` for anything else. Case-insensitive. No arguments are
 * accepted — `/clear foo` is NOT a clear command.
 */
export function parseClearCommand(message: string): boolean {
  return /^\/clear$/i.test(message.trim());
}

/** The built-in command entry for the slash-command autocomplete dropdown. */
export const CLEAR_COMMAND_NAME = 'clear';
export const CLEAR_COMMAND_DESCRIPTION = 'Clear the visible chat transcript';
