// Script jobs — the host half (spec/08 § Action — `script`).
//
// A `script` job's fire arrives as `job.exec_request`: run this command, in
// this folder, on this host. There is no chat and no model anywhere in the
// path — that is the point of it, and it is why the host runs the command
// itself rather than routing it through a chat's Bash tool.
//
// NO FALLBACK: a folder that does not exist fails the fire and says so. It is
// never run somewhere else instead — a tick pointed at the wrong directory
// that silently ran in the host's home would report success while doing
// nothing.

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
import type { JobExecRequestEvent, WireEvent } from '@patch/wire';
import { SCRIPT_ACTION_OUTPUT_LIMIT } from '@patch/wire/jobs';
import { expandHome } from './expandHome.js';

/** Keep the TAIL: the interesting part of a failing command is its last words. */
function tail(s: string): string {
  const t = s.trimEnd();
  return t.length <= SCRIPT_ACTION_OUTPUT_LIMIT
    ? t
    : `…${t.slice(t.length - SCRIPT_ACTION_OUTPUT_LIMIT)}`;
}

export function handleJobExec(
  event: JobExecRequestEvent,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  const started = Date.now();
  const reply = (r: {
    ok: boolean;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
  }): void => {
    sender({
      type: 'job.exec_result',
      jobId: event.jobId,
      fireId: event.fireId,
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: Date.now() - started,
      stdout: tail(r.stdout ?? ''),
      stderr: tail(r.stderr ?? ''),
      ...(r.error !== undefined ? { error: r.error } : {}),
    });
  };

  // Typed the way a shell accepts a path — `~/projects/x` — but this never
  // goes through a shell, so expand it before any fs call.
  const folder = expandHome(event.folder);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    logger.error(
      { jobId: event.jobId, folder: event.folder },
      'job.exec_request: folder not found, refusing to run elsewhere',
    );
    reply({
      ok: false,
      exitCode: null,
      error: `folder not found on this host: ${event.folder}`,
    });
    return;
  }

  // A login shell, then the command in a plain one. Two separate needs.
  //
  // LOGIN, because the command is written by the same person who writes the
  // host's dotfiles, and a tick that works when they type it must work here —
  // the profile's PATH especially.
  //
  // But a non-interactive LOGIN shell reads `~/.bash_logout` whenever `exit` is
  // executed explicitly, and Ubuntu's default one ends in
  //
  //     [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q
  //
  // which returns 1 for want of a console — a host has none, ever. That
  // becomes the shell's exit status, so `set -euo pipefail` + `exit 0`, i.e. how
  // every careful gate is written, reported FAILURE on every correct hold
  // (caught 12 Sep 2026 the first time a gate printed a verdict and the run
  // still came back `dispatch-error`). `exec` is the fix: it replaces the login
  // shell with a plain one, so there is no login shell left to read a logout
  // file, and the status recorded is the command's own and nothing else.
  //
  // The command travels in the ENVIRONMENT rather than inside the `-c` string so
  // there is no quoting to get wrong — a gate is full of quotes and heredocs.
  const child = execFile(
    '/bin/bash',
    ['-lc', 'exec /bin/bash -c "$PATCH_JOB_COMMAND"'],
    {
      cwd: folder,
      env: { ...process.env, PATCH_JOB_COMMAND: event.command },
      timeout: event.timeoutMs,
      // Enough for the tail on both streams plus slack; the cap is applied
      // again on the way out.
      maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
    },
    (err, stdout, stderr) => {
      if (err === null) {
        reply({ ok: true, exitCode: 0, stdout, stderr });
        return;
      }
      const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      const code = typeof err.code === 'number' ? err.code : null;
      logger.warn(
        { jobId: event.jobId, exitCode: code, killed, err: err.message },
        'job.exec_request: command failed',
      );
      reply({
        ok: false,
        exitCode: code,
        stdout,
        stderr,
        error: killed
          ? `command killed after its ${event.timeoutMs}ms timeout`
          : `command failed: ${err.message}`,
      });
    },
  );
  // The tick is the host's work, not a reason to keep the process alive.
  child.unref();
}
