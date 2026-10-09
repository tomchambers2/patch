// `patch hosts *` — machines as a resource (spec/17 § Hosts and the CLI).
//
// There was no `hosts` command at all, so from the machine a person was sitting
// on there was no way to ask what machines existed, what they were running, or
// to drive any host-scoped control — even though the host's local socket is
// exactly where those controls belong.
//
// Routing follows the spec's split, and it matters:
//   - Controls the HOST owns reach this machine over its own local socket, so
//     they work with no round trip through the server (and while the server is
//     unreachable).
//   - Four commands go to the SERVER even when they name this machine, because
//     the server owns what they change rather than the host: `add`, `rename`,
//     `set-home` and `remove`.
//
// `--host` names another machine and forces the REST path, since another
// machine's host is not reachable over this one's socket.

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';

interface HostsOpts extends CommonOpts {
  host?: string;
}

interface HostSummary {
  daemonId: string;
  hostName: string | null;
  online: boolean;
  isHomeHost: boolean;
  defaultModel?: string;
}

/**
 * Resolve `--host` against the registry: a host NAME or a `daemonId` prefix.
 * An ambiguous or unknown value is an error listing the candidates, rather than
 * a silent pick — acting on the wrong machine is the failure this prevents.
 */
export async function resolveHost(opts: HostsOpts): Promise<string> {
  const t = getTransport({ ...opts, remote: true });
  const { hosts } = await t.get<{ hosts: HostSummary[] }>('/api/hosts');
  const needle = opts.host!;
  const byName = hosts.filter((h) => h.hostName === needle);
  if (byName.length === 1) return byName[0]!.daemonId;
  const byPrefix = hosts.filter((h) => h.daemonId.startsWith(needle));
  if (byPrefix.length === 1) return byPrefix[0]!.daemonId;
  const candidates = (byName.length > 1 ? byName : byPrefix)
    .map((h) => `${h.daemonId}${h.hostName ? ` (${h.hostName})` : ''}`)
    .join(', ');
  throw new Error(
    candidates.length > 0
      ? `--host "${needle}" is ambiguous — candidates: ${candidates}`
      : `--host "${needle}" matches no registered machine (known: ${hosts
          .map((h) => h.hostName ?? h.daemonId)
          .join(', ')})`,
  );
}

/**
 * Where a host-owned control should go. With no `--host` it is this machine,
 * over its local socket. With `--host` it is another machine, so it must route
 * through the server.
 */
async function daemonRoute(
  opts: HostsOpts,
  udsPath: string,
  restPath: (daemonId: string) => string,
): Promise<{ t: ReturnType<typeof getTransport>; path: string }> {
  if (opts.host === undefined) {
    const t = getTransport(opts);
    return { t, path: t.kind === 'uds' ? udsPath : restPath('') };
  }
  const daemonId = await resolveHost(opts);
  return { t: getTransport({ ...opts, remote: true }), path: restPath(daemonId) };
}

export function registerHostsCommands(program: Command): void {
  const hosts = program.command('hosts').description('Machines this account runs on');

  hosts
    .command('list')
    .description('Every registered machine: name, status, version')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.get<{ hosts: HostSummary[] }>('/api/hosts');
        if (opts.json) {
          emitJson(res);
          return;
        }
        for (const h of res.hosts) {
          // A machine that has never reported has no name — say so rather than
          // printing an id dressed up as one.
          const name = h.hostName ?? `${h.daemonId} (no report yet)`;
          emitText(
            `${h.online ? '●' : '○'} ${name}${h.isHomeHost ? '  [home]' : ''}  ${h.daemonId}`,
          );
        }
      });
    });

  hosts
    .command('get')
    .description('One machine: platform, backends, components, home marker')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(
          opts,
          '/host',
          (id) => `/api/hosts${id ? `?daemonId=${encodeURIComponent(id)}` : ''}`,
        );
        const res = await t.get<unknown>(path);
        emitJson(res);
      });
    });

  const folders = hosts.command('folders').description("That machine's project-folder registry");

  folders
    .command('list', { isDefault: true })
    .description('List the project roots')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(opts, '/folders', () => '/api/folders');
        emitJson(await t.get<unknown>(path));
      });
    });

  folders
    .command('add <path>')
    .description('Designate a project root on that machine')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (folderPath: string, opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(opts, '/folders/add', () => '/api/folders/add');
        emitJson(await t.post<unknown>(path, { path: folderPath }));
      });
    });

  folders
    .command('remove <path>')
    .description('Drop a designated project root')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (folderPath: string, opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(opts, '/folders/remove', () => '/api/folders/remove');
        emitJson(await t.post<unknown>(path, { path: folderPath }));
      });
    });

  hosts
    .command('backends')
    .description("Each backend's version and that machine's view of the shared accounts")
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(opts, '/backends', () => '/api/hosts/backends');
        emitJson(await t.get<unknown>(path));
      });
    });

  hosts
    .command('models')
    .description("That machine's model catalogue across its backends")
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(
          opts,
          '/models',
          (id) => `/api/models?daemonId=${encodeURIComponent(id)}`,
        );
        emitJson(await t.get<unknown>(path));
      });
    });

  hosts
    .command('install <component>')
    .description('Install an optional component on that machine')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (component: string, opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(
          opts,
          '/components/install',
          () => '/api/hosts/components/install',
        );
        emitJson(await t.post<unknown>(path, { componentId: component }));
      });
    });

  hosts
    .command('uninstall <component>')
    .description('Delete an installed component from that machine')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (component: string, opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(
          opts,
          '/components/remove',
          () => '/api/hosts/components/remove',
        );
        emitJson(await t.post<unknown>(path, { componentId: component }));
      });
    });

  const claudeSettings = hosts
    .command('claude-settings')
    .description("That host's Claude Code memory entries and any settings.json drift");

  claudeSettings
    .command('get', { isDefault: true })
    .description('Show memory entries and any settings.json drift')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(
          opts,
          '/claude-settings',
          () => '/api/hosts/claude-settings',
        );
        emitJson(await t.get<unknown>(path));
      });
    });

  claudeSettings
    .command('discard')
    .description("Rewrite that host's drifted settings.json from the shared settings")
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(
          opts,
          '/claude-settings/discard',
          () => '/api/hosts/claude-settings/discard',
        );
        emitJson(await t.post<unknown>(path, {}));
      });
    });

  const memory = hosts.command('memory').description("That host's Claude Code memory entries");

  memory
    .command('remove <project> <file>')
    .description('Delete one memory entry')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (project: string, file: string, opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(
          opts,
          '/claude-settings/memory/delete',
          () => '/api/hosts/claude-settings/memory/delete',
        );
        emitJson(await t.post<unknown>(path, { project, file }));
      });
    });

  hosts
    .command('update')
    .description('Apply an available host update on that machine')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const { t, path } = await daemonRoute(opts, '/update', () => '/api/hosts/update');
        emitJson(await t.post<unknown>(path, {}));
      });
    });

  hosts
    .command('pair-device')
    .description('On this machine only: open a five-minute window for a voice device')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        // No `--host`: the host adopts the device itself, so this is
        // local-only and has no wire frame (spec/02 § Control IPC).
        const t = getTransport(opts);
        if (t.kind !== 'uds') {
          throw new Error('hosts pair-device runs on the machine itself, over its local socket');
        }
        emitJson(await t.post<unknown>('/pair-device', {}));
      });
    });

  // --- Server-owned, even when they name this machine ----------------------

  hosts
    .command('add')
    .description('Mint a registration code for a new machine, with the install command')
    .option('--os <os>', 'target operating system for the install command (macos|linux)', 'macos')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { os: string }) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const code = await t.post<{ code: string; expiresAt: number }>(
          '/api/auth/daemon/pair/start',
          {},
        );
        // The install command comes from the SERVER — never composed here out of
        // this CLI's idea of the server's address or of how a build is named.
        const install = await t.get<{ command: string; version: string }>(
          `/api/daemon/install-command?os=${encodeURIComponent(opts.os)}`,
        );
        if (opts.json) {
          emitJson({ ...code, install });
          return;
        }
        emitText(`code: ${code.code}`);
        emitText(`run on the new machine: ${install.command}`);
      });
    });

  hosts
    .command('rename <name>')
    .description('Rename a machine (server-owned)')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: HostsOpts) => {
      await run(opts, async () => {
        if (name.trim().length === 0) throw new Error('a machine name cannot be empty');
        const t = getTransport({ ...opts, remote: true });
        const daemonId = opts.host !== undefined ? await resolveHost(opts) : undefined;
        emitJson(
          await t.post<unknown>('/api/hosts/rename', {
            hostName: name,
            ...(daemonId ? { daemonId } : {}),
          }),
        );
      });
    });

  hosts
    .command('set-home')
    .description('Make a machine the account home, where the special threads run')
    .option('--host <h>', 'machine name or daemonId prefix (default: this machine)')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const daemonId = opts.host !== undefined ? await resolveHost(opts) : undefined;
        emitJson(
          await t.post<unknown>('/api/hosts/set-home', { ...(daemonId ? { daemonId } : {}) }),
        );
      });
    });

  hosts
    .command('remove')
    .description('Revoke a machine (requires --host)')
    .requiredOption('--host <h>', 'machine name or daemonId prefix — never defaulted')
    .option('--json', 'JSON output')
    .action(async (opts: HostsOpts) => {
      await run(opts, async () => {
        // `--host` is REQUIRED here: an irreversible revocation must never be
        // aimed at a machine by default (spec/17 § Hosts and the CLI).
        const daemonId = await resolveHost(opts);
        const t = getTransport({ ...opts, remote: true });
        emitJson(await t.post<unknown>('/api/auth/revoke', { id: daemonId }));
      });
    });
}
