#!/usr/bin/env node
// Keep the box's published downloads to the CURRENT build of each surface, plus
// the one before it.
//
//   node scripts/prune-downloads.mjs [dir]     (default: ~/.patch-server/downloads)
//   node scripts/prune-downloads.mjs --dry-run
//
// Run at the end of every deploy by scripts/deploy-cleanup.mjs, and straight
// after an APK or host publish by ship.mjs.
//
// Every publish added a per-commit artifact and removed nothing, so the
// directory grew without bound — 19 APKs at ~96 MB each, five desktop zips,
// four host versions across three targets. 2.6 GB of builds nobody can
// install, on the disk a docker build needs its last gigabyte from.
//
// WHAT IS CURRENT IS WHAT A MANIFEST POINTS AT. Not "the highest version
// number", not "the newest mtime" — the manifests are the definition:
//
//   android-latest.json   the APK the phone downloads (and `patch.apk`, the
//                         stable alias the ntfy link and QR use)
//   daemon-latest.json    one artifact per target, for self-update
//   desktop-latest.json   the zip a fresh install pulls
//   latest-mac.yml        the zip Squirrel fetches for an auto-update
//
// Deleting a file an updater still references breaks something that was
// working, which is far worse than the disk it saves. So the rules are:
//
//   * anything referenced by a manifest is kept, as is every manifest;
//   * a `.sig` / `.blockmap` sidecar lives and dies with the file it belongs to;
//   * a file this program does not RECOGNISE is kept — the directory is served
//     publicly and holds things beyond these families;
//   * a missing or unreadable manifest means "no definition of current for this
//     family", and NOTHING of that family is removed. Refuse rather than guess;
//   * the newest superseded build of each family (per host target, per desktop
//     arch) is kept too, so a bad publish can be rolled back by pointing the
//     manifest at the file that was live a moment ago rather than by rebuilding.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

/** Artifact families this program is allowed to delete from. */
const FAMILIES = [
  {
    id: 'apk',
    matches: (n) => /^patch-[0-9a-f]{7,40}(-\d+)?\.apk$/.test(n),
    manifest: 'android-latest.json',
    // What a rollback is a rollback OF: one line of builds per family, except
    // where one publish ships several artifacts side by side.
    line: () => 'apk',
  },
  {
    id: 'daemon',
    matches: (n) => /^patch-daemon-.+\.tar\.gz$/.test(n),
    manifest: 'daemon-latest.json',
    // patch-daemon-<version>-<target>.tar.gz — one line per target.
    line: (n) => n.match(/^patch-daemon-\d[\w.]*-(.+)\.tar\.gz$/)?.[1] ?? n,
  },
  {
    id: 'desktop',
    matches: (n) => /^Patch-.+-mac\.zip$/.test(n),
    manifest: 'desktop-latest.json',
    // Patch-<version>-<arch>-mac.zip — one line per arch.
    line: (n) => n.match(/^Patch-\d[\w.]*?-(.+)-mac\.zip$/)?.[1] ?? 'mac',
  },
];

/** Sidecars belong to a payload; they are never considered on their own. */
const SIDECAR = /\.(sig|blockmap)$/;

/** Every filename referenced by a manifest, however that manifest spells it. */
function referenced(dir, name) {
  const path = join(dir, name);
  if (!existsSync(path)) return null; // no manifest ⇒ no definition of current
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const out = new Set();
  if (name.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null; // unreadable ⇒ refuse to prune this family
    }
    const walk = (v) => {
      if (typeof v === 'string') out.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(parsed);
  } else {
    // latest-mac.yml — `url:` / `path:` lines naming the zip.
    for (const m of text.matchAll(/(?:url|path):\s*(\S+)/g)) out.add(m[1]);
  }
  return out;
}

/**
 * What a prune would do: `{ keep, remove }`, both filename arrays. Pure — it
 * reads the directory and decides, and touches nothing.
 *
 * `keepPrevious` superseded builds survive per line (see FAMILIES), newest
 * first by mtime — the order they were published in.
 */
export function planPrune(dir, { keepPrevious = 1 } = {}) {
  if (!existsSync(dir)) return { keep: [], remove: [] };
  const mtime = new Map();
  const files = readdirSync(dir).filter((n) => {
    try {
      const st = statSync(join(dir, n));
      mtime.set(n, st.mtimeMs);
      return st.isFile();
    } catch {
      return false;
    }
  });

  // Union of every manifest's references. `latest-mac.yml` is read alongside
  // desktop-latest.json because Squirrel follows it, not the json.
  const live = new Set(['patch.apk']);
  const families = new Map();
  for (const family of FAMILIES) {
    const refs = referenced(dir, family.manifest);
    families.set(family.id, refs !== null);
    if (refs) for (const r of refs) live.add(r);
  }
  const mac = referenced(dir, 'latest-mac.yml');
  if (mac) for (const r of mac) live.add(r);

  // Superseded payloads, grouped by line, newest first; the first
  // `keepPrevious` of each line are the rollback and survive.
  const superseded = new Map();
  for (const name of files) {
    if (SIDECAR.test(name)) continue;
    const family = FAMILIES.find((f) => f.matches(name));
    if (!family || !families.get(family.id) || live.has(name)) continue;
    const key = `${family.id}:${family.line(name)}`;
    superseded.set(key, [...(superseded.get(key) ?? []), name]);
  }
  const rollback = new Set();
  for (const names of superseded.values()) {
    names.sort((a, b) => (mtime.get(b) ?? 0) - (mtime.get(a) ?? 0));
    for (const n of names.slice(0, keepPrevious)) rollback.add(n);
  }

  const remove = [];
  for (const name of files) {
    const payload = name.replace(SIDECAR, '');
    const family = FAMILIES.find((f) => f.matches(payload));
    if (!family) continue; // unknown ⇒ keep
    if (!families.get(family.id)) continue; // no usable manifest ⇒ keep
    if (live.has(payload) || live.has(name)) continue; // current ⇒ keep
    if (rollback.has(payload)) continue; // the build before it ⇒ keep
    remove.push(name);
  }
  return { keep: files.filter((n) => !remove.includes(n)), remove };
}

/** Apply the plan. Returns the bytes reclaimed. */
export function pruneDownloads(dir, { dryRun = false, log = () => {}, keepPrevious } = {}) {
  const { remove } = planPrune(dir, { keepPrevious });
  let bytes = 0;
  for (const name of remove) {
    const path = join(dir, name);
    try {
      bytes += statSync(path).size;
    } catch {
      /* counted as 0 — the delete below still reports it */
    }
    log(`${dryRun ? 'would remove' : 'removing'} ${name}`);
    if (!dryRun) rmSync(path, { force: true });
  }
  return bytes;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target =
    args.find((a) => !a.startsWith('--')) ??
    resolve(process.env.PATCH_SERVER_HOME ?? `${process.env.HOME}/.patch-server`, 'downloads');
  const bytes = pruneDownloads(resolve(target), {
    dryRun,
    log: (line) => process.stdout.write(`prune-downloads: ${line}\n`),
  });
  process.stdout.write(
    `prune-downloads: ${dryRun ? 'would reclaim' : 'reclaimed'} ${(bytes / 1e9).toFixed(2)} GB from ${target}\n`,
  );
}
