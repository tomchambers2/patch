#!/usr/bin/env node
// Patch CLI — TUI + agent-facing primitives. See spec/13 + spec/17.
//
// One binary, two modes:
//   - With no subcommand → launch the TUI (Ink).
//   - With a subcommand → run the agent-facing primitive.

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { healthz } from './healthz.js';
import { registerChatsCommands } from './commands/chats.js';
import { registerActivityCommands } from './commands/activity.js';
import { registerJobsCommands } from './commands/jobs.js';
import { registerHooksCommands } from './commands/hooks.js';
import { registerMessageHooksCommands } from './commands/message-hooks.js';
import { registerThreadsCommands } from './commands/threads.js';
import { registerSurfacesCommands } from './commands/surfaces.js';
import { registerLogsCommands } from './commands/logs.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerHostCommands } from './commands/host.js';
import { registerHostsCommands } from './commands/hosts.js';
import { registerSettingsCommands } from './commands/settings.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerManageCommands } from './commands/manage.js';
import { resolveCliVersion } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name('patch')
  .description('Patch — TUI + agent CLI for the patch coordination layer')
  .version(resolveCliVersion(here));

program
  .command('healthz')
  .description('Hit the configured server /api/healthz endpoint')
  .option('--server <url>', 'Server base URL (overrides config serverUrl)')
  .option('--json', 'JSON output')
  .action(async (opts: { server?: string; json?: boolean }) => {
    try {
      // Precedence: per-invocation --server > config serverUrl (which itself
      // honours PATCH_SERVER_URL > config file > default). NO FALLBACK beyond
      // that chain.
      const { loadConfig } = await import('./config.js');
      const server = opts.server ?? loadConfig().serverUrl;
      const result = await healthz(server);
      if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) process.stdout.write(JSON.stringify({ error: msg }) + '\n');
      else process.stderr.write('[patch] error: ' + msg + '\n');
      process.exit(1);
    }
  });

// TUI launch (`patch`, `patch resume`, `patch attach`).
program
  .command('resume [id]')
  .description('Resume a chat in the TUI')
  .option('--folder <folder>', 'Folder for new chat')
  .option('--no-status', 'Suppress the StatusStrip')
  .option('--model <model>', 'SDK model override (pass-through to host spawn)')
  .option(
    '--dangerously-skip-permissions',
    'Run with permissionMode=bypassPermissions (pass-through to host spawn)',
  )
  .action(
    async (
      id: string | undefined,
      opts: {
        folder?: string;
        status?: boolean;
        model?: string;
        dangerouslySkipPermissions?: boolean;
      },
      cmd: Command,
    ) => {
      // `--model` / `--dangerously-skip-permissions` are shared with the root
      // `patch` program, so commander may bind them at the root level; read via
      // optsWithGlobals() to capture the value either way (see chats spawn).
      const merged = cmd.optsWithGlobals() as {
        model?: string;
        dangerouslySkipPermissions?: boolean;
      };
      const { launchTui } = await import('./tui/launch.js');
      await launchTui({
        ...(id ? { resume: id } : {}),
        ...(opts.folder ? { folder: opts.folder } : {}),
        ...(merged.model ? { model: merged.model } : {}),
        ...(merged.dangerouslySkipPermissions
          ? { permissionMode: 'bypassPermissions' as const }
          : {}),
        hideStatus: opts.status === false,
      });
    },
  );

program
  .command('attach <id>')
  .description('Attach to a live chat in the TUI')
  .action(async (id: string) => {
    const { launchTui } = await import('./tui/launch.js');
    await launchTui({ attach: id });
  });

// Default action (no subcommand) → launch picker TUI.
//
// Flag pass-through (spec/13 ## Flag pass-through): `--resume`, `--model`,
// `--dangerously-skip-permissions` are accepted on the bare `patch` invocation
// and translated into the host's spawn-chat / resume-chat RPC options.
program
  .option('--folder <folder>', 'Skip the picker and spawn in this folder')
  .option('--no-status', 'Suppress the StatusStrip')
  .option('--resume <chatId>', 'Resume an existing chat by id (pass-through to host resume)')
  .option('--model <model>', 'SDK model override (pass-through to host spawn)')
  .option(
    '--dangerously-skip-permissions',
    'Run with permissionMode=bypassPermissions (pass-through to host spawn)',
  )
  .action(
    async (opts: {
      folder?: string;
      status?: boolean;
      resume?: string;
      model?: string;
      dangerouslySkipPermissions?: boolean;
    }) => {
      const { launchTui } = await import('./tui/launch.js');
      await launchTui({
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(opts.folder ? { folder: opts.folder } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.dangerouslySkipPermissions
          ? { permissionMode: 'bypassPermissions' as const }
          : {}),
        hideStatus: opts.status === false,
      });
    },
  );

// Resource-grouped agent primitives.
registerChatsCommands(program);
registerActivityCommands(program);
registerJobsCommands(program);
registerHooksCommands(program);
registerMessageHooksCommands(program);
registerThreadsCommands(program);
registerSurfacesCommands(program);
registerLogsCommands(program);
registerAuthCommands(program);
registerHostCommands(program);
registerHostsCommands(program);
registerSettingsCommands(program);
registerDoctorCommand(program);
registerManageCommands(program);

// Reject an unknown TOP-LEVEL command before it falls through to the default
// (TUI) action. The program carries a default `.action()` (bare `patch` →
// picker TUI), which makes commander treat an unknown bareword like
// `patch florp` as an EXCESS ARGUMENT to that default command — so it reports a
// misleading "unknown option '--json'" (or silently runs the default TUI
// action) instead of naming the unknown command. We mirror how unknown
// SUBCOMMANDS are already reported ("unknown command 'florp'") by checking the
// bareword against commander's own registry of registered command names +
// aliases. NO FALLBACK: a command the CLI doesn't define is rejected, not
// swallowed.
const knownCommandNames = new Set<string>();
for (const cmd of program.commands) {
  knownCommandNames.add(cmd.name());
  for (const alias of cmd.aliases()) knownCommandNames.add(alias);
}
const cmdName = process.argv[2];
if (cmdName !== undefined && !cmdName.startsWith('-') && !knownCommandNames.has(cmdName)) {
  process.stderr.write(`error: unknown command '${cmdName}'\n`);
  process.exit(1);
}

// Determine if we're in TUI mode (no subcommand, or `resume`/`attach`).
// In those modes we keep the event loop alive for Ink. For everything else
// we explicitly exit after the action resolves so HTTP keep-alive sockets
// don't pin the process open.
const TUI_MODE_VERBS = new Set(['resume', 'attach']);
const isTuiMode = cmdName === undefined || cmdName.startsWith('-') || TUI_MODE_VERBS.has(cmdName);

program.parseAsync(process.argv).then(
  () => {
    if (!isTuiMode) {
      // Flush stdout then exit (avoids Undici keepalive socket pinning).
      process.stdout.write('', () => process.exit(0));
    }
  },
  (err: Error) => {
    process.stderr.write('[patch] fatal: ' + err.message + '\n');
    process.exit(1);
  },
);
