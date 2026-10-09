// What `patch --version` reports.
//
// Two shapes run this program and they know their version differently:
//
//   an INSTALLED ARTIFACT — one bundled `bin/patch.js`, no package.json within
//     reach — carries `build-info.json` at its root, the same stamp the host
//     reads (spec/11 § Version reporting);
//   a CHECKOUT — `packages/cli/src/index.ts` — has the package.json above it.
//
// Reading only the second is what made every `patch` command on a freshly
// installed machine die at startup, before parsing a single argument.
//
// NO FALLBACK: with neither present this throws, naming both places. A CLI that
// invents a version number is worse than one that admits it doesn't know.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the version for a program whose own directory is `here`. */
export function resolveCliVersion(here: string): string {
  const buildInfo = [join(here, '..', 'build-info.json'), join(here, 'build-info.json')];
  for (const candidate of buildInfo) {
    try {
      const info = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (info.version) return info.version;
    } catch {
      // not this one
    }
  }
  const manifests = [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')];
  for (const candidate of manifests) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // not this one
    }
  }
  throw new Error(
    `@patch/cli: no version found — looked for build-info.json in ${buildInfo.join(', ')} ` +
      `and package.json in ${manifests.join(', ')}`,
  );
}
