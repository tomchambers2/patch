// `patch doctor` — env + connection diagnostics (user-facing; spec/13 + spec/17).
//
// Reports, against the live stack:
//   - server reachability (GET /api/healthz)
//   - host online/offline state (UDS /healthz when daemon-local, else the
//     server's GET /api/daemon/healthz which mirrors the daemon-link state)
//   - errored-chat count (chats whose activity === 'errored')
//   - the chat history log's replay comparison (daemon-local only)
//   - pending cron/webhook backlog (buffered fires in <dataDir>/pending/, the
//     server dispatcher's offline buffer — read on-box when PATCH_DATA_DIR is
//     resolvable; null when off-box)
//
// NO FALLBACK: each probe records its real result or a captured error string;
// nothing is silently defaulted to a healthy value.

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, run } from './_common.js';
import {
  configFilePath,
  configHomeDir,
  credentialFilePath,
  identityFilePath,
  loadConfig,
} from '../config.js';
import { healthz } from '../healthz.js';
import { bearerToken } from '../auth.js';
import { RestClient, RestError } from '../transport/rest.js';
import { buildTransport } from '../transport/index.js';

interface ChatRow {
  chatId: string;
  name?: string | null;
  activity?: string;
  status?: string;
  lastError?: { code: string; message: string; at: number } | null;
}

/** Count buffered cron/webhook fires in the server dispatcher's pending dir. */
function pendingBacklog(): number | null {
  const dataDir = process.env.PATCH_DATA_DIR;
  if (!dataDir || dataDir.length === 0) return null;
  const dir = join(dataDir, 'pending');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
}

interface UndeliveredEntry {
  ts: number;
  channel: string;
  chatId: string;
  message: string;
  error: string;
}

/**
 * Notify delivery failures recorded in <dataDir>/undelivered.jsonl (spec/09:
 * "Failures … logged to /data/undelivered.jsonl and surfaced via patch
 * doctor"). The notifications router appends one line per failed delivery
 * (Expo push rejected, no devices, bot API error). On-box only — read when
 * PATCH_DATA_DIR is resolvable, null when off-box (NO FALLBACK: a parse error
 * is recorded verbatim, never silently treated as zero failures).
 */
function undeliveredNotifications():
  | { count: number; byChannel: Record<string, number>; recent: UndeliveredEntry[] }
  | string
  | null {
  const dataDir = process.env.PATCH_DATA_DIR;
  if (!dataDir || dataDir.length === 0) return null;
  const path = join(dataDir, 'undelivered.jsonl');
  if (!existsSync(path)) return { count: 0, byChannel: {}, recent: [] };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const entries: UndeliveredEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as UndeliveredEntry);
    } catch (err) {
      return `parse error in undelivered.jsonl: ${(err as Error).message}`;
    }
  }
  const byChannel: Record<string, number> = {};
  for (const e of entries) byChannel[e.channel] = (byChannel[e.channel] ?? 0) + 1;
  // Surface the most recent few so the user can see *what* failed, not just a
  // count — mirrors erroredChatDetails.
  const recent = entries.slice(-5);
  return { count: entries.length, byChannel, recent };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnostics: env, server reachability, host state, backlogs')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const config = loadConfig();
        const checks: Record<string, unknown> = {
          configHome: configHomeDir(),
          configFile: existsSync(configFilePath()),
          identity: existsSync(identityFilePath()),
          credential: existsSync(credentialFilePath()),
          serverUrl: config.serverUrl,
          daemonSocket: config.daemonSocket,
          daemonLocalKey: config.daemonLocalKey !== null ? '<set>' : null,
        };

        // --- server reachability ---
        let serverReachable = false;
        try {
          checks['serverHealthz'] = await healthz(config.serverUrl);
          serverReachable = true;
        } catch (err) {
          checks['serverHealthz'] = `error: ${(err as Error).message}`;
        }
        checks['serverReachable'] = serverReachable;

        // --- host online/offline ---
        // Prefer the host's own UDS /healthz when we have a local socket; it
        // is the most direct liveness signal. Otherwise read the server's
        // /api/daemon/healthz, which reflects the daemon-link state (503 when
        // the host is not connected).
        let daemonOnline = false;
        if (config.daemonSocket !== null && config.daemonLocalKey !== null) {
          try {
            const t = buildTransport(config, { forceUds: true });
            await t.get<{ ok: boolean }>('/healthz');
            daemonOnline = true;
            checks['daemonProbe'] = 'uds:/healthz';
          } catch (err) {
            checks['daemonProbe'] = `uds error: ${(err as Error).message}`;
          }
        } else {
          // REST path: the server's /api/daemon/healthz is account-internal
          // state (spec/10) and requires the surface JWT bearer — exactly like
          // `patch host status`. Hitting it anonymously gets a by-design 401
          // which must NOT be read as the host being offline. Use the
          // authenticated REST transport so the bearer is attached, then:
          //   - 200 {ok:true}  → host online
          //   - 503            → host genuinely offline (link down)
          // NO FALLBACK: a 401/credential/network error is recorded verbatim,
          // never silently treated as either online or offline.
          try {
            const t = buildTransport(config, { forceRest: true });
            const res = await t.get<{ ok: boolean }>('/api/daemon/healthz');
            daemonOnline = res.ok === true;
            checks['daemonProbe'] = `server:/api/daemon/healthz (200)`;
          } catch (err) {
            if (err instanceof RestError) {
              // 503 is the server's authoritative "host link down" signal.
              if (err.status === 503) {
                daemonOnline = false;
                checks['daemonProbe'] = `server:/api/daemon/healthz (503)`;
              } else {
                // 401/other: not a daemon-liveness signal — surface it, don't
                // pretend the host is down.
                checks['daemonProbe'] = `server:/api/daemon/healthz (${err.status})`;
              }
            } else {
              checks['daemonProbe'] = `server error: ${(err as Error).message}`;
            }
          }
        }
        checks['daemonOnline'] = daemonOnline;

        // --- errored-chat count ---
        try {
          const t = buildTransport(config);
          const path = t.kind === 'uds' ? '/chats' : '/api/chats';
          const res = await t.get<{
            chats: ChatRow[];
            unreadable?: Array<{ chatId: string; path: string; error: string }>;
          }>(path);
          // An errored chat is one whose persisted LIFECYCLE status is
          // 'errored' (survives restart, visible in `threads list`/`chats get`),
          // NOT the transient `activity` field (which settles back to 'idle'
          // after the failed turn). Counting `activity === 'errored'` made every
          // restored errored thread invisible to diagnostics — the d6 defect.
          const errored = res.chats.filter((c) => c.status === 'errored');
          checks['erroredChats'] = errored.length;
          // Dedicated field so the user can SEE which chats errored and why,
          // rather than just a count. lastError is the persisted error detail.
          checks['erroredChatDetails'] = errored.map((c) => ({
            chatId: c.chatId,
            name: c.name ?? null,
            lastError: c.lastError ?? null,
          }));
          // Chats the host could not load at all: their meta.json failed to
          // read or parse, so they are absent from `chats` above. Only the
          // local socket reports them; the server route does not carry it.
          checks['unreadableChats'] =
            res.unreadable ?? 'unknown: only reported over the local host socket';
        } catch (err) {
          checks['erroredChats'] = `error: ${(err as Error).message}`;
        }

        // --- pending cron/webhook backlog (on-box only) ---
        checks['pendingBacklog'] = pendingBacklog();

        // --- notify delivery failures (on-box only) ---
        // spec/09: delivery failures are logged to <dataDir>/undelivered.jsonl
        // and surfaced via `patch doctor`. Read the file (same dataDir as the
        // server's notifications router) and report the failure count + recent
        // detail so the user can SEE which channels are dropping notifies.
        const undelivered = undeliveredNotifications();
        if (typeof undelivered === 'string') {
          checks['undeliveredNotifications'] = undelivered;
          checks['undeliveredCount'] = undelivered; // surface the error here too
        } else if (undelivered === null) {
          checks['undeliveredNotifications'] = null;
          checks['undeliveredCount'] = null;
        } else {
          checks['undeliveredCount'] = undelivered.count;
          checks['undeliveredNotifications'] = undelivered;
        }

        // --- credential validity (best-effort, REST only) ---
        try {
          const jwt = bearerToken();
          const rest = new RestClient({ serverUrl: config.serverUrl, bearer: jwt });
          const me = await rest.get<unknown>('/api/auth/me');
          checks['credentialValid'] = true;
          checks['authMe'] = me;
        } catch (err) {
          checks['credentialValid'] = false;
          checks['credentialError'] = (err as Error).message;
        }

        if (opts.json) emitJson(checks);
        else
          for (const [k, v] of Object.entries(checks))
            emitText(`${k.padEnd(20)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      });
    });
}
