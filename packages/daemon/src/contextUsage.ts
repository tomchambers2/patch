// How full a chat's context window is (spec/14 § Composer — context ring).
//
// Two facts from two different Claude Code messages, because neither carries
// both:
//
//   USED   — every `assistant` message carries the API usage of the request
//            that produced it. Everything the model read for that request is
//            `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
//            which is exactly the conversation as it stands in the window.
//            A subagent's message (`parent_tool_use_id` set) is a different
//            conversation and says nothing about this one.
//   WINDOW — only the turn's `result` names the size of the window, per model,
//            in `modelUsage[model].contextWindow`. It is keyed by the model id
//            the assistant message reports, so the two are joined on that.
//
// Nothing is guessed. A message without usage leaves the reading alone, and a
// result whose window cannot be matched to the chat's model leaves the window
// unknown rather than borrowing another model's.

export interface ContextReading {
  tokens: number;
  /** The API model id that produced the reading, for matching the window. */
  model: string | undefined;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The context an `assistant` message's request filled, or undefined when it says nothing. */
export function assistantContextTokens(raw: unknown): ContextReading | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (m['type'] !== 'assistant') return undefined;
  if (typeof m['parent_tool_use_id'] === 'string') return undefined;
  const message = m['message'];
  if (typeof message !== 'object' || message === null) return undefined;
  const msg = message as Record<string, unknown>;
  const usage = msg['usage'];
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  if (typeof u['input_tokens'] !== 'number') return undefined;
  const tokens =
    num(u['input_tokens']) +
    num(u['cache_creation_input_tokens']) +
    num(u['cache_read_input_tokens']);
  // A synthetic message (an injected notice, an API error) reports zero input:
  // no request was made, so there is nothing to read.
  if (tokens === 0) return undefined;
  return { tokens, model: typeof msg['model'] === 'string' ? msg['model'] : undefined };
}

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` are one model; the tag only says which window. */
const stripContextTag = (id: string): string => id.replace(/\[[^\]]*\]$/, '');

/**
 * The window size a `result` reports for `model`.
 *
 * With no model to match (no assistant message this turn), a result naming
 * exactly one model is unambiguous. With several — Claude Code also bills its
 * own small-model calls here — the window is unknown.
 */
export function resultContextWindow(raw: unknown, model: string | undefined): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'result') return undefined;
  const mu = r['modelUsage'];
  if (typeof mu !== 'object' || mu === null) return undefined;
  const entries = Object.entries(mu as Record<string, unknown>);
  const pick =
    model !== undefined
      ? (entries.find(([k]) => k === model) ??
        entries.find(([k]) => stripContextTag(k) === stripContextTag(model)))
      : entries.length === 1
        ? entries[0]
        : undefined;
  if (!pick) return undefined;
  const w = (pick[1] as Record<string, unknown> | null)?.['contextWindow'];
  return typeof w === 'number' && w > 0 ? w : undefined;
}
