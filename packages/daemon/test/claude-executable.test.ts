// Which `claude` a turn runs (spec/02 § Agent backends: the host "resolves
// the `claude` executable and passes it to the SDK as
// `pathToClaudeCodeExecutable`, so turns run against the same binary, version
// and configuration the user gets in their terminal").
//
// This is the half of the backend that genuinely belongs to the MACHINE. The
// SDK — the npm package the daemon imports — is the daemon's own dependency and
// travels in the artifact; the ~200 MB Claude Code binary is not something a
// host build should be carrying, and the machine already has the one its user
// runs. Without a path the SDK looks for a platform package that the artifact
// deliberately does not ship, and dies with "Native CLI binary for
// linux-x64 not found".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveClaudeExecutable,
  WELL_KNOWN_CLAUDE_PATHS,
  type ResolveClaudeOptions,
} from '../src/claudeExecutable.js';

let root: string;

/**
 * Resolve against a machine described ENTIRELY by the fixture. Left to the
 * default, `wellKnown` reaches out to the real `/usr/local/bin/claude`, so the
 * two "machine has no Claude Code" cases passed on a laptop without one and
 * failed on every box that had one — green where it did not matter and red
 * where it did. Cases that mean to describe a machine WITH a well-known
 * install pass their own paths.
 */
function resolve(opts: Omit<ResolveClaudeOptions, 'wellKnown'> & { wellKnown?: string[] }) {
  return resolveClaudeExecutable({ wellKnown: [], ...opts });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-claude-exe-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function installClaude(dir: string, name = 'claude'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho claude\n');
  chmodSync(path, 0o755);
  return path;
}

describe('resolving the machine’s Claude Code', () => {
  it('finds the native install under the user’s home', () => {
    const expected = installClaude(join(root, '.local', 'bin'));
    expect(resolve({ home: root, pathEnv: '' })).toBe(expected);
  });

  it('finds one on PATH', () => {
    const dir = join(root, 'opt', 'bin');
    const expected = installClaude(dir);
    expect(resolve({ home: join(root, 'empty'), pathEnv: dir })).toBe(expected);
  });

  it('prefers an explicit override over anything it would search for', () => {
    // A machine with two installs, or a test rig pointing at its own.
    installClaude(join(root, '.local', 'bin'));
    const chosen = installClaude(join(root, 'chosen'), 'claude');
    expect(resolve({ home: root, pathEnv: '', override: chosen })).toBe(chosen);
  });

  it('ignores an override that is not there, rather than passing a bad path on', () => {
    const real = installClaude(join(root, '.local', 'bin'));
    expect(resolve({ home: root, pathEnv: '', override: join(root, 'ghost') })).toBe(real);
  });

  it('falls back to a well-known install location when home and PATH have none', () => {
    const expected = installClaude(join(root, 'usr', 'local', 'bin'));
    expect(resolve({ home: join(root, 'empty'), pathEnv: '', wellKnown: [expected] })).toBe(
      expected,
    );
  });

  it('searches the real system install locations by default', () => {
    // The default is what production gets: the two paths Claude Code installs
    // itself to outside a home directory, tried last.
    expect(WELL_KNOWN_CLAUDE_PATHS).toEqual(['/usr/local/bin/claude', '/opt/homebrew/bin/claude']);
    expect(
      resolveClaudeExecutable({ home: join(root, 'empty'), pathEnv: join(root, 'nope') }),
    ).toBe(WELL_KNOWN_CLAUDE_PATHS.find((p) => existsSync(p)));
  });

  it('reports nothing when the machine has no Claude Code', () => {
    // Not an error here: the caller decides what to say. `daemon.host` reports
    // the backend `absent`, and a turn fails naming it.
    expect(resolve({ home: root, pathEnv: join(root, 'nope') })).toBeUndefined();
  });

  it('does not accept a directory called claude', () => {
    mkdirSync(join(root, '.local', 'bin', 'claude'), { recursive: true });
    expect(resolve({ home: root, pathEnv: '' })).toBeUndefined();
  });
});
