// JSON-over-WebSocket-text-frame codec.
//
// `encode` is total: zod is the source of truth for *inbound* validation, but
// outbound events are constructed by code that already passes typecheck, so we
// don't pay double validation on every send.
//
// There are TWO decoders, and which one a reader uses is a policy decision, not
// a taste one — spec/03-wire-protocol.md § Forward compatibility:
//
//   * `decode` is strict: any malformed frame throws `WireDecodeError`. No
//     silent coercion to a generic shape — see /CLAUDE.md and
//     spec/principles.md. It is what INGRESS uses (server ← surface, server ←
//     host). The server is the protocol's referee and is never older than
//     anything talking to it — every client artifact is published by the deploy
//     that ships the server — so an unknown key arriving there is a typo, not
//     the future, and has to be loud.
//
//   * `decodeCompat` is for readers that can be OLDER than their sender: the
//     web and mobile surfaces, and the host reading server→host frames.
//     Those lag routinely — a phone that was off during a deploy, a desktop
//     shell that has not restarted, a host that OTAs on its own
//     schedule. It tolerates EXACTLY the two shapes of "my sender is newer than
//     me" (an unknown field on a known event; an unknown event type) and
//     nothing else. It is not a fallback: a missing field, a wrong type, a bad
//     enum or invalid JSON still throws, and so does a frame that mixes an
//     unknown key with a real error.
//
// Before this split, a host that added one field to `chat.state` made every
// surface that had not taken the matching OTA unusable — chat.state drives the
// sidebar and the chat view, so the surface did not degrade, it stopped and
// showed a wall of error banners (2026-09-11, the `limitBlock` / `usage.overage`
// work). It also meant nobody could add a field without a lockstep deploy, which
// is visible in the protocol's own design scars (see `editedNewString`).

import { z } from 'zod';
import { WireEvent, type WireEvent as WireEventT } from './events.js';
import { WireDecodeError } from './errors.js';

/** Encode a typed event to a WebSocket text-frame string. */
export function encode(event: WireEventT): string {
  return JSON.stringify(event);
}

/** Decode raw inbound data. Throws `WireDecodeError` on any failure. */
export function decode(raw: string | Buffer | ArrayBuffer | Uint8Array): WireEventT {
  const text = rawToString(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new WireDecodeError('invalid JSON', preview(text), e as SyntaxError);
  }
  const result = WireEvent.safeParse(parsed);
  if (!result.success) {
    throw new WireDecodeError(
      'schema validation failed',
      preview(text),
      result.error,
      receivedAt(parsed, result.error.issues[0]?.path ?? []),
    );
  }
  return result.data;
}

function rawToString(raw: string | Buffer | ArrayBuffer | Uint8Array): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  // Buffer (subclass of Uint8Array) is handled by the Uint8Array branch above.
  throw new WireDecodeError('unsupported frame type', String(raw));
}

/**
 * The value the frame actually carried at the offending path, rendered and
 * bounded. A validation refusal names it so the sender can see WHAT was wrong
 * rather than only that something was.
 */
function receivedAt(parsed: unknown, path: readonly (string | number)[]): string | undefined {
  let cursor: unknown = parsed;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  if (cursor === undefined && path.length > 0) return 'undefined';
  let rendered: string;
  try {
    rendered = JSON.stringify(cursor) ?? String(cursor);
  } catch {
    return undefined;
  }
  const max = 80;
  return rendered.length <= max ? rendered : `${rendered.slice(0, max)}…`;
}

function preview(text: string): string {
  const max = 200;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

/** Type guard — narrows an unknown to a `WireEvent` without throwing. */
export function isWireEvent(value: unknown): value is WireEventT {
  return WireEvent.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// Forward compatibility (spec/03 § Forward compatibility)

/** What `decodeCompat` returns when it did not throw. */
export type CompatDecodeResult =
  | {
      ok: true;
      event: WireEventT;
      /**
       * Dotted paths of the unknown keys stripped to make this frame decode,
       * qualified by event type — e.g. `chat.state.limitBlock.resetsAt`. Empty
       * on the ordinary path, i.e. a sender this build's own age.
       */
      tolerated: string[];
    }
  | {
      ok: false;
      reason: 'unknown-type';
      /** The `type` this build has never heard of, bounded for logging. */
      type: string;
    };

/**
 * Running totals of what forward compatibility has absorbed on this process,
 * read by the surfaces' connection-diagnostics screen (spec/12 § Connection
 * diagnostics screen).
 *
 * The two are not equally serious and the screen says so. A tolerated FIELD is
 * harmless: the sender added something this build has no use for. A dropped
 * event TYPE means the sender is emitting behaviour this build does not
 * implement at all — the one case where the honest thing to tell the user is
 * "update this surface".
 */
export interface WireCompatStats {
  /** Frames dropped because their `type` is unknown here, counted by type. */
  unknownTypes: Record<string, number>;
  /** Unknown keys stripped, counted by `<event type>.<dotted path>`. */
  unknownFields: Record<string, number>;
}

const compatStats: WireCompatStats = { unknownTypes: {}, unknownFields: {} };

/** Snapshot of the running totals — a copy, so callers cannot mutate the source. */
export function wireCompatStats(): WireCompatStats {
  return {
    unknownTypes: { ...compatStats.unknownTypes },
    unknownFields: { ...compatStats.unknownFields },
  };
}

/** Zero the totals. For tests, and for a diagnostics screen that offers a reset. */
export function resetWireCompatStats(): void {
  for (const k of Object.keys(compatStats.unknownTypes)) delete compatStats.unknownTypes[k];
  for (const k of Object.keys(compatStats.unknownFields)) delete compatStats.unknownFields[k];
}

/**
 * Decode an inbound frame the way a reader that may be older than its sender
 * should. See the module header for the policy and `decode` for the strict
 * ingress variant that tolerates nothing.
 *
 * Throws `WireDecodeError` on a frame that is genuinely malformed.
 */
export function decodeCompat(raw: string | Buffer | ArrayBuffer | Uint8Array): CompatDecodeResult {
  const text = rawToString(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new WireDecodeError('invalid JSON', preview(text), e as SyntaxError);
  }
  const result = WireEvent.safeParse(parsed);
  if (result.success) return { ok: true, event: result.data, tolerated: [] };

  // An unknown discriminator is zod's way of saying no member of the union has
  // this `type` — an event this build has never heard of. Nothing here could
  // act on it, so it is dropped and counted rather than announced per frame.
  const unknownType = result.error.issues.some(
    (i) => i.code === 'invalid_union_discriminator' && i.path.length === 1 && i.path[0] === 'type',
  );
  if (unknownType) {
    const type = boundedType(parsed);
    compatStats.unknownTypes[type] = (compatStats.unknownTypes[type] ?? 0) + 1;
    return { ok: false, reason: 'unknown-type', type };
  }

  const refuse = (): never => {
    throw new WireDecodeError(
      'schema validation failed',
      preview(text),
      result.error,
      receivedAt(parsed, result.error.issues[0]?.path ?? []),
    );
  };

  // A known event whose ONLY problems are unknown keys: strip exactly those and
  // insist the frame passes on its own terms afterwards. Anything else — or a
  // real error riding along with an unknown key — is refused as before.
  const tolerated: string[] = [];
  let issues: z.ZodIssue[] = result.error.issues;
  // One pass is normally enough (zod reports every object's unrecognized keys in
  // the same error), but a nested union can surface a second layer only once the
  // first is gone. Bounded so a pathological frame cannot spin.
  for (let pass = 0; pass < 4; pass++) {
    const unknownKeys = issues.filter((i) => i.code === 'unrecognized_keys');
    if (unknownKeys.length === 0 || unknownKeys.length !== issues.length) return refuse();
    for (const issue of unknownKeys) {
      const at = issue.path.join('.');
      const keys = (issue as z.ZodIssue & { keys: string[] }).keys;
      for (const key of keys) tolerated.push(at === '' ? key : `${at}.${key}`);
      stripKeys(parsed, issue.path, keys);
    }
    const retry = WireEvent.safeParse(parsed);
    if (retry.success) {
      // Sorted so the reported paths (and the counters and diagnostics text
      // built from them) do not depend on the order zod happened to walk the
      // tree in — it reports nested objects before the root.
      const qualified = tolerated.map((p) => `${retry.data.type}.${p}`).sort();
      for (const path of qualified) {
        compatStats.unknownFields[path] = (compatStats.unknownFields[path] ?? 0) + 1;
      }
      return { ok: true, event: retry.data, tolerated: qualified };
    }
    issues = retry.error.issues;
  }
  return refuse();
}

/** Delete `keys` from the object at `path` within `root`, in place. */
function stripKeys(root: unknown, path: readonly (string | number)[], keys: string[]): void {
  let cursor: unknown = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  if (cursor === null || typeof cursor !== 'object') return;
  for (const key of keys) delete (cursor as Record<string, unknown>)[key];
}

/**
 * The unknown `type`, bounded — it is sender-controlled and ends up as a
 * counter key and in a log line.
 */
function boundedType(parsed: unknown): string {
  if (parsed === null || typeof parsed !== 'object') return '<no type>';
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || type === '') return '<no type>';
  return type.length <= 64 ? type : `${type.slice(0, 64)}…`;
}
