#!/usr/bin/env node
// personal-check — keeps one person's setup out of a public product.
//
// Patch is distributed to anyone. A hostname, account name or app id that only
// means something on Tom's machines does not belong in product code: it belongs
// in configuration, or in the private overlay that deploys his own setup.
//
// This is a ratchet, not a purge. `personal-check.baseline.json` records how
// many personal strings each file carried when the check was introduced; the
// check fails on a NEW file with one, or on a file whose count went UP. Removing
// them is welcome and `--ratchet` writes the lower number down so it can never
// creep back. The baseline only ever shrinks; raising an entry by hand is a
// decision a reviewer has to see.
//
// Not scanned: tests, specs, design notes and docs. They name real hosts as
// fixtures and history and are reviewed by eye. Product code, scripts and
// config are what a stranger runs, and are scanned.
//
//   node scripts/personal-check.mjs            # fail on any new or increased use
//   node scripts/personal-check.mjs --ratchet # lower the baseline to today's counts
//   node scripts/personal-check.mjs --init     # write the first baseline (refuses if one exists)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const BASELINE = join(ROOT, 'scripts', 'personal-check.baseline.json');

// Strings that mean "this is Tom's setup". Case-insensitive.
export const PERSONAL = /tomchambers|tomsownclaw|tom\.chambers|netcup|hetzner|claude-dev/gi;

const SKIP_PATH = /^(spec|design|docs|testing|\.cadence|\.claude)\//;
const SKIP_FILE = /(pnpm-lock\.yaml|\.(png|jpe?g|gif|ico|onnx|bin|wav|pcm|mp3|woff2?|apk|jar|keystore)$|personal-check\.)/;
const isTest = (p) =>
  /(^|\/)(test|tests|__tests__|e2e|fixtures|maestro)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
// Top-level notes (reports, runbooks, strategy) are working papers, not product.
const isRootNote = (p) => !p.includes('/') && p.endsWith('.md') && p !== 'README.md';

/** Which tracked files this check reads. */
export function scannedFiles(paths) {
  return paths.filter((p) => !SKIP_PATH.test(p) && !SKIP_FILE.test(p) && !isTest(p) && !isRootNote(p));
}

// The product's own identity names its owner, and that is not a personal setup:
// the app id every install carries, and the public repository releases come from.
const PRODUCT_IDENTITY = /io[./]github[./]tomchambers2[./]patch|github\.com\/tomchambers2\/patch|tomchambers2\/patch/gi;

/** Personal-string count for one file's text. */
export function countPersonal(text) {
  return (text.replace(PRODUCT_IDENTITY, '').match(PERSONAL) ?? []).length;
}

/** Compare today's counts to the baseline. Pure, so it can be tested. */
export function compare(current, baseline) {
  const worse = [];
  const better = [];
  for (const [file, n] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (n > allowed) worse.push({ file, n, allowed });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const n = current[file] ?? 0;
    if (n < allowed) better.push({ file, n, allowed });
  }
  return { worse, better };
}

function scan() {
  // Tracked and new-but-not-yet-added files alike: a check that only saw what is
  // already committed would wave through everything written since.
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0')
    .filter(Boolean);
  const counts = {};
  for (const file of scannedFiles(tracked)) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // a tracked path that is a directory or a dangling link
    }
    if (text.includes('\0')) continue; // binary
    const n = countPersonal(text);
    if (n > 0) counts[file] = n;
  }
  return counts;
}

function readBaseline() {
  if (!existsSync(BASELINE)) {
    console.error('personal-check: no baseline. Run `node scripts/personal-check.mjs --init` once.');
    process.exit(2);
  }
  return JSON.parse(readFileSync(BASELINE, 'utf8'));
}

const write = (obj) =>
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(obj).sort()), null, 2) + '\n');

function main() {
  const args = process.argv.slice(2);
  const current = scan();

  if (args.includes('--init')) {
    if (existsSync(BASELINE)) {
      console.error('personal-check: a baseline already exists; use --ratchet to lower it.');
      process.exit(2);
    }
    write(current);
    console.log(`personal-check: baseline written, ${Object.keys(current).length} files.`);
    return;
  }

  const baseline = readBaseline();
  const { worse, better } = compare(current, baseline);

  if (args.includes('--ratchet')) {
    const next = {};
    for (const [file, allowed] of Object.entries(baseline)) {
      const n = Math.min(current[file] ?? 0, allowed);
      if (n > 0) next[file] = n;
    }
    write(next);
    console.log(`personal-check: baseline lowered, ${better.length} file(s) improved.`);
    return;
  }

  if (worse.length) {
    console.error('personal-check: personal strings added to product code.');
    console.error('This is a public product. Take the value from configuration instead of writing it in.\n');
    for (const w of worse) console.error(`  ${w.file}: ${w.n} (allowed ${w.allowed})`);
    process.exit(1);
  }
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  console.log(
    `personal-check: ok — ${total} personal string(s) in ${Object.keys(current).length} file(s)` +
      (better.length ? `; ${better.length} file(s) improved, run --ratchet to lock it in` : ''),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
