// `patch jobs *` — primitives over the host's jobs resource.
//
// Routes:
//   list       → GET /internal/jobs (uds) | GET /api/jobs (rest)
//   get <id>   → REST only: GET /api/jobs/:id
//   create     → POST /internal/jobs | POST /api/jobs
//   update     → PATCH /internal/jobs/:id | PATCH /api/jobs/:id
//   delete     → DELETE /internal/jobs/:id | DELETE /api/jobs/:id
//   enable     → POST .../enable
//   disable    → POST .../disable
//   runs       → GET .../runs
//   hooks      → GET .../webhooks

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { assertValidCron, assertValidTimeZone } from '@patch/wire';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, parseLimit, pickPath, run } from './_common.js';

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as unknown;
}

export function registerJobsCommands(program: Command): void {
  const jobs = program.command('jobs').description('Job CRUD');

  jobs
    .command('list')
    .description('List all jobs')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const res = await t.get<{
          jobs: Array<{ id: string; name?: string; enabled?: boolean; trigger?: { type: string } }>;
        }>(pickPath(t, '/internal/jobs', '/api/jobs'));
        if (opts.json) {
          emitJson(res);
          return;
        }
        if (res.jobs.length === 0) {
          emitText('(no jobs)');
          return;
        }
        for (const j of res.jobs) {
          const state = j.enabled === false ? 'disabled' : 'enabled';
          emitText(
            `${j.id}  ${j.name ?? '(unnamed)'}  [${state}]  trigger=${j.trigger?.type ?? '?'}`,
          );
        }
      });
    });

  jobs
    .command('get <id>')
    .description('Show a single job')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        if (t.kind === 'uds') {
          // No GET-by-id over UDS today — list and filter (still a primitive).
          const res = await t.get<{ jobs: Array<{ id: string }> }>('/internal/jobs');
          const job = res.jobs.find((j) => j.id === id);
          if (!job) throw new Error(`job not found: ${id}`);
          if (opts.json) emitJson(job);
          else emitText(JSON.stringify(job, null, 2));
        } else {
          const job = await t.get<unknown>(`/api/jobs/${id}`);
          if (opts.json) emitJson(job);
          else emitText(JSON.stringify(job, null, 2));
        }
      });
    });

  jobs
    .command('create [file]')
    .description('Create a job from a JSON file, OR via flags')
    .option(
      '--cron <expr>',
      'Cron expression (flag-mode shortcut). Evaluated in --timezone (default $TZ) unless --utc.',
    )
    .option(
      '--timezone <iana>',
      'IANA zone the cron expression is evaluated in (default: $TZ). Stored on the trigger, so DST is tracked.',
    )
    .option('--utc', 'Evaluate --cron in UTC (store no timezone on the trigger)')
    .option('--action <type>', "Action type when using flag-mode ('spawn', 'message' or 'script')")
    .option('--folder <path>', 'Spawn folder when --action spawn (or --action script)')
    .option('--chat-id <id>', 'Target chat when --action message')
    .option('--command <cmd>', 'Shell command to run when --action script')
    .option('--daemon-id <id>', 'Host the command runs on when --action script')
    .option('--timeout-ms <ms>', 'Kill a --action script command after this long (default 60000)')
    .option('--prompt <prompt>', 'First-turn prompt (exactly one of --prompt | --skill required)')
    .option('--skill <name>', 'First-turn skill (exactly one of --prompt | --skill required)')
    .option('--name <name>', 'Job name (flag-mode)')
    .option('--filter <jsonata>', 'Optional jsonata filter expression')
    .option('--webhook', 'Flag-mode shortcut: build a webhook-trigger job (instead of --cron)')
    .option(
      '--scheme <scheme>',
      "Webhook signature scheme: 'none' (default), 'hmac-sha256', 'github', 'stripe' or 'todoist'",
    )
    .option(
      '--secret <secret>',
      'Webhook shared secret (required for any --scheme other than none)',
    )
    .option('--json', 'JSON output')
    .action(
      async (
        file: string | undefined,
        opts: CommonOpts & {
          cron?: string;
          timezone?: string;
          utc?: boolean;
          action?: string;
          folder?: string;
          chatId?: string;
          command?: string;
          daemonId?: string;
          timeoutMs?: string;
          prompt?: string;
          skill?: string;
          name?: string;
          filter?: string;
          webhook?: boolean;
          scheme?: string;
          secret?: string;
        },
        cmd: Command,
      ) => {
        await run(opts, async () => {
          let body: unknown;
          // Commander's parent program also defines `--folder` (for the
          // TUI default action), so it can shadow our subcommand option.
          // Fall back to the root opts when present.
          const rootOpts = cmd.parent?.parent?.opts() as { folder?: string } | undefined;
          const folder = opts.folder ?? rootOpts?.folder;
          if (file !== undefined) {
            body = readJsonFile(file);
          } else if (opts.action !== undefined && (opts.cron !== undefined || opts.webhook)) {
            // Flag-mode: an --action plus EITHER --cron (cron trigger) OR
            // --webhook (webhook trigger). Webhook authoring no longer requires
            // a JSON file (H1-d7), so the advertised --filter flag is reachable
            // for webhook jobs too. Exactly one trigger source is allowed.
            if (opts.cron !== undefined && opts.webhook) {
              throw new Error('jobs create: pass either --cron OR --webhook, not both');
            }
            const action: Record<string, unknown> = { type: opts.action };
            // A `script` action runs a command instead of delivering a first
            // turn (spec/08 § Action), so it is the one action type that takes
            // neither --prompt nor --skill — and it is checked before the
            // first-turn rules below rather than being exempted inside them.
            if (opts.action === 'script') {
              if (!opts.command) throw new Error('--command is required when --action script');
              if (!folder) throw new Error('--folder is required when --action script');
              if (!opts.daemonId) throw new Error('--daemon-id is required when --action script');
              if (opts.prompt !== undefined || opts.skill !== undefined) {
                throw new Error('--action script takes --command, not --prompt / --skill');
              }
              action['command'] = opts.command;
              action['folder'] = folder;
              action['daemonId'] = opts.daemonId;
              if (opts.timeoutMs !== undefined) {
                const ms = Number(opts.timeoutMs);
                if (!Number.isInteger(ms)) throw new Error('--timeout-ms must be a whole number');
                action['timeoutMs'] = ms;
              }
            }
            // spec/08 §Actions: every action carries EXACTLY ONE first-turn —
            // a skill OR a prompt (all four where×what combinations are valid).
            // Validate client-side with an actionable, field-naming message so
            // the user never sees the server's opaque {"error":"invalid_input"}.
            const hasPrompt = opts.prompt !== undefined && opts.prompt.length > 0;
            const hasSkill = opts.skill !== undefined && opts.skill.length > 0;
            if (opts.action !== 'script' && hasPrompt && hasSkill) {
              throw new Error(
                `--action ${opts.action} accepts exactly one of --prompt or --skill, not both`,
              );
            }
            if (opts.action !== 'script' && !hasPrompt && !hasSkill) {
              throw new Error(
                `--action ${opts.action} requires a first-turn: pass --prompt <text> or --skill <name>`,
              );
            }
            if (opts.action === 'script') {
              // Already built above.
            } else if (opts.action === 'spawn') {
              if (!folder) throw new Error('--folder is required when --action spawn');
              action['folder'] = folder;
            } else if (opts.action === 'message') {
              if (!opts.chatId) throw new Error('--chat-id is required when --action message');
              action['chatId'] = opts.chatId;
            } else {
              throw new Error(
                `unknown --action '${opts.action}' (expected 'spawn', 'message' or 'script')`,
              );
            }
            if (hasPrompt) action['prompt'] = opts.prompt;
            if (hasSkill) action['skill'] = opts.skill;

            let trigger: Record<string, unknown>;
            if (opts.webhook) {
              // Webhook trigger (H1-d7). scheme defaults to 'none'; any other
              // scheme requires a --secret (matches WebhookTrigger schema).
              const scheme = opts.scheme ?? 'none';
              const validSchemes = ['none', 'hmac-sha256', 'github', 'stripe', 'todoist'];
              if (!validSchemes.includes(scheme)) {
                throw new Error(
                  `invalid --scheme '${scheme}' (expected one of: ${validSchemes.join(', ')})`,
                );
              }
              if (scheme !== 'none' && (opts.secret === undefined || opts.secret.length === 0)) {
                throw new Error(`--secret is required when --scheme is '${scheme}'`);
              }
              trigger = { type: 'webhook', scheme };
              if (opts.secret !== undefined && opts.secret.length > 0) {
                trigger['secret'] = opts.secret;
              }
            } else {
              // Cron trigger. NO FALLBACK (H1-d5): validate the cron expression
              // CLIENT-SIDE — regardless of $TZ — so a malformed cron is named
              // as the problem here, never forwarded to the server for an opaque
              // {"error":"invalid body"}.
              //
              // The expression is stored EXACTLY as typed and the zone travels
              // with it on the trigger (spec/08 § Cron). This CLI used to
              // rewrite a local expression into UTC here, which baked in
              // whichever offset happened to be current on the day the job was
              // created — a 9am job made in GMT then fired at 10am all summer.
              // --utc stores no zone at all (evaluated in UTC, the pre-timezone
              // behaviour); --timezone overrides $TZ.
              const cronExpr = opts.cron!;
              assertValidCron(cronExpr);
              trigger = { type: 'cron', expression: cronExpr };
              if (!opts.utc) {
                const tz = opts.timezone ?? process.env['TZ'];
                if (tz !== undefined && tz.length > 0) {
                  assertValidTimeZone(tz);
                  trigger['timezone'] = tz;
                } else if (opts.timezone !== undefined) {
                  throw new Error('--timezone was given but empty');
                }
              } else if (opts.timezone !== undefined) {
                throw new Error('--utc and --timezone are mutually exclusive');
              }
            }
            body = {
              name: opts.name ?? `job-${Date.now()}`,
              enabled: true,
              trigger,
              filter: opts.filter ?? null,
              action,
            };
          } else {
            throw new Error(
              'jobs create: provide either a file path or --action + (--cron|--webhook) + ' +
                '(--folder|--chat-id) + (--prompt|--skill)',
            );
          }
          const t = getTransport(opts);
          const res = await t.post<unknown>(pickPath(t, '/internal/jobs', '/api/jobs'), body);
          if (opts.json) emitJson(res);
          else emitText(JSON.stringify(res, null, 2));
        });
      },
    );

  jobs
    .command('update <id> <file>')
    .description('Update a job from a JSON file (PATCH)')
    .option('--json', 'JSON output')
    .action(async (id: string, file: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const body = readJsonFile(file);
        const t = getTransport(opts);
        const res = await t.patch<unknown>(
          pickPath(t, `/internal/jobs/${id}`, `/api/jobs/${id}`),
          body,
        );
        if (opts.json) emitJson(res);
        else emitText(JSON.stringify(res, null, 2));
      });
    });

  jobs
    .command('delete <id>')
    .description('Delete a job')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const res = await t.delete<{ ok: true }>(
          pickPath(t, `/internal/jobs/${id}`, `/api/jobs/${id}`),
        );
        if (opts.json) emitJson(res);
        else emitText('deleted');
      });
    });

  jobs
    .command('enable <id>')
    .description('Enable a job')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const res = await t.post<unknown>(
          pickPath(t, `/internal/jobs/${id}/enable`, `/api/jobs/${id}/enable`),
        );
        if (opts.json) emitJson(res);
        else emitText('enabled');
      });
    });

  jobs
    .command('disable <id>')
    .description('Disable a job')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const res = await t.post<unknown>(
          pickPath(t, `/internal/jobs/${id}/disable`, `/api/jobs/${id}/disable`),
        );
        if (opts.json) emitJson(res);
        else emitText('disabled');
      });
    });

  jobs
    .command('runs <id>')
    .description('List run history (jsonl tail)')
    .option('--limit <n>', 'limit rows', '50')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts & { limit: string }) => {
      await run(opts, async () => {
        const limit = parseLimit(opts.limit);
        const t = getTransport(opts);
        const path =
          pickPath(t, `/internal/jobs/${id}/runs`, `/api/jobs/${id}/runs`) + `?limit=${limit}`;
        const res = await t.get<{ runs: unknown[] }>(path);
        if (opts.json) emitJson(res);
        else for (const r of res.runs) emitText(JSON.stringify(r));
      });
    });

  jobs
    .command('hooks <id>')
    .description('List webhook history (jsonl tail)')
    .option('--limit <n>', 'limit rows', '50')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts & { limit: string }) => {
      await run(opts, async () => {
        const limit = parseLimit(opts.limit);
        const t = getTransport(opts);
        const path =
          pickPath(t, `/internal/jobs/${id}/webhooks`, `/api/jobs/${id}/webhooks`) +
          `?limit=${limit}`;
        const res = await t.get<{ webhooks: unknown[] }>(path);
        if (opts.json) emitJson(res);
        else for (const r of res.webhooks) emitText(JSON.stringify(r));
      });
    });
}
