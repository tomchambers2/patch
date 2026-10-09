// Shared helpers for resource-grouped subcommands.
//
// Every command has the same shape:
//   1. Read CLI flags (incl. --json).
//   2. Build a Transport (UDS-preferred when host is local).
//   3. Make the call.
//   4. On success: emit JSON to stdout if --json, else a human-readable
//      formatting; exit 0.
//   5. On failure: print to stderr and exit non-zero. With --json the
//      stdout is `{"error": "..."}`.

import type { Transport } from '../transport/index.js';
import { buildTransport } from '../transport/index.js';
import { loadConfig } from '../config.js';
import { RestError } from '../transport/rest.js';
import { UdsError } from '../transport/uds.js';
import {
  CredentialMissingError,
  CredentialCorruptError,
  CredentialExpiredError,
  MissingCredentialError,
  MissingIdentityError,
} from '../auth.js';

export interface CommonOpts {
  json?: boolean;
  /** When true, force REST mode (e.g. `--remote`). */
  remote?: boolean;
}

export function getTransport(opts: CommonOpts = {}): Transport {
  return buildTransport(loadConfig(), opts.remote ? { forceRest: true } : {});
}

export function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function emitText(line: string): void {
  process.stdout.write(line + '\n');
}

/** Format a top-level error for `--json` and human modes consistently. */
export function fail(opts: CommonOpts, err: unknown, exitCode = 1): never {
  const message = errorMessage(err);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ error: message }) + '\n');
  } else {
    process.stderr.write('[patch] error: ' + message + '\n');
  }
  process.exit(exitCode);
}

export function errorMessage(err: unknown): string {
  if (
    err instanceof CredentialMissingError ||
    err instanceof CredentialCorruptError ||
    err instanceof CredentialExpiredError ||
    err instanceof MissingCredentialError ||
    err instanceof MissingIdentityError
  ) {
    return err.message;
  }
  if (err instanceof RestError) {
    let bodyError: string | undefined;
    let bodyMessage: string | undefined;
    if (err.body && typeof err.body === 'object' && err.body !== null) {
      const b = err.body as { error?: unknown; message?: unknown };
      if (typeof b.error === 'string') bodyError = b.error;
      if (typeof b.message === 'string') bodyMessage = b.message;
    }
    const combined =
      bodyError && bodyMessage ? `${bodyError}: ${bodyMessage}` : (bodyError ?? bodyMessage);
    if (err.status === 401) {
      const detail = combined ?? 'unauthenticated';
      // Heuristic: server uses generic 'unauthenticated' for any 401. Try to
      // distinguish missing vs invalid bearer based on whether we sent one.
      const hadBearer = err.sentBearer === true;
      if (!hadBearer) return 'missing bearer (401) — no credential sent. Run `patch auth login`.';
      return `invalid bearer (401): ${detail}. Token may be revoked or for a different account; re-run \`patch auth login\`.`;
    }
    if (combined) return combined;
    return err.message;
  }
  if (err instanceof UdsError) {
    if (
      err.body &&
      typeof err.body === 'object' &&
      err.body !== null &&
      'error' in err.body &&
      typeof (err.body as { error: unknown }).error === 'string'
    ) {
      return String((err.body as { error: string }).error);
    }
    return err.message;
  }
  if (err instanceof Error) {
    // fetch failures: enrich with cause code if present.
    const e = err as Error & { cause?: { code?: string } };
    if (err.message === 'fetch failed' && e.cause?.code) {
      return `fetch failed (${e.cause.code})`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Validate a `--limit` flag value. Every command that accepts `--limit`
 * (history, logs, jobs runs, jobs hooks, hooks tail) MUST route through this so
 * the error contract is identical across the CLI: a non-numeric, zero, or
 * negative value is rejected client-side with the SAME message and a non-zero
 * exit — never silently ignored and never forwarded to the host (which would
 * surface as an opaque 500). NO FALLBACK: a bad limit is a caller error, not a
 * default-to-something situation.
 */
export function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer (got ${raw})`);
  }
  return n;
}

/** Wrap a command body so all thrown errors become `fail()`. */
export async function run(opts: CommonOpts, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    fail(opts, err);
  }
}

/** Choose the right path depending on transport: UDS or REST. */
export function pickPath(transport: Transport, udsPath: string, restPath: string): string {
  return transport.kind === 'uds' ? udsPath : restPath;
}
