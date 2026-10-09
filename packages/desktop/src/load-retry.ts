// Load retry — spec/12 § Connection diagnostics screen.
//
// The desktop shell IS the web SPA: `createMainWindow` does `loadURL(SERVER_URL)`
// and everything after that is the page. So the one failure the SPA cannot heal
// is the failure to load the SPA — a dead document load leaves Chromium's own
// "This site can't be reached" in the window, and nothing in Electron retries
// it. The window sits on that error until Tom quits and reopens the app.
//
// That is not hypothetical. Every `patch-server` restart takes the upstream
// down for a second or two, and Caddy answers `GET /` and `GET /ws` with a 502
// (`dial tcp [::1]:3000: connection refused`) while it is gone — five of them in
// the journal across 13-14 Sep 2026, each landing in the same second as a
// restart. The server is healthy moments later; only the shell is still showing
// the failure, for ever, which is what "prod app failing with 502 on desktop"
// actually was.
//
// So a failed document load is retried on a widening backoff, and a load that
// succeeds resets the ladder — the error state clears itself the moment the
// socket is back, exactly like `api/ws.ts`'s reconnect. NO FALLBACK: the retries
// are finite and the last failure is left on screen rather than looping in
// silence. A server that is genuinely down still reads as down.

/**
 * How long to wait before each re-load, in order. Starts well inside the ~1-2s
 * a `patch-server` restart takes, so the usual case heals before the window has
 * finished painting the error page; widens to cover a slower deploy.
 */
export const LOAD_RETRY_BACKOFF_MS: readonly number[] = [400, 1_000, 2_500, 5_000, 10_000];

/**
 * Chromium's `ERR_ABORTED`. Fired when a navigation is superseded or cancelled
 * — by `loadURL` being called again, by the renderer navigating itself. Nothing
 * failed, so nothing is retried; retrying here would fight the navigation that
 * replaced it.
 */
export const ERR_ABORTED = -3;

/**
 * The delay before attempt `attempt` (1-based), or `null` once the ladder is
 * spent — the caller then leaves the failure on screen.
 */
export function loadRetryDelay(attempt: number): number | null {
  if (attempt < 1 || attempt > LOAD_RETRY_BACKOFF_MS.length) return null;
  return LOAD_RETRY_BACKOFF_MS[attempt - 1]!;
}

/** Whether a `did-fail-load` is one worth re-dialling. */
export function shouldRetryLoad(errorCode: number, isMainFrame: boolean): boolean {
  // A subframe that failed is a broken image or iframe inside a page that
  // LOADED — re-dialling the whole window over it would throw away a working
  // app to fix something that isn't the app.
  if (!isMainFrame) return false;
  return errorCode !== ERR_ABORTED;
}
