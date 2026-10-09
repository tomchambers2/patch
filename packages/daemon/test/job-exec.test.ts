// spec/08 § Action — `script`, host half. Real commands, real exit codes:
// this is the layer that would silently succeed if it ran the command in the
// wrong directory or swallowed a failure.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { handleJobExec } from '../src/jobExec.js';

const silentLogger = pino({ level: 'silent' });

function run(
  command: string,
  folder: string,
  timeoutMs = 5000,
): Promise<Extract<WireEvent, { type: 'job.exec_result' }>> {
  return new Promise((resolve) => {
    handleJobExec(
      {
        type: 'job.exec_request',
        daemonId: 'd1',
        jobId: 'j_1',
        fireId: 'f_1',
        folder,
        command,
        timeoutMs,
      },
      (e) => {
        if (e.type === 'job.exec_result') resolve(e);
      },
      silentLogger,
    );
  });
}

describe('handleJobExec', () => {
  it('runs the command IN the folder it was given and reports its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    writeFileSync(join(dir, 'marker.txt'), 'here');
    const r = await run('ls marker.txt && pwd', dir);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('marker.txt');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a non-zero exit is a failure carrying the code and stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const r = await run('echo "went wrong" >&2; exit 3', dir);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('went wrong');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a folder that does not exist rather than running somewhere else', async () => {
    const r = await run('pwd', join(tmpdir(), 'patch-exec-does-not-exist-xyz'));
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain('folder not found');
    // Nothing ran, so there is nothing to report from it.
    expect(r.stdout).toBe('');
  });

  // patch doesn't recognise tilde in workspace paths — a job's folder is
  // typed into the same "type a path" field as a chat's, so `~/sub` must run
  // there rather than failing `folder not found`.
  it('expands a leading ~ in the job folder', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-exec-tilde-home-'));
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const r = await run('pwd', '~');
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe(home);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('kills a command that outlives its timeout and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const r = await run('sleep 30', dir, 1000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timeout');
    rmSync(dir, { recursive: true, force: true });
  });

  // The bug that made every correct hold look like a crash.
  //
  // A non-interactive LOGIN shell reads `~/.bash_logout` whenever `exit` runs
  // explicitly, and Ubuntu's default one ends in a `&&` whose right side needs a
  // console (`clear_console -q`) and so returns 1 in a host. Under `set -e`
  // that became the shell's exit status — so a gate written the careful way
  // (`set -euo pipefail`, `exit 0` on the nothing-to-do path) reported FAILURE
  // on every fire where it correctly did nothing. Found 12 Sep 2026, the first
  // time a gate printed a verdict and its run still came back `dispatch-error`.
  //
  // The host's own dotfiles are NOT the fixture: these supply a hostile
  // `~/.bash_logout` of their own so the case is reproduced on any machine,
  // including ones whose real logout file is harmless or absent. Two conditions
  // are needed and both are set here — the logout file must exist, and the shell
  // must compute `SHLVL=1`, which is true of a systemd service and false of
  // anything launched from a terminal (which is why this hid for so long).
  describe('the exit code is the command’s, not the login shell’s', () => {
    let home: string;
    let savedHome: string | undefined;
    let savedShlvl: string | undefined;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'patch-exec-home-'));
      writeFileSync(
        join(home, '.bash_logout'),
        // Ubuntu's skeleton file, verbatim in shape: a `&&` that fails for want
        // of a console. `false` stands in for `clear_console -q`, which is what
        // it returns in a host.
        'if [ "$SHLVL" = 1 ]; then\n  [ -x /bin/false ] && /bin/false\nfi\n',
      );
      savedHome = process.env['HOME'];
      savedShlvl = process.env['SHLVL'];
      process.env['HOME'] = home;
      // A systemd service has no SHLVL, so the shell it starts is level 1.
      delete process.env['SHLVL'];
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      if (savedShlvl === undefined) delete process.env['SHLVL'];
      else process.env['SHLVL'] = savedShlvl;
      rmSync(home, { recursive: true, force: true });
    });

    it('`set -e` plus an explicit `exit 0` succeeds', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
      const r = await run('set -euo pipefail\necho "queue empty — holding"\nexit 0', dir);
      expect(r.exitCode).toBe(0);
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain('queue empty');
      rmSync(dir, { recursive: true, force: true });
    });

    it('...and a deliberate non-zero exit still fails, with its own code', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
      const r = await run('set -euo pipefail\necho "observer unreachable" >&2\nexit 1', dir);
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(1);
      rmSync(dir, { recursive: true, force: true });
    });

    it('passes a command full of quotes through untouched', async () => {
      // The command travels in the environment precisely so this cannot break.
      const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
      const r = await run(
        `python3 -c 'import json;print(json.dumps({"verdict": "held"}))'\necho "done \\"quoted\\" $(echo sub)"`,
        dir,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('{"verdict": "held"}');
      expect(r.stdout).toContain('done "quoted" sub');
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
