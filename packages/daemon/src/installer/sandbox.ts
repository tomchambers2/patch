// The agent sandbox, provisioned on the machine at install time.
//
// spec/11 § Host installation — "the backend's own install is provisioned on
// the machine, not carried in the artifact". The sandbox is part of that
// backend: Claude Code runs every `auto`-mode bash command inside it, and only
// escalates to the user when a command tries to leave it. Without one, `auto`
// has nothing to run commands INSIDE, so it falls back to asking about
// everything — a machine where every unattended job parks on its first
// command, looking identical to a machine that is merely quiet.
//
// That is the whole reason this step exists. The alternative — probe the
// sandbox at runtime, record whether it works, and behave differently on
// machines where it does not — is two code paths and a silent second-class
// mode. One path: a machine that finishes `install` has a working sandbox, so
// `auto` means the same thing on every host patch runs on.
//
// macOS needs nothing: the sandbox is `sandbox-exec`, part of the OS. Linux
// needs two packages and, on any distro that restricts unprivileged user
// namespaces (Ubuntu 23.10+, which is every current LTS server), an AppArmor
// profile that lets bwrap alone create one. Installing those needs root, so
// this step is available exactly when the user already has passwordless sudo —
// the same condition, and the same say-it-out-loud failure, as registering a
// system service.
//
// NO FALLBACK: every failure here stops the install and names the commands
// that fix it. A host must not be started on a machine whose sandbox does
// not work.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Thrown when the sandbox cannot be provisioned. Carries what the user must run. */
export class SandboxProvisionError extends Error {
  constructor(
    readonly step: string,
    readonly remedy: string[],
    detail: string,
  ) {
    super(`${step}: ${detail}`);
    this.name = 'SandboxProvisionError';
  }
}

export interface SandboxIo {
  out(line: string): void;
}

/** The two programs Claude Code's Linux sandbox shells out to. */
const LINUX_REQUIREMENTS = ['bwrap', 'socat'] as const;

/**
 * Package names per manager, keyed by the manager's own binary. This is a
 * lookup table, not a fallback chain: a machine has exactly one of these, and a
 * machine with none of them is one this step cannot provision and says so.
 */
const PACKAGES: Record<string, { install: string[]; names: string[] }> = {
  'apt-get': { install: ['install', '-y'], names: ['bubblewrap', 'socat'] },
  dnf: { install: ['install', '-y'], names: ['bubblewrap', 'socat'] },
  pacman: { install: ['-S', '--noconfirm'], names: ['bubblewrap', 'socat'] },
  zypper: { install: ['install', '-y'], names: ['bubblewrap', 'socat'] },
};

/**
 * The profile that grants `userns` to bwrap and nothing else. Ubuntu's
 * `apparmor_restrict_unprivileged_userns` denies user namespaces to every
 * unconfined program; this is the distro's own sanctioned way to exempt one
 * binary, and it leaves every other program on the machine restricted.
 */
const APPARMOR_PROFILE_PATH = '/etc/apparmor.d/bwrap';
const APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

async function run(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { encoding: 'utf8' });
  return stdout;
}

function detail(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr ?? '').trim();
  return text.length > 0 ? text : (e.message ?? String(err));
}

async function has(program: string): Promise<boolean> {
  return run('sh', ['-c', `command -v ${program}`]).then(
    () => true,
    () => false,
  );
}

async function canElevate(): Promise<boolean> {
  return run('sudo', ['-n', 'true']).then(
    () => true,
    () => false,
  );
}

/**
 * Does an unprivileged user namespace actually work? `command -v bwrap` does
 * not answer this: on a machine with AppArmor's userns restriction the binary
 * is present and every invocation fails. The only honest question is whether
 * one runs, so run one.
 *
 * This is the step's post-condition, not a runtime branch — nothing reads it
 * later to decide how to behave.
 */
async function sandboxWorks(): Promise<boolean> {
  return run('bwrap', ['--ro-bind', '/', '/', '--unshare-user', 'true']).then(
    () => true,
    () => false,
  );
}

async function packageManager(): Promise<string | null> {
  for (const mgr of Object.keys(PACKAGES)) if (await has(mgr)) return mgr;
  return null;
}

/**
 * Make this machine able to run the agent sandbox, or stop the install.
 *
 * Writes what it did to the installer's own transcript. Throws
 * `SandboxProvisionError` with the exact remedy commands when the machine
 * cannot be provisioned from here.
 */
export async function provisionSandbox(platform: NodeJS.Platform, io: SandboxIo): Promise<void> {
  if (platform === 'darwin') {
    // sandbox-exec ships with macOS; there is nothing to install and nothing
    // that can be missing.
    io.out('  sandbox: sandbox-exec (built into macOS)');
    return;
  }
  if (platform !== 'linux') {
    throw new SandboxProvisionError(
      'sandbox',
      [],
      `patch has no sandbox provisioning for ${platform}; supported: darwin, linux`,
    );
  }

  const missing: string[] = [];
  for (const req of LINUX_REQUIREMENTS) if (!(await has(req))) missing.push(req);

  if (missing.length > 0) {
    const mgr = await packageManager();
    if (mgr === null) {
      throw new SandboxProvisionError(
        'sandbox packages',
        [`install bubblewrap and socat with this machine's package manager`],
        `missing ${missing.join(', ')} and no supported package manager ` +
          `(${Object.keys(PACKAGES).join(', ')}) was found`,
      );
    }
    const spec = PACKAGES[mgr] as { install: string[]; names: string[] };
    const cmd = `sudo ${mgr} ${spec.install.join(' ')} ${spec.names.join(' ')}`;
    if (!(await canElevate())) {
      throw new SandboxProvisionError(
        'sandbox packages',
        [cmd, 'then re-run the installer'],
        `missing ${missing.join(', ')} and this user has no passwordless sudo to install them`,
      );
    }
    try {
      await run('sudo', ['-n', mgr, ...spec.install, ...spec.names]);
    } catch (err) {
      throw new SandboxProvisionError('sandbox packages', [cmd], detail(err));
    }
    io.out(`  sandbox: installed ${spec.names.join(', ')} via ${mgr}`);
  }

  if (await sandboxWorks()) {
    io.out('  sandbox: bubblewrap + socat, user namespaces available');
    return;
  }

  // bwrap is present but cannot create a namespace — on every current Ubuntu
  // that is AppArmor's unprivileged-userns restriction, and the profile below
  // is the distro's own way to exempt this one binary.
  const remedy = [
    `sudo tee ${APPARMOR_PROFILE_PATH} <<'EOF'\n${APPARMOR_PROFILE}EOF`,
    `sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`,
    'then re-run the installer',
  ];
  if (!(await canElevate())) {
    throw new SandboxProvisionError(
      'sandbox user namespaces',
      remedy,
      'bwrap cannot create a user namespace and this user has no passwordless sudo to grant it',
    );
  }
  try {
    await run('sudo', [
      '-n',
      'sh',
      '-c',
      `cat > ${APPARMOR_PROFILE_PATH} <<'PATCH_EOF'\n${APPARMOR_PROFILE}PATCH_EOF`,
    ]);
    await run('sudo', ['-n', 'apparmor_parser', '-r', APPARMOR_PROFILE_PATH]);
  } catch (err) {
    throw new SandboxProvisionError('sandbox user namespaces', remedy, detail(err));
  }

  if (!(await sandboxWorks())) {
    throw new SandboxProvisionError(
      'sandbox user namespaces',
      remedy,
      `wrote and loaded ${APPARMOR_PROFILE_PATH} and bwrap still cannot create a user namespace`,
    );
  }
  io.out(`  sandbox: bubblewrap + socat, user namespaces granted via ${APPARMOR_PROFILE_PATH}`);
}
