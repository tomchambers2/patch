// Keeps the machine's Claude Code CLI current (spec/02 § Agent backends).
//
// The host drives the machine's own `claude` binary rather than carrying one
// (see claudeExecutable.ts). That binary updates itself — but only from an
// INTERACTIVE session, and a host that exists to run unattended jobs never has
// one. So the binary silently stops moving: ubuntu-4gb-hel1-1 sat on 2.1.92
// from April while the host shipped a dozen releases past it.
//
// A stale CLI is not a cosmetic problem. Claude Code resolves features against
// its own server-side gates, and a build old enough to be outside a gate does
// not refuse the feature — it substitutes a working-looking alternative. On
// 2.1.92 that meant `--permission-mode auto` came back as `default`, so every
// unattended job asked a human to approve every tool call, in a chat nobody was
// watching. Nothing in the logs said the CLI's age was the cause.
//
// So the host updates it, on the same "boot then hourly" cadence as its own
// version check, using the CLI's OWN updater — `claude update` lays the new
// version down and repoints the symlink itself, and reimplementing that here
// would be a second installer to keep in step with the first.
//
// NO FALLBACK: a failed update is reported with the CLI's own stderr, never
// swallowed. The path the host resolved does not change across an update
// (`~/.local/bin/claude` stays put; only its symlink target moves), so a
// long-lived process needs no re-resolution and in-flight turns keep the binary
// they already opened.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

/**
 * How long `claude update` may take before the host gives up on it. Generous:
 * it downloads a ~200 MB binary, and a slow link is not a failure.
 */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
/** `claude --version` is a local read; it has no business taking longer. */
const VERSION_TIMEOUT_MS = 30_000;

export interface ClaudeCliUpdateOptions {
  /** The machine's `claude`, as resolved by `resolveClaudeExecutable`. */
  executable: string;
  logger: Logger;
  /** Injected in tests; defaults to running the real binary. */
  run?: (args: readonly string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
}

export interface ClaudeCliUpdateResult {
  /** Version before the attempt; null when it could not be read. */
  before: string | null;
  /** Version after. Equal to `before` when the CLI was already current. */
  after: string | null;
  /** Did the version actually move? */
  updated: boolean;
  /** Set when the update command itself failed. */
  error?: string;
}

/**
 * `claude --version` prints e.g. `2.1.246 (Claude Code)`. Only the version is
 * wanted, and an unparseable line is null rather than the raw text: this value
 * is compared for equality to decide whether an update moved anything, and
 * comparing noise would report phantom updates.
 */
export function parseClaudeVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  return match ? (match[1] as string) : null;
}

/**
 * Bring the machine's Claude Code up to date, and say what moved.
 *
 * Reads the version, runs the CLI's own updater, reads it again. The two reads
 * are what make this reportable: "already current" and "updated 2.1.92 →
 * 2.1.246" are different facts about the machine, and only one of them is worth
 * a person's attention.
 */
export async function updateClaudeCli(
  opts: ClaudeCliUpdateOptions,
): Promise<ClaudeCliUpdateResult> {
  const run =
    opts.run ??
    (async (args: readonly string[], timeoutMs: number) =>
      execFileAsync(opts.executable, [...args], { timeout: timeoutMs }));

  const readVersion = async (): Promise<string | null> => {
    try {
      const { stdout } = await run(['--version'], VERSION_TIMEOUT_MS);
      return parseClaudeVersion(stdout);
    } catch (err) {
      opts.logger.warn(
        { err, executable: opts.executable },
        'claude-cli-update: could not read the CLI version',
      );
      return null;
    }
  };

  const before = await readVersion();
  try {
    await run(['update'], UPDATE_TIMEOUT_MS);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    const message = stderr && stderr.trim().length > 0 ? stderr.trim() : (err as Error).message;
    // Reported, not swallowed: a host silently stuck on an old CLI is the exact
    // failure this module exists to end.
    opts.logger.error(
      { executable: opts.executable, before, err: message },
      'claude-cli-update: `claude update` failed — this host stays on its current CLI',
    );
    return { before, after: before, updated: false, error: message };
  }

  const after = await readVersion();
  const updated = before !== null && after !== null && before !== after;
  if (updated) {
    opts.logger.info(
      { executable: opts.executable, before, after },
      'claude-cli-update: Claude Code updated',
    );
  } else {
    opts.logger.debug(
      { executable: opts.executable, version: after },
      'claude-cli-update: Claude Code already current',
    );
  }
  return { before, after, updated };
}
