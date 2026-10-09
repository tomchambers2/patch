// Which Claude Code a turn runs (spec/02 § Agent backends).
//
// The backend splits cleanly in two, and the split is what belongs where:
//
//   the SDK      `@anthropic-ai/claude-agent-sdk` — the host's own library
//                dependency, imported in-process. It travels IN the artifact.
//   the CLI      the ~200 MB Claude Code binary it drives. That is the
//                machine's, installed the way its user installs it, and the
//                host runs whichever one they get in their terminal.
//
// Passing the resolved path as `pathToClaudeCodeExecutable` is what makes that
// true. Without it the SDK looks for a per-platform npm package the artifact
// deliberately does not carry, and fails with "Native CLI binary for
// <platform> not found".

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ResolveClaudeOptions {
  /** The host user's home. */
  home: string;
  /** `PATH`, as the host has it. */
  pathEnv: string;
  /** `CLAUDE_CODE_PATH` — an explicit choice, honoured before any search. */
  override?: string | undefined;
  /**
   * The absolute install locations to try after `home` and `pathEnv`. Part of
   * the machine like the other two, so it is passed in like the other two: when
   * these were baked in as literals, "the machine has no Claude Code" was not a
   * describable state — a caller could hand over an empty home and an empty
   * PATH and still get `/usr/local/bin/claude` back off the real filesystem.
   */
  wellKnown?: readonly string[];
}

/** Where Claude Code installs itself outside the user's home. */
export const WELL_KNOWN_CLAUDE_PATHS: readonly string[] = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];

function usable(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The machine's `claude`, or `undefined` when it hasn't got one. Not an error
 * here — the caller decides what that means: `daemon.host` reports the backend
 * `absent`, and a turn that cannot run says so naming the machine.
 */
export function resolveClaudeExecutable(opts: ResolveClaudeOptions): string | undefined {
  if (opts.override !== undefined && usable(opts.override)) return opts.override;
  const candidates = [
    // The native installer's location, which is how Claude Code installs today.
    join(opts.home, '.local', 'bin', 'claude'),
    ...opts.pathEnv
      .split(':')
      .filter((d) => d.length > 0)
      .map((d) => join(d, 'claude')),
    ...(opts.wellKnown ?? WELL_KNOWN_CLAUDE_PATHS),
  ];
  return candidates.find(usable);
}
