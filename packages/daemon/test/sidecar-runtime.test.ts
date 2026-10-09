// Provisioning a voice sidecar's Python runtime on demand (spec/02 § Optional
// components).
//
// The artifact carries the sidecar SOURCE and nothing that can run it. Pressing
// Install on Kokoro must therefore end with a machine that can actually speak —
// or with a stated reason it cannot. Never with a component recorded installed
// on a runtime that will fail at the first voice call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  provisionSidecarRuntime,
  resolveUv,
  venvPython,
  sidecarRuntimeReady,
  SidecarRuntimeError,
  type RunCommand,
} from '../src/audio/sidecarRuntime.js';

let root: string;
let sourceDir: string;
let venvDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-sidecar-'));
  sourceDir = join(root, 'sidecars', 'kokoro');
  venvDir = join(root, 'components', 'kokoro', 'venv');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'pyproject.toml'), '[project]\nname = "patch-kokoro-sidecar"\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Stands in for uv: materialises the interpreter a real sync would leave. */
function fakeUv(): RunCommand {
  return vi.fn(async () => {
    mkdirSync(join(venvDir, 'bin'), { recursive: true });
    writeFileSync(join(venvDir, 'bin', 'python'), '#!/bin/sh\n');
    return { code: 0, stdout: 'Resolved 84 packages', stderr: '' };
  });
}

const uvAt = '/usr/local/bin/uv';
const resolveUvTo = async (): Promise<string> => uvAt;

describe('provisioning a sidecar runtime', () => {
  it('builds the venv from the sidecar source, off the CPU torch index', async () => {
    const run = fakeUv();
    const python = await provisionSidecarRuntime({
      sourceDir,
      venvDir,
      run,
      resolveUv: resolveUvTo,
    });

    expect(python).toBe(join(venvDir, 'bin', 'python'));
    const [command, args, callOpts] = (run as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, string[], { cwd?: string; env?: Record<string, string> }];
    expect(command).toBe(uvAt);
    expect(args).toEqual(['sync', '--no-dev']);
    expect(callOpts.cwd).toBe(sourceDir);
    // The default Linux torch wheel drags in multi-GB CUDA libraries a CPU box
    // cannot use and a small one cannot even store.
    expect(callOpts.env?.['UV_TORCH_BACKEND']).toBe('cpu');
    // The venv belongs to the COMPONENT, not to the source tree, so removing
    // the component takes its runtime with it.
    expect(callOpts.env?.['UV_PROJECT_ENVIRONMENT']).toBe(venvDir);
  });

  it('installs the wheels the sidecar’s manifest cannot name, INTO that venv', async () => {
    // Kokoro's G2P needs spaCy's English model, published as a URL. This failed
    // for real on the Hetzner host: `uv pip` is not a project command and does
    // not read UV_PROJECT_ENVIRONMENT, so without `--python` it looked for a
    // venv in the working directory and died with "No virtual environment
    // found" — after the multi-minute sync had built exactly the right one.
    const run = fakeUv();
    await provisionSidecarRuntime({
      sourceDir,
      venvDir,
      run,
      resolveUv: resolveUvTo,
      extraWheels: ['https://example.invalid/en_core_web_sm-3.8.0-py3-none-any.whl'],
    });
    const calls = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toEqual([
      'pip',
      'install',
      '--python',
      join(venvDir, 'bin', 'python'),
      'https://example.invalid/en_core_web_sm-3.8.0-py3-none-any.whl',
    ]);
  });

  it('runs nothing when the machine already has a FINISHED runtime', async () => {
    const run = fakeUv();
    await provisionSidecarRuntime({ sourceDir, venvDir, run, resolveUv: resolveUvTo });
    expect(sidecarRuntimeReady(venvDir)).toBe(true);

    const again = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await provisionSidecarRuntime({ sourceDir, venvDir, run: again, resolveUv: resolveUvTo });
    expect(again).not.toHaveBeenCalled();
  });

  it('redoes a provision that died after the venv but before the wheels', async () => {
    // The interpreter is there and perfectly good — and the sidecar still can't
    // run, because what it needs went in afterwards. Resuming off "there's a
    // python here" would skip the rest for ever, and the gap would surface only
    // as a failed voice call.
    mkdirSync(join(venvDir, 'bin'), { recursive: true });
    writeFileSync(join(venvDir, 'bin', 'python'), '#!/bin/sh\n');
    expect(sidecarRuntimeReady(venvDir)).toBe(false);

    const run = fakeUv();
    await provisionSidecarRuntime({
      sourceDir,
      venvDir,
      run,
      resolveUv: resolveUvTo,
      extraWheels: ['https://example.invalid/wheel.whl'],
    });
    expect((run as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2);
    expect(sidecarRuntimeReady(venvDir)).toBe(true);
  });

  it('leaves no completion stamp when the wheels fail', async () => {
    let call = 0;
    const run: RunCommand = async () => {
      call++;
      if (call === 1) {
        mkdirSync(join(venvDir, 'bin'), { recursive: true });
        writeFileSync(join(venvDir, 'bin', 'python'), '#!/bin/sh\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 2, stdout: '', stderr: 'No virtual environment found' };
    };
    await expect(
      provisionSidecarRuntime({
        sourceDir,
        venvDir,
        run,
        resolveUv: resolveUvTo,
        extraWheels: ['https://example.invalid/wheel.whl'],
      }),
    ).rejects.toThrow(/No virtual environment found/);
    expect(sidecarRuntimeReady(venvDir)).toBe(false);
  });

  it('says the artifact carries no sidecar when the source is missing', async () => {
    const run = fakeUv();
    await expect(
      provisionSidecarRuntime({
        sourceDir: join(root, 'nope'),
        venvDir,
        run,
        resolveUv: resolveUvTo,
      }),
    ).rejects.toThrow(/does not carry the voice sidecars/);
    expect(run).not.toHaveBeenCalled();
  });

  it('quotes uv when the sync fails', async () => {
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'No solution found for torch==2.9',
    });
    await expect(
      provisionSidecarRuntime({ sourceDir, venvDir, run, resolveUv: resolveUvTo }),
    ).rejects.toThrow(/No solution found for torch/);
  });

  it('refuses to report a runtime that has no interpreter', async () => {
    // An install that CLAIMS to have worked is the worst outcome: the failure
    // would surface at the first voice call, far from its cause.
    const run: RunCommand = async () => ({ code: 0, stdout: 'ok', stderr: '' });
    await expect(
      provisionSidecarRuntime({ sourceDir, venvDir, run, resolveUv: resolveUvTo }),
    ).rejects.toThrow(/no interpreter/);
    expect(venvPython(venvDir)).toBeUndefined();
  });
});

describe('finding uv', () => {
  const installDir = '/patch-home/tools';

  it('uses the machine’s own uv when it has one', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const found = await resolveUv({
      candidates: ['/nope/uv', '/home/me/.local/bin/uv'],
      installDir,
      run,
      exists: (p) => p === '/home/me/.local/bin/uv',
    });
    expect(found).toBe('/home/me/.local/bin/uv');
    expect(run).not.toHaveBeenCalled();
  });

  it('installs uv into the patch home when the machine has none', async () => {
    // Pressing Install must not end in "first, go and install uv yourself".
    const present = new Set<string>();
    const run = vi.fn(async () => {
      present.add(join(installDir, 'uv'));
      return { code: 0, stdout: 'installed', stderr: '' };
    });
    const found = await resolveUv({
      candidates: ['/nope/uv'],
      installDir,
      run,
      exists: (p) => present.has(p),
    });
    expect(found).toBe(join(installDir, 'uv'));
    const [, , callOpts] = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    // Confined to the patch home, and it must not rewrite the user's shell.
    expect(callOpts.env?.['UV_INSTALL_DIR']).toBe(installDir);
    expect(callOpts.env?.['UV_NO_MODIFY_PATH']).toBe('1');
  });

  it('reports the failure and how to fix it by hand', async () => {
    const run: RunCommand = async () => ({
      code: 7,
      stdout: '',
      stderr: 'curl: (6) could not resolve host',
    });
    const err = await resolveUv({
      candidates: [],
      installDir,
      run,
      exists: () => false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SidecarRuntimeError);
    expect((err as Error).message).toMatch(/could not resolve host/);
    expect((err as Error).message).toMatch(/docs\.astral\.sh\/uv/);
  });
});
