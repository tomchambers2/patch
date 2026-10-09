// One-shot migration: name the zone Tom's pre-timezone cron jobs were always
// written in.
//
// A cron trigger is evaluated in `trigger.timezone` and an ABSENT one means
// UTC (spec/08 § Cron). That default is load-bearing and must stay — it is
// what every job stored before the field existed relies on, and it is what a
// host on an older @patch/wire can still round-trip. So this correction does
// NOT live in the server's store-load path: it is a one-time edit of specific
// historical data, run by hand.
//
// The data it corrects: every cron job on this box was authored in UK
// wall-clock intent ("Weekly timesheet (Fri 9am)") but carries no zone, so it
// evaluates as UTC and fires an hour late in BST — "shows 9am but runs at 10".
// Stamping the zone the author meant makes the expression mean what it says,
// on both sides of a DST change.
//
// Invocation:
//   node scripts/migrate-cron-timezone.mjs --dry-run
//   node scripts/migrate-cron-timezone.mjs --data-dir ~/.patch-server/data
//
// NO FALLBACKS: an unresolvable zone, a malformed job file or a missing jobs
// dir all crash before anything is written. A job that already names a zone —
// including an explicit `UTC` — is never overwritten; on the wire those two
// are indistinguishable from the old default only in EFFECT, and someone who
// typed UTC meant it.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The zone every cron job on this box was authored in. */
export const DEFAULT_TIMEZONE = 'Europe/London';

/** The installed server's data dir (packages/server/release/install). */
export const DEFAULT_DATA_DIR = join(
  process.env.PATCH_SERVER_HOME ?? join(homedir(), '.patch-server'),
  'data',
);

/**
 * True iff `tz` is a NAMED IANA zone this runtime can resolve. A bare offset
 * (`+01:00`) is refused even though ECMA-402 accepts it: an offset is frozen,
 * so it cannot track DST — storing one reintroduces the very bug this fixes.
 * Mirrors `isValidTimeZone` in packages/wire/src/cron-tz.ts (this script is
 * plain node with no build step, so it cannot import it).
 */
function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    return !/^[+-]/.test(resolved);
  } catch {
    return false;
  }
}

/**
 * Write `body` to `path` the way the server's JobStore does (temp + fsync +
 * rename), so a crash mid-migration can never leave a truncated job file that
 * the store would then refuse to load.
 */
function writeAtomic(path, body) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, 'utf8');
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    // The rename is the commit point; if it fails the temp file is garbage.
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file is already gone — nothing to clean up */
    }
    throw err;
  }
}

/**
 * Stamp `timezone` onto every cron job in `<dataDir>/jobs` that carries none.
 *
 * Idempotent: a job that already has a `timezone` key is read and left exactly
 * as it was, so re-running writes nothing. Returns a report naming what did
 * and did not change, for the caller to print.
 */
export function migrateCronTimezones({ dataDir, timezone = DEFAULT_TIMEZONE, dryRun = false }) {
  if (!isValidTimeZone(timezone)) {
    throw new Error(`"${timezone}" is not an IANA timezone (a bare offset cannot track DST)`);
  }
  const jobsDir = join(dataDir, 'jobs');
  if (!existsSync(jobsDir) || !statSync(jobsDir).isDirectory()) {
    throw new Error(`no jobs dir at ${jobsDir}`);
  }

  const changed = [];
  const skipped = [];
  for (const name of readdirSync(jobsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(jobsDir, name);
    const raw = readFileSync(path, 'utf8');
    let job;
    try {
      job = JSON.parse(raw);
    } catch (err) {
      throw new Error(`malformed JSON in ${name}: ${err.message}`);
    }
    const id = job?.id ?? name.replace(/\.json$/, '');
    const trigger = job?.trigger;
    if (!trigger || trigger.type !== 'cron') {
      skipped.push({ id, reason: `trigger is ${trigger?.type ?? 'missing'}, not cron` });
      continue;
    }
    if (trigger.timezone !== undefined) {
      skipped.push({ id, reason: `already runs in ${trigger.timezone}` });
      continue;
    }
    changed.push({
      id,
      name: job?.name ?? id,
      expression: trigger.expression,
      from: null,
      to: timezone,
    });
    if (dryRun) continue;
    // Assigning appends `timezone` after `expression`, matching the field
    // order CronTrigger declares and the editors write.
    trigger.timezone = timezone;
    // Byte-for-byte the shape JobStore.writeAtomic produces (2-space
    // indent, no trailing newline), so a later server write is a no-op diff.
    writeAtomic(path, JSON.stringify(job, null, 2));
  }
  return { dataDir, jobsDir, timezone, dryRun, changed, skipped };
}

function parseArgs(argv) {
  let dataDir = process.env.PATCH_DATA_DIR ?? DEFAULT_DATA_DIR;
  let timezone = DEFAULT_TIMEZONE;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--data-dir' || a === '--timezone') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${a} requires a value`);
      }
      if (a === '--data-dir') dataDir = next;
      else timezone = next;
      i++;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { dataDir, timezone, dryRun };
}

function main(argv) {
  const report = migrateCronTimezones(parseArgs(argv));
  const verb = report.dryRun ? 'would set' : 'set';
  process.stdout.write(`migrate-cron-timezone: ${report.jobsDir}\n`);
  for (const s of report.skipped) process.stdout.write(`  skip  ${s.id} — ${s.reason}\n`);
  for (const c of report.changed) {
    process.stdout.write(`  ${verb} ${c.to}  ${c.id}  "${c.name}"  (${c.expression})\n`);
  }
  process.stdout.write(
    `${report.changed.length} ${report.dryRun ? 'to change' : 'changed'}, ${report.skipped.length} left alone\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`migrate-cron-timezone: ${err.message}\n`);
    process.exit(1);
  }
}
