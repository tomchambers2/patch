// 02-daemon.md § Self-wake — `/loop` slash command. Typing `/loop <interval>
// <message>` in the composer arms a DURABLE recurring self-wake instead of
// sending a chat turn — the host re-delivers `message` into this chat every
// `interval`, forever, until stopped. A bare `/loop` (no interval) CLEARS the
// pending wake (loop or plain one-shot — the composer's stop path). Unlike
// `/goal`/`/remind`, this reaches the same underlying scheduler the agent's
// `patch_loop` tool call reaches (see `chat.loop_request` in `@patch/wire`).
//
// This is a pure parse so it's unit-testable in isolation and the composer's
// send path stays a thin dispatch. `/loop` is matched case-insensitively on
// the command word only. Duration parsing (`"5m"`, `"1h30m"`, seconds) is NOT
// done here — the raw text is forwarded as-is and parsed host-side by the
// same `parseDelayMs` `patch_wake_me`'s `in` already goes through, so there is
// exactly one duration grammar in the whole system.

export interface LoopCommand {
  /** True when the message is a `/loop` command (and NOT a normal chat turn). */
  isLoop: boolean;
  /**
   * `null` when this is the CANCEL form (a bare `/loop`); otherwise the raw
   * interval text as typed (e.g. `"5m"`), unparsed.
   */
  every: string | null;
  /**
   * The message to loop. `null` when cancelling, OR when an interval was
   * given with no message following it — an incomplete arm the caller should
   * reject rather than guess a message for (NO FALLBACK).
   */
  message: string | null;
}

const NOT_LOOP: LoopCommand = { isLoop: false, every: null, message: null };

/**
 * Parse a composer message. Returns `{ isLoop: true, every: null, message:
 * null }` for a bare `/loop` (cancel), `{ isLoop: true, every, message: null
 * }` for `/loop <interval>` with nothing after it (incomplete — the caller
 * shows a usage error rather than arming with a guessed message), or
 * `{ isLoop: true, every, message }` for a full `/loop <interval> <message>`.
 * Any other message → `isLoop: false`.
 */
export function parseLoopCommand(message: string): LoopCommand {
  const m = /^\/loop(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i.exec(message.trim());
  if (!m) return NOT_LOOP;
  const every = m[1] ?? null;
  if (every === null) return { isLoop: true, every: null, message: null };
  const rest = (m[2] ?? '').trim();
  return { isLoop: true, every, message: rest.length > 0 ? rest : null };
}
