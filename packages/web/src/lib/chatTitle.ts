// chatTitle — derive a human-readable chat label for the sidebar + header.
//
// spec/04 § Name: the chat `name` is an AI-generated summary of the opening
// exchange, produced ONCE after the first response (Haiku). Until it lands the
// row reads "New chat" — the first user message is NEVER used as the title (it
// produced garbage like a raw `[Attachments]` path). The host's `preview`
// snippet still renders as a SECONDARY line on the row; it is not a title
// source.
//
// The folder basename used to sit between the two, so a brand-new chat was
// titled `portfolio` — indistinguishable from every other chat in that folder,
// and read as a real name rather than as "this hasn't been named yet" (Tom,
// Patch Updates — "chats should be New chat before they have a name instead of
// folder name"). The folder is still on the row, as the crumb; it is no longer
// pretending to be a title.
//
// Precedence:
//   1. the server `name` (the AI title / user override), if set;
//   2. "New chat" until it lands.

/**
 * Best human-readable title for a chat. `name` is the server-authoritative
 * label (null until the AI title lands after the first turn). Never returns the
 * folder, the first user message, or the preview snippet as the title.
 */
export function deriveChatTitle(name: string | null): string {
  if (name && name.trim() !== '') return name;
  return 'New chat';
}
