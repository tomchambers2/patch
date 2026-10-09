// Provisioning a voice sidecar's Python runtime, on demand, per machine
// (spec/02 § Optional components).
//
// The voice sidecars are Python: a few KB of source the artifact carries, and
// ~2 GB of wheels (torch and friends) it must NOT. So the artifact ships the
// source and NOTHING that can run it, and the runtime is built here — when the
// user installs the component, not when they install the host.
//
// Until this existed, an artifact-installed host could never speak: `KOKORO_BACKEND=real`
// makes the host spawn `uv run … patch_kokoro_sidecar`, and on such a host
// there was no sidecar source, no venv and often no `uv` — so TTS was reachable
// only from the docker image, which bakes all three at build time.
//
// NO FALLBACK: every failure here is reported with the command that failed and
// what it printed. A component is never recorded installed on a runtime that
// cannot start.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How a command is run. Injected so tests provision nothing. */
export interface RunCommand {
  (
    command: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ProvisionSidecarOptions {
  /** The sidecar package (pyproject.toml + uv.lock + its module). */
  sourceDir: string;
  /** Where this machine's venv for that sidecar goes. */
  venvDir: string;
  run: RunCommand;
  /** Resolve `uv`, installing it for this machine if it is missing. */
  resolveUv: () => Promise<string>;
  /** Progress line for the surface (spec/02 § Optional components). */
  onProgress?: (note: string) => void;
  /**
   * Extra wheels the sidecar needs that its manifest cannot express — Kokoro's
   * G2P wants spaCy's English model, published as a URL, not a package name.
   * Installed after the sync, into the same venv.
   */
  extraWheels?: string[];
}

export class SidecarRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarRuntimeError';
  }
}

/** The interpreter a venv exposes, if it has one built yet. */
export function venvPython(venvDir: string): string | undefined {
  const python = join(venvDir, 'bin', 'python');
  return existsSync(python) ? python : undefined;
}

/**
 * The stamp a COMPLETED provision leaves. An interpreter is not the same thing:
 * `uv sync` builds the venv first and the extra wheels go in after it, so a run
 * that died between the two leaves a perfectly good Python that is missing what
 * the sidecar needs. Resuming off "there's a python here" would skip the rest
 * for ever, and the gap would only show up as a failed voice call.
 */
const PROVISIONED_STAMP = '.patch-runtime-complete';

/** Whether this machine has a FINISHED runtime for a sidecar. */
export function sidecarRuntimeReady(venvDir: string): boolean {
  return existsSync(join(venvDir, PROVISIONED_STAMP));
}

/**
 * Build (or confirm) the sidecar's venv. Idempotent: an already-provisioned
 * runtime returns without running anything, so re-installing a component after
 * a weights change costs nothing.
 *
 * `UV_TORCH_BACKEND=cpu` is not an optimisation — the default Linux torch wheel
 * drags in multi-GB CUDA libraries that a CPU box cannot use and, on a small
 * machine, cannot even store.
 */
export async function provisionSidecarRuntime(opts: ProvisionSidecarOptions): Promise<string> {
  const existing = venvPython(opts.venvDir);
  if (existing !== undefined && sidecarRuntimeReady(opts.venvDir)) return existing;

  if (!existsSync(join(opts.sourceDir, 'pyproject.toml'))) {
    throw new SidecarRuntimeError(
      `no sidecar source at ${opts.sourceDir} (expected pyproject.toml). This host artifact ` +
        'does not carry the voice sidecars; a newer build does.',
    );
  }

  const uv = await opts.resolveUv();
  const env = {
    ...process.env,
    UV_TORCH_BACKEND: 'cpu',
    UV_PROJECT_ENVIRONMENT: opts.venvDir,
  };

  opts.onProgress?.('building the Python runtime (this is the slow part)');
  const sync = await opts.run(uv, ['sync', '--no-dev'], { cwd: opts.sourceDir, env });
  if (sync.code !== 0) {
    throw new SidecarRuntimeError(
      `uv sync failed in ${opts.sourceDir} (exit ${sync.code}): ${(sync.stderr || sync.stdout).trim()}`,
    );
  }

  const built = venvPython(opts.venvDir);
  if (built === undefined) {
    throw new SidecarRuntimeError(
      `uv reported success but ${opts.venvDir} has no interpreter. The runtime is not usable; ` +
        'nothing has been left claiming otherwise.',
    );
  }

  for (const wheel of opts.extraWheels ?? []) {
    opts.onProgress?.(`installing ${wheel.split('/').pop() ?? wheel}`);
    // `--python` names the environment explicitly. `uv pip` is not a project
    // command and does NOT read `UV_PROJECT_ENVIRONMENT`, so without this it
    // looked for a venv in the current directory, found none, and failed with
    // "No virtual environment found" — after the multi-minute sync had already
    // built the right one.
    const add = await opts.run(uv, ['pip', 'install', '--python', built, wheel], {
      cwd: opts.sourceDir,
      env,
    });
    if (add.code !== 0) {
      throw new SidecarRuntimeError(
        `uv pip install ${wheel} failed (exit ${add.code}): ${(add.stderr || add.stdout).trim()}`,
      );
    }
  }

  // Only now is the runtime complete. The stamp is what a later run reads, so a
  // provision interrupted between the sync and the wheels is redone rather than
  // mistaken for a finished one.
  writeFileSync(join(opts.venvDir, PROVISIONED_STAMP), `${new Date().toISOString()}\n`);
  return built;
}

export interface ResolveUvOptions {
  /** Candidate paths tried in order before anything is installed. */
  candidates: string[];
  /** Where a freshly installed `uv` is put (its own directory, per machine). */
  installDir: string;
  run: RunCommand;
  onProgress?: (note: string) => void;
  /** Injected for tests. Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Find `uv`, installing it for this machine if the machine hasn't got one.
 *
 * Voice is meant to install itself when the user asks for it, so "you need to
 * install uv first" is not an acceptable outcome of pressing Install. The
 * installer is Astral's own, pinned to this machine's patch home — it touches
 * nothing outside it and no shell profile.
 */
export async function resolveUv(opts: ResolveUvOptions): Promise<string> {
  const exists = opts.exists ?? existsSync;
  for (const candidate of opts.candidates) {
    if (exists(candidate)) return candidate;
  }
  const installed = join(opts.installDir, 'uv');
  if (exists(installed)) return installed;

  opts.onProgress?.('installing uv (the Python package manager the sidecar needs)');
  const result = await opts.run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
    env: {
      ...process.env,
      // Land it in the patch home and leave the user's shell alone.
      UV_INSTALL_DIR: opts.installDir,
      UV_NO_MODIFY_PATH: '1',
    },
  });
  if (result.code !== 0) {
    throw new SidecarRuntimeError(
      `could not install uv (exit ${result.code}): ${(result.stderr || result.stdout).trim()}. ` +
        'Install uv on this machine (https://docs.astral.sh/uv/) and install the component again.',
    );
  }
  if (!exists(installed)) {
    throw new SidecarRuntimeError(
      `the uv installer reported success but there is no uv at ${installed}.`,
    );
  }
  return installed;
}
