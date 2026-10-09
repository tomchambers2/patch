// The agent's built-in `AskUserQuestion` tool, as a permission request
// (spec/15 § Chat detail; mirrors `packages/web/src/lib/askUserQuestion.ts` —
// deliberately duplicated rather than shared, same convention as
// `toolsCatalog.ts`). Its arguments are the question itself, so the card
// renders THEM rather than the tool's name, and the user's selections travel
// back as the tool's `answers` argument via `approve_with_edits`
// (spec/03 § Answering with content).

/** The tool name the question card is keyed on. */
export const ASK_USER_QUESTION = 'AskUserQuestion';

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  /** Short chip label, e.g. `Auth method`. */
  header: string;
  /** The full question text. Also the key the answer is returned under. */
  question: string;
  options: AskOption[];
  multiSelect: boolean;
}

/**
 * The questions carried by an `AskUserQuestion` permission request's args.
 *
 * NO FALLBACK: anything that is not the tool's documented shape returns `null`
 * and the card says so out loud. Rendering a half-parsed question — or quietly
 * dropping back to a generic Approve/Deny — would put the user back in exactly
 * the failure this card exists to fix: answering something other than what was
 * asked, or approving with no answer at all.
 */
export function parseAskUserQuestion(args: unknown): AskQuestion[] | null {
  if (typeof args !== 'object' || args === null) return null;
  const raw = (args as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== 'object' || q === null) return null;
    const { header, question, options, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== 'string' || question.length === 0) return null;
    if (typeof header !== 'string') return null;
    if (!Array.isArray(options) || options.length === 0) return null;
    const parsedOptions: AskOption[] = [];
    for (const o of options) {
      if (typeof o !== 'object' || o === null) return null;
      const { label, description } = o as Record<string, unknown>;
      if (typeof label !== 'string' || label.length === 0) return null;
      parsedOptions.push({
        label,
        description: typeof description === 'string' ? description : '',
      });
    }
    questions.push({
      header,
      question,
      options: parsedOptions,
      multiSelect: multiSelect === true,
    });
  }
  return questions;
}

/**
 * The one string the tool's `answers[questionText]` takes. A multi-select
 * answer is its labels joined with `, ` — the tool's own schema is
 * `{[question]: string}`, so a multi-select has nowhere else to put them.
 */
export function joinAnswer(labels: string[]): string {
  return labels.join(', ');
}

/**
 * The inverse of `joinAnswer`, for redrawing a RESOLVED question from its
 * stored `answers[question]` string (mirrors
 * `packages/web/src/lib/askUserQuestion.ts`'s `parseStoredAnswer`) rather than
 * from transient screen state that is gone once the card unmounts. Splits the
 * answer on `, `, matches each piece against the question's own option
 * labels, and treats whatever is left over as the free-text `Other` answer.
 *
 * A label that itself contains `, ` cannot be told apart from two joined
 * labels — a pre-existing ambiguity in the wire format this only reads back —
 * so this is a best-effort reconstruction, not a guaranteed exact one.
 */
export function parseStoredAnswer(
  answer: string,
  options: AskOption[],
  multiSelect: boolean,
): { picked: string[]; other: string | null } {
  if (!multiSelect) {
    const match = options.find((o) => o.label === answer);
    if (match) return { picked: [match.label], other: null };
    // A bare `Other` (chosen with no comment) is the label itself.
    if (answer === 'Other') return { picked: [], other: '' };
    return { picked: [], other: answer };
  }
  const labels = new Set(options.map((o) => o.label));
  const picked: string[] = [];
  const rest: string[] = [];
  for (const part of answer.split(', ')) {
    if (labels.has(part) && !picked.includes(part)) picked.push(part);
    else rest.push(part);
  }
  return { picked, other: rest.length > 0 ? rest.join(', ') : null };
}

/**
 * Is this timeline entry a tool row the question card has already rendered?
 *
 * `AskUserQuestion` reaches the surface three times over: the permission
 * request that becomes the card, the tool call once it is granted, and the
 * tool result echoing the answer back. Where the card was ANSWERED it already
 * shows the questions, the options, the selections and the outcome, so both
 * other rows are the same event told twice more.
 *
 * A card that was NOT answered keeps its result row, because that row is the
 * only place the reason appears: the wire carries a plain `deny` for both a
 * user cancel and a question that expired unanswered, so the card can only say
 * "Cancelled" and the tool result is what distinguishes the two.
 *
 * NO FALLBACK: a tool row is only ever suppressed when the card that replaces
 * it is genuinely in the timeline, at a lower seq. A question that never
 * produced a permission request (an old host, a replay that lost the
 * request) still shows its rows — hiding the only trace of a tool run is a
 * worse bug than showing it twice.
 */
export function isQuestionRowCoveredByCard(
  entry: { kind: string; tool?: string; seq: number },
  timeline: readonly {
    kind: string;
    tool?: string;
    seq: number;
    permissionResolved?: string | undefined;
  }[],
): boolean {
  if (entry.kind !== 'tool_call' && entry.kind !== 'tool_result') return false;
  if (entry.tool !== ASK_USER_QUESTION) return false;
  const card = timeline.find(
    (e) => e.kind === 'permission' && e.tool === ASK_USER_QUESTION && e.seq < entry.seq,
  );
  if (!card) return false;
  return entry.kind === 'tool_call' || card.permissionResolved === 'approve';
}
