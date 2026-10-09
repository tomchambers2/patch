// Registering the host with the machine's own service manager.
//
// spec/02 § Runtime and installation: "The OS service manager owns its
// lifecycle: launchd on macOS, a systemd user unit on Linux, with
// restart-on-failure and start-at-boot. It runs through logout, surface
// disconnects, and any app on the same machine closing."
//
// Two hard rules come out of spec/02 § Stack and § Runtime and installation:
//
//   * The service runs as the invoking user, under that user's HOME. Nothing
//     here is installed system-wide and nothing runs as root.
//   * The unit carries NO working directory. Every path the host keeps is
//     resolved from the user's HOME (`~/.patch/...`), so a working directory
//     would be a second, contradictory answer to "where does its state live".
//
// NO FALLBACK: if the service manager refuses the registration we report what
// it said and stop. We never "just run it" in the background instead — that is
// exactly the thing that runs once and is gone at the next reboot.

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ServiceManager = 'launchd' | 'systemd';

/** The one service label / unit name a machine's patch host is known by. */
export const SERVICE_LABEL = 'me.tomchambers.patch-daemon';
export const SYSTEMD_UNIT = 'patch-daemon.service';

export interface ServiceDefinition {
  /** Absolute path of the pinned Node runtime in the install. */
  nodePath: string;
  /** Absolute path of the bundled host program. */
  programPath: string;
  /** Environment the service runs with. */
  env: Record<string, string>;
  /**
   * Credentials the service runs with. systemd reads them from a 0600
   * EnvironmentFile so they are not written into the unit; launchd has no
   * equivalent, so there they join `env` in the plist.
   */
  secretEnv?: Record<string, string>;
  /** The user's HOME — where the unit and the logs go. */
  home: string;
  /** Numeric uid, for launchd's per-user domain. */
  uid: number;
}

export class ServiceRegistrationError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(
      `could not register the service with ${command}: ${detail}\n` +
        'Nothing was started. A host that is not under the service manager would ' +
        'run once and be gone at the next reboot, so the install stops here.',
    );
    this.name = 'ServiceRegistrationError';
  }
}

export function launchdPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function systemdSecretsPath(home: string): string {
  return join(home, '.patch', 'daemon-secrets.env');
}

/** systemd EnvironmentFile syntax: KEY="value", with \ and " escaped. */
export function systemdSecretsFile(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`)
    .join('');
}

export function systemdUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * launchd job. `RunAtLoad` is start-at-boot; `KeepAlive.SuccessfulExit=false`
 * is restart-on-failure (a clean `patch host stop` stays stopped, a crash
 * comes back). Deliberately NO `WorkingDirectory`.
 */
export function launchdPlist(def: ServiceDefinition, systemDaemon = false): string {
  const envEntries = Object.entries({ ...def.env, ...def.secretEnv })
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join('\n');
  const logDir = join(def.home, '.patch', 'logs');
  // A system job runs as root unless it is told whose job it is. The host
  // runs as the invoking user and nobody else (spec/02 § Runtime and
  // installation), so a system-domain install names that user explicitly.
  const asUser = systemDaemon
    ? `  <key>UserName</key><string>${xmlEscape(def.env['USER'] ?? '')}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
${asUser}  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(def.nodePath)}</string>
    <string>${xmlEscape(def.programPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, 'daemon.log'))}</string>
</dict>
</plist>
`;
}

/**
 * systemd user unit. `Restart=on-failure` and `WantedBy=default.target` are the
 * restart-on-failure / start-at-boot pair; lingering (enabled separately) is
 * what carries it through logout. Deliberately NO `WorkingDirectory=`.
 */
export function systemdUnit(def: ServiceDefinition): string {
  const env = Object.entries(def.env)
    .map(([k, v]) => `Environment="${k}=${v.replace(/"/g, '\\"')}"`)
    .join('\n');
  const logPath = join(def.home, '.patch', 'logs', 'daemon.log');
  const secrets =
    def.secretEnv !== undefined && Object.keys(def.secretEnv).length > 0
      ? `EnvironmentFile=${systemdSecretsPath(def.home)}\n`
      : '';
  return `[Unit]
Description=Patch daemon
Documentation=https://github.com/tomchambers2/patch
After=network-online.target

[Service]
Type=simple
ExecStart=${def.nodePath} ${def.programPath}
${env}
${secrets}Restart=on-failure
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

async function run(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    ...(opts.env ? { env: opts.env } : {}),
  });
}

function detail(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr ?? '').trim();
  return text.length > 0 ? text : (e.message ?? String(err));
}

/**
 * What the service manager says about the registered job RIGHT NOW.
 *
 * `pid` is what makes a crash loop visible: a unit that is "running" at two
 * instants under two different pids has died and been restarted in between,
 * which is exactly the state an installer must never report as success.
 */
export interface ServiceRunState {
  running: boolean;
  pid?: number;
  /** The service manager's own words — printed verbatim when it is not up. */
  detail: string;
}

export interface ServiceOps {
  /** Write the unit and register it with the service manager. Does not start. */
  register(def: ServiceDefinition): Promise<{ unitPath: string; notes: string[] }>;
  /** Start (or restart) the registered service. */
  start(def: ServiceDefinition): Promise<void>;
  /** Human-readable status, straight from the service manager. */
  status(def: ServiceDefinition): Promise<string>;
  /** Is the job actually up, and under which pid (spec/11 § Deploy guide: verify, don't trust exit 0). */
  runState(def: ServiceDefinition): Promise<ServiceRunState>;
}

/**
 * The host's own last words, for an installer that has to explain why the
 * service it just started is not running. Without this the user is told "it
 * failed" and has to go and find the log themselves.
 */
export function daemonLogTail(home: string, lines = 20): string {
  const path = join(home, '.patch', 'logs', 'daemon.log');
  if (!existsSync(path)) return `(no host log at ${path})`;
  const text = readFileSync(path, 'utf8').trimEnd();
  if (text.length === 0) return `(${path} is empty)`;
  return text.split('\n').slice(-lines).join('\n');
}

/**
 * launchd has two ways to own a per-user background process, and which one this
 * machine can have is not a preference — it is what the machine allows.
 *
 *   * A system host in `/Library/LaunchDaemons`, running as this user via
 *     `UserName`. It starts at boot before anyone logs in and keeps running
 *     through logout, which is what spec/02's "runs through logout, ... and any
 *     app on the same machine closing" asks for. Installing it needs root, so
 *     it is available exactly when this user already has passwordless sudo on
 *     their own machine.
 *   * A LaunchAgent in `~/Library/LaunchAgents`, bootstrapped into `gui/<uid>`.
 *     No privileges needed, starts at login, restarts on failure — and ends
 *     with the login session. (`user/<uid>` is not an alternative: modern macOS
 *     refuses to bootstrap into it at all, root or not.)
 *
 * When only the second is available the installer SAYS so, and prints the one
 * command that changes it. The difference is stated out loud, never papered
 * over.
 */
const SYSTEM_PLIST_PATH = `/Library/LaunchDaemons/${SERVICE_LABEL}.plist`;

async function canElevate(): Promise<boolean> {
  return run('sudo', ['-n', 'true']).then(
    () => true,
    () => false,
  );
}

interface LaunchdMode {
  /** `system` or `gui/<uid>`. */
  domain: string;
  target: string;
  plistPath: string;
  launchctl: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  survivesLogout: boolean;
}

async function launchdMode(def: ServiceDefinition): Promise<LaunchdMode> {
  if (await canElevate()) {
    return {
      domain: 'system',
      target: `system/${SERVICE_LABEL}`,
      plistPath: SYSTEM_PLIST_PATH,
      launchctl: (args) => run('sudo', ['-n', 'launchctl', ...args]),
      survivesLogout: true,
    };
  }
  return {
    domain: `gui/${def.uid}`,
    target: `gui/${def.uid}/${SERVICE_LABEL}`,
    plistPath: launchdPlistPath(def.home),
    launchctl: (args) => run('launchctl', args),
    survivesLogout: false,
  };
}

export const launchdOps: ServiceOps = {
  async register(def) {
    mkdirSync(join(def.home, '.patch', 'logs'), { recursive: true });
    const mode = await launchdMode(def);
    const agentPath = launchdPlistPath(def.home);
    const otherDomainNotes: string[] = [];
    if (mode.domain === 'system') {
      // ONE label, ONE job. macOS auto-bootstraps anything in
      // ~/Library/LaunchAgents at login, so a plist left there beside a system
      // job gives the machine two hosts under one label after a reboot — the
      // second crash-looping forever on the first's port. The other domain is
      // booted out and its plist removed, every time, so this machine can only
      // ever carry the job we just registered.
      await run('launchctl', ['bootout', `gui/${def.uid}/${SERVICE_LABEL}`]).catch(() => undefined);
      if (existsSync(agentPath)) {
        rmSync(agentPath, { force: true });
        otherDomainNotes.push(
          `removed the LaunchAgent copy at ${agentPath} — this machine runs the system job, ` +
            'and two jobs under one label would fight over the host’s port at every login',
        );
      }
      // The plist carries this machine's credentials, so it is written 0600 and
      // installed as root-owned 0600 — never a world-readable copy under HOME.
      const staged = join(def.home, '.patch', `${SERVICE_LABEL}.plist`);
      writeFileSync(staged, launchdPlist(def, true), { encoding: 'utf8', mode: 0o600 });
      chmodSync(staged, 0o600);
      try {
        await run('sudo', ['-n', 'cp', staged, SYSTEM_PLIST_PATH]);
        await run('sudo', ['-n', 'chown', 'root:wheel', SYSTEM_PLIST_PATH]);
        await run('sudo', ['-n', 'chmod', '600', SYSTEM_PLIST_PATH]);
      } catch (err) {
        throw new ServiceRegistrationError(`installing ${SYSTEM_PLIST_PATH}`, detail(err));
      } finally {
        rmSync(staged, { force: true });
      }
    } else {
      // The mirror image: a LaunchAgent install must not leave a system job
      // behind either. We are here because this user cannot elevate, so a
      // system plist that IS there cannot be removed from here — it is
      // reported loudly with the one command that removes it, never ignored.
      mkdirSync(dirname(agentPath), { recursive: true });
      writeFileSync(agentPath, launchdPlist(def, false), { encoding: 'utf8', mode: 0o600 });
      chmodSync(agentPath, 0o600);
      if (existsSync(SYSTEM_PLIST_PATH)) {
        otherDomainNotes.push(
          `WARNING: a system job is also installed at ${SYSTEM_PLIST_PATH}. Two jobs under one ` +
            'label will fight over the host’s port. Remove it with: ' +
            `sudo launchctl bootout system/${SERVICE_LABEL}; sudo rm ${SYSTEM_PLIST_PATH}`,
        );
      }
    }
    // A re-run replaces the previous registration. Booting out a job that isn't
    // loaded is not an error condition, it is the idempotent half of "register".
    await mode.launchctl(['bootout', mode.target]).catch(() => undefined);
    // launchd tears a job down asynchronously, and bootstrapping while the old
    // one is still going away fails with a bare "Bootstrap failed: 5: Input/
    // output error". Wait for the label to actually be gone.
    for (let i = 0; i < 50; i += 1) {
      const stillThere = await mode.launchctl(['print', mode.target]).then(
        () => true,
        () => false,
      );
      if (!stillThere) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      await mode.launchctl(['bootstrap', mode.domain, mode.plistPath]);
    } catch (err) {
      throw new ServiceRegistrationError(`launchctl bootstrap ${mode.domain}`, detail(err));
    }
    try {
      await mode.launchctl(['enable', mode.target]);
    } catch (err) {
      throw new ServiceRegistrationError(`launchctl enable ${mode.target}`, detail(err));
    }
    const notes = [
      ...otherDomainNotes,
      `launchd job ${SERVICE_LABEL} registered in domain ${mode.domain} (${mode.plistPath})`,
      'start-at-boot: RunAtLoad; restart-on-failure: KeepAlive/SuccessfulExit=false',
      mode.survivesLogout
        ? 'a system job running as this user: it starts at boot and runs through logout'
        : `NOTE: ${mode.domain} ends with your login session, so the host stops at logout and ` +
          'starts again at login. To make it run through logout, run: ' +
          `sudo cp ${agentPath} ${SYSTEM_PLIST_PATH} && sudo launchctl bootstrap system ${SYSTEM_PLIST_PATH}`,
    ];
    return { unitPath: mode.plistPath, notes };
  },
  async start(def) {
    const mode = await launchdMode(def);
    try {
      await mode.launchctl(['kickstart', '-k', mode.target]);
    } catch (err) {
      throw new ServiceRegistrationError('launchctl kickstart', detail(err));
    }
  },
  async status(def) {
    const mode = await launchdMode(def);
    const { stdout } = await mode.launchctl(['print', mode.target]);
    return stdout;
  },
  async runState(def) {
    const mode = await launchdMode(def);
    let stdout: string;
    try {
      ({ stdout } = await mode.launchctl(['print', mode.target]));
    } catch (err) {
      return { running: false, detail: `launchctl print ${mode.target}: ${detail(err)}` };
    }
    const pid = /^\s*pid\s*=\s*(\d+)/m.exec(stdout)?.[1];
    const state = /^\s*state\s*=\s*(\S+)/m.exec(stdout)?.[1];
    // `last exit code` is launchd's record of the previous run: on a
    // crash-looping job it is the host's own exit status, which is the one
    // fact that says "this came up and died" rather than "this never started".
    const lastExit = /^\s*last exit code\s*=\s*(\S+)/m.exec(stdout)?.[1];
    const running = state === 'running' && pid !== undefined;
    return {
      running,
      ...(pid !== undefined ? { pid: Number(pid) } : {}),
      detail: `launchd state=${state ?? 'unknown'}${
        lastExit !== undefined ? `, last exit code=${lastExit}` : ''
      }`,
    };
  },
};

export const systemdOps: ServiceOps = {
  async register(def) {
    const unitPath = systemdUnitPath(def.home);
    mkdirSync(dirname(unitPath), { recursive: true });
    mkdirSync(join(def.home, '.patch', 'logs'), { recursive: true });
    // The unit carries this machine's credentials (PATCH_INTERNAL_TOKEN, and
    // any voice/agent token passed at install), so it is owner-only. systemd
    // --user reads it as this same user.
    writeFileSync(unitPath, systemdUnit(def), { encoding: 'utf8', mode: 0o600 });
    chmodSync(unitPath, 0o600);
    if (def.secretEnv !== undefined && Object.keys(def.secretEnv).length > 0) {
      const secretsPath = systemdSecretsPath(def.home);
      writeFileSync(secretsPath, systemdSecretsFile(def.secretEnv), {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(secretsPath, 0o600);
    }
    try {
      await run('systemctl', ['--user', 'daemon-reload']);
    } catch (err) {
      throw new ServiceRegistrationError('systemctl --user daemon-reload', detail(err));
    }
    try {
      await run('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
    } catch (err) {
      throw new ServiceRegistrationError(`systemctl --user enable ${SYSTEMD_UNIT}`, detail(err));
    }
    const notes = [
      `systemd user unit ${SYSTEMD_UNIT} registered at ${unitPath}`,
      'start-at-boot: WantedBy=default.target; restart-on-failure: Restart=on-failure',
    ];
    notes.push(await ensureLinger(def));
    return { unitPath, notes };
  },
  async start() {
    try {
      await run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
    } catch (err) {
      throw new ServiceRegistrationError(`systemctl --user restart ${SYSTEMD_UNIT}`, detail(err));
    }
  },
  async status() {
    // `status` exits non-zero for an inactive unit, which is information, not a
    // failure of the call.
    try {
      const { stdout } = await run('systemctl', ['--user', 'status', SYSTEMD_UNIT]);
      return stdout;
    } catch (err) {
      return (err as { stdout?: string }).stdout ?? detail(err);
    }
  },
  async runState() {
    // One call, machine-readable: ActiveState/SubState say whether it is up,
    // MainPID identifies the instance (a changed pid between two probes is a
    // restart), NRestarts and Result are how a crash loop announces itself.
    const props = ['ActiveState', 'SubState', 'MainPID', 'NRestarts', 'Result', 'ExecMainStatus'];
    let stdout: string;
    try {
      ({ stdout } = await run('systemctl', [
        '--user',
        'show',
        SYSTEMD_UNIT,
        ...props.map((p) => `-p${p}`),
      ]));
    } catch (err) {
      return { running: false, detail: `systemctl --user show: ${detail(err)}` };
    }
    const read = (key: string): string | undefined =>
      new RegExp(`^${key}=(.*)$`, 'm').exec(stdout)?.[1];
    const pid = Number(read('MainPID') ?? '0');
    const running = read('ActiveState') === 'active' && pid > 0;
    return {
      running,
      ...(pid > 0 ? { pid } : {}),
      detail:
        `systemd ActiveState=${read('ActiveState') ?? 'unknown'} ` +
        `SubState=${read('SubState') ?? 'unknown'} Result=${read('Result') ?? 'unknown'} ` +
        `NRestarts=${read('NRestarts') ?? '0'} ExecMainStatus=${read('ExecMainStatus') ?? 'unknown'}`,
    };
  },
};

/**
 * Lingering is what makes a systemd user unit survive logout and come up at
 * boot without anyone logging in (spec/02: "It runs through logout"). Without
 * it the unit dies with the last session, so a machine that cannot enable it
 * is told exactly which root command to run rather than being left with a
 * host that quietly disappears.
 */
async function ensureLinger(def: ServiceDefinition): Promise<string> {
  const user = def.env['USER'] ?? process.env['USER'] ?? String(def.uid);
  try {
    const { stdout } = await run('loginctl', ['show-user', user, '--property=Linger', '--value']);
    if (stdout.trim() === 'yes') return `lingering already enabled for ${user} (survives logout)`;
  } catch {
    // Fall through and try to enable it; the enable error is the one worth
    // reporting.
  }
  try {
    await run('loginctl', ['enable-linger', user]);
    return `lingering enabled for ${user} (survives logout, starts at boot)`;
  } catch (err) {
    throw new ServiceRegistrationError(
      `loginctl enable-linger ${user}`,
      `${detail(err)}\nRun \`sudo loginctl enable-linger ${user}\` and re-run the installer. ` +
        'Without lingering the host stops at logout instead of running through it.',
    );
  }
}

export function opsFor(manager: ServiceManager): ServiceOps {
  return manager === 'launchd' ? launchdOps : systemdOps;
}
