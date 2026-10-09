// The host IMAGE must carry the tools a terminal session exists to run
// (spec/02 § Terminal sessions).
//
// This is not pedantry: the shipped image had bash but NO git, so the one thing
// the terminal is for — `git clone` a repo onto the host so a chat can be
// opened in it — failed with "git: not found" on the real box. A unit test
// can't run a container, but it can hold the Dockerfile to the contract.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(here, '..', 'Dockerfile'), 'utf8');

/** The runtime stage — the layer that actually ships (the builder is discarded). */
const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:${NODE_VERSION}-bookworm-slim'));

describe('daemon Dockerfile — terminal session tools', () => {
  it('installs git and an ssh client in the RUNTIME stage', () => {
    expect(runtime).toMatch(/apt-get install[^\n]*\bgit\b/);
    expect(runtime).toMatch(/apt-get install[^\n]*\bopenssh-client\b/);
  });

  it('still ships bash — the shell a terminal session spawns', () => {
    // Debian's node:*-bookworm-slim base carries bash; the guard is that nobody
    // swaps the runtime to a base (alpine/distroless) that doesn't.
    expect(runtime).toMatch(/FROM node:\$\{NODE_VERSION\}-bookworm-slim/);
  });
});
