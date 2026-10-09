// The host installer (spec/02 § Installation, spec/10 § Host registration,
// spec/11 § Host installation).
//
// The live proof of this code is an artifact installing on a bare machine; what
// is pinned here is the behaviour that is expensive to re-prove and easy to
// regress: the platform refusal, the authority notice, the unit contents, the
// named pairing failures, and the machine identity.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  lstatSync,
  symlinkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorityNotice,
  parseArgs,
  passThroughEnv,
  readBuildInfo,
  readMachineSettings,
  runInstaller,
  serviceManagerFor,
  wsUrlFor,
  writeMachineSettings,
  type InstallerContext,
} from '../src/installer/main.js';
import {
  launchdPlist,
  systemdSecretsFile,
  systemdUnit,
  ServiceRegistrationError,
  type ServiceDefinition,
  type ServiceOps,
} from '../src/installer/service.js';
import { redeemPairingCode } from '../src/installer/pairing.js';
import {
  daemonIdentityPath,
  loadOrCreateDaemonIdentity,
  readDaemonIdentity,
} from '../src/identity.js';

const tmps: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BUILD = {
  version: '9.9.9',
  gitSha: 'abc1234',
  builtAt: '2026-01-01T00:00:00.000Z',
  target: 'linux-x64',
};

/** A minimal but complete artifact directory. */
function makeArtifact(target = BUILD.target): string {
  const dir = mkTmp('patch-artifact-');
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ ...BUILD, target }));
  writeFileSync(join(dir, 'daemon.mjs'), '// bundled host\n');
  writeFileSync(join(dir, 'node'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'silero_vad.onnx'), 'onnx');
  writeFileSync(join(dir, 'install'), '#!/bin/sh\n');
  mkdirSync(join(dir, 'skill', 'patch-cli'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'patch-cli', 'SKILL.md'), '# patch-cli\n');
  return dir;
}

function makeCtx(over: Partial<InstallerContext> & { home: string }): InstallerContext {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: InstallerContext = {
    artifactDir: over.artifactDir ?? makeArtifact(),
    env: { HOME: over.home, PATH: '/usr/bin:/bin', ...(over.env ?? {}) },
    argv: over.argv ?? [],
    io: over.io ?? { out: (l) => out.push(l), err: (l) => err.push(l) },
    platform: over.platform ?? 'linux',
    arch: over.arch ?? 'x64',
    uid: over.uid ?? 501,
    ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
    ...(over.serviceOps ? { serviceOps: over.serviceOps } : {}),
    ...(over.loginShellPath ? { loginShellPath: over.loginShellPath } : {}),
    // The suite provisions no sandbox: installing packages and loading an
    // AppArmor profile is the machine's business, not a unit test's. The step
    // itself is covered in installer-sandbox.test.ts.
    provisionSandbox: over.provisionSandbox ?? (async () => {}),
  };
  // Expose the captured streams for assertions.
  (ctx as unknown as { _out: string[]; _err: string[] })._out = out;
  (ctx as unknown as { _out: string[]; _err: string[] })._err = err;
  return ctx;
}
const streams = (ctx: InstallerContext): { out: string; err: string } => {
  const c = ctx as unknown as { _out: string[]; _err: string[] };
  return { out: c._out.join('\n'), err: c._err.join('\n') };
};

function recordingOps(
  runningAfterStart = true,
): ServiceOps & { registered: number; started: number } {
  const ops = {
    registered: 0,
    started: 0,
    async register(): Promise<{ unitPath: string; notes: string[] }> {
      ops.registered += 1;
      return { unitPath: '/unit/path', notes: ['registered'] };
    },
    async start(): Promise<void> {
      ops.started += 1;
    },
    async status(): Promise<string> {
      return 'active';
    },
    // The installer verifies the job is actually up rather than trusting the
    // start command's exit status — `runningAfterStart: false` is the
    // crash-looping unit that used to be reported as a successful install.
    async runState(): Promise<{ running: boolean; pid?: number; detail: string }> {
      return runningAfterStart
        ? { running: true, pid: 4242, detail: 'active (running)' }
        : { running: false, detail: 'activating (auto-restart) (Result: exit-code)' };
    },
  };
  return ops;
}

describe('the authority notice (spec/10 § The authority of a turn)', () => {
  it('names the user, the machine and the home, and states the whole authority', () => {
    const text = authorityNotice('tom', 'laptop', '/Users/tom');
    expect(text).toContain('laptop');
    expect(text).toContain("tom's whole");
    expect(text).toContain('/Users/tom');
    expect(text).toContain('sudo');
    expect(text).toContain('read, change and delete any file');
    // It says triggers carry the same authority, unattended.
    expect(text).toMatch(/Triggers.*unattended/s);
  });

  it('is printed before anything is registered', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
    });
    await runInstaller(ctx);
    const { out } = streams(ctx);
    expect(out.indexOf('what this installs')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('what this installs')).toBeLessThan(out.indexOf('installed 9.9.9'));
  });
});

describe('an artifact for the wrong platform', () => {
  it('refuses, names both sides, and writes nothing at all', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps();
    const ctx = makeCtx({
      home,
      artifactDir: makeArtifact('darwin-arm64'),
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(65);
    const { err } = streams(ctx);
    expect(err).toContain('this artifact is for darwin-arm64, but this machine is linux-x64');
    expect(err).toContain('Nothing has been installed');
    expect(ops.registered).toBe(0);
    expect(() => statSync(join(home, '.patch'))).toThrow();
  });
});

describe('the service unit', () => {
  const def: ServiceDefinition = {
    nodePath: '/home/u/.patch/versions/1/node',
    programPath: '/home/u/.patch/versions/1/daemon.mjs',
    home: '/home/u',
    uid: 1000,
    env: { HOME: '/home/u', USER: 'u', PATCH_SERVER_URL: 'http://s' },
  };

  it('systemd: restart-on-failure, start-at-boot, and NO working directory', () => {
    const unit = systemdUnit(def);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('ExecStart=/home/u/.patch/versions/1/node');
    expect(unit).not.toContain('WorkingDirectory');
    expect(unit).toContain('Environment="HOME=/home/u"');
  });

  it('systemd: credentials go in a 0600 EnvironmentFile, never inline in the unit', () => {
    const unit = systemdUnit({
      ...def,
      secretEnv: { PATCH_INTERNAL_TOKEN: 'tok-xyz', GROQ_API_KEY: 'gsk_abc' },
    });
    expect(unit).toContain('EnvironmentFile=/home/u/.patch/daemon-secrets.env');
    expect(unit).not.toContain('tok-xyz');
    expect(unit).not.toContain('gsk_abc');
    expect(systemdSecretsFile({ A: 'a"b\\c' })).toBe('A="a\\"b\\\\c"\n');
    expect(systemdUnit(def)).not.toContain('EnvironmentFile');
  });

  it('launchd: credentials still reach the plist (no EnvironmentFile there)', () => {
    expect(launchdPlist({ ...def, secretEnv: { GROQ_API_KEY: 'gsk_abc' } })).toContain('gsk_abc');
  });

  it('launchd: start-at-boot, restart-on-failure, and NO working directory', () => {
    const plist = launchdPlist(def);
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).not.toContain('WorkingDirectory');
    // An agent job inherits the invoking user; it must NOT name one.
    expect(plist).not.toContain('UserName');
  });

  it('launchd: no Background ProcessType — every chat and build inherits it', () => {
    // Background pins the host and its children to the efficiency cores with
    // throttled IO: a tsc that takes seconds took minutes.
    expect(launchdPlist(def)).not.toContain('ProcessType');
    expect(launchdPlist(def, true)).not.toContain('ProcessType');
  });

  it('launchd system host runs as the invoking user, never as root', () => {
    const plist = launchdPlist(def, true);
    expect(plist).toContain('<key>UserName</key><string>u</string>');
    expect(plist).not.toContain('WorkingDirectory');
  });

  it('a registration failure says which command failed and that nothing was started', () => {
    const e = new ServiceRegistrationError('systemctl --user enable', 'Failed to connect to bus');
    expect(e.message).toContain('systemctl --user enable');
    expect(e.message).toContain('Failed to connect to bus');
    expect(e.message).toContain('Nothing was started');
    expect(e.message).toContain('gone at the next reboot');
  });
});

describe('pairing failures are named, not lumped together', () => {
  const identity = {
    daemonId: 'd1',
    publicKey: 'pk',
    privateKey: 'sk',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const redeem = (status: number, body: unknown): ReturnType<typeof redeemPairingCode> =>
    redeemPairingCode({
      serverUrl: 'http://s',
      code: 'c',
      identity,
      label: 'm',
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

  it('an expired code is reported as expired', async () => {
    const r = await redeem(400, { error: 'code expired', code: 'nonce_expired' });
    expect(r).toMatchObject({ ok: false, kind: 'code_expired' });
    expect((r as { message: string }).message).toContain('expired');
  });

  it('an already-used code is reported as already used', async () => {
    const r = await redeem(400, { error: 'code already used', code: 'nonce_used' });
    expect(r).toMatchObject({ ok: false, kind: 'code_used' });
    expect((r as { message: string }).message).toContain('already been used');
  });

  it('a code the server never issued is reported as unrecognised', async () => {
    const r = await redeem(400, { error: 'unknown code', code: 'nonce_unknown' });
    expect(r).toMatchObject({ ok: false, kind: 'code_unknown' });
  });

  it('an unreachable server is reported as unreachable, naming the address', async () => {
    const r = await redeemPairingCode({
      serverUrl: 'http://unreachable.invalid',
      code: 'c',
      identity,
      label: 'm',
      fetchImpl: (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, kind: 'unreachable' });
    expect((r as { message: string }).message).toContain('http://unreachable.invalid');
  });

  it('submits the code together with this machine’s public key, and mints nothing', async () => {
    let seen: unknown;
    await redeemPairingCode({
      serverUrl: 'http://s',
      code: 'the-code',
      identity,
      label: 'm',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (String(url).includes('register/complete')) {
          seen = JSON.parse(String(init?.body));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{"daemonKey":"k"}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(seen).toEqual({
      nonce: 'the-code',
      daemonId: 'd1',
      label: 'm',
      publicKey: 'pk',
    });
  });
});

describe('a machine that cannot reach the server', () => {
  it('still leaves a registered service, and says the code could not be submitted', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't', '--code', 'abc'],
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(75);
    expect(ops.registered).toBe(1);
    expect(ops.started).toBe(0);
    const { err } = streams(ctx);
    expect(err).toContain('the pairing code could not be submitted');
    expect(err).toContain('The service IS registered');
    expect(err).toContain('Enter a fresh code with');
  });

  it('with no code at all, says so and stops before starting anything', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(70);
    expect(ops.registered).toBe(1);
    expect(ops.started).toBe(0);
    expect(streams(ctx).err).toContain('no pairing code');
  });
});

describe('a machine that is already registered', () => {
  it('re-uses the stored credential rather than pairing again', async () => {
    const home = mkTmp('patch-home-');
    mkdirSync(join(home, '.patch'), { recursive: true });
    writeFileSync(join(home, '.patch', 'daemon.key'), 'an-existing-daemon-key');
    const identity = loadOrCreateDaemonIdentity(join(home, '.patch'));
    const ops = recordingOps();
    let paired = false;
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
      fetchImpl: (async () => {
        paired = true;
        return new Response('{}', { status: 500 });
      }) as unknown as typeof fetch,
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(0);
    expect(paired).toBe(false);
    expect(ops.started).toBe(1);
    expect(streams(ctx).out).toContain(`already registered as ${identity.daemonId}`);
    // The stored credential is untouched.
    expect(readFileSync(join(home, '.patch', 'daemon.key'), 'utf8')).toBe('an-existing-daemon-key');
  });
});

describe('re-running the installer WITH a code on a machine already registered', () => {
  // spec/10: "Registration is per machine and idempotent." This used to abort
  // 75 and tell the user to "enter a fresh code" — advice that can never work,
  // because every fresh code hits the same 409. Only the code-less re-run was
  // idempotent, so the documented recovery path was a dead end.
  it('re-uses the stored credential instead of failing with unusable advice', async () => {
    const home = mkTmp('patch-home-');
    mkdirSync(join(home, '.patch'), { recursive: true });
    writeFileSync(join(home, '.patch', 'daemon.key'), 'an-existing-daemon-key');
    const identity = loadOrCreateDaemonIdentity(join(home, '.patch'));
    const ops = recordingOps();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't', '--code', 'c'],
      // 409 is the server saying "a machine is already registered".
      fetchImpl: (async () =>
        new Response('a machine is already registered', {
          status: 409,
        })) as unknown as typeof fetch,
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(0);
    expect(streams(ctx).out).toContain(`already registered as ${identity.daemonId}`);
    expect(streams(ctx).err).not.toContain('Enter a fresh code');
    // The stored credential is untouched.
    expect(readFileSync(join(home, '.patch', 'daemon.key'), 'utf8')).toBe('an-existing-daemon-key');
  });
});

describe('an install whose service does not stay up', () => {
  // The regression this guards: `systemctl restart` and `launchctl kickstart`
  // both exit 0 for a unit that starts and immediately dies, so the installer
  // printed "service started" and exited 0 over a host that crash-looped
  // forever. A person was told the machine was installed and working when it
  // was registered and permanently offline.
  it('reports the failure and exits non-zero rather than claiming success', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps(false);
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't', '--code', 'c'],
      fetchImpl: (async () =>
        new Response(JSON.stringify({ daemonKey: 'k' }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const res = await runInstaller(ctx);
    expect(res.code).not.toBe(0);
    expect(ops.started).toBe(1);
    const err = streams(ctx).err;
    expect(err).toContain('the service was started but is not running');
    // It must not claim the machine is ready to use.
    expect(streams(ctx).out).not.toContain('It appears under Settings → Hosts');
  });
});

describe('what the install puts on the machine', () => {
  it('replaces a legacy CLI symlink without overwriting the bundled JavaScript', async () => {
    const home = mkTmp('patch-home-');
    const artifactDir = makeArtifact('linux-x64');
    mkdirSync(join(artifactDir, 'bin'), { recursive: true });
    writeFileSync(join(artifactDir, 'bin/patch.js'), '// bundled CLI');
    const launcher = join(home, '.local/bin/patch');
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    symlinkSync(join(home, '.patch/current/bin/patch.js'), launcher);
    await runInstaller(
      makeCtx({
        home,
        artifactDir,
        serviceOps: recordingOps(),
        argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
      }),
    );
    expect(readFileSync(join(home, '.patch/current/bin/patch.js'), 'utf8')).toBe('// bundled CLI');
    expect(lstatSync(launcher).isSymbolicLink()).toBe(false);
    expect(readFileSync(launcher, 'utf8')).toContain('#!/bin/sh');
  });

  it('installs under the user’s own HOME and writes the patch-cli skill there', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
    });
    await runInstaller(ctx);
    const installDir = join(home, '.patch', 'versions', '9.9.9');
    expect(readFileSync(join(installDir, 'daemon.mjs'), 'utf8')).toContain('bundled host');
    expect(readFileSync(join(installDir, 'silero_vad.onnx'), 'utf8')).toBe('onnx');
    expect(
      readFileSync(join(home, '.claude', 'skills', 'patch-cli', 'SKILL.md'), 'utf8'),
    ).toContain('patch-cli');
  });

  it('rewrites a clobbered skill on the next install', async () => {
    const home = mkTmp('patch-home-');
    const skill = join(home, '.claude', 'skills', 'patch-cli');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'clobbered');
    const ctx = makeCtx({
      home,
      serviceOps: recordingOps(),
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
    });
    await runInstaller(ctx);
    expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toContain('patch-cli');
  });

  it('carries the machine’s settings into the unit, and keeps them on a bare re-run', async () => {
    const home = mkTmp('patch-home-');
    let captured: Record<string, string> = {};
    const ops: ServiceOps = {
      async register(def) {
        captured = { ...def.env, ...def.secretEnv };
        return { unitPath: '/u', notes: [] };
      },
      async start() {},
      async status() {
        return '';
      },
    };
    const first = makeCtx({
      home,
      serviceOps: ops,
      env: { GROQ_API_KEY: 'gk', WHISPER_BACKEND: 'groq' },
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
    });
    await runInstaller(first);
    expect(captured['GROQ_API_KEY']).toBe('gk');
    expect(captured['VAD_BACKEND']).toBe('silero');
    expect(captured['VAD_MODEL_PATH']).toBe(
      join(home, '.patch', 'versions', '9.9.9', 'silero_vad.onnx'),
    );
    expect(captured['SDK_BACKEND']).toBe('real');

    // A re-run with an empty environment and no flags must not lose them.
    captured = {};
    const second = makeCtx({ home, serviceOps: ops, argv: ['--non-interactive'] });
    await runInstaller(second);
    expect(captured['GROQ_API_KEY']).toBe('gk');
    expect(captured['PATCH_SERVER_URL']).toBe('http://s');
    expect(captured['PATCH_INTERNAL_TOKEN']).toBe('t');
  });
});

describe('installer plumbing', () => {
  it('parses flags and falls back to the documented env vars', () => {
    const a = parseArgs(['--code', 'c', '--server', 'http://s', '--non-interactive'], {});
    expect(a).toMatchObject({ code: 'c', serverUrl: 'http://s', nonInteractive: true });
    const b = parseArgs([], { PATCH_PAIRING_CODE: 'x', PATCH_INTERNAL_TOKEN: 'y' });
    expect(b).toMatchObject({ code: 'x', internalToken: 'y' });
    expect(() => parseArgs(['--code'], {})).toThrow('--code needs a value');
    expect(() => parseArgs(['--nope'], {})).toThrow('unknown option: --nope');
  });

  it('derives the host’s WebSocket URL from the server URL', () => {
    expect(wsUrlFor('https://patch.example.com')).toBe('wss://patch.example.com/ws');
    expect(wsUrlFor('http://127.0.0.1:3000/')).toBe('ws://127.0.0.1:3000/ws');
  });

  it('knows which service manager a platform has, and refuses the rest', () => {
    expect(serviceManagerFor('darwin')).toBe('launchd');
    expect(serviceManagerFor('linux')).toBe('systemd');
    expect(() => serviceManagerFor('win32')).toThrow('unsupported platform');
  });

  it('refuses an artifact that is not stamped', () => {
    const dir = mkTmp('patch-artifact-');
    expect(() => readBuildInfo(dir)).toThrow('is missing');
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ version: '1' }));
    expect(() => readBuildInfo(dir)).toThrow('not stamped');
  });

  it('passes only the documented machine settings through', () => {
    expect(passThroughEnv({ GROQ_API_KEY: 'g', SOMETHING_ELSE: 'x', TZ: '' })).toEqual({
      GROQ_API_KEY: 'g',
    });
  });

  it('stores machine settings 0600 under the user’s own patch home', () => {
    const patchHome = mkTmp('patch-home-');
    writeMachineSettings(patchHome, { serverUrl: 'http://s', env: { A: 'b' } });
    expect(readMachineSettings(patchHome)).toEqual({ serverUrl: 'http://s', env: { A: 'b' } });
    expect(statSync(join(patchHome, 'machine.json')).mode & 0o777).toBe(0o600);
    expect(readMachineSettings(mkTmp('patch-empty-'))).toEqual({});
  });
});

describe('the machine’s own identity', () => {
  let patchHome: string;
  beforeEach(() => {
    patchHome = mkTmp('patch-identity-');
  });

  it('is minted once and is stable across calls', () => {
    const a = loadOrCreateDaemonIdentity(patchHome);
    const b = loadOrCreateDaemonIdentity(patchHome);
    expect(b).toEqual(a);
    expect(a.daemonId).toHaveLength(26);
    expect(statSync(daemonIdentityPath(patchHome)).mode & 0o777).toBe(0o600);
  });

  it('is a real keypair — the public key derives from the private one', () => {
    const a = loadOrCreateDaemonIdentity(patchHome);
    writeFileSync(daemonIdentityPath(patchHome), JSON.stringify({ ...a, publicKey: 'AAAA' }));
    expect(() => readDaemonIdentity(patchHome)).toThrow('does not match');
  });

  it('a malformed identity is an error, never a silent re-mint', () => {
    writeFileSync(daemonIdentityPath(patchHome), '{"daemonId":"x"}');
    expect(() => readDaemonIdentity(patchHome)).toThrow('malformed');
    expect(readDaemonIdentity(mkTmp('patch-none-'))).toBeUndefined();
  });
});

describe('the shipping targets (spec/11 § Host installation)', () => {
  it('is macOS arm64 + Linux x64/arm64 — and NOT macOS x64', async () => {
    const { TARGETS } = (await import('../../../scripts/build-daemon.mjs')) as {
      TARGETS: { target: string }[];
    };
    expect(TARGETS.map((t) => t.target).sort()).toEqual([
      'darwin-arm64',
      'linux-arm64',
      'linux-x64',
    ]);
    // onnxruntime-node ships no darwin-x64 binary and every artifact carries
    // VAD, so the target cannot be built.
    expect(TARGETS.some((t) => t.target === 'darwin-x64')).toBe(false);
  });
});

describe('a machine added with only a pairing code (no --internal-token)', () => {
  function pairingServer(body: Record<string, unknown>): {
    fetchImpl: typeof fetch;
    completes: () => number;
  } {
    let completes = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/register/complete')) {
        completes += 1;
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, completes: () => completes };
  }

  it('takes the secret from pairing, before the service it goes into is registered', async () => {
    const home = mkTmp('patch-home-');
    const envs: Record<string, string>[] = [];
    const ops = recordingOps();
    const register = ops.register.bind(ops);
    ops.register = async (def: ServiceDefinition) => {
      envs.push({ ...def.env, ...def.secretEnv });
      return register(def);
    };
    const server = pairingServer({ daemonKey: 'k', internalToken: 'server-secret' });
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--code', 'abc'],
      fetchImpl: server.fetchImpl,
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(0);
    expect(envs[0]?.['PATCH_INTERNAL_TOKEN']).toBe('server-secret');
    // Paired once — the code is single-use, so a second attempt would fail.
    expect(server.completes()).toBe(1);
    expect(readMachineSettings(join(home, '.patch')).internalToken).toBe('server-secret');
    expect(ops.started).toBe(1);
  });

  it('stops before registering anything when the server does not hand the secret over', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps();
    const server = pairingServer({ daemonKey: 'k' });
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s', '--code', 'abc'],
      fetchImpl: server.fetchImpl,
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(75);
    expect(ops.registered).toBe(0);
    expect(streams(ctx).err).toContain('did not hand over its voice-session secret');
  });

  it('with neither a code nor the secret, asks for a code', async () => {
    const home = mkTmp('patch-home-');
    const ops = recordingOps();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      argv: ['--non-interactive', '--server', 'http://s'],
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(64);
    expect(ops.registered).toBe(0);
    expect(streams(ctx).err).toContain('--code <code>');
  });
});

describe("a Mac's service PATH", () => {
  function capture(): { ops: ReturnType<typeof recordingOps>; envs: Record<string, string>[] } {
    const envs: Record<string, string>[] = [];
    const ops = recordingOps();
    const register = ops.register.bind(ops);
    ops.register = async (def: ServiceDefinition) => {
      envs.push(def.env);
      return register(def);
    };
    return { ops, envs };
  }

  it("is the user's login-shell PATH, not the installer's own", async () => {
    const home = mkTmp('patch-home-');
    const { ops, envs } = capture();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      platform: 'darwin',
      arch: 'arm64',
      artifactDir: makeArtifact('darwin-arm64'),
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
      loginShellPath: () => '/opt/homebrew/bin:/usr/bin:/bin',
    });
    await runInstaller(ctx);
    expect(envs[0]?.['PATH']).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('stops the install when the login shell will not say, rather than guess one', async () => {
    const home = mkTmp('patch-home-');
    const { ops } = capture();
    const ctx = makeCtx({
      home,
      serviceOps: ops,
      platform: 'darwin',
      arch: 'arm64',
      artifactDir: makeArtifact('darwin-arm64'),
      argv: ['--non-interactive', '--server', 'http://s', '--internal-token', 't'],
      loginShellPath: () => {
        throw new Error("could not read your login shell's PATH from /bin/zsh: timed out");
      },
    });
    const res = await runInstaller(ctx);
    expect(res.code).toBe(69);
    expect(ops.registered).toBe(0);
    expect(streams(ctx).err).toContain("login shell's PATH");
  });
});
