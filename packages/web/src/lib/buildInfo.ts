// What THIS running SPA is — the surface half of the update panel.
//
// The values are compile-time literals baked in by `define` (see
// ../../build-info.ts), so they describe the bundle the browser actually loaded,
// not whatever the server happens to be serving now. That distinction is the
// point: comparing the two is how "you're running something older than what's
// deployed" becomes detectable instead of invisible.

/** Immutable provenance of the loaded bundle. */
export interface WebBuildInfo {
  /** Semver, monotonic per commit (e.g. `0.1.317`). */
  version: string;
  /** Short git sha this bundle was built from. */
  gitSha: string;
  /** ISO instant the bundle was built. */
  builtAt: string;
}

export const BUILD_INFO: WebBuildInfo = {
  version: __PATCH_VERSION__,
  gitSha: __PATCH_GIT_SHA__,
  builtAt: __PATCH_BUILT_AT__,
};
