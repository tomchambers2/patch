// Where the host's own installed files are.
//
// The host ships as an artifact (spec/02 § Installation):
//
//   patch-daemon-<version>-<os>-<arch>/
//     node               pinned Node runtime
//     daemon.mjs         the bundled host        <- import.meta.url, once bundled
//     bin/               the MCP stdio server
//     native/            platform-native addons (onnxruntime for VAD)
//     silero_vad.onnx    the VAD model
//     skill/patch-cli/   the CLI skill written into the user's skills dir
//     install            the installer
//     build-info.json    version, source commit, build instant
//
// esbuild inlines this module into `daemon.mjs`, so `import.meta.url` here is
// the artifact's own program file and `programDir` is the install directory —
// which is how spec/18 has the host read `silero_vad.onnx` "out of the
// host's own install directory".
//
// Running from source (tsx, dev) this module sits in `packages/daemon/src`,
// where none of those siblings exist. That is not a fallback: an artifact and a
// source checkout are two different programs, and each accessor answers
// truthfully for the one it is running in — `undefined` means "this is not an
// artifact", and every caller says so out loud rather than inventing a path.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding the running host program. */
export const programDir = dirname(fileURLToPath(import.meta.url));

export interface DaemonBuildInfo {
  version: string;
  gitSha: string;
  builtAt: string;
  target: string;
}

/** `build-info.json` from the artifact, or undefined when not running from one. */
export function bundledBuildInfo(dir: string = programDir): DaemonBuildInfo | undefined {
  const path = join(dir, 'build-info.json');
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DaemonBuildInfo>;
  for (const key of ['version', 'gitSha', 'builtAt', 'target'] as const) {
    if (typeof parsed[key] !== 'string' || parsed[key]?.length === 0) {
      throw new Error(`${path}: missing or empty "${key}" — the artifact is not stamped`);
    }
  }
  return parsed as DaemonBuildInfo;
}

/**
 * The artifact's `native/` directory, which holds the platform's prebuilt
 * addons. Bare `import 'onnxruntime-node'` cannot find it (there is no
 * node_modules in an artifact), so the VAD loader imports the package's entry
 * file from here by path.
 */
export function bundledNativeDir(dir: string = programDir): string | undefined {
  const native = join(dir, 'native');
  return existsSync(join(native, 'onnxruntime-node', 'package.json')) ? native : undefined;
}

/** The artifact's `silero_vad.onnx` (~2 MB), present in every install. */
export function bundledVadModelPath(dir: string = programDir): string | undefined {
  const model = join(dir, 'silero_vad.onnx');
  return existsSync(model) ? model : undefined;
}

/**
 * A voice sidecar's Python SOURCE, carried by the artifact (`sidecars/<id>/`).
 *
 * The source is a few KB and ships; its ~2 GB of wheels do not, and are built
 * per machine when the user installs the component (spec/02 § Optional
 * components). Running from a source checkout there is no artifact, so the
 * monorepo's own `packages/<id>-sidecar` is the answer instead — the same
 * program, in the place this checkout keeps it.
 */
export function bundledSidecarDir(sidecar: string, dir: string = programDir): string {
  const shipped = join(dir, 'sidecars', sidecar);
  if (existsSync(join(shipped, 'pyproject.toml'))) return shipped;
  return join(dir, '..', '..', `${sidecar}-sidecar`);
}

/** The agent backend the host drives (spec/02 § Agent backends). */
export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * The backend version a machine is provisioned with. Kept equal to the host's
 * own dependency on it (packages/daemon/package.json) — a test asserts that, so
 * the version the host is TYPED against and the version its machines RUN can
 * never drift apart silently.
 */
export const AGENT_SDK_VERSION = '0.2.126';

/**
 * Where the machine's agent backend is provisioned (spec/02 § Agent backends —
 * "the host provisions a backend the host lacks rather than reporting it as
 * missing").
 *
 * Under the PATCH HOME, not the version directory: self-update installs each
 * build into its own `versions/<v>/`, so a backend provisioned there would have
 * to be re-provisioned on every update — and an update that silently lost the
 * backend is exactly the failure this path exists to end. One provision per
 * machine, shared by every version that machine runs.
 */
export function agentSdkBackendDir(patchHome: string): string {
  return join(patchHome, 'backends', 'claude');
}

/**
 * The provisioned backend's entry file, or `undefined` when this machine has
 * none. The host imports it BY PATH: an artifact has no `node_modules` on any
 * parent of `daemon.mjs`, so a bare specifier cannot reach a package installed
 * anywhere else on the machine — which is why every turn on an installed host
 * failed with "Cannot find package '@anthropic-ai/claude-agent-sdk'".
 *
 * A package directory with no readable entry point counts as ABSENT, not as
 * provisioned: a half-finished install must be caught where it is checked,
 * naming what is missing, rather than at the first turn a user sends.
 */
export function provisionedAgentSdkEntry(patchHome: string): string | undefined {
  const pkgDir = join(agentSdkBackendDir(patchHome), 'node_modules', AGENT_SDK_PACKAGE);
  const manifest = join(pkgDir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  let main: unknown;
  try {
    main = (JSON.parse(readFileSync(manifest, 'utf8')) as { main?: unknown }).main;
  } catch {
    return undefined;
  }
  if (typeof main !== 'string' || main.length === 0) return undefined;
  const entry = join(pkgDir, main);
  return existsSync(entry) ? entry : undefined;
}
