// Typed error thrown when an inbound wire frame fails decoding.
//
// Per the patch principle "no fallbacks", a malformed frame must NOT be
// coerced into a generic shape — it has to surface immediately so the bug
// (whichever side produced it) is visible. Callers catch this at the WS
// boundary and either drop the connection or log + close.

import type { ZodError } from 'zod';

export class WireDecodeError extends Error {
  override readonly name = 'WireDecodeError';
  /** Bounded preview of the offending payload — opt-in via `.preview`, never on `.message`. */
  readonly preview: string;
  override readonly cause: ZodError | SyntaxError | undefined;

  constructor(
    message: string,
    preview: string,
    cause?: ZodError | SyntaxError,
    /**
     * The rejected VALUE at the offending path, already bounded by the caller.
     * A refusal has to name the value that was wrong — "empty name rejected" is
     * indistinguishable from an edit that did not save unless the frame says
     * WHICH field held WHAT (spec/03 § Host events, unhappy paths).
     */
    readonly received?: string,
  ) {
    super(formatMessage(message, cause, received));
    this.preview = preview;
    this.cause = cause;
  }
}

function formatMessage(
  reason: string,
  cause: ZodError | SyntaxError | undefined,
  received?: string,
): string {
  if (cause && isZodError(cause)) {
    const issue = cause.issues[0];
    if (issue) {
      const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      // If the discriminator is known, the first issue often references it
      // directly via `path: ['type']`. We surface path + message verbatim;
      // attacker-controlled bytes never make it onto `.message` — only the
      // caller-bounded `received` rendering does.
      const got = received !== undefined ? ` (received: ${received})` : '';
      return `${reason}: ${where}: ${issue.message}${got}`;
    }
  }
  if (cause && cause instanceof SyntaxError) {
    return `${reason}: ${cause.message}`;
  }
  return reason;
}

function isZodError(err: unknown): err is ZodError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'issues' in err &&
    Array.isArray((err as { issues: unknown }).issues)
  );
}
