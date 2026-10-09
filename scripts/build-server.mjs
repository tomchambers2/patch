#!/usr/bin/env node
// `pnpm build:server` — the Patch server as an installable release.
//
// One directory (and, from the CLI, a tarball of it) holding the server, the SPA
// it serves, and the installer:
//
//   patch-server-<release>/
//     patch-server        launcher (packages/server/release/patch-server)
//     install             installer (packages/server/release/install)
//     server.env.example  config template
//     server/             @patch/server's dist + production node_modules,
//                         with @patch/wire and @patch/auth copied in
//     web/                the SPA (packages/web/dist)
//     build-info.json     { release, version, gitSha, builtAt, serverSha, web }
//
// Pure JavaScript — no native addons — so one release runs on any OS/arch with
// Node 20+. Install it with `<release>/install`; that is how the live box is
// deployed too (scripts/ship.mjs), so self-hosting and production are one path.
//
// `--reuse-server=<release dir>` assembles a release around an EXISTING server
// build — its `server/` and its server identity — with a freshly built SPA. A
// web-only deploy uses it so a UI change does not ship a new server version,
// which would have to move every host in lockstep with it
// (deploy-scope.mjs § LOCKSTEP).
//
// NO FALLBACK: a missing entry bundle, a failed build or a reused release that
// is not stamped aborts.
//
// Usage:
//   node scripts/build-server.mjs [--out=dist/server] [--reuse-server=DIR] [--no-tarball]

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const sh = (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

/**
 * Build a release under `out` from the workspace at `root`, stamped with `info`
 * (scripts/version.mjs buildInfo()). Returns `{ dir, release, bundle }`, where
 * `bundle` is the SPA entry script the release serves.
 */
export function buildServerRelease({ root, info, out, reuseServer = null, log = console.log }) {
  const release = info.version;
  const dir = join(out, `patch-server-${release}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // The SPA and the server both resolve @patch/wire (and the server @patch/auth)
  // through their dist, which a fresh checkout does not have.
  // The server imports @patch/relay (and its /host entry) too, and tsc needs its
  // built declarations; a deploy builds everything first and so never noticed
  // that this script, run on its own, did not.
  log('release → building @patch/wire + @patch/auth + @patch/relay');
  sh(
    'pnpm',
    ['--filter', '@patch/wire', '--filter', '@patch/auth', '--filter', '@patch/relay', 'build'],
    { cwd: root },
  );
  log(`release → building SPA ${info.version} / ${info.gitSha}`);
  sh('pnpm', ['--filter', '@patch/web', 'build'], {
    cwd: root,
    env: {
      ...process.env,
      PATCH_VERSION: info.version,
      PATCH_GIT_SHA: info.gitSha,
      PATCH_BUILT_AT: info.builtAt,
    },
  });
  const webDist = join(root, 'packages/web/dist');
  const bundle = readFileSync(join(webDist, 'index.html'), 'utf8').match(
    /assets\/index-[A-Za-z0-9_-]+\.js/,
  )?.[0];
  if (!bundle) throw new Error(`no entry bundle in ${webDist}/index.html`);
  cpSync(webDist, join(dir, 'web'), { recursive: true });

  let server;
  if (reuseServer) {
    const prev = JSON.parse(readFileSync(join(reuseServer, 'build-info.json'), 'utf8'));
    for (const k of ['version', 'gitSha', 'builtAt', 'serverSha']) {
      if (typeof prev[k] !== 'string' || !prev[k]) {
        throw new Error(`${reuseServer}/build-info.json has no ${k} — cannot reuse its server`);
      }
    }
    if (!existsSync(join(reuseServer, 'server/dist/index.js'))) {
      throw new Error(`${reuseServer} has no server/dist/index.js — cannot reuse its server`);
    }
    log(`release → reusing server ${prev.version} / ${prev.gitSha} from ${reuseServer}`);
    cpSync(join(reuseServer, 'server'), join(dir, 'server'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    server = {
      version: prev.version,
      gitSha: prev.gitSha,
      builtAt: prev.builtAt,
      serverSha: prev.serverSha,
    };
  } else {
    log(`release → building server ${info.version} / ${info.gitSha}`);
    sh('pnpm', ['--filter', '@patch/server', 'build'], { cwd: root });
    // Its own production node_modules, with the workspace libs COPIED in (not
    // linked back to the tree), so the release runs with the source tree gone.
    sh('pnpm', ['--filter', '@patch/server', 'deploy', '--prod', '--legacy', join(dir, 'server')], {
      cwd: root,
    });
    // pnpm hoists a link to the package itself pointing back into the tree it
    // was deployed from. Nothing imports @patch/server by name.
    rmSync(join(dir, 'server/node_modules/.pnpm/node_modules/@patch/server'), { force: true });
    server = {
      version: info.version,
      gitSha: info.gitSha,
      builtAt: info.builtAt,
      serverSha: info.serverSha,
    };
  }

  const tmpl = join(root, 'packages/server/release');
  for (const f of ['patch-server', 'install', 'server.env.example']) {
    cpSync(join(tmpl, f), join(dir, f));
  }
  chmodSync(join(dir, 'patch-server'), 0o755);
  chmodSync(join(dir, 'install'), 0o755);
  writeFileSync(
    join(dir, 'build-info.json'),
    `${JSON.stringify({ release, ...server, web: { gitSha: info.gitSha, bundle } }, null, 2)}\n`,
  );
  log(`release → ${dir}`);
  return { dir, release, bundle };
}

/**
 * What the one-command installer downloads (packages/server/release/install-server.sh):
 * the release tarball under a name that never changes, its checksum beside it,
 * and the installer itself. Publish these three together at one URL.
 */
export function writeInstallChannel({ root, out, tarball }) {
  const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const stable = join(out, 'patch-server.tar.gz');
  cpSync(tarball, stable);
  writeFileSync(`${stable}.sha256`, `${sum}  patch-server.tar.gz\n`);
  cpSync(join(root, 'packages/server/release/install-server.sh'), join(out, 'install.sh'));
  chmodSync(join(out, 'install.sh'), 0o755);
  return { stable, sum, installer: join(out, 'install.sh') };
}

if (isMain(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const val = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const { buildInfo } = await import('./version.mjs');
  const out = resolve(val('out') ?? join(root, 'dist/server'));
  const { dir, release } = buildServerRelease({
    root,
    info: buildInfo(),
    out,
    reuseServer: val('reuse-server') ? resolve(val('reuse-server')) : null,
  });
  if (!args.includes('--no-tarball')) {
    const tarball = join(out, `patch-server-${release}.tar.gz`);
    sh('tar', ['-czf', tarball, '-C', out, `patch-server-${release}`]);
    console.log(`release → ${tarball}`);
    const { stable, installer } = writeInstallChannel({ root, out, tarball });
    console.log(`install channel → ${stable} (+ .sha256) and ${installer}`);
  }
  console.log(`\nInstall it with:  ${dir}/install`);
}
