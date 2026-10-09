#!/usr/bin/env node
// Pays what the Mac owes (mac-pending.mjs) once the Mac is awake.
//
// Run from the box on a short timer. Almost every run does nothing and says
// nothing: nothing is owed, or the Mac is still away, or a catch-up already
// started recently. When there IS something to do it starts an ordinary
// `pnpm run deploy --only=<surfaces>` in the background, which builds the newest
// commit on the Mac exactly as a full deploy would, and settles the debt itself
// as each surface lands (ship.mjs). A catch-up that fails fails loudly, the way
// any deploy does; the gap below only stops it being retried every few minutes.
//
//   node scripts/mac-catch-up.mjs          # check, and start a catch-up if due
//   node scripts/mac-catch-up.mjs --dry    # say what it would do

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptDue, clearPending, markAttempt, readPending } from './mac-pending.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = process.env.PATCH_DEPLOY_STATE ?? join(homedir(), '.patch-deploy');
const PENDING = join(STATE, 'mac-pending.json');
const SERVER_HEALTH = process.env.PATCH_LOCAL_HEALTH ?? 'http://127.0.0.1:3000/api/healthz';
const MAC_HOST = process.env.PATCH_MAC_HOST ?? 'mac';
export const RETRY_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * What to do about a pending record. Pure, so the decisions can be tested.
 *
 * The smoke test judges the app a phone would run for one specific commit, so it
 * can only be paid while that commit is still the one live; once the box has
 * moved on, the newer deploy owes its own smoke and this one is moot.
 */
export function planCatchUp(rec, liveSha, now, gapMs = RETRY_GAP_MS) {
  if (!rec) return { action: 'none', reason: 'nothing owed' };
  if (!attemptDue(rec, now, gapMs)) return { action: 'wait', reason: 'tried recently' };
  const moot = rec.surfaces.includes('smoke') && rec.sha !== liveSha ? ['smoke'] : [];
  const run = rec.surfaces.filter((s) => !moot.includes(s));
  if (run.length === 0) return { action: 'settle', moot, reason: 'only superseded work is left' };
  return { action: 'run', run, moot, reason: `owed for ${rec.sha}` };
}

function macAwake() {
  return spawnSync('ssh', ['-o', 'ConnectTimeout=10', MAC_HOST, 'true'], { stdio: 'ignore' }).status === 0;
}

async function liveSha() {
  const res = await fetch(SERVER_HEALTH, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${SERVER_HEALTH} answered ${res.status}`);
  return (await res.json()).gitSha;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const rec = readPending(PENDING);
  if (!rec) return;

  const plan = planCatchUp(rec, await liveSha(), Date.now());
  if (plan.action === 'wait') return;
  if (plan.action === 'settle') {
    if (!dry) clearPending(PENDING, rec.sha, plan.moot);
    console.log(`mac-catch-up: dropped superseded ${plan.moot.join(', ')}`);
    return;
  }
  if (!macAwake()) return; // still away: say nothing, try again next tick

  const only = plan.run.join(',');
  if (dry) {
    console.log(`mac-catch-up: would run deploy --only=${only}`);
    return;
  }
  if (plan.moot.length) clearPending(PENDING, rec.sha, plan.moot);
  markAttempt(PENDING);
  mkdirSync(join(STATE, 'logs'), { recursive: true });
  const logFile = join(STATE, 'logs', `mac-catch-up-${Date.now()}.log`);
  const fd = openSync(logFile, 'a');
  spawn('pnpm', ['run', 'deploy', `--only=${only}`], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
  }).unref();
  console.log(`mac-catch-up: started deploy --only=${only} for ${rec.sha}; log ${logFile}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`mac-catch-up: ${err.message}`);
    process.exit(1);
  });
}
