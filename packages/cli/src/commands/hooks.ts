// `patch hooks *` — webhook trigger introspection.
//
// `list`  → derive from `jobs list` + filter to webhook triggers.
// `tail`  → poll the most recent webhook lines for a job (or for all webhook
//           jobs if --id is not given).

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, parseLimit, pickPath, run } from './_common.js';
import { loadConfig } from '../config.js';

interface JobShape {
  id: string;
  name?: string;
  trigger?: { type: string; scheme?: string };
}

/**
 * Inbound ingress trigger types and their server route prefix (spec/08
 * ## Webhook / Todoist): the server exposes
 *   webhook  → POST /api/webhooks/<jobId>
 * Cron jobs have no ingress URL and are excluded. Todoist is NOT here — it is
 * job-less, see ingressUrl.
 */
const INGRESS_PREFIX: Record<string, string> = {
  webhook: '/api/webhooks',
};

/** The one shared Todoist callback URL (spec/08 § Todoist › Shared ingress). */
const TODOIST_INGRESS = '/api/webhooks/todoist';

/** Build the live ingress URL for a job, or null if its trigger has none. */
function ingressUrl(serverUrl: string, job: JobShape): string | null {
  const type = job.trigger?.type;
  if (type === undefined) return null;
  const base = serverUrl.replace(/\/$/, '');
  // A Todoist app has exactly ONE callback URL, so every todoist job is driven
  // by the same job-less endpoint — reporting a per-job URL here would hand the
  // user a URL that 401s for any job wired the normal way (no clientSecret).
  if (type === 'todoist' || (type === 'webhook' && job.trigger?.scheme === 'todoist')) {
    return `${base}${TODOIST_INGRESS}`;
  }
  const prefix = INGRESS_PREFIX[type];
  if (prefix === undefined) return null;
  return `${base}${prefix}/${job.id}`;
}

export function registerHooksCommands(program: Command): void {
  const hooks = program.command('hooks').description('Webhook trigger introspection');

  hooks
    .command('list')
    .description('List webhook URLs by job')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const serverUrl = loadConfig().serverUrl;
        const res = await t.get<{ jobs: JobShape[] }>(pickPath(t, '/internal/jobs', '/api/jobs'));
        // Every ingress-bearing trigger (webhook / todoist) has a
        // discoverable POST URL; cron jobs do not. Compute the URL from the
        // server base + the route prefix for the trigger type so `hooks list`
        // actually emits the URL its description promises (spec/17 'List
        // webhook URLs by trigger').
        const hooks = res.jobs
          .map((j) => ({ ...j, hookUrl: ingressUrl(serverUrl, j) }))
          .filter((j): j is JobShape & { hookUrl: string } => j.hookUrl !== null);
        if (opts.json) {
          emitJson({ hooks });
          return;
        }
        if (hooks.length === 0) {
          emitText('(no webhook jobs)');
          return;
        }
        for (const j of hooks) emitText(`${j.id}  ${j.hookUrl}`);
      });
    });

  hooks
    .command('tail')
    .description('Tail recent webhook deliveries')
    .option('--id <id>', 'Filter to a single job')
    .option('--limit <n>', 'rows per job', '20')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { id?: string; limit: string }) => {
      await run(opts, async () => {
        const limit = parseLimit(opts.limit);
        const t = getTransport(opts);
        const ids: string[] = [];
        if (opts.id) {
          ids.push(opts.id);
        } else {
          const list = await t.get<{ jobs: JobShape[] }>(
            pickPath(t, '/internal/jobs', '/api/jobs'),
          );
          for (const j of list.jobs) if (j.trigger?.type === 'webhook') ids.push(j.id);
        }
        const out: Record<string, unknown[]> = {};
        for (const id of ids) {
          const path =
            pickPath(t, `/internal/jobs/${id}/webhooks`, `/api/jobs/${id}/webhooks`) +
            `?limit=${limit}`;
          const res = await t.get<{ webhooks: unknown[] }>(path);
          out[id] = res.webhooks;
        }
        if (opts.json) emitJson(out);
        else
          for (const id of Object.keys(out)) {
            emitText(`# ${id}`);
            const list = out[id] ?? [];
            for (const r of list) emitText(JSON.stringify(r));
          }
      });
    });
}
