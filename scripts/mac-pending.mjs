// Work that only the Mac can do, held until the Mac is there to do it.
//
// The desktop shell and the macOS host are built and signed on a Mac, and the
// box drives that over ssh. A Mac that is asleep used to fail the whole deploy,
// which turned an absent machine into a red deploy that somebody had to re-run.
//
// An unreachable Mac is not a failed build: nothing was tried. So the deploy
// records what the Mac still owes for a commit, finishes everything else, and
// says so plainly. `mac-catch-up.mjs`, run on the Mac, does the building when
// the Mac is next awake and clears the record. Anything that fails WHILE the Mac
// is reachable is still a failure and still fails the deploy.
//
// The record is one small JSON file on the box, written atomically:
//   { "sha": "<commit>", "surfaces": ["desktop", "daemon-mac", "smoke"], "at": <ms> }
// Only the newest commit is kept. A Mac that was away for ten deploys needs the
// last one, not ten builds.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The surfaces that can only be built on the Mac. */
export const MAC_SURFACES = ['daemon-mac', 'desktop', 'smoke'];

/** Thrown when the Mac could not be reached, as opposed to a build that failed. */
export class MacUnreachable extends Error {
  constructor(message) {
    super(message);
    this.name = 'MacUnreachable';
  }
}

/** The pending record, or null when nothing is owed. */
export function readPending(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const rec = JSON.parse(text);
  if (typeof rec.sha !== 'string' || !Array.isArray(rec.surfaces)) {
    throw new Error(`${file} is not a pending record: ${text.slice(0, 120)}`);
  }
  return rec;
}

function write(file, rec) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + '\n');
  renameSync(tmp, file);
}

/**
 * Record that `surface` is owed for `sha`. A newer commit replaces the record
 * (what the Mac owed for an older one is superseded); the same commit adds to it.
 */
export function addPending(file, surface, sha, now = Date.now()) {
  if (!MAC_SURFACES.includes(surface)) throw new Error(`${surface} is not a Mac surface`);
  const cur = readPending(file);
  const surfaces = cur && cur.sha === sha ? new Set(cur.surfaces) : new Set();
  surfaces.add(surface);
  const rec = { sha, surfaces: MAC_SURFACES.filter((s) => surfaces.has(s)), at: now };
  write(file, rec);
  return rec;
}

/**
 * Mark `surfaces` done for `sha`. Does nothing if the record has moved on to a
 * newer commit in the meantime: that newer debt is still owed.
 */
export function clearPending(file, sha, surfaces) {
  const cur = readPending(file);
  if (!cur || cur.sha !== sha) return cur;
  const left = cur.surfaces.filter((s) => !surfaces.includes(s));
  if (left.length === 0) {
    rmSync(file, { force: true });
    return null;
  }
  const rec = { ...cur, surfaces: left };
  write(file, rec);
  return rec;
}

/**
 * `surface` has just been built for the newest commit, so it is owed no longer,
 * whichever commit the record was written for.
 */
export function settle(file, surface) {
  const cur = readPending(file);
  if (!cur || !cur.surfaces.includes(surface)) return cur;
  return clearPending(file, cur.sha, [surface]);
}

/** Remember that a catch-up was just started, so a failing one is not hammered. */
export function markAttempt(file, now = Date.now()) {
  const cur = readPending(file);
  if (!cur) return null;
  const rec = { ...cur, attemptedAt: now };
  write(file, rec);
  return rec;
}

/** Is it time to try again? A catch-up that just ran is left alone for `gapMs`. */
export function attemptDue(rec, now, gapMs) {
  return !rec.attemptedAt || now - rec.attemptedAt >= gapMs;
}

/** One line for a deploy summary, or '' when nothing is owed. */
export function describePending(rec) {
  if (!rec) return '';
  return `pending on the Mac for ${rec.sha}: ${rec.surfaces.join(', ')} (builds when the Mac is next awake)`;
}
