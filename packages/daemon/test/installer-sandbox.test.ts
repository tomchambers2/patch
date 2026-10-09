// The install step that provisions the agent sandbox (installer/sandbox.ts).
//
// What matters here is that there is ONE path: a machine finishes this step
// with a sandbox that actually creates a user namespace, or the install stops
// and names the commands that fix it. There is no "sandbox unavailable" mode
// to assert, because there is not supposed to be one.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { provisionSandbox, SandboxProvisionError } from '../src/installer/sandbox.js';

// The module shells out through node:child_process.execFile; the suite drives
// it by scripting what each command returns, rather than touching the machine
// running the tests.
const calls: string[][] = [];
let script: (file: string, args: string[]) => { stdout: string } | Error;

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push([file, ...args]);
    const r = script(file, args);
    if (r instanceof Error) cb(r);
    else cb(null, { stdout: r.stdout, stderr: '' });
  },
}));

const io = {
  lines: [] as string[],
  out(l: string) {
    this.lines.push(l);
  },
};

afterEach(() => {
  calls.length = 0;
  io.lines = [];
});

/** A machine where `have` are on PATH, sudo works, and bwrap runs iff `userns`. */
function machine(opts: {
  have: string[];
  sudo?: boolean;
  userns: boolean;
  apparmorFixes?: boolean;
}) {
  let nsWorks = opts.userns;
  return (file: string, args: string[]): { stdout: string } | Error => {
    if (file === 'sh' && args[0] === '-c') {
      const prog = args[1]!.replace('command -v ', '');
      return opts.have.includes(prog) ? { stdout: `/usr/bin/${prog}` } : new Error('not found');
    }
    if (file === 'sudo' && args[1] === 'true') {
      return opts.sudo === false ? new Error('sudo: a password is required') : { stdout: '' };
    }
    if (file === 'bwrap') {
      return nsWorks ? { stdout: '' } : new Error('bwrap: setting up uid map: Permission denied');
    }
    if (file === 'sudo' && args[1] === 'apparmor_parser') {
      if (opts.apparmorFixes) nsWorks = true;
      return { stdout: '' };
    }
    if (file === 'sudo') return { stdout: '' };
    return new Error(`unscripted: ${file}`);
  };
}

describe('provisionSandbox', () => {
  it('does nothing on macOS — the sandbox is part of the OS', async () => {
    script = () => new Error('nothing should be run on darwin');
    await provisionSandbox('darwin', io);
    expect(calls).toEqual([]);
    expect(io.lines.join('\n')).toContain('sandbox-exec');
  });

  it('passes through a linux machine that already has a working sandbox', async () => {
    script = machine({ have: ['bwrap', 'socat'], userns: true });
    await provisionSandbox('linux', io);
    // Nothing installed, no profile written: only the checks were run.
    expect(calls.some((c) => c[0] === 'sudo' && c.includes('apt-get'))).toBe(false);
    expect(calls.some((c) => c[0] === 'bwrap')).toBe(true);
  });

  it('installs the missing packages when the machine has a package manager', async () => {
    script = machine({ have: ['apt-get'], userns: true });
    await provisionSandbox('linux', io);
    const install = calls.find((c) => c[0] === 'sudo' && c.includes('apt-get'));
    expect(install).toBeDefined();
    expect(install).toContain('bubblewrap');
    expect(install).toContain('socat');
  });

  it('grants userns via an AppArmor profile when bwrap cannot make one', async () => {
    script = machine({ have: ['bwrap', 'socat'], userns: false, apparmorFixes: true });
    await provisionSandbox('linux', io);
    expect(calls.some((c) => c.includes('apparmor_parser'))).toBe(true);
    expect(io.lines.join('\n')).toContain('/etc/apparmor.d/bwrap');
  });

  it('stops the install, with the commands, when there is no passwordless sudo', async () => {
    script = machine({ have: ['bwrap', 'socat'], sudo: false, userns: false });
    await expect(provisionSandbox('linux', io)).rejects.toThrow(SandboxProvisionError);
    await expect(provisionSandbox('linux', io)).rejects.toMatchObject({
      remedy: expect.arrayContaining([expect.stringContaining('apparmor_parser')]),
    });
  });

  it('stops the install when no supported package manager exists', async () => {
    script = machine({ have: [], userns: false });
    await expect(provisionSandbox('linux', io)).rejects.toThrow(/package manager/);
  });

  // The failure this whole step exists to prevent: everything "succeeded" and
  // the sandbox still does not work. That must stop the install, not pass.
  it('stops the install when the profile loads and userns still fails', async () => {
    script = machine({ have: ['bwrap', 'socat'], userns: false, apparmorFixes: false });
    await expect(provisionSandbox('linux', io)).rejects.toThrow(/still cannot create/);
  });
});
