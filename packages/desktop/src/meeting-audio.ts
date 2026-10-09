// The desktop shell's side of Meeting mode: the native helper that hears the
// system's audio, and the watcher that notices a call starting and ending.
//
// Both come from one bundled binary, `patch-audio` (native/patch-audio). Audio is
// a Core Audio tap, so macOS shows no screen picker and no screen-sharing
// indicator. A meeting is noticed the way Granola notices it: a calling app
// opening the microphone. NO FALLBACK: a helper that is missing or fails is an
// error the caller shows, never a silent downgrade to mic-only.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Bundle-ID prefix → name shown in the toast. A prefix, because the process
 *  holding the mic is often a helper (`com.google.Chrome.helper`). */
export const CALLING_APPS: ReadonlyArray<readonly [prefix: string, name: string]> = [
  ['us.zoom.xos', 'Zoom'],
  ['com.microsoft.teams', 'Microsoft Teams'],
  ['com.apple.FaceTime', 'FaceTime'],
  ['com.tinyspeck.slackmacgap', 'Slack'],
  ['com.hnc.Discord', 'Discord'],
  ['com.google.Chrome', 'Chrome call'],
  ['com.microsoft.edgemac', 'Edge call'],
  ['com.brave.Browser', 'Brave call'],
  ['company.thebrowser.Browser', 'Arc call'],
  ['org.mozilla.firefox', 'Firefox call'],
  ['com.apple.Safari', 'Safari call'],
];

/** How long the mic must stay closed before a meeting counts as over, so a mute
 *  or a brief reconnect does not announce a second meeting. */
export const END_GRACE_MS = 10_000;

export interface MicProcess {
  pid: number;
  bundleId: string;
}

/** Names of calling apps among the processes that have a mic open. `ignore` is
 *  Patch's own bundle prefix: its voice notes and the meeting itself use the mic. */
export function callingAppsIn(processes: readonly MicProcess[], ignore: string): string[] {
  const names = new Set<string>();
  for (const p of processes) {
    if (p.bundleId.startsWith(ignore)) continue;
    const hit = CALLING_APPS.find(([prefix]) => p.bundleId.startsWith(prefix));
    if (hit) names.add(hit[1]);
  }
  return [...names].sort();
}

/** Turns "which apps have the mic now" into started / ended events. */
export class MeetingDetector {
  private lastSeen = new Map<string, number>();
  private present = new Set<string>();

  constructor(
    private readonly on: { started(app: string): void; ended(app: string): void },
    private readonly graceMs: number = END_GRACE_MS,
  ) {}

  /** The current set of calling apps with a mic open. */
  update(apps: readonly string[], now: number): void {
    this.present = new Set(apps);
    for (const app of apps) {
      if (!this.lastSeen.has(app)) {
        this.lastSeen.set(app, now);
        this.on.started(app);
      }
    }
    this.tick(now);
  }

  /** Call regularly: the helper reports changes only, so an end is a lapse of time. */
  tick(now: number): void {
    for (const app of this.present) this.lastSeen.set(app, now);
    const before = this.lastSeen.size;
    let lastEnded: string | undefined;
    for (const [app, seen] of [...this.lastSeen]) {
      if (this.present.has(app) || now - seen < this.graceMs) continue;
      this.lastSeen.delete(app);
      lastEnded = app;
    }
    // One "ended" per meeting: when the last calling app has let go.
    if (before > 0 && this.lastSeen.size === 0 && lastEnded) this.on.ended(lastEnded);
  }
}

/** Keeps whole 16-bit samples: a pipe can split one across two reads. */
export class PcmAligner {
  private carry: Buffer | null = null;

  push(chunk: Buffer): Buffer | null {
    const all = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = all.length - (all.length % 2);
    this.carry = usable < all.length ? Buffer.from(all.subarray(usable)) : null;
    return usable > 0 ? all.subarray(0, usable) : null;
  }
}

/** Where the helper lives: inside the packaged app, or next to the source in dev. */
export function helperPath(opts: {
  packaged: boolean;
  resourcesPath: string;
  devDir: string;
}): string {
  const path = opts.packaged
    ? join(opts.resourcesPath, 'bin', 'patch-audio')
    : join(opts.devDir, '..', 'build', 'native', 'patch-audio');
  if (!existsSync(path)) {
    throw new Error(
      `The audio helper is missing at ${path}. Run \`node scripts/build-native.cjs\` in packages/desktop.`,
    );
  }
  return path;
}

type Spawn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface SystemAudioHandlers {
  /** Whole 16-bit samples of 16 kHz mono PCM. */
  onPcm(pcm: Buffer): void;
  /** The helper stopped without being asked to. */
  onFailed(message: string): void;
}

const READY_TIMEOUT_MS = 8000;

/** Runs `patch-audio tap`. `start` resolves once audio is flowing. */
export class SystemAudio {
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly binary: () => string,
    private readonly spawnFn: Spawn = (cmd, args) => spawn(cmd, args),
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(handlers: SystemAudioHandlers): Promise<void> {
    if (this.child) return Promise.reject(new Error('System audio is already running'));
    const child = this.spawnFn(this.binary(), ['tap']);
    this.child = child;
    const aligner = new PcmAligner();
    let stderr = '';
    let ready = false;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            'System audio did not start in time. Is System Audio Recording allowed for Patch?',
          ),
        );
      }, READY_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        const pcm = aligner.push(chunk);
        if (pcm) handlers.onPcm(pcm);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (!ready && /(^|\n)ready\n/.test(stderr)) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        this.child = null;
        if (ready) handlers.onFailed(err.message);
        else reject(err);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const asked = this.child !== child;
        this.child = null;
        if (asked) return;
        const message =
          stderr.replace(/(^|\n)ready\n/g, '$1').trim() || `exited (${signal ?? code})`;
        if (ready) handlers.onFailed(message);
        else reject(new Error(message));
      });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill('SIGTERM');
  }
}

/** Runs `patch-audio mic-watch`, reporting each change in who has a mic open. */
export function watchMicrophone(
  binary: string,
  handlers: { onProcesses(processes: MicProcess[]): void; onFailed(message: string): void },
  spawnFn: Spawn = (cmd, args) => spawn(cmd, args),
): () => void {
  const child = spawnFn(binary, ['mic-watch']);
  let buffer = '';
  let stderr = '';
  let stopped = false;
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { processes: MicProcess[] };
        handlers.onProcesses(parsed.processes);
      } catch (err) {
        handlers.onFailed(`unreadable mic-watch output: ${(err as Error).message}`);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.on('error', (err) => handlers.onFailed(err.message));
  child.on('exit', (code, signal) => {
    if (!stopped) handlers.onFailed(stderr.trim() || `mic-watch exited (${signal ?? code})`);
  });
  return () => {
    stopped = true;
    child.kill('SIGTERM');
  };
}
