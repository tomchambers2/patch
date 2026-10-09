// `patch settings`, `patch accounts`, `patch keys` — the shared settings
// (spec/01 § Settings, spec/17 § Commands).
//
// These change what every host runs on, so they go to the SERVER wherever the
// CLI runs — never a machine's own socket. With no server reachable they fail,
// naming it, rather than changing one machine behind the others' backs.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';
import { resolveHost } from './hosts.js';

interface SharedState {
  version: number;
  settings: Record<string, unknown> & {
    accountStrategy: { claude: string; codex: string };
  };
  secrets: {
    claude: Array<{ id: string; label: string; connected: boolean; email?: string }>;
    codex: Array<{ id: string; label: string; kind: string; connected: boolean; email?: string }>;
    providerKeys: Array<{ id: string; set: boolean; last4?: string }>;
  };
  hosts: Array<{ daemonId: string; appliedVersion?: number; error?: string }>;
  problem?: string;
}

const server = (opts: CommonOpts) => getTransport({ ...opts, remote: true });

/** `permission-mode` → `permissionModeDefault`, and the few other CLI names. */
const SETTING_KEYS: Record<string, string> = {
  'permission-mode': 'permissionModeDefault',
  'default-model': 'defaultModel',
  'question-expiry': 'questionExpiry',
  'question-expiry-seconds': 'questionExpirySeconds',
  'auto-resume': 'autoResumeRateLimit',
  'chat-name-interval': 'chatNameInterval',
  'kokoro-voice': 'kokoroVoice',
  memory: 'harnessMemoryEnabled',
};

/** A value as typed: JSON where it parses (true, 60, "x"), else the text itself. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function backendOf(name: string): 'claude-code' | 'codex' {
  if (name === 'claude' || name === 'claude-code') return 'claude-code';
  if (name === 'codex' || name === 'openai' || name === 'chatgpt') return 'codex';
  throw new Error(`no backend "${name}" (claude or codex)`);
}

function printAccounts(state: SharedState, backend: 'claude-code' | 'codex'): void {
  const list = backend === 'codex' ? state.secrets.codex : state.secrets.claude;
  const strategy = state.settings.accountStrategy[backend === 'codex' ? 'codex' : 'claude'];
  emitText(`${backend === 'codex' ? 'ChatGPT' : 'Claude'} — strategy: ${strategy}`);
  if (list.length === 0) emitText('  (no accounts)');
  list.forEach((a, i) =>
    emitText(
      `  ${i + 1}. ${a.label}${a.email ? ` <${a.email}>` : ''}${a.connected ? '' : '  [not connected]'}  ${a.id}`,
    ),
  );
}

export function registerSettingsCommands(program: Command): void {
  const settings = program
    .command('settings')
    .description('The shared settings every host runs on');

  settings
    .command('show', { isDefault: true })
    .description('Every shared setting, and which version each host runs')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).get<SharedState>('/api/settings/shared');
        if (opts.json) {
          emitJson(state);
          return;
        }
        if (state.problem) emitText(`problem: ${state.problem}`);
        emitText(`version ${state.version}`);
        for (const [k, v] of Object.entries(state.settings))
          emitText(`  ${k}: ${JSON.stringify(v)}`);
        for (const h of state.hosts) {
          emitText(
            `host ${h.daemonId}: ${h.error ? `could not apply — ${h.error}` : h.appliedVersion === state.version ? 'up to date' : `on ${h.appliedVersion ?? 'none'}`}`,
          );
        }
      });
    });

  settings
    .command('set <key> <value>')
    .description(`Change one shared setting (e.g. ${Object.keys(SETTING_KEYS).join(', ')})`)
    .option('--json', 'JSON output')
    .action(async (key: string, value: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const field = SETTING_KEYS[key] ?? key;
        const res = await server(opts).patch<unknown>('/api/settings', {
          [field]: parseValue(value),
        });
        if (opts.json) emitJson(res);
        else emitText(`${field}: ${value}`);
      });
    });

  settings
    .command('claude <file>')
    .description("Replace the shared Claude Code settings.json from a file (or '-' for none)")
    .option('--os <os>', 'set the override for darwin or linux instead of the shared text')
    .option('--json', 'JSON output')
    .action(async (file: string, opts: CommonOpts & { os?: string }) => {
      await run(opts, async () => {
        const which = opts.os ?? 'shared';
        if (!['shared', 'darwin', 'linux'].includes(which)) {
          throw new Error(`--os must be darwin or linux (got ${which})`);
        }
        const t = server(opts);
        const current = await t.get<SharedState>('/api/settings/shared');
        const text = file === '-' ? '' : readFileSync(file, 'utf8');
        const claudeSettings = {
          ...(current.settings['claudeSettings'] as Record<string, string>),
          [which]: text,
        };
        emitJson(await t.patch<unknown>('/api/settings', { claudeSettings }));
      });
    });

  const accounts = program
    .command('accounts')
    .description('The Claude and ChatGPT accounts every host draws from');

  accounts
    .command('list [backend]', { isDefault: true })
    .description('The shared accounts, in order, with the strategy')
    .option('--json', 'JSON output')
    .action(async (backend: string | undefined, opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).get<SharedState>('/api/settings/shared');
        if (opts.json) {
          emitJson(state.secrets);
          return;
        }
        if (backend !== undefined) printAccounts(state, backendOf(backend));
        else {
          printAccounts(state, 'claude-code');
          printAccounts(state, 'codex');
        }
      });
    });

  accounts
    .command('add <backend>')
    .description('Add a Claude account from a token, or a ChatGPT API key')
    .option('--token <t>', 'a `claude setup-token` token (claude)')
    .option('--api-key <k>', 'an OpenAI API key (codex)')
    .option('--label <l>', 'a name for it')
    .option('--json', 'JSON output')
    .action(
      async (
        backend: string,
        opts: CommonOpts & { token?: string; apiKey?: string; label?: string },
      ) => {
        await run(opts, async () => {
          const id = backendOf(backend);
          const body = {
            ...(opts.token ? { token: opts.token } : {}),
            ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
            ...(opts.label ? { label: opts.label } : {}),
          };
          const state = await server(opts).post<SharedState>(`/api/accounts/${id}`, body);
          if (opts.json) emitJson(state);
          else printAccounts(state, id);
        });
      },
    );

  accounts
    .command('connect <backend> <accountId>')
    .description("Replace an account's token")
    .requiredOption('--token <t>', 'the new token')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountId: string, opts: CommonOpts & { token: string }) => {
      await run(opts, async () => {
        emitJson(
          await server(opts).patch<unknown>(
            `/api/accounts/${backendOf(backend)}/${encodeURIComponent(accountId)}`,
            { token: opts.token },
          ),
        );
      });
    });

  accounts
    .command('disconnect <backend> <accountId>')
    .description('Take an account out of every host’s sequence (it stays listed)')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        emitJson(
          await server(opts).post<unknown>(
            `/api/accounts/${backendOf(backend)}/${encodeURIComponent(accountId)}/disconnect`,
          ),
        );
      });
    });

  accounts
    .command('remove <backend> <accountId>')
    .description('Remove an account from every host')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        emitJson(
          await server(opts).delete<unknown>(
            `/api/accounts/${backendOf(backend)}/${encodeURIComponent(accountId)}`,
          ),
        );
      });
    });

  accounts
    .command('order <backend> <accountIds...>')
    .description('Set the order: every account, each once, first to last')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountIds: string[], opts: CommonOpts) => {
      await run(opts, async () => {
        const id = backendOf(backend);
        const state = await server(opts).put<SharedState>(`/api/accounts/${id}/order`, {
          accountIds,
        });
        if (opts.json) emitJson(state);
        else printAccounts(state, id);
      });
    });

  accounts
    .command('strategy <backend> <strategy>')
    .description('How a turn picks its account: priority, round-robin, soonest-reset, least-used')
    .option('--json', 'JSON output')
    .action(async (backend: string, strategy: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const id = backendOf(backend);
        const state = await server(opts).put<SharedState>(`/api/accounts/${id}/strategy`, {
          strategy,
        });
        if (opts.json) emitJson(state);
        else printAccounts(state, id);
      });
    });

  accounts
    .command('adopt <backend>')
    .description("Store a machine's own login as a shared account")
    .option('--host <h>', 'machine name or daemonId prefix (default: the home host)')
    .option('--json', 'JSON output')
    .action(async (backend: string, opts: CommonOpts & { host?: string }) => {
      await run(opts, async () => {
        const daemonId = await hostOrHome(opts);
        const id = backendOf(backend);
        const state = await server(opts).post<SharedState>(`/api/accounts/${id}/adopt`, {
          daemonId,
        });
        if (opts.json) emitJson(state);
        else printAccounts(state, id);
      });
    });

  const keys = program.command('keys').description('Provider keys shared by every host');

  keys
    .command('list', { isDefault: true })
    .description('Each key: set or not, and its last four characters')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).get<SharedState>('/api/settings/shared');
        if (opts.json) {
          emitJson(state.secrets.providerKeys);
          return;
        }
        for (const k of state.secrets.providerKeys) {
          emitText(`${k.id}: ${k.set ? `set · ends ${k.last4 ?? '????'}` : 'not set'}`);
        }
      });
    });

  keys
    .command('set <keyId> [value]')
    .description(
      "Set a key for every host; with --host and no value, adopt that machine's environment key",
    )
    .option('--host <h>', 'machine name or daemonId prefix to adopt from')
    .option('--json', 'JSON output')
    .action(
      async (keyId: string, value: string | undefined, opts: CommonOpts & { host?: string }) => {
        await run(opts, async () => {
          const t = server(opts);
          const path = `/api/providers/keys/${encodeURIComponent(keyId)}`;
          const res =
            value !== undefined
              ? await t.put<unknown>(path, { value })
              : await t.post<unknown>(`${path}/adopt`, { daemonId: await hostOrHome(opts) });
          if (opts.json) emitJson(res);
          else emitText(`${keyId}: set`);
        });
      },
    );

  keys
    .command('revoke <keyId>')
    .description('Delete a key from every host')
    .option('--json', 'JSON output')
    .action(async (keyId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const res = await server(opts).delete<unknown>(
          `/api/providers/keys/${encodeURIComponent(keyId)}`,
        );
        if (opts.json) emitJson(res);
        else emitText(`${keyId}: revoked`);
      });
    });
}

/** `--host`, or the account's home host when none is named. */
async function hostOrHome(opts: CommonOpts & { host?: string }): Promise<string> {
  if (opts.host !== undefined) return resolveHost(opts);
  const { hosts } = await server(opts).get<{
    hosts: Array<{ daemonId: string; isHomeHost: boolean }>;
  }>('/api/hosts');
  const home = hosts.find((h) => h.isHomeHost);
  if (!home) throw new Error('no home host — name one with --host');
  return home.daemonId;
}
