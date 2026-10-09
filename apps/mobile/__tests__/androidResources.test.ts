// Android resource names must be unique per qualifier, whatever the file
// extension (`ic_launcher.png` and `ic_launcher.webp` are the SAME resource).
//
// A stray `expo prebuild` committed a full set of `.webp` launcher icons beside
// the `.png` ones the adaptive-icon work had deliberately added, and from that
// commit on `assembleRelease` died in `mergeReleaseResources` with "Duplicate
// resources" — 40 of them. No APK was publishable for two days, and nothing in
// the repo noticed, because a broken Android build is invisible to a JS test
// suite. This is the cheap guard that makes it visible.

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const RES = join(fileURLToPath(new URL('../android/app/src/main/res', import.meta.url)));

describe('android res/', () => {
  it('never defines one resource name twice in a folder', () => {
    expect(existsSync(RES)).toBe(true);
    const clashes: string[] = [];
    for (const folder of readdirSync(RES, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const seen = new Map<string, string>();
      for (const file of readdirSync(join(RES, folder.name))) {
        const name = basename(file, extname(file));
        const first = seen.get(name);
        if (first !== undefined) {
          clashes.push(`${folder.name}/${name}: ${first} and ${file}`);
        } else {
          seen.set(name, file);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  // A bare workflow: `app.config.ts` `sounds` only reaches the APK through a
  // prebuild, which is not part of the build. The urgent sound shipped once as
  // a config entry with no file in res/raw, and Android silently played the
  // default sound on a channel that can then never be changed.
  it('carries every notification sound app.config.ts names in res/raw', async () => {
    const { default: config } = await import('../app.config');
    const expo = typeof config === 'function' ? config({ config: {} } as never) : config;
    const plugins = (expo.plugins ?? []) as unknown[];
    const notif = plugins.find(
      (p): p is [string, { sounds?: string[] }] =>
        Array.isArray(p) && p[0] === 'expo-notifications',
    );
    const sounds = notif?.[1].sounds ?? [];
    expect(sounds.length).toBeGreaterThan(0);
    for (const sound of sounds) {
      expect(existsSync(join(RES, 'raw', basename(sound))), sound).toBe(true);
    }
  });
});
