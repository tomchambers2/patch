#!/usr/bin/env node
// Stamp the desktop shell's provenance into dist/build-info.json before packaging.
//
// electron-builder bakes a VERSION into the bundle but nothing else — no git sha,
// no build instant, and no record of whether the build was actually signed. The
// update panel needs all three: the sha/instant to say what you're running, and
// `signed` to explain why a downloaded update can't be applied (macOS Squirrel
// refuses to update an adhoc-signed app).
//
// Shipped into the bundle via the `dist/**/*` glob in electron-builder.yml.
//
// NO FALLBACK: if the version can't be resolved we exit non-zero rather than ship
// a bundle that can't identify itself.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');

const info = JSON.parse(
  execFileSync('node', [path.join(REPO_ROOT, 'scripts', 'version.mjs'), '--json'], {
    encoding: 'utf8',
  }),
);

// electron-builder signs only when a usable identity is available. `signed` drives
// the panel's "why can't this self-update?" message, so it must reflect what
// actually happened — a wrong value here means the app either nags about signing it
// has, or stays quiet about signing it lacks.
const signed =
  process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false' &&
  Boolean(process.env.CSC_LINK || process.env.CSC_NAME || hasSigningIdentity());

/**
 * Any VALID code-signing identity, not just an Apple Developer ID.
 *
 * This used to match /Developer ID Application/ only, which would have reported our
 * self-signed builds as unsigned — and the panel would then wrongly tell you macOS
 * can't apply updates, when it demonstrably can (spec/11 § Desktop code signing).
 * `-v` is what matters: it lists only identities macOS considers valid, so an
 * untrusted certificate correctly doesn't count.
 */
function hasSigningIdentity() {
  if (process.platform !== 'darwin') return false;
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    return /\d+\) [0-9A-F]{40} "/.test(out);
  } catch {
    return false;
  }
}

const distDir = path.join(DESKTOP_DIR, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const payload = { ...info, signed };
fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(payload, null, 2) + '\n');
console.log(
  `[write-build-info] ${payload.version} / ${payload.gitSha} / signed=${payload.signed}`,
);
