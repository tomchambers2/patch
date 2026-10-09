// Desktop shell auto-update — the state machine behind the "Version & updates" panel.
//
// spec/11 § Version reporting. This exists because the shell's updater had never
// run once: the installed app was produced by `dist:dry` (electron-builder
// `--dir`), which emits no `app-update.yml`, so main.ts's `existsSync` guard
// returned early on every launch; the publish config pointed at a GitHub repo that
// isn't the real remote; there were no releases; and the version was pinned to
// 0.0.0 so electron-updater had nothing to compare. Four independent breakages,
// none of them visible from inside the app — which is the actual defect.
//
// So the design rule here is: every outcome is RECORDED and reportable, including
// failure. "I checked and there's nothing new" and "I couldn't check" must never
// look the same, and neither may silently look like "up to date".
//
// The check state is persisted to userData so "last checked" survives relaunch —
// otherwise every launch would claim it had never checked.

/** What the panel renders. Serialisable — crosses the IPC boundary as-is. */
export interface UpdaterState {
  /** Version of the running shell. */
  currentVersion: string;
  /** Short git sha the running shell was built from, or null if unstamped. */
  gitSha: string | null;
  /** ISO instant the running shell was built, or null if unstamped. */
  builtAt: string | null;
  /** The feed being polled, or null when updates are not configured at all. */
  feedUrl: string | null;
  /**
   * Why the updater is inert, when it is. Non-null here is the honest answer to
   * "why does this never find updates?" — the question the old build couldn't
   * answer. null means the updater is live.
   */
  disabledReason: string | null;
  /** ISO instant the last check COMPLETED (persisted across launches). */
  lastCheckedAt: string | null;
  /** Outcome of the last completed check. */
  lastResult: 'up-to-date' | 'update-available' | 'downloaded' | 'error' | null;
  /** Failure detail when lastResult is 'error'. Surfaced verbatim, never swallowed. */
  lastError: string | null;
  /** Version offered by the feed, when newer than current. */
  availableVersion: string | null;
  /** True once the update is on disk and installable. */
  downloaded: boolean;
  /**
   * ISO instant this shell FIRST learned it was behind the feed, and has been
   * behind ever since. Cleared only by actually installing.
   *
   * Deliberately not "when the current download finished": Patch ships ~20
   * times a day, so a per-download clock is reset by the next deploy and can
   * never age past a few minutes. The thing worth measuring — the thing the
   * banner escalates on — is how long you have been running a build older than
   * what is published, across however many versions have gone by.
   */
  staleSince: string | null;
  /** True while a check is in flight. */
  checking: boolean;
}

/** The subset of UpdaterState worth persisting between launches. */
export interface PersistedUpdaterState {
  lastCheckedAt: string | null;
  lastResult: UpdaterState['lastResult'];
  lastError: string | null;
  availableVersion: string | null;
  /** Survives relaunch: a shell restarted for some other reason is still behind. */
  staleSince: string | null;
}

export function emptyPersisted(): PersistedUpdaterState {
  return {
    lastCheckedAt: null,
    lastResult: null,
    lastError: null,
    availableVersion: null,
    staleSince: null,
  };
}

/**
 * Parse persisted state read off disk. Unknown/corrupt content yields "never
 * checked" rather than a thrown boot error — the app must still launch — but it
 * deliberately does NOT invent a check time, so the panel still says "never".
 */
export function parsePersisted(raw: string): PersistedUpdaterState {
  try {
    const v = JSON.parse(raw) as Partial<PersistedUpdaterState>;
    const results: UpdaterState['lastResult'][] = [
      'up-to-date',
      'update-available',
      'downloaded',
      'error',
    ];
    return {
      lastCheckedAt: typeof v.lastCheckedAt === 'string' ? v.lastCheckedAt : null,
      lastResult: results.includes(v.lastResult as UpdaterState['lastResult'])
        ? (v.lastResult as UpdaterState['lastResult'])
        : null,
      lastError: typeof v.lastError === 'string' ? v.lastError : null,
      availableVersion: typeof v.availableVersion === 'string' ? v.availableVersion : null,
      staleSince: typeof v.staleSince === 'string' ? v.staleSince : null,
    };
  } catch {
    return emptyPersisted();
  }
}

/**
 * Reasons the updater cannot work, checked in the order a user would hit them.
 * Returns null when it should function.
 *
 * Each of these was a REAL breakage in the shipped app, silently short-circuiting
 * the update check. Naming them turns "updates never appear" into a specific,
 * fixable sentence in the panel.
 */
export function diagnoseUpdater(env: {
  /** app.isPackaged — a `pnpm dev` run has nothing to update. */
  isPackaged: boolean;
  /** Does `<resources>/app-update.yml` exist? Absent for a `--dir` build. */
  hasUpdateConfig: boolean;
  /** The running app's version. */
  version: string;
  /** Is the bundle signed with a real (non-adhoc) identity? */
  signed: boolean;
  /**
   * Set when this app has no server to take updates from — it runs its own
   * (spec/05 § Desktop first run, "On this Mac"). The feed is the server's.
   */
  noFeedReason?: string | null;
}): string | null {
  if (!env.isPackaged) {
    return 'running from source (pnpm dev) — only a packaged build can self-update';
  }
  if (env.noFeedReason) return env.noFeedReason;
  if (!env.hasUpdateConfig) {
    return (
      'this build has no app-update.yml, so it can never check for updates — ' +
      'it was produced by `dist:dry` (--dir). Rebuild with `pnpm ship desktop`.'
    );
  }
  if (/^0\.0\.0/.test(env.version)) {
    return `version is ${env.version}, which can never compare as older than a release — rebuild with a real version`;
  }
  if (!env.signed) {
    // Measured, not assumed: an adhoc build downloads the update and then fails
    // validation ("code has no resources but signature indicates they must be
    // present"). A Developer ID is NOT required — Squirrel's designated requirement
    // is `identifier … and certificate root = H"…"` with no `anchor apple` clause, so
    // any trusted code-signing identity works, self-signed included (spec/11 §
    // Desktop code signing).
    return (
      'this build is adhoc-signed, so macOS will refuse to APPLY a downloaded ' +
      'update — Squirrel requires the update to carry the same code-signing ' +
      'certificate as the installed app, and adhoc has none. Checking and ' +
      'downloading work; installing needs a signed build (any trusted ' +
      'code-signing identity, not necessarily an Apple Developer ID).'
    );
  }
  return null;
}

/**
 * Fold an updater event into new state. Pure, so the whole state machine is
 * testable without Electron or a live feed.
 */
export type UpdaterEvent =
  | { type: 'check-started' }
  | { type: 'up-to-date'; at: string }
  | { type: 'available'; version: string; at: string }
  | { type: 'downloaded'; version: string; at: string }
  | { type: 'error'; message: string; at: string };

export function reduceUpdater(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case 'check-started':
      // Keep the previous result visible while re-checking — blanking it would
      // make a failed check look like "no answer yet" forever.
      return { ...state, checking: true };
    case 'up-to-date':
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'up-to-date',
        lastError: null,
        availableVersion: null,
        downloaded: false,
        // Current again. Either the update was installed, or the feed rolled
        // back to what we run; either way there is nothing to nag about.
        staleSince: null,
      };
    case 'available':
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'update-available',
        lastError: null,
        availableVersion: event.version,
        // First sighting starts the clock; later sightings do NOT restart it.
        staleSince: state.staleSince ?? event.at,
      };
    case 'downloaded':
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'downloaded',
        lastError: null,
        availableVersion: event.version,
        downloaded: true,
        staleSince: state.staleSince ?? event.at,
      };
    case 'error':
      // An error CLEARS neither the previous availableVersion nor `downloaded`
      // (a already-downloaded update is still installable), but it does record
      // that this check failed — never reported as up to date.
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'error',
        lastError: event.message,
      };
  }
}

export function persistedOf(state: UpdaterState): PersistedUpdaterState {
  return {
    lastCheckedAt: state.lastCheckedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    availableVersion: state.availableVersion,
    staleSince: state.staleSince,
  };
}

/** Build the initial state from the running app plus whatever was persisted. */
export function initialUpdaterState(args: {
  currentVersion: string;
  gitSha: string | null;
  builtAt: string | null;
  feedUrl: string | null;
  disabledReason: string | null;
  persisted: PersistedUpdaterState;
}): UpdaterState {
  return {
    currentVersion: args.currentVersion,
    gitSha: args.gitSha,
    builtAt: args.builtAt,
    feedUrl: args.feedUrl,
    disabledReason: args.disabledReason,
    lastCheckedAt: args.persisted.lastCheckedAt,
    lastResult: args.persisted.lastResult,
    lastError: args.persisted.lastError,
    availableVersion: args.persisted.availableVersion,
    downloaded: false, // a downloaded update does not survive a relaunch decision.
    checking: false,
    // A relaunch is not an install: the shell that comes back is the same
    // build, so if it was behind before it is behind now. Only `quitAndInstall`
    // clears this, and it clears it by replacing the binary.
    staleSince: args.persisted.staleSince,
  };
}

/**
 * The exact sequence that makes "restart to install" actually restart.
 *
 * Two things have to be true or the install is a silent no-op:
 *
 *  1. `app.isQuitting` must ALREADY be set. `quitAndInstall` works by closing
 *     every window and then quitting, but main.ts's `close` handler
 *     `preventDefault()`s and hides any close it hasn't been told is a real
 *     quit (Cmd+W hides; the tray app stays alive). Without the flag the window
 *     merely hides, no window ever closes, `app.quit()` is never reached, and
 *     the shell carries on running the OLD build — which is exactly what
 *     "restart to install just closes the window" was.
 *  2. `isForceRunAfter` must be true, so the installer relaunches the shell
 *     instead of leaving the user with no app at all.
 *
 * Every install path goes through here rather than touching `autoUpdater`
 * directly, so a third call site can't reintroduce the bug. Dependencies are
 * injected because main.ts imports electron and so is not importable under
 * node:test; this keeps the ordering rule unit-testable.
 *
 * If the install is REFUSED — Squirrel.Mac throws synchronously when it won't
 * apply an update to an adhoc/invalid signature — the flag goes back and the
 * error is handed to `onError` for the panel. Since there is no longer a
 * "restart to install" prompt to fall back to (every download installs itself),
 * that error line is the only way a broken updater reaches the user, so it must
 * never be swallowed and must not leave the app armed to quit on the next Cmd+W.
 */
/**
 * How long to give a successful-looking `quitAndInstall()` call before
 * concluding it silently stalled. electron-updater relaunches within a few
 * seconds on a healthy install; this is generous headroom above that.
 *
 * Found live: Squirrel.Mac's ShipIt helper can take the install request and
 * then wedge — a FileCoordination claim granted and never released, no error
 * event, no relaunch — leaving the old process running indefinitely. Nothing
 * upstream of this ever reported that as a failure, so pressing "Restart now"
 * looked like it did nothing at all.
 */
export const INSTALL_WATCHDOG_MS = 20_000;

export function quitAndInstallNow(deps: {
  app: { isQuitting: boolean };
  autoUpdater: { quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void };
  onError: (err: Error) => void;
  /** Test seam for the stall watchdog below; real callers get the real timer. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}): void {
  deps.app.isQuitting = true;
  try {
    deps.autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    deps.app.isQuitting = false;
    deps.onError(err as Error);
    return;
  }
  // A call that returns without throwing is not proof the install is
  // happening — see above. If it genuinely is, this process exits before the
  // timer below ever fires, so firing at all IS the evidence of a stall, not
  // a guess at one.
  const schedule = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const watchdog = schedule(() => {
    deps.app.isQuitting = false;
    deps.onError(
      new Error(
        'Restart did not finish — Patch is still running the old build. Quit it by hand (⌘Q) and reopen it.',
      ),
    );
  }, INSTALL_WATCHDOG_MS);
  watchdog.unref?.();
}

/**
 * How loudly the pending-update banner should speak, by how long this shell has
 * been behind.
 *
 * Modelled on Chrome, which is the only updater most people tolerate: it never
 * relaunches itself, it just puts a button in the corner and lets it change
 * colour — green, then amber, then red — until you press it. Slack's contribution
 * is the wording: say which version is waiting and what pressing it does.
 *
 * The thresholds are shorter than Chrome's 2/4/7 days because restarting Patch
 * costs seconds and it ships many times a day, but the shape is the same: the
 * first hours are quiet, and it only becomes insistent once being behind is a
 * real fact about the install rather than a deploy that landed a minute ago.
 *
 * This is deliberately NOT a countdown to a forced restart. There is no forced
 * restart; the escalation is the whole mechanism.
 */
export type UpdateUrgency = 'none' | 'ready' | 'due' | 'overdue';

/** Behind for less than this, the banner is quiet and informational. */
export const URGENCY_DUE_MS = 8 * 60 * 60 * 1000;
/** Behind for longer than this, the banner is at its loudest. */
export const URGENCY_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

export function updateUrgency(staleSince: string | null, now: number): UpdateUrgency {
  if (staleSince === null) return 'none';
  const since = Date.parse(staleSince);
  // An unparseable timestamp must not silently mean "not stale" — we know the
  // shell is behind, we just can't age it, so show it at its quietest rather
  // than hiding it.
  if (Number.isNaN(since)) return 'ready';
  const age = now - since;
  if (age >= URGENCY_OVERDUE_MS) return 'overdue';
  if (age >= URGENCY_DUE_MS) return 'due';
  return 'ready';
}

/** How long one update check may run before it is recorded as a failure. */
export const UPDATE_CHECK_TIMEOUT_MS = 2 * 60_000;

/**
 * One update check, bounded and single-flight. Dependencies are injected for
 * the same reason as `quitAndInstallNow`: main.ts imports electron.
 *
 * Without the bound, a feed that accepted the request and never answered left
 * `checking: true` for good and "Check now" awaiting forever; without
 * single-flight, each hourly re-check stacked another call on top of the stuck
 * one. Both ends are recorded as an `error` — never a quiet "up to date".
 */
export function createCheckRunner(deps: {
  start: () => void;
  record: (event: UpdaterEvent) => void;
  check: () => Promise<unknown>;
  /** True when the check emitted an outcome (events arrive via electron-updater). */
  hasOutcomeSinceStart: () => boolean;
  /** Reason to give when the check resolved but nothing answered. */
  silentReason?: () => string | null;
  timeoutMs?: number;
}): () => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  let inFlight: Promise<void> | null = null;
  const fail = (message: string): void =>
    deps.record({ type: 'error', message, at: new Date().toISOString() });

  const run = async (): Promise<void> => {
    deps.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([deps.check().then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        fail(
          `update check timed out after ${Math.round(timeoutMs / 1000)}s — the feed did not answer`,
        );
        return;
      }
    } catch (err) {
      fail((err as Error).message);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!deps.hasOutcomeSinceStart()) {
      fail(
        deps.silentReason?.() ??
          'the updater returned no result (no update feed answered this check)',
      );
    }
  };

  return () => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
