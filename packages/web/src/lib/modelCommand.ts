// spec/04-chats-and-folders.md § Model — `/model <name>` slash command. Typing
// `/model <name>` in the composer changes the chat's model the same way the
// picker does, without opening it — matched against the host's catalogue by
// id or label, case-insensitively, and by unique substring where nothing
// matches exactly. Unlike `/goal`/`/remind`/`/loop`, a bare `/model` has no
// sensible "clear" meaning (a chat always has a model), so it's a usage error.
//
// This is a pure parse (`parseModelCommand`) plus a pure catalogue match
// (`matchModel`), so both are unit-testable in isolation and the composer's
// send path stays a thin dispatch.

import type { ModelOption } from './models.js';

export interface ModelCommand {
  /** True when the message is a `/model` command (and NOT a normal chat turn). */
  isModel: boolean;
  /** The raw query text, trimmed. `null` for a bare `/model` (a usage error). */
  query: string | null;
}

const NOT_MODEL: ModelCommand = { isModel: false, query: null };

/**
 * Parse a composer message. Returns `{ isModel: true, query }` when the
 * message is a `/model` command — `query` is the trimmed text after the
 * command, or `null` when nothing followed. Any other message → `isModel:
 * false`.
 */
export function parseModelCommand(message: string): ModelCommand {
  const m = /^\/model(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!m) return NOT_MODEL;
  const rest = (m[1] ?? '').trim();
  return { isModel: true, query: rest.length > 0 ? rest : null };
}

export type ModelMatch =
  | { status: 'found'; modelId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: string[] };

/**
 * Resolve a typed query against the host's model catalogue. Tries an exact
 * (case-insensitive) id or label match first; failing that, a case-insensitive
 * substring match against either field — unique is a find, more than one is
 * `ambiguous` (naming the candidates' labels), none is `not_found`. Never
 * rounds to a near match (spec/04 § Model: "never rounded to a near match").
 */
export function matchModel(query: string, models: readonly ModelOption[]): ModelMatch {
  const q = query.trim().toLowerCase();
  const exact = models.find((m) => m.id.toLowerCase() === q || m.label.toLowerCase() === q);
  if (exact) return { status: 'found', modelId: exact.id };
  const partial = models.filter(
    (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
  );
  if (partial.length === 1) return { status: 'found', modelId: partial[0]!.id };
  if (partial.length > 1) return { status: 'ambiguous', candidates: partial.map((m) => m.label) };
  return { status: 'not_found' };
}
