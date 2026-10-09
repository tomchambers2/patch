// The server and every host run one version (scripts/deploy-scope.mjs §
// LOCKSTEP). A deploy ships both, but a machine that was asleep, off or cut off
// at the time comes back on the old build — and on 2026-09-30 an old host that
// could not read the new server's greeting sat wedged until it was updated by
// hand. So the server checks every host as it connects and, when the host is
// behind and the matching build is published, tells it to update.

export type DaemonLockstep =
  | { kind: 'in-step' }
  /** Behind, and the server's own version is published: send `host.update`. */
  | { kind: 'update'; to: string }
  /** Behind, but the build it needs is not what the update channel serves. */
  | { kind: 'unpublished'; published: string | null }
  /** Ahead of the server: the SERVER is the stale side, and cannot fix itself. */
  | { kind: 'server-behind' }
  /** A version that does not parse (a source checkout): nothing to compare. */
  | { kind: 'incomparable' };

function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return 0;
}

export function daemonLockstep(opts: {
  serverVersion: string;
  daemonVersion: string;
  publishedVersion: string | null;
}): DaemonLockstep {
  const server = parse(opts.serverVersion);
  const daemon = parse(opts.daemonVersion);
  if (!server || !daemon) return { kind: 'incomparable' };
  const order = compare(daemon, server);
  if (order === 0) return { kind: 'in-step' };
  if (order > 0) return { kind: 'server-behind' };
  if (opts.publishedVersion === opts.serverVersion) {
    return { kind: 'update', to: opts.serverVersion };
  }
  return { kind: 'unpublished', published: opts.publishedVersion };
}
