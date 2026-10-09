// What a running background task is costing the machine (spec/02 § Background
// task completions), for the surface's background task bar (spec/14 § Main
// chat panel — Background task bar).
//
// Nothing in the wire protocol, the SDK stream or the host's own state
// carries a background task's pid — the agent layer owns those processes and
// never reports them. What it DOES do is stream the task's output to
// `/tmp/claude-<uid>/<project>/<session>/tasks/<id>.output`, and every process
// in a backgrounded command's tree inherits that file as BOTH its stdout and
// its stderr. So the file is the handle: whoever holds it open is the task.
//
// `lsof` rather than walking `/proc/*/fd/1`, even though the proc walk is
// faster and needs no child process: a host also runs on macOS, which has no
// `/proc` at all, and a resource readout that silently only worked on Linux
// hosts is exactly the half-working thing this codebase refuses. One `lsof`
// invocation takes every path at once — it costs the same ~1.5s whether it is
// asked about one task or twenty, because the cost is the scan of the open-file
// table, not the number of paths — so the poll is one `lsof` plus one `ps`.
//
// NO FALLBACK, and it is the point of the whole module: a task we cannot
// measure is ABSENT from the result. Never zero. A backgrounded sub-agent runs
// inside the agent process and only links its transcript into the tasks
// directory, so it has no process of its own and never will; a command whose
// processes have exited leaves its output file behind. Reporting either as
// `0% · 0 B` would make a task that finished, a task that is blocked on I/O and
// a task we failed to find indistinguishable from one another.

import { execFile } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type {
  BackgroundTaskStat,
  PatchBackgroundTaskStatsRequestEvent,
  WireEvent,
} from '@patch/wire';

/**
 * A background id is a bare token from the agent layer. It is interpolated
 * into a filesystem path and handed to `lsof` as an argument, so anything that
 * is not this shape is dropped rather than escaped.
 */
const BACKGROUND_ID = /^[A-Za-z0-9_-]+$/;

/** Where the agent layer keeps its per-session scratch. */
const TASKS_ROOT = '/tmp';

/**
 * Measuring must never hold the host's event loop, and must never outlive the
 * surface's poll interval — a pile-up of `lsof` scans is worse than no reading.
 */
const PROBE_TIMEOUT_MS = 4_000;

/** Injectable so the tests can point at a fixture tree and a fake process table. */
export interface StatsProbeDeps {
  /** Root holding the `claude-<uid>` directories. */
  tasksRoot: string;
  /** Runs a binary and resolves its stdout. Rejects only if the binary is missing. */
  run: (bin: string, args: string[]) => Promise<{ stdout: string; failed: boolean }>;
}

function defaultRun(bin: string, args: string[]): Promise<{ stdout: string; failed: boolean }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        // `lsof` exits 1 when ANY named path has no holder, and `ps` exits 1
        // when a pid has gone — both are ordinary outcomes here, not failures,
        // and stdout still carries every hit. Only a missing binary (ENOENT)
        // is a real failure, which is what `no_process_table` reports.
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(err);
          return;
        }
        resolve({ stdout: stdout ?? '', failed: err != null });
      },
    );
  });
}

export const defaultStatsProbeDeps: StatsProbeDeps = { tasksRoot: TASKS_ROOT, run: defaultRun };

/**
 * Every `<root>/claude-<uid>/<project>/<session>/tasks/<taskId>.output` that
 * exists, mapped back to the id that named it.
 *
 * The surface knows neither the project nor the session — it reads background
 * ids off the transcript — so the host walks the two unknown levels. It is a
 * `readdir` of at most a handful of `claude-<uid>` directories and their
 * projects, then one `existsSync` per session, which is far cheaper than the
 * `lsof` that follows.
 */
export function resolveTaskOutputFiles(
  taskIds: string[],
  tasksRoot: string,
): Map<string, string[]> {
  const wanted = taskIds.filter((id) => BACKGROUND_ID.test(id));
  const found = new Map<string, string[]>();
  if (wanted.length === 0) return found;
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const uid of dirs(tasksRoot).filter((n) => n.startsWith('claude-'))) {
    for (const project of dirs(join(tasksRoot, uid))) {
      for (const session of dirs(join(tasksRoot, uid, project))) {
        const tasks = join(tasksRoot, uid, project, session, 'tasks');
        if (!existsSync(tasks)) continue;
        for (const id of wanted) {
          const file = join(tasks, `${id}.output`);
          if (!existsSync(file)) continue;
          const list = found.get(id);
          if (list) list.push(file);
          else found.set(id, [file]);
        }
      }
    }
  }
  return found;
}

/**
 * `lsof -F pn` emits a pid line (`p<pid>`) followed by one name line (`n<path>`)
 * per matching descriptor — so a task's own wrapper appears twice, once for
 * stdout and once for stderr. Returns path → the distinct pids holding it.
 */
export function parseLsof(stdout: string): Map<string, Set<number>> {
  const byPath = new Map<string, Set<number>>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : null;
      continue;
    }
    if (line.startsWith('n') && pid !== null) {
      const path = line.slice(1);
      const set = byPath.get(path) ?? new Set<number>();
      set.add(pid);
      byPath.set(path, set);
    }
  }
  return byPath;
}

/**
 * `ps -o pid=,%cpu=,rss=` — headerless, three columns. `%cpu` is the process's
 * share of one core averaged over its lifetime and `rss` is in KiB on both
 * Linux and macOS. A pid that died between the `lsof` and the `ps` simply has
 * no row, and drops out of the sum.
 */
export function parsePs(stdout: string): Map<number, { cpu: number; rssBytes: number }> {
  const out = new Map<number, { cpu: number; rssBytes: number }>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), { cpu: Number(m[2]), rssBytes: Number(m[3]) * 1024 });
  }
  return out;
}

/**
 * Measure the named background tasks. Resolves to one stat per task the host
 * could actually account for — ids that resolved to no file, or to a file no
 * live process holds, are simply not in the result.
 *
 * Throws only when the host has no process table to read (a missing `lsof` or
 * `ps`), which is a different fact from "nothing is running" and has to reach
 * the surface as one.
 */
export async function measureBackgroundTasks(
  taskIds: string[],
  deps: StatsProbeDeps = defaultStatsProbeDeps,
): Promise<BackgroundTaskStat[]> {
  const files = resolveTaskOutputFiles(taskIds, deps.tasksRoot);
  if (files.size === 0) return [];
  const paths = [...files.values()].flat();
  const lsof = await deps.run('lsof', ['-F', 'pn', '--', ...paths]);
  const holders = parseLsof(lsof.stdout);
  const pids = new Set<number>();
  for (const set of holders.values()) for (const p of set) pids.add(p);
  if (pids.size === 0) return [];
  const ps = await deps.run('ps', ['-o', 'pid=,%cpu=,rss=', '-p', [...pids].join(',')]);
  const table = parsePs(ps.stdout);

  const stats: BackgroundTaskStat[] = [];
  for (const [taskId, taskPaths] of files) {
    // A task's tree is every distinct pid holding any of that id's output
    // files. `lsof` reports the wrapper once per descriptor and the id can in
    // principle resolve in more than one session directory, so the pids are
    // de-duplicated before they are summed — counting the same process twice
    // would double both its CPU and its memory.
    const taskPids = new Set<number>();
    for (const path of taskPaths) for (const p of holders.get(path) ?? []) taskPids.add(p);
    let cpuPercent = 0;
    let rssBytes = 0;
    let processes = 0;
    for (const p of taskPids) {
      const row = table.get(p);
      if (!row) continue;
      cpuPercent += row.cpu;
      rssBytes += row.rssBytes;
      processes += 1;
    }
    if (processes === 0) continue;
    stats.push({ taskId, cpuPercent: Math.round(cpuPercent * 10) / 10, rssBytes, processes });
  }
  return stats;
}

/**
 * The `patch.background_task_stats.request` handler. The chat is checked only
 * so a request routed to the wrong host says so instead of reporting an empty
 * measurement — the tasks directory itself is per-machine, not per-chat.
 */
export async function handleBackgroundTaskStatsRequest(
  event: PatchBackgroundTaskStatsRequestEvent,
  hasChat: (chatId: string) => boolean,
  sender: (e: WireEvent) => void,
  logger: Logger,
  deps: StatsProbeDeps = defaultStatsProbeDeps,
): Promise<void> {
  if (!hasChat(event.chatId)) {
    sender({
      type: 'patch.background_task_stats.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'chat_not_found', message: `chat not found: ${event.chatId}` },
    });
    return;
  }
  try {
    const stats = await measureBackgroundTasks(event.taskIds, deps);
    sender({
      type: 'patch.background_task_stats.response',
      requestId: event.requestId,
      ok: true,
      stats,
    });
  } catch (err) {
    const missingTool = (err as NodeJS.ErrnoException).code === 'ENOENT';
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId },
      'patch.background_task_stats.request: measurement failed',
    );
    sender({
      type: 'patch.background_task_stats.response',
      requestId: event.requestId,
      ok: false,
      error: {
        code: missingTool ? 'no_process_table' : 'internal',
        message: (err as Error).message,
      },
    });
  }
}
