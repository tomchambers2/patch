#!/usr/bin/env node
// `pnpm build:daemon` — the daemon's installable artifact, one per OS/arch.
//
// spec/11 § Host installation + spec/18 § Two shipping shapes. Each artifact
// is a directory (and a tarball of it) holding exactly:
//
//   node               the pinned Node runtime for that OS/arch
//   daemon.mjs         the host and its pure-JS dependencies, one esbuild bundle
//   bin/               the stdio MCP server every SDK query launches
//   native/            the platform's prebuilt native addons (onnxruntime-node)
//   silero_vad.onnx    the VAD model (~2 MB) — the one model weight in the artifact
//   skill/patch-cli/   the CLI skill the install writes into the user's skills dir
//   install            the installer (sh entry + its bundled program)
//   install.mjs
//   build-info.json    version, source commit, build instant, target
//
// Targets: darwin-arm64, linux-x64, linux-arm64. macOS x64 is NOT a target —
// onnxruntime-node ships no darwin-x64 binary and every artifact carries VAD,
// so the target cannot be built (spec/11 § Host installation).
//
// What is deliberately NOT in here: the agent backend (provisioned on the
// machine), the Python environment the voice sidecars need, and the large model
// weights (Kokoro ~340 MB, local Whisper ~1.5 GB) — those are optional
// components the host downloads per machine.
//
// NO FALLBACK anywhere: a missing vendored input, a missing signing key or a
// failed signature aborts the build. An unsigned or half-built artifact would
// be indistinguishable from a good one at install time.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { buildInfo } from './version.mjs';
import { isMain } from './lib/is-main.mjs';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = join(REPO_ROOT, 'packages', 'daemon');

/** The three shipping targets. */
export const TARGETS = [
  { target: 'darwin-arm64', platform: 'darwin', arch: 'arm64', node: 'darwin-arm64' },
  { target: 'linux-x64', platform: 'linux', arch: 'x64', node: 'linux-x64' },
  { target: 'linux-arm64', platform: 'linux', arch: 'arm64', node: 'linux-arm64' },
];

const NODE_VERSION = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim();

function die(msg) {
  process.stderr.write(`build:daemon: ${msg}\n`);
  process.exit(1);
}

function requireDir(path, what) {
  if (!existsSync(path)) die(`${what} not found at ${path}`);
  return path;
}

/**
 * The vendored build inputs: the pinned Node runtimes, the per-platform
 * onnxruntime-node prebuilds and silero_vad.onnx. Kept outside the repo (they
 * are ~500 MB of third-party binaries) and named explicitly, so a build either
 * has every input it needs or fails saying which one is missing.
 */
function vendorRoot() {
  const dir = process.env.PATCH_BUILD_VENDOR;
  if (!dir) {
    die(
      'PATCH_BUILD_VENDOR is not set. It must point at a directory holding:\n' +
        `  node/node-v<version>-<target>/bin/node   (pinned Node, .nvmrc says ${NODE_VERSION})\n` +
        '  onnxruntime-node/{package.json,dist/,<platform>-<arch>/}\n' +
        '  models/silero_vad.onnx',
    );
  }
  return requireDir(resolve(dir), 'PATCH_BUILD_VENDOR');
}

function nodeBinaryFor(vendor, t) {
  const candidates = [
    join(vendor, 'node', `node-v${NODE_VERSION}-${t.node}`, 'bin', 'node'),
    join(vendor, 'node', `node-v${NODE_VERSION}.0-${t.node}`, 'bin', 'node'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // The pin in .nvmrc may be a major line; accept the one vendored build of it.
  const dir = join(vendor, 'node');
  const match = existsSync(dir)
    ? execFileSync('ls', [dir], { encoding: 'utf8' })
        .split('\n')
        .filter((n) => n.startsWith(`node-v${NODE_VERSION}`) && n.endsWith(`-${t.node}`))
    : [];
  if (match.length === 1) {
    const p = join(dir, match[0], 'bin', 'node');
    if (existsSync(p)) return p;
  }
  die(
    `no pinned Node runtime for ${t.target}: looked for ${candidates.join(', ')}. ` +
      'Vendor the matching nodejs.org tarball.',
  );
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The project's artifact signing identity: an Ed25519 key held by whoever
 * publishes builds. The signature over each artifact is what the self-update
 * path verifies against (spec/11 § Host installation), and the public half
 * goes into the manifest the server serves.
 */
function signingKey() {
  const path = process.env.PATCH_ARTIFACT_SIGNING_KEY;
  if (!path) {
    die(
      'PATCH_ARTIFACT_SIGNING_KEY is not set. It must point at the project signing key ' +
        '(a base64url Ed25519 32-byte seed). Every artifact is signed; an unsigned one ' +
        'could not be verified by the self-update path.',
    );
  }
  if (!existsSync(path)) die(`signing key not found at ${path}`);
  const seed = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url');
  if (seed.length !== 32)
    die(`signing key at ${path} is ${seed.length} bytes, expected a 32-byte seed`);
  return {
    seed: new Uint8Array(seed),
    publicKey: Buffer.from(ed.getPublicKey(seed)).toString('base64url'),
  };
}

export async function esbuild() {
  const mod = await import('esbuild');
  return mod.default ?? mod;
}

export async function bundle(esb, entry, outfile) {
  await esb.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Everything pure-JS goes IN. The two exceptions cannot be flattened into a
    // single file, so they ship BESIDE the bundle instead:
    //   onnxruntime-node                a native addon         → native/
    //   @anthropic-ai/claude-agent-sdk  spawns its own program → node_modules/
    // External means "not inlined", NOT "not shipped". Treating the SDK as
    // something the machine would supply is what left every installed host
    // unable to run a single turn.
    //
    // chromium-bidi is a THIRD exception, but of a different kind: it is
    // never shipped at all. playwright-core's bidiOverCdp module (the BiDi-
    // over-CDP compatibility shim Playwright itself only reaches for from
    // modes this host's browser automation never selects — plain CDP
    // launch/connect, no isolated-context/BiDi path) lazily `require`s it
    // behind an `__esm` init function esbuild cannot prove is dead, so
    // bundling fails resolving a package that genuinely isn't installed.
    // External leaves the `require(...)` as a real runtime require instead
    // of a bundle-time resolve — safe exactly because that init function is
    // never actually called.
    //
    // fsevents is the same kind again, macOS only: playwright's optional
    // native file-watcher dependency, installed only on a Mac, so only the
    // darwin build tried to bundle its `.node` binary and failed ("No loader
    // is configured for .node files"), taking the whole host lane down with
    // it. The watcher belongs to playwright's test runner, which the host
    // never starts; verified 2026-10-04 that the darwin-arm64 bundle builds
    // and loads with it external.
    //
    // playwright-core is the fourth: it is shipped beside the bundle (see
    // copyPlaywrightCore) because it locates its own package.json as
    // `path.join(__dirname, '..')`, which only holds while it sits one folder
    // inside its package. Flattened into daemon.mjs that resolves to the parent
    // of the install directory and every browser tool dies with MODULE_NOT_FOUND.
    external: [
      'onnxruntime-node',
      '@anthropic-ai/claude-agent-sdk',
      'chromium-bidi/*',
      'fsevents',
      'playwright-core',
      'playwright-core/*',
    ],
    banner: {
      // The bundle is ESM but some dependencies reach for CJS globals.
      js: [
        "import { createRequire as __patchCreateRequire } from 'node:module';",
        "import { fileURLToPath as __patchFileURLToPath } from 'node:url';",
        "import { dirname as __patchDirname } from 'node:path';",
        'const require = __patchCreateRequire(import.meta.url);',
        'const __filename = __patchFileURLToPath(import.meta.url);',
        'const __dirname = __patchDirname(__filename);',
      ].join('\n'),
    },
    logLevel: 'warning',
  });
}

/** Copy the platform's onnxruntime-node into `native/`. */
function copyNativeAddons(vendor, t, outDir) {
  const src = requireDir(join(vendor, 'onnxruntime-node'), 'vendored onnxruntime-node');
  const prebuilt = requireDir(join(src, t.target), `onnxruntime-node prebuild for ${t.target}`);
  const dest = join(outDir, 'native', 'onnxruntime-node');
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(src, 'package.json'), join(dest, 'package.json'));
  cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true });
  // onnxruntime-node's binding.js requires
  // `../bin/napi-v6/<process.platform>/<process.arch>/onnxruntime_binding.node`
  // relative to dist/, so the prebuild lands at exactly that path.
  const binDir = join(dest, 'bin', 'napi-v6', t.platform, t.arch);
  mkdirSync(binDir, { recursive: true });
  cpSync(prebuilt, binDir, { recursive: true });
  // Its one runtime dependency is pure JS and platform-independent.
  const common = requireDir(
    join(
      REPO_ROOT,
      'node_modules',
      '.pnpm',
      'onnxruntime-common@1.26.0',
      'node_modules',
      'onnxruntime-common',
    ),
    'onnxruntime-common (run pnpm install)',
  );
  const commonDest = join(dest, 'node_modules', 'onnxruntime-common');
  mkdirSync(dirname(commonDest), { recursive: true });
  cpSync(common, commonDest, { recursive: true, dereference: true });
  return binDir;
}

/**
 * Copy the agent SDK into the artifact's own `node_modules`, so the host's
 * bare `import('@anthropic-ai/claude-agent-sdk')` resolves from beside
 * `daemon.mjs` on any machine.
 *
 * It is external to the BUNDLE because it spawns its own program files and
 * cannot be flattened into one .mjs — not because it belongs to the machine. It
 * is an ordinary library dependency of the host, and treating it as the
 * machine's problem is what left every installed host unable to run a turn:
 * an artifact has no node_modules on any parent of its program, so a bare
 * specifier could never have resolved to anything.
 *
 * The per-platform `claude-agent-sdk-<os>-<arch>` packages are deliberately NOT
 * copied: each is a ~200 MB Claude Code binary, and the host runs the
 * machine's own `claude` instead, passed as `pathToClaudeCodeExecutable`
 * (spec/02 § Agent backends — "so a host runs the same `claude` the user runs").
 * ~4 MB of library travels; the CLI does not.
 */
function copyAgentSdk(outDir) {
  const require = createRequire(join(DAEMON, 'package.json'));
  let entry;
  try {
    entry = require.resolve('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    die(`@anthropic-ai/claude-agent-sdk is not installed (run pnpm install): ${err.message}`);
  }
  // …/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs → the package root.
  const pkgRoot = dirname(entry);
  const scopeRoot = dirname(pkgRoot); // …/@anthropic-ai
  const nodeModules = dirname(scopeRoot); // …/node_modules
  const dest = join(outDir, 'node_modules');

  cpSync(pkgRoot, join(dest, '@anthropic-ai', 'claude-agent-sdk'), {
    recursive: true,
    dereference: true,
  });
  // Its own runtime dependencies, as pnpm laid them out beside it. The platform
  // binaries are skipped by name — they are the one thing that must not travel.
  for (const name of ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'zod']) {
    const src = join(nodeModules, name);
    if (!existsSync(src)) {
      die(`the agent SDK's dependency ${name} is not beside it at ${src} (run pnpm install)`);
    }
    cpSync(src, join(dest, name), { recursive: true, dereference: true });
  }
  if (!existsSync(join(dest, '@anthropic-ai', 'claude-agent-sdk', 'package.json'))) {
    die('the agent SDK did not land in the artifact');
  }
}

/**
 * Copy playwright-core into the artifact's `node_modules`, so the bundle's
 * `require('playwright-core')` resolves to a package with its own package.json
 * and `lib/` around it. It has no runtime dependencies of its own.
 */
export function copyPlaywrightCore(outDir) {
  const require = createRequire(join(DAEMON, 'package.json'));
  let pkgJson;
  try {
    // `playwright` is the host's dependency; playwright-core is its sibling.
    const playwright = dirname(require.resolve('playwright/package.json'));
    pkgJson = createRequire(join(playwright, 'package.json')).resolve(
      'playwright-core/package.json',
    );
  } catch (err) {
    die(`playwright-core is not installed (run pnpm install): ${err.message}`);
  }
  const dest = join(outDir, 'node_modules', 'playwright-core');
  cpSync(dirname(pkgJson), dest, { recursive: true, dereference: true });
  if (!existsSync(join(dest, 'package.json'))) die('playwright-core did not land in the artifact');
}

/**
 * macOS: every Mach-O in the artifact is signed with the project identity,
 * hardened runtime ON. The entitlements are not optional — V8 JITs, and without
 * `allow-jit` the signed Node dies at startup with "Failed to reserve virtual
 * memory for CodeRange" while still passing `codesign --verify`.
 */
function codesignMacArtifact(outDir, machos) {
  const identity = process.env.PATCH_CODESIGN_IDENTITY ?? process.env.CSC_NAME;
  if (!identity) {
    die(
      'PATCH_CODESIGN_IDENTITY (or CSC_NAME) is not set — the macOS artifact must be signed ' +
        'with the project signing identity, which is what the self-update path verifies.',
    );
  }
  const entitlements =
    process.env.PATCH_CODESIGN_ENTITLEMENTS ??
    join(DAEMON, 'installer', 'daemon-entitlements.plist');
  if (!entitlements || !existsSync(entitlements)) {
    die(
      'PATCH_CODESIGN_ENTITLEMENTS must point at the daemon entitlements plist ' +
        '(com.apple.security.cs.allow-jit + allow-unsigned-executable-memory + ' +
        'disable-library-validation). Signing --options runtime without it produces an ' +
        'artifact that verifies and then refuses to start.',
    );
  }
  for (const file of machos) {
    sh('codesign', [
      '--force',
      '--timestamp=none',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      '--sign',
      identity,
      file,
    ]);
    sh('codesign', ['--verify', '--strict', '--verbose=2', file]);
  }
  return identity;
}

async function buildTarget(t, ctx) {
  const { vendor, esb, info, outRoot, key } = ctx;
  const name = `patch-daemon-${info.version}-${t.target}`;
  const outDir = join(outRoot, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. one bundled program file + the MCP child + the installer program
  await bundle(esb, join(DAEMON, 'src', 'index.ts'), join(outDir, 'daemon.mjs'));
  await bundle(
    esb,
    join(DAEMON, 'src', 'bin', 'patch-tools-server.ts'),
    join(outDir, 'bin', 'patch-tools-server.js'),
  );
  await bundle(esb, join(DAEMON, 'src', 'installer', 'entry.ts'), join(outDir, 'install.mjs'));

  // 2. the pinned Node runtime
  const nodeBin = nodeBinaryFor(vendor, t);
  copyFileSync(nodeBin, join(outDir, 'node'));
  chmodSync(join(outDir, 'node'), 0o755);

  // 3. the platform's prebuilt native addons
  const binDir = copyNativeAddons(vendor, t, outDir);

  // 3b. the agent SDK, beside the bundle, so the host's bare import resolves
  // on a machine that has nothing installed but this artifact.
  copyAgentSdk(outDir);
  copyPlaywrightCore(outDir);

  // 4. the VAD model — the one model weight in the artifact
  const model = join(vendor, 'models', 'silero_vad.onnx');
  if (!existsSync(model)) die(`silero_vad.onnx not found at ${model}`);
  copyFileSync(model, join(outDir, 'silero_vad.onnx'));

  // 5. the patch CLI itself. The artifact shipped the patch-cli SKILL — which
  // tells every chat on the machine to run `patch chats list` and friends — but
  // no `patch` binary, so the skill's first instruction failed on a freshly
  // installed machine. Ship the program the skill documents.
  await bundle(
    esb,
    join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts'),
    join(outDir, 'bin', 'patch.js'),
  );

  // 6. the patch-cli skill the install writes into the user's skills directory
  cpSync(join(DAEMON, 'skill'), join(outDir, 'skill'), { recursive: true });

  // 6b. the voice sidecars' SOURCE — a few KB of Python each, and none of the
  // ~2 GB of wheels they need. Those are built per machine when the user
  // installs the component (spec/02 § Optional components); the source has to
  // be here for there to be anything to build. Without it an artifact-installed
  // host could download 340 MB of Kokoro weights and still never say a word,
  // because the program that reads them existed only in the docker image.
  for (const sidecar of ['kokoro', 'whisper']) {
    const src = requireDir(
      join(REPO_ROOT, 'packages', `${sidecar}-sidecar`),
      `${sidecar} sidecar source`,
    );
    cpSync(src, join(outDir, 'sidecars', sidecar), {
      recursive: true,
      // A developer's local venv and caches are not part of the artifact.
      filter: (p) => !/(^|\/)(\.venv|__pycache__|\.pytest_cache)(\/|$)/.test(p),
    });
  }

  // 7. the installer entry
  copyFileSync(join(DAEMON, 'installer', 'install'), join(outDir, 'install'));
  chmodSync(join(outDir, 'install'), 0o755);

  // 8. the stamp: version, source commit, build instant, target
  writeFileSync(
    join(outDir, 'build-info.json'),
    `${JSON.stringify(
      {
        version: info.version,
        gitSha: info.gitSha,
        builtAt: info.builtAt,
        target: t.target,
        nodeVersion: NODE_VERSION,
      },
      null,
      2,
    )}\n`,
  );

  // 8. signing
  let codesignIdentity;
  if (t.platform === 'darwin') {
    if (process.platform !== 'darwin') {
      die('the darwin-arm64 artifact must be built on macOS — codesign lives there');
    }
    codesignIdentity = codesignMacArtifact(outDir, [
      join(
        outDir,
        'native',
        'onnxruntime-node',
        'bin',
        'napi-v6',
        t.platform,
        t.arch,
        'onnxruntime_binding.node',
      ),
      ...['libonnxruntime.1.26.0.dylib', 'libonnxruntime.1.dylib']
        .map((f) => join(binDir, f))
        .filter((f) => existsSync(f)),
      join(outDir, 'node'),
    ]);
  }

  // 9. the tarball + its detached project signature
  const tar = join(outRoot, `${name}.tar.gz`);
  rmSync(tar, { force: true });
  // COPYFILE_DISABLE stops macOS bsdtar writing an AppleDouble `._<file>` next
  // to every entry. Those resource forks travel inside the tarball and get
  // materialised on extraction, so a Linux install ends up with `._SKILL.md`
  // in the user's skills directory and `._patch-tools-server.js` in bin — junk
  // in shipped directories, and hundreds of lines of `LIBARCHIVE.xattr` noise
  // scrolling past during a `curl … | sh`.
  // COPYFILE_DISABLE stops the AppleDouble `._<file>` sidecars; --no-xattrs
  // stops bsdtar storing the xattrs THEMSELVES, which is the other half — an
  // install on Linux otherwise prints a `LIBARCHIVE.xattr.com.apple.provenance`
  // warning per entry, ~200 lines of noise scrolling past a `curl … | sh`.
  sh('tar', ['--no-xattrs', '-czf', tar, '-C', outRoot, name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const digest = sha256(tar);
  const signature = Buffer.from(
    await ed.signAsync(new Uint8Array(Buffer.from(digest, 'hex')), key.seed),
  ).toString('base64url');
  writeFileSync(`${tar}.sig`, `${signature}\n`);

  return {
    target: t.target,
    file: `${name}.tar.gz`,
    dir: outDir,
    bytes: statSync(tar).size,
    sha256: digest,
    sig: signature,
    ...(codesignIdentity ? { codesignIdentity } : {}),
  };
}

export async function buildDaemonArtifacts(opts = {}) {
  const vendor = vendorRoot();
  const key = signingKey();
  const info = buildInfo();
  const esb = await esbuild();
  const outRoot = resolve(
    opts.outDir ?? process.env.PATCH_BUILD_OUT ?? join(REPO_ROOT, 'dist', 'daemon'),
  );
  mkdirSync(outRoot, { recursive: true });

  const only = opts.only ?? process.env.PATCH_BUILD_TARGETS?.split(',').filter(Boolean);
  const targets = only ? TARGETS.filter((t) => only.includes(t.target)) : TARGETS;
  if (targets.length === 0) die(`no known targets in ${only?.join(',')}`);

  const artifacts = [];
  for (const t of targets) {
    process.stdout.write(`build:daemon: ${t.target}…\n`);
    artifacts.push(await buildTarget(t, { vendor, esb, info, outRoot, key }));
  }

  const manifest = {
    version: info.version,
    gitSha: info.gitSha,
    builtAt: info.builtAt,
    signingPublicKey: key.publicKey,
    artifacts: artifacts.map(({ dir: _dir, ...rest }) => rest),
  };
  writeFileSync(join(outRoot, 'daemon-latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(DAEMON, 'installer', 'curl-install.sh'), join(outRoot, 'install.sh'));
  return { outRoot, manifest, artifacts };
}

if (isMain(import.meta.url)) {
  const { outRoot, manifest } = await buildDaemonArtifacts();
  process.stdout.write(`build:daemon: ${manifest.artifacts.length} artifact(s) in ${outRoot}\n`);
  for (const a of manifest.artifacts) {
    process.stdout.write(
      `  ${a.target}  ${a.file}  ${(a.bytes / 1e6).toFixed(1)} MB  ${a.sha256.slice(0, 12)}…\n`,
    );
  }
}
