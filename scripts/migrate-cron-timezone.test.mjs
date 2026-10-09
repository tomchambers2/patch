// One-shot cron-timezone migration (scripts/migrate-cron-timezone.mjs).
//
// The interesting cases are all the ones where it must NOT act: a job that
// already names a zone (including an explicit `UTC`, which is a deliberate
// choice indistinguishable from the old default on the wire), a non-cron
// trigger, and a second run over its own output.
//
// Run: node scripts/migrate-cron-timezone.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateCronTimezones } from './migrate-cron-timezone.mjs';

function fixture(jobs) {
  const dataDir = mkdtempSync(join(tmpdir(), 'patch-cron-tz-'));
  const jobsDir = join(dataDir, 'jobs');
  mkdirSync(jobsDir);
  for (const job of jobs) {
    writeFileSync(join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
  }
  return { dataDir, jobsDir };
}

const read = (jobsDir, id) => JSON.parse(readFileSync(join(jobsDir, `${id}.json`), 'utf8'));

const cronJob = (id, extra = {}) => ({
  id,
  name: id,
  enabled: true,
  trigger: { type: 'cron', expression: '0 9 * * *', ...extra },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 's' },
  createdAt: 1,
  updatedAt: 2,
});

test('a cron job with NO timezone is migrated to the named zone', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  const report = migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  assert.equal(read(jobsDir, 'j_absent').trigger.timezone, 'Europe/London');
  assert.deepEqual(
    report.changed.map((c) => [c.id, c.from, c.to]),
    [['j_absent', null, 'Europe/London']],
  );
});

test('migrating touches nothing else about the job', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  const after = read(jobsDir, 'j_absent');
  assert.equal(after.trigger.expression, '0 9 * * *');
  assert.equal(after.updatedAt, 2); // a data correction, not a user edit
  assert.deepEqual(after.action, { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 's' });
});

test('an explicit UTC zone is left alone — it is a choice, not an absence', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_utc', { timezone: 'UTC' })]);
  const report = migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  assert.equal(read(jobsDir, 'j_utc').trigger.timezone, 'UTC');
  assert.deepEqual(report.changed, []);
});

test('a job already in the target zone is left alone', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_london', { timezone: 'Europe/London' })]);
  const report = migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  assert.equal(read(jobsDir, 'j_london').trigger.timezone, 'Europe/London');
  assert.deepEqual(report.changed, []);
});

test('a non-cron trigger is never given a timezone', () => {
  const todoist = {
    ...cronJob('j_todoist'),
    trigger: { type: 'todoist', filter: null },
  };
  const { dataDir, jobsDir } = fixture([todoist]);
  const report = migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  assert.equal('timezone' in read(jobsDir, 'j_todoist').trigger, false);
  assert.deepEqual(report.changed, []);
});

test('a second run over its own output changes nothing', () => {
  const { dataDir, jobsDir } = fixture([
    cronJob('j_absent'),
    cronJob('j_utc', { timezone: 'UTC' }),
  ]);
  migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  const snapshot = readFileSync(join(jobsDir, 'j_absent.json'), 'utf8');
  const second = migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  assert.deepEqual(second.changed, []);
  assert.equal(readFileSync(join(jobsDir, 'j_absent.json'), 'utf8'), snapshot);
});

test('--dry-run reports the change without writing it', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  const before = readFileSync(join(jobsDir, 'j_absent.json'), 'utf8');
  const report = migrateCronTimezones({ dataDir, timezone: 'Europe/London', dryRun: true });
  assert.equal(report.changed.length, 1);
  assert.equal(report.dryRun, true);
  assert.equal(readFileSync(join(jobsDir, 'j_absent.json'), 'utf8'), before);
});

test('writes the exact byte shape the server store does — no trailing newline', () => {
  // A different shape would make the next ordinary server write show up as a
  // whitespace-only diff on a file nobody edited.
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  const body = readFileSync(join(jobsDir, 'j_absent.json'), 'utf8');
  assert.equal(body.endsWith('}'), true);
  assert.equal(body, JSON.stringify(JSON.parse(body), null, 2));
});

test('leaves no temp files behind — the write is temp-then-rename', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  assert.deepEqual(readdirSync(jobsDir), ['j_absent.json']);
});

test('a non-IANA zone is refused before anything is written', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  const before = readFileSync(join(jobsDir, 'j_absent.json'), 'utf8');
  assert.throws(
    () => migrateCronTimezones({ dataDir, timezone: '+01:00' }),
    /not an IANA timezone/,
  );
  assert.equal(readFileSync(join(jobsDir, 'j_absent.json'), 'utf8'), before);
});

test('malformed JSON is a loud failure, not a silently skipped job', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  writeFileSync(join(jobsDir, 'j_broken.json'), '{ not json', 'utf8');
  assert.throws(() => migrateCronTimezones({ dataDir, timezone: 'Europe/London' }), /j_broken/);
});

test('non-.json files in the jobs dir are ignored', () => {
  const { dataDir, jobsDir } = fixture([cronJob('j_absent')]);
  writeFileSync(join(jobsDir, 'runs.jsonl'), 'not a job\n', 'utf8');
  const report = migrateCronTimezones({ dataDir, timezone: 'Europe/London' });
  assert.deepEqual(
    report.changed.map((c) => c.id),
    ['j_absent'],
  );
});

test('a missing jobs dir fails loudly rather than reporting success over nothing', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'patch-cron-tz-'));
  assert.throws(() => migrateCronTimezones({ dataDir, timezone: 'Europe/London' }), /no jobs dir/);
});
