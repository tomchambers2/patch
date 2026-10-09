// The machine's Claude Code stays current (spec/02 § Agent backends).
//
// The CLI self-updates only from an interactive session, so a host that exists
// to run unattended jobs silently stops moving — and a build old enough to be
// gated out of a feature substitutes a working-looking alternative rather than
// refusing (a stale CLI is how `--permission-mode auto` became `default` on
// every job). These tests pin the two facts a person needs off this module: did
// the version move, and if the update failed, why.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { parseClaudeVersion, updateClaudeCli } from '../src/claudeCliUpdate.js';

const silentLogger = pino({ level: 'silent' });

/** A fake `claude` whose `--version` answers change after `update` runs. */
function fakeCli(versions: readonly string[]) {
  let reads = 0;
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === '--version') {
        const v = versions[Math.min(reads, versions.length - 1)] as string;
        reads += 1;
        return { stdout: `${v} (Claude Code)\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  };
}

describe('parseClaudeVersion', () => {
  it('takes the version out of the CLI’s own line', () => {
    expect(parseClaudeVersion('2.1.246 (Claude Code)\n')).toBe('2.1.246');
  });

  it('is null for a line it cannot read — never the raw text', () => {
    // This value is compared for equality to decide whether an update moved
    // anything, so noise would report a phantom update every run.
    expect(parseClaudeVersion('command not found')).toBeNull();
  });
});

describe('updateClaudeCli', () => {
  it('reports the versions either side when the update moves the CLI', async () => {
    const cli = fakeCli(['2.1.92', '2.1.246']);
    const result = await updateClaudeCli({
      executable: '/usr/local/bin/claude',
      logger: silentLogger,
      run: cli.run,
    });
    expect(result).toMatchObject({ before: '2.1.92', after: '2.1.246', updated: true });
    expect(cli.calls).toEqual([['--version'], ['update'], ['--version']]);
  });

  it('reports `updated: false` when the CLI was already current', async () => {
    const cli = fakeCli(['2.1.246']);
    const result = await updateClaudeCli({
      executable: '/usr/local/bin/claude',
      logger: silentLogger,
      run: cli.run,
    });
    expect(result).toMatchObject({ before: '2.1.246', after: '2.1.246', updated: false });
    expect(result.error).toBeUndefined();
  });

  it("carries the CLI's own stderr when the update fails, and leaves the version alone", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '--version') return { stdout: '2.1.92 (Claude Code)\n', stderr: '' };
      throw Object.assign(new Error('exit 1'), { stderr: 'no write permission on /usr/local/bin' });
    });
    const result = await updateClaudeCli({
      executable: '/usr/local/bin/claude',
      logger: silentLogger,
      run,
    });
    expect(result.updated).toBe(false);
    expect(result.after).toBe('2.1.92');
    expect(result.error).toContain('no write permission');
  });

  it('still attempts the update when the version cannot be read at all', async () => {
    // An unreadable version is not a reason to skip the update — it is a reason
    // to be unable to REPORT on it. Skipping would leave the host stale.
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '--version') throw new Error('ENOENT');
      return { stdout: '', stderr: '' };
    });
    const result = await updateClaudeCli({
      executable: '/usr/local/bin/claude',
      logger: silentLogger,
      run,
    });
    expect(run.mock.calls.map((c) => c[0][0])).toContain('update');
    expect(result).toMatchObject({ before: null, after: null, updated: false });
  });
});
