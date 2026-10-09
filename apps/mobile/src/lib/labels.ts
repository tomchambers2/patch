// User-facing UI copy constants that carry a specific spec requirement, kept
// here so their exact wording is a single source of truth and can be guarded
// by unit tests (e.g. "no (AI)", "no read-mostly").

// spec/15 § Chats tab — Search: the header's search field is labelled simply
// "Search chats".
export const CHATS_SEARCH_PLACEHOLDER = 'Search chats…';

// spec/03 § Chat search — the header search asks the server, which searches
// every chat's name and transcript on every host. Web draws the same words.
export const CHATS_SEARCHING = 'Searching…';
export const CHATS_SEARCH_MORE = 'More results';
/** The row a failed search draws in place of its results. */
export function chatSearchFailed(message: string): string {
  return `Search failed: ${message}`;
}

// spec/15 § Jobs screen: the jobs list carries the same instant local search
// as the Chats tab, labelled simply "Search jobs".
export const JOBS_SEARCH_PLACEHOLDER = 'Search jobs…';

// spec/15 § Settings tab — the linked-surfaces section carries web's own name,
// "Linked devices" (spec/14 § Hosts & devices), so the two surfaces' Settings
// read as one list. Section headers stand alone, no descriptive subtitle.
export const LINKED_DEVICES_TITLE = 'Linked devices';

// spec/15 § Settings tab — "Linked devices": each row shows a human-friendly
// device NAME in plain words, never a doubled token like "mobile.mobile" and
// never a raw surface id as the primary label. Maps a surfaceKind (and optional
// custom label) to a readable name.
const DEVICE_KIND_NAMES: Record<string, string> = {
  mobile: 'Phone',
  tablet: 'Tablet',
  desktop: 'Desktop',
  web: 'Web',
  'voice-device': 'Voice device',
  cli: 'Terminal',
};

// spec/04 § Name / spec/15 § Chat title — a raw generated identifier is NEVER
// shown to the user. ULIDs (26-char Crockford base32) and `chat_`/`thread_` ids
// are internal. The title is an AI-generated summary of the opening exchange,
// captured once after the first response; until it lands the row reads "New
// chat". The first user message is NEVER the title (it produced garbage like a
// raw `[Attachments]` path), and neither is the folder — spec/15 already said
// so ("it stays 'New chat' rather than the folder basename, which would collide
// for two chats in one folder"); the code hadn't caught up. Precedence (matches
// packages/web/src/lib/chatTitle.ts):
//   1. an explicit human name (the AI title / override; not a generated id);
//   2. "New chat" — never the folder, never the raw id. The host's `preview`
//      snippet still renders as a SEPARATE secondary line (see badge.ts).
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isGeneratedId(s: string): boolean {
  const t = s.trim();
  return ULID_RE.test(t) || t.startsWith('chat_') || t.startsWith('thread_');
}

export function deriveChatTitle(row: {
  name: string | null;
  chatId: string;
  folder: string;
  preview?: string | null;
}): string {
  const name = row.name?.trim();
  if (name && name.length > 0 && !isGeneratedId(name)) return name;

  // No AI name yet. The folder basename used to sit here, but it titled every
  // unnamed chat in a project the same thing and read as a real name rather
  // than as "not named yet" — so the placeholder is the only step left, and web
  // does exactly the same (packages/web/src/lib/chatTitle.ts).
  return 'New chat';
}

export function friendlyDeviceName(surfaceKind: string, label?: string): string {
  const kindName = DEVICE_KIND_NAMES[surfaceKind] ?? 'Device';
  const trimmed = label?.trim() ?? '';
  // A custom label is shown only when it adds information — i.e. it is not just
  // a restatement of the kind ("mobile" label on a "mobile" surface → just
  // "Phone", never "mobile · mobile").
  if (trimmed.length > 0 && trimmed.toLowerCase() !== surfaceKind.toLowerCase()) {
    return trimmed;
  }
  return kindName;
}

/**
 * How a permission mode is written on screen (spec/02 § Permission mode).
 *
 * The same words as the id, cased and spaced for reading — never a friendlier
 * synonym, because the value goes to the agent SDK verbatim and a renamed mode
 * would have the user picking one thing and the model told another. Mirrors
 * packages/web/src/lib/permissionModeLabel.ts.
 */
const PERMISSION_MODE_LABELS: Record<string, string> = {
  auto: 'Auto',
  default: 'Default',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'Bypass permissions',
  plan: 'Plan',
};

export function permissionModeLabel(mode: string): string {
  const known = PERMISSION_MODE_LABELS[mode];
  if (known !== undefined) return known;
  const spaced = mode.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
