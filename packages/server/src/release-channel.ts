// Which release channel this server follows, and where releases come from.
//
// The project's releases live in one public repository, so that is a constant of
// the product rather than something each server is configured with. Which
// channel a server follows is the one choice an operator makes, and it is kept in
// a one-word file in the data directory, set with `patch-server channel`. It is
// read on every check, so changing it needs no restart.
//
//   stable   the newest ordinary release (the default)
//   dev      the newest build of anything, prereleases included
//   off      follow nothing; the server is updated some other way
//
// NO FALLBACK: a file that says something else is an error, not "stable".

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The project's public home on GitHub. */
export const RELEASE_REPO = 'tomchambers2/patch';

export const CHANNELS = ['stable', 'dev', 'off'] as const;
export type FollowedChannel = (typeof CHANNELS)[number];

const FILE = 'release-channel';

export function readChannel(dataDir: string): FollowedChannel {
  const file = join(dataDir, FILE);
  if (!existsSync(file)) return 'stable';
  const value = readFileSync(file, 'utf8').trim();
  if (!(CHANNELS as readonly string[]).includes(value)) {
    throw new Error(`${file} says "${value}"; it must be one of ${CHANNELS.join(', ')}`);
  }
  return value as FollowedChannel;
}

export function writeChannel(dataDir: string, channel: string): FollowedChannel {
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`"${channel}" is not a channel; use one of ${CHANNELS.join(', ')}`);
  }
  writeFileSync(join(dataDir, FILE), `${channel}\n`);
  return channel as FollowedChannel;
}
