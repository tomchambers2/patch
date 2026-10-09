// What THIS phone is actually running (spec/11 § Version reporting).
//
// Reported on the WS `hello` so `GET /api/version` — and the desktop update panel
// — can answer "is my phone on the latest build?" instead of only "what has the
// box published?". Those are different questions: publishing an APK says nothing
// about whether the phone ever installed it.
//
// All three fields describe ONE thing: the JS bundle actually executing. They
// are inlined together by Metro when that bundle is built — by `eas update` for
// an OTA (scripts/ship.mjs passes the version, sha and build time), or by the
// APK build for an embedded launch — so they cannot disagree with each other.
//
// `builtAt` used to come from `Updates.createdAt` instead, on the reasoning that
// it describes the running JS. It does not: once a newer update has been
// DOWNLOADED but not yet launched, that constant reports the pending one, while
// `version`/`gitSha` still describe the bundle running. The panel then showed a
// version from one build beside a timestamp from another — which is how a phone
// came to report 0.1.658 (fe11bf6) "built" at the instant a much later update
// was published. Whether an update is waiting is a separate question, and
// `useUpdates()` answers it properly (see the Settings → Version panel).

/** Provenance of the running mobile client. */
export interface MobileBuildInfo {
  /** Version of the JS bundle running, e.g. `0.1.705`. */
  version: string;
  /** Short git sha that bundle was built from, or undefined if unstamped. */
  gitSha?: string;
  /** ISO instant that same bundle was built. */
  builtAt?: string;
}

// Injected at bundle time. `EXPO_PUBLIC_*` vars are inlined by Metro, so these are
// literals in the shipped bundle — set by scripts/local/deliver.mjs from
// scripts/version.mjs. Absent in a dev/Expo Go run, where there is no release build
// to describe.
const NATIVE_VERSION = process.env['EXPO_PUBLIC_PATCH_VERSION'];
const NATIVE_GIT_SHA = process.env['EXPO_PUBLIC_PATCH_GIT_SHA'];
const NATIVE_BUILT_AT = process.env['EXPO_PUBLIC_PATCH_BUILT_AT'];

/**
 * Provenance of this client, resolved at call time (not module load) because
 * `Updates.createdAt` is only meaningful once the runtime has resolved which
 * bundle it launched.
 */
export function mobileBuildInfo(): MobileBuildInfo {
  return {
    // `dev` is honest here: a Metro/Expo Go run has no release version, and the
    // panel renders an uncomparable version as "unknown" rather than current.
    version: NATIVE_VERSION ?? 'dev',
    ...(NATIVE_GIT_SHA ? { gitSha: NATIVE_GIT_SHA } : {}),
    ...(NATIVE_BUILT_AT ? { builtAt: NATIVE_BUILT_AT } : {}),
  };
}
