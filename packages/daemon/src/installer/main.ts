// The host installer: first run on a machine that has only an OS on it.
//
// spec/02 § Installation, spec/10 § Host registration, spec/11 § Host
// installation. It is shipped inside the artifact and run either by a person
// (`curl … | sh`, or `./install` from an unpacked artifact) or by a surface
// (`./install --non-interactive --code …`). Both routes run this same program.
//
// What it does, in this order and no other:
//
//   1. refuses an artifact built for a different machine, before it touches
//      anything at all;
//   2. states, once, what the host will be able to do on this machine
//      (spec/10 § The authority of a turn);
//   3. installs the artifact under the user's own ~/.patch and writes the
//      patch-cli skill into the user's own agent skills directory;
//   4. provisions the agent sandbox this machine runs every turn inside,
//      because `auto` without one degrades into asking about every command;
//   5. registers the service with launchd / systemd, with restart-on-failure
//      and start-at-boot;
//   6. redeems the pairing code the user took from an already-linked surface,
//      submitting it with this machine's public key;
//   7. starts the service.
//
// The service is registered BEFORE pairing on purpose: a machine that cannot
// reach the server must still end up with a real, registered service and a
// clear "the code could not be submitted", so a fresh code can be entered later
// (spec/11, unhappy paths). Nothing here is a fallback: each failure stops the
// install where it is and says which step failed and why.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  createReadStream,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type ReadStream,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { hostname, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateDaemonIdentity } from '../identity.js';
import { readDaemonKey, writeDaemonKey } from '../registration.js';
import { redeemPairingCode } from './pairing.js';
import { provisionSandbox, SandboxProvisionError } from './sandbox.js';
import {
  opsFor,
  daemonLogTail,
  ServiceRegistrationError,
  SERVICE_LABEL,
  SYSTEMD_UNIT,
  type ServiceDefinition,
  type ServiceManager,
  type ServiceOps,
  type ServiceRunState,
} from './service.js';

/**
 * Whether the job is up, once it has had a moment to fall over. A crash-looping
 * host is "running" for the instant between exec and abort, so sampling once
 * immediately after start reports success for a service that is already dying.
 * Poll until it is up and STAYS up, or until the window closes.
 */
async function settledRunState(
  ops: ServiceOps,
  def: ServiceDefinition,
  attempts = 6,
  delayMs = 500,
): Promise<ServiceRunState> {
  let last: ServiceRunState = { running: false, detail: 'service never reported a state' };
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await ops.runState(def);
    if (!last.running) return last;
  }
  return last;
}

export interface InstallerIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Ask the user a question. Absent in non-interactive runs. */
  ask?: (question: string) => Promise<string>;
}

export interface InstallerContext {
  /** The unpacked artifact directory (where this program lives). */
  artifactDir: string;
  env: NodeJS.ProcessEnv;
  argv: string[];
  io: InstallerIo;
  platform: NodeJS.Platform;
  arch: string;
  uid: number;
  fetchImpl?: typeof fetch;
  /** Service-manager override — test hook, so a unit test registers nothing. */
  serviceOps?: ServiceOps;
  /**
   * Sandbox-provisioning override — test hook, alongside `serviceOps`, so a
   * unit test installs no packages and touches no AppArmor profile on the
   * machine running the suite.
   */
  provisionSandbox?: (platform: NodeJS.Platform, io: { out(line: string): void }) => Promise<void>;
  /** Login-shell PATH override — test hook, so a unit test runs no shell. */
  loginShellPath?: () => string;
}

export interface BuildInfo {
  version: string;
  gitSha: string;
  builtAt: string;
  target: string;
}

/**
 * spec/10 § The authority of a turn: "The installer states what the host will
 * be able to do on the machine, once, before it registers." Plain language, no
 * jargon, and it names the actual user and the actual machine.
 */
export function authorityNotice(user: string, machine: string, home: string): string {
  return [
    '',
    '  Patch host — what this installs, and what it will be able to do',
    '',
    `  The host runs on this machine (${machine}) as ${user}, with ${user}'s whole`,
    '  authority. A chat opened against this machine from any of your linked',
    '  surfaces — phone, web, desktop — can do anything you can do from your own',
    '  shell here:',
    '',
    '    * read, change and delete any file you can, anywhere on this machine',
    `    * run any installed command, including sudo and docker where ${user} has them`,
    '    * reach services on this machine that are not exposed to the network',
    '    * use the credentials, SSH keys and logins already on this machine',
    '',
    `  It runs under ${home}, so it reads your own agent configuration and behaves`,
    '  the way your agent behaves in your terminal. It keeps its own state in',
    `  ${join(home, '.patch')} and nowhere else.`,
    '',
    '  Triggers — a message, a webhook, a schedule — start turns',
    '  with that same authority, unattended.',
    '',
  ].join('\n');
}

interface Args {
  code?: string;
  serverUrl?: string;
  internalToken?: string;
  hostName?: string;
  nonInteractive: boolean;
  help: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const args: Args = { nonInteractive: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--code') args.code = next();
    else if (a === '--server') args.serverUrl = next();
    else if (a === '--internal-token') args.internalToken = next();
    else if (a === '--host-name') args.hostName = next();
    else if (a === '--non-interactive') args.nonInteractive = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (args.code === undefined && env['PATCH_PAIRING_CODE']) args.code = env['PATCH_PAIRING_CODE'];
  if (args.serverUrl === undefined && env['PATCH_SERVER_URL'])
    args.serverUrl = env['PATCH_SERVER_URL'];
  if (args.internalToken === undefined && env['PATCH_INTERNAL_TOKEN'])
    args.internalToken = env['PATCH_INTERNAL_TOKEN'];
  if (args.hostName === undefined && env['PATCH_HOST_NAME']) args.hostName = env['PATCH_HOST_NAME'];
  return args;
}

const USAGE = `patch host installer

  ./install --server <url> [--code <pairing code>] [--internal-token <token>]

  --server <url>            the patch server this machine reports to
  --internal-token <token>  the server's voice-session secret (default: sent at pairing)
  --code <code>             the pairing code from a linked surface's Add host
  --host-name <name>        what to call this machine (default: its hostname)
  --non-interactive         never prompt; used when a surface runs the install
  -h, --help                this
`;

/**
 * The PATH the user's login shell builds, read by running it the way Terminal
 * does (login + interactive, so both .zprofile and .zshrc apply). The value is
 * fenced with markers because an interactive shell may print a banner.
 */
export function loginShellPath(env: NodeJS.ProcessEnv): string {
  const shell = env['SHELL'] && env['SHELL'].length > 0 ? env['SHELL'] : '/bin/zsh';
  const mark = '__PATCH_PATH__';
  let printed: string;
  try {
    printed = execFileSync(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      env: { HOME: env['HOME'] ?? '', USER: env['USER'] ?? '', SHELL: shell, TERM: 'dumb' },
    });
  } catch (err) {
    throw new Error(
      `could not read your login shell's PATH from ${shell}: ${(err as Error).message}`,
    );
  }
  const found = new RegExp(`${mark}(.*?)${mark}`, 's').exec(printed)?.[1];
  if (!found) throw new Error(`${shell} did not print a PATH when asked for one`);
  return found;
}

/** Whether this run can get a pairing code: named, or askable. */
function canPair(args: Args, io: InstallerIo): boolean {
  return args.code !== undefined || (!args.nonInteractive && io.ask !== undefined);
}

/** The pairing code: the one named, else asked for. `undefined` when neither. */
async function pairingCode(args: Args, io: InstallerIo): Promise<string | undefined> {
  if (args.code !== undefined) return args.code.length > 0 ? args.code : undefined;
  if (args.nonInteractive || !io.ask) return undefined;
  io.out('');
  io.out('  Open Settings → Hosts → Add host on a linked surface and read the code.');
  const code = (await io.ask('  Pairing code: ')).trim();
  return code.length > 0 ? code : undefined;
}

/** Which service manager this machine has. Anything else is not a target. */
export function serviceManagerFor(platform: NodeJS.Platform): ServiceManager {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  throw new Error(`unsupported platform: ${platform} (patch installs on macOS and Linux)`);
}

export function readBuildInfo(artifactDir: string): BuildInfo {
  const path = join(artifactDir, 'build-info.json');
  if (!existsSync(path)) {
    throw new Error(`${path} is missing — this is not a complete patch host artifact`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildInfo>;
  for (const key of ['version', 'gitSha', 'builtAt', 'target'] as const) {
    if (typeof raw[key] !== 'string' || raw[key]?.length === 0) {
      throw new Error(`${path}: missing "${key}" — the artifact is not stamped`);
    }
  }
  return raw as BuildInfo;
}

/**
 * Machine-level settings the host reads from its own environment (spec/11
 * § Env). They are passed to the installer and written into the service unit,
 * so the host has them on every start without anyone editing the unit.
 */
export const PASSTHROUGH_ENV = [
  'WHISPER_BACKEND',
  'GROQ_API_KEY',
  'WHISPER_LOCAL_SIDECAR_URL',
  'KOKORO_BACKEND',
  'KOKORO_SIDECAR_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'TZ',
] as const;

/** Passed-through variables that are credentials, kept out of the unit file. */
export const SECRET_ENV = ['GROQ_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export function passThroughEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = env[key];
    if (v !== undefined && v !== '') out[key] = v;
  }
  return out;
}

/**
 * What this machine was installed with, kept under the user's own ~/.patch.
 *
 * spec/10 § Host registration: "Re-running the installer on a host that is
 * already registered re-uses what is already stored." That has to cover the
 * machine's settings too, not just its credential — a re-run invoked without,
 * say, GROQ_API_KEY in its environment must not quietly rewrite the service
 * unit without it and leave the host refusing to boot. Anything named on the
 * re-run wins; anything not named is what it already was.
 */
export interface MachineSettings {
  serverUrl?: string;
  internalToken?: string;
  hostName?: string;
  env?: Record<string, string>;
}

export function machineSettingsPath(patchHome: string): string {
  return join(patchHome, 'machine.json');
}

export function readMachineSettings(patchHome: string): MachineSettings {
  const path = machineSettingsPath(patchHome);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as MachineSettings;
}

export function writeMachineSettings(patchHome: string, settings: MachineSettings): void {
  const path = machineSettingsPath(patchHome);
  mkdirSync(patchHome, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Derive the WebSocket URL the host dials from the server's HTTP URL. */
export function wsUrlFor(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`;
  return u.toString();
}

export interface InstallResult {
  code: number;
}

export async function runInstaller(ctx: InstallerContext): Promise<InstallResult> {
  const { io } = ctx;
  let args: Args;
  try {
    args = parseArgs(ctx.argv, ctx.env);
  } catch (err) {
    io.err(`patch install: ${(err as Error).message}`);
    io.err(USAGE);
    return { code: 64 };
  }
  if (args.help) {
    io.out(USAGE);
    return { code: 0 };
  }

  // ---- 1. Right artifact for this machine? ------------------------------
  // Checked FIRST, and before anything is written, copied or registered: an
  // artifact for the wrong platform refuses rather than half-installing.
  const build = readBuildInfo(ctx.artifactDir);
  const here = `${ctx.platform}-${ctx.arch}`;
  if (build.target !== here) {
    io.err(
      `patch install: this artifact is for ${build.target}, but this machine is ${here}.\n` +
        'Nothing has been installed. Download the artifact for this platform and run that one.',
    );
    return { code: 65 };
  }

  const home = ctx.env['HOME'];
  if (home === undefined || home.length === 0) {
    io.err('patch install: HOME is not set. The host lives under the invoking user’s home.');
    return { code: 78 };
  }
  const user = userInfo().username;
  const machine = args.hostName ?? readMachineSettings(join(home, '.patch')).hostName ?? hostname();

  // What this machine already knows about itself; anything named on this run
  // overrides it, anything not named survives untouched.
  const stored = readMachineSettings(join(home, '.patch'));
  const serverUrl = args.serverUrl ?? stored.serverUrl;
  if (serverUrl === undefined || serverUrl.length === 0) {
    io.err('patch install: --server <url> is required (or PATCH_SERVER_URL).');
    io.err(USAGE);
    return { code: 64 };
  }
  // Known up front only on a re-install or when named. Otherwise the server
  // hands it over at pairing (spec/10 § Host registration), which is then
  // done before the service is registered, since the service cannot run
  // without it.
  let internalToken = args.internalToken ?? stored.internalToken;
  if ((internalToken === undefined || internalToken.length === 0) && !canPair(args, io)) {
    io.err(
      'patch install: no pairing code. Open Settings → Hosts → Add host on a linked surface ' +
        'and run this again with --code <code>.',
    );
    io.err(USAGE);
    return { code: 64 };
  }

  // ---- 2. Say what this machine is agreeing to, once, up front ----------
  io.out(authorityNotice(user, machine, home));
  if (!args.nonInteractive && io.ask) {
    const answer = (await io.ask('  Install the patch host on this machine? [y/N] ')).trim();
    if (!/^y(es)?$/i.test(answer)) {
      io.out('  Nothing installed.');
      return { code: 1 };
    }
  }

  // ---- 3. Put the artifact under the user's own ~/.patch ----------------
  const patchHome = join(home, '.patch');
  const installDir = join(patchHome, 'versions', build.version);
  mkdirSync(installDir, { recursive: true });
  if (resolve(ctx.artifactDir) !== resolve(installDir)) {
    cpSync(ctx.artifactDir, installDir, { recursive: true });
  }
  for (const exe of ['node', 'install']) {
    const p = join(installDir, exe);
    if (existsSync(p)) chmodSync(p, 0o755);
  }
  const current = join(patchHome, 'current');
  rmSync(current, { force: true, recursive: false });
  symlinkSync(installDir, current);
  io.out(`  installed ${build.version} (${build.gitSha}, built ${build.builtAt}) → ${installDir}`);

  // ---- 4. The patch-cli skill, in the user's own skills directory -------
  // spec/17 § Skill: written on install and rewritten on every self-update, so
  // every chat on this machine can drive the CLI and the skill matches the
  // host it describes.
  const skillSrc = join(installDir, 'skill', 'patch-cli');
  if (!existsSync(join(skillSrc, 'SKILL.md'))) {
    io.err(`patch install: the artifact carries no patch-cli skill at ${skillSrc}`);
    return { code: 65 };
  }
  const skillDest = join(home, '.claude', 'skills', 'patch-cli');
  mkdirSync(dirname(skillDest), { recursive: true });
  rmSync(skillDest, { force: true, recursive: true });
  cpSync(skillSrc, skillDest, { recursive: true });
  io.out(`  patch-cli skill written to ${skillDest}`);

  // The `patch` program the skill just told every chat on this machine to run.
  // Shipping the skill without the binary meant its very first instruction
  // (`patch chats list --json`) failed on a freshly installed machine. The
  // launcher runs the artifact's own pinned Node against the bundled CLI, so it
  // needs nothing on the machine.
  const cliBundle = join(installDir, 'bin', 'patch.js');
  if (existsSync(cliBundle)) {
    const binDir = join(home, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    const launcher = join(binDir, 'patch');
    const launcherTmp = `${launcher}.new-${process.pid}`;
    writeFileSync(
      launcherTmp,
      `#!/bin/sh\nexec ${JSON.stringify(join(installDir, 'node'))} ${JSON.stringify(cliBundle)} "$@"\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
    // Replace a legacy symlink itself, never follow it into the CLI bundle.
    renameSync(launcherTmp, launcher);
    chmodSync(launcher, 0o755);
    io.out(`  patch CLI installed at ${launcher}`);
    if (!(ctx.env['PATH'] ?? '').split(':').includes(binDir)) {
      // Said out loud rather than silently leaving a binary nobody can reach.
      io.out(`  NOTE: ${binDir} is not on PATH — add it to run \`patch\``);
    }
  } else {
    // An artifact without the CLI must not claim the skill's instructions work.
    io.err(
      `patch install: WARNING the artifact carries no patch CLI at ${cliBundle}; ` +
        'the patch-cli skill describes commands this machine cannot run',
    );
  }

  // ---- 5. The agent sandbox this machine will run every turn inside -----
  // Before the service exists, because a host whose sandbox does not work is
  // a host that parks every unattended job on its first command (see
  // sandbox.ts). Provisioned on the machine, like the backend itself.
  try {
    await (ctx.provisionSandbox ?? provisionSandbox)(ctx.platform, io);
  } catch (err) {
    if (!(err instanceof SandboxProvisionError)) throw err;
    io.err(`patch install: ${err.message}`);
    for (const line of err.remedy) io.err(`  ${line}`);
    return { code: 65 };
  }

  // ---- 5b. Pair first when the server's secret is not yet known ----------
  const identity = loadOrCreateDaemonIdentity(patchHome);
  let pairedEarly = false;
  if (internalToken === undefined || internalToken.length === 0) {
    const code = await pairingCode(args, io);
    if (code === undefined) {
      io.err('patch install: no pairing code, so this machine cannot join the account.');
      return { code: 70 };
    }
    const result = await redeemPairingCode({
      serverUrl,
      code,
      identity,
      label: machine,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    if (!result.ok) {
      io.err(`patch install: the pairing code could not be submitted — ${result.message}`);
      io.err('  Nothing is registered yet. Get a fresh code and run this again.');
      return { code: 75 };
    }
    if (result.internalToken === undefined) {
      io.err(
        'patch install: the server paired this machine but did not hand over its voice-session ' +
          'secret, so the host cannot start. The server predates this installer: update it, ' +
          'or run this again with --internal-token <token>.',
      );
      return { code: 75 };
    }
    writeDaemonKey(patchHome, result.daemonKey);
    internalToken = result.internalToken;
    pairedEarly = true;
    io.out(`  registered with ${serverUrl} as ${result.daemonId}`);
  }

  // ---- 6. Register with the machine's own service manager ---------------
  const machineEnv = { ...stored.env, ...passThroughEnv(ctx.env) };
  writeMachineSettings(patchHome, {
    serverUrl,
    internalToken,
    hostName: machine,
    env: machineEnv,
  });

  const manager = serviceManagerFor(ctx.platform);
  const ops = ctx.serviceOps ?? opsFor(manager);
  // A launchd agent starts with launchd's own bare PATH, and whatever ran this
  // installer (a desktop app, an ssh session) had another bare one. Chats run
  // the user's tools — node, pnpm, gh, Homebrew's everything — so on macOS the
  // service gets the PATH the user's own login shell builds. A chat on a
  // freshly added Mac could otherwise run `uname` and nothing a project needs.
  let servicePath: string;
  try {
    servicePath =
      ctx.platform === 'darwin'
        ? (ctx.loginShellPath ?? (() => loginShellPath(ctx.env)))()
        : (ctx.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin');
  } catch (err) {
    io.err(`patch install: ${(err as Error).message}`);
    return { code: 69 };
  }
  const def: ServiceDefinition = {
    nodePath: join(installDir, 'node'),
    programPath: join(installDir, 'daemon.mjs'),
    home,
    uid: ctx.uid,
    env: {
      HOME: home,
      USER: user,
      PATH: servicePath,
      PATCH_SERVER_URL: serverUrl,
      PATCH_SERVER_WS_URL: wsUrlFor(serverUrl),
      PATCH_HOST_NAME: machine,
      // The one agent backend patch drives. The backend's own install is
      // provisioned on the machine, not carried in the artifact (spec/11).
      SDK_BACKEND: 'real',
      // Every artifact carries silero_vad.onnx, so end-of-utterance detection
      // and barge-in work on this machine with nothing downloaded (spec/02).
      VAD_BACKEND: 'silero',
      VAD_MODEL_PATH: join(installDir, 'silero_vad.onnx'),
      // spec/11 § Env: WHISPER_BACKEND, GROQ_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
      // "are read by the host, so they are set in the environment of each
      // host's service rather than in the server's compose env". They travel
      // with the install command, and are carried into the unit here.
      ...Object.fromEntries(
        Object.entries(machineEnv).filter(([k]) => !(SECRET_ENV as readonly string[]).includes(k)),
      ),
    },
    secretEnv: {
      PATCH_INTERNAL_TOKEN: internalToken,
      ...Object.fromEntries(
        Object.entries(machineEnv).filter(([k]) => (SECRET_ENV as readonly string[]).includes(k)),
      ),
    },
  };
  let unitPath: string;
  try {
    const registered = await ops.register(def);
    unitPath = registered.unitPath;
    for (const note of registered.notes) io.out(`  ${note}`);
  } catch (err) {
    if (err instanceof ServiceRegistrationError) {
      io.err(`patch install: ${err.message}`);
      return { code: 69 };
    }
    throw err;
  }

  // ---- 7. Pair with the account ----------------------------------------
  const existingKey = readDaemonKey(patchHome);
  let paired = existingKey !== undefined;

  if (pairedEarly) {
    // Done in 5b; the code is spent.
  } else if (paired && args.code === undefined) {
    // spec/10: "re-running the installer on a host that is already registered
    // re-uses its stored daemonKey rather than creating a duplicate host."
    io.out(`  already registered as ${identity.daemonId} — re-using the stored credential`);
  } else {
    const code = await pairingCode(args, io);
    if (code === undefined) {
      io.err(
        'patch install: no pairing code. The service is registered but this machine is not ' +
          'linked to an account yet.\n' +
          `Get a code from a linked surface and run: ${join(installDir, 'install')} --code <code> ` +
          `--server ${serverUrl} --internal-token <token>`,
      );
      return { code: 70 };
    }
    const result = await redeemPairingCode({
      serverUrl,
      code,
      identity,
      label: machine,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    if (result.ok) {
      writeDaemonKey(patchHome, result.daemonKey);
      paired = true;
      io.out(`  registered with ${serverUrl} as ${result.daemonId}`);
    } else if (result.kind === 'already_registered' && existingKey !== undefined) {
      // spec/10: "Registration is per machine and idempotent." Re-running WITH
      // a code on a machine that already holds a credential used to abort 75
      // and advise "enter a fresh code" — advice that can never succeed, since
      // every fresh code hits the same 409. The stored credential is the right
      // answer; the code simply went unused.
      paired = true;
      io.out(`  already registered as ${identity.daemonId} — re-using the stored credential`);
      io.out('  (the pairing code was not needed and has not been consumed)');
    } else {
      // The service IS registered; only the pairing failed. Say which, so a
      // fresh code can be entered once the problem is fixed.
      io.err('');
      io.err(`patch install: the pairing code could not be submitted — ${result.message}`);
      io.err('');
      io.err(
        `  The service IS registered (${manager === 'launchd' ? SERVICE_LABEL : SYSTEMD_UNIT} at ${unitPath}) ` +
          'and will start at boot.',
      );
      io.err(
        `  Enter a fresh code with: ${join(installDir, 'install')} --code <code> --server ${serverUrl} --internal-token <token>`,
      );
      return { code: 75 };
    }
  }

  // ---- 8. Start it ------------------------------------------------------
  if (paired) {
    try {
      await ops.start(def);
    } catch (err) {
      io.err(`patch install: ${(err as Error).message}`);
      return { code: 69 };
    }
    // Do NOT trust the start command's exit status. `systemctl restart` and
    // `launchctl kickstart` both return 0 for a unit that comes up and dies
    // immediately, which is exactly what a missing credential produces — so
    // reporting "service started" here told the user the install had worked
    // while the host crash-looped forever. Verify the job is actually up,
    // and if it is not, say so with the host's own last words.
    const state = await settledRunState(ops, def);
    if (!state.running) {
      io.err('patch install: the service was started but is not running.');
      io.err(`  ${state.detail}`);
      const tail = daemonLogTail(def.home);
      if (tail.trim().length > 0) {
        io.err('  The host said:');
        for (const line of tail.split('\n')) io.err(`    ${line}`);
      }
      io.err('');
      io.err(
        '  The service IS registered and will retry at boot. Fix the cause, then: ' +
          (manager === 'launchd'
            ? `launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}`
            : `systemctl --user restart ${SYSTEMD_UNIT}`),
      );
      return { code: 70 };
    }
    io.out(`  service started (pid ${state.pid ?? 'unknown'})`);
    // A stored credential can be VALID or merely PRESENT. A machine whose key
    // has been revoked still has the file, so "re-using the stored credential"
    // and "it appears under Settings → Hosts" were both asserted for a machine
    // the server refuses on every reconnect. The host says so in its own log
    // within a second of starting — so look, rather than claim.
    const revoked = /daemon revoked|4401/.test(daemonLogTail(def.home, 40));
    if (revoked) {
      io.err('');
      io.err('patch install: this machine is registered but its credential has been REVOKED.');
      io.err('  The server refuses the connection, so it will NOT appear under Settings → Hosts.');
      io.err(
        `  Pair it again with a fresh code: ${join(installDir, 'install')} --code <code> ` +
          `--server ${serverUrl} --internal-token <token>`,
      );
      return { code: 77 };
    }
    io.out('');
    io.out(`  This machine is ${machine}. It appears under Settings → Hosts.`);
  }
  return { code: 0 };
}

/** The controlling terminal, when this process has one. */
function controllingTerminal(): ReadStream | undefined {
  try {
    return createReadStream('', { fd: openSync('/dev/tty', 'r') });
  } catch {
    return undefined;
  }
}

/** Entry point for the bundled `install.mjs`. */
export async function installerMain(): Promise<number> {
  const artifactDir = dirname(fileURLToPath(import.meta.url));
  // `curl … | sh` hands the installer the script as its stdin, so the terminal
  // the person is sitting at is only reachable as /dev/tty. Without it there
  // is nobody to ask, and a missing code is said out loud further on.
  const tty = process.stdin.isTTY === true ? undefined : controllingTerminal();
  const input = process.stdin.isTTY === true ? process.stdin : tty;
  const rl = input ? createInterface({ input, output: process.stdout }) : undefined;
  const io: InstallerIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    ...(rl ? { ask: (q: string): Promise<string> => rl.question(q) } : {}),
  };
  try {
    const result = await runInstaller({
      artifactDir,
      env: process.env,
      argv: process.argv.slice(2),
      io,
      platform: process.platform,
      arch: process.arch,
      uid: process.getuid?.() ?? 0,
    });
    return result.code;
  } finally {
    rl?.close();
    // An open /dev/tty would hold the process open after the install is done.
    tty?.destroy();
  }
}
