// Stage what the packaged app carries so "On this Mac" can run a Patch server and
// a host with nothing installed and nothing downloaded (spec/05 § Desktop first
// run): the server release, and the host build for this Mac. electron-builder
// copies build/staged/{server,host} into the app's resources.
//
// NO FALLBACK: an app packaged without either would ship a first-run choice that
// cannot be honoured, so a missing host build or a failed server build stops
// the packaging here, with what to run.
//
//   node scripts/stage-resources.cjs
//
// Exported for the test: stage({ repoRoot, desktopDir, buildServer }).

const { cpSync, existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** The host files this Mac needs: the manifest, the installer, and the darwin-arm64 build. */
const wanted = (name) => !/\.tar\.gz(\.sig)?$/.test(name) || /darwin-arm64/.test(name);

function stage({ repoRoot, desktopDir, buildServer }) {
  const staged = path.join(desktopDir, 'build', 'staged');
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });

  const daemonOut = path.join(repoRoot, 'dist', 'daemon');
  if (!existsSync(path.join(daemonOut, 'daemon-latest.json'))) {
    throw new Error(
      `No daemon build at ${daemonOut}. Run \`pnpm build:daemon\` first: the app carries the host it sets up on this Mac.`,
    );
  }
  mkdirSync(path.join(staged, 'daemon'));
  let carried = 0;
  for (const name of readdirSync(daemonOut)) {
    if (!wanted(name)) continue;
    cpSync(path.join(daemonOut, name), path.join(staged, 'daemon', name), { recursive: true });
    if (/darwin-arm64/.test(name)) carried++;
  }
  if (carried === 0) {
    throw new Error(`${daemonOut} has no darwin-arm64 host build; the app would have no host to install.`);
  }

  const release = buildServer(path.join(staged, 'server-build'));
  cpSync(release, path.join(staged, 'server'), { recursive: true, verbatimSymlinks: true });
  rmSync(path.join(staged, 'server-build'), { recursive: true, force: true });
  return staged;
}

function buildServerRelease(out) {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  execFileSync('node', [path.join(repoRoot, 'scripts', 'build-server.mjs'), `--out=${out}`, '--no-tarball'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const dirs = readdirSync(out).filter((n) => n.startsWith('patch-server-'));
  if (dirs.length !== 1) throw new Error(`expected one patch-server-* release in ${out}, found ${dirs.length}`);
  return path.join(out, dirs[0]);
}

module.exports = { stage, wanted };

if (require.main === module) {
  const desktopDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(desktopDir, '..', '..');
  console.log(`[stage] staged into ${stage({ repoRoot, desktopDir, buildServer: buildServerRelease })}`);
}
