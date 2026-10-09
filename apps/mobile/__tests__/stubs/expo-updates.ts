// expo-updates stub for unit tests. `isEnabled` defaults to false (matches
// dev/Expo Go, where OTA is disabled); otaUpdates.test.ts flips it with
// __setEnabled to exercise the enabled path. Exported as a `let` so
// `import * as Updates from 'expo-updates'` sees the live-binding update
// (standard ESM namespace-import semantics).
export let isEnabled = false;
export function __setEnabled(v: boolean): void {
  isEnabled = v;
}

// The channel name baked into the running build, or null when the build was
// never given one — see expo-updates' own `Updates.channel` docs. Defaults to
// a real-looking channel so every existing enabled-path test (which predates
// this stub field) keeps exercising the "can check" path unchanged; tests for
// the no-channel case set it to null explicitly.
export let channel: string | null = 'preview';
export function __setChannel(v: string | null): void {
  channel = v;
}

// Retained for otaUpdates' own tests. buildInfo.ts no longer reads these: the
// running bundle's identity is inlined into it by Metro, and `createdAt` can
// describe a DOWNLOADED-but-not-launched update rather than the running one.
export let isEmbeddedLaunch = true;
export let createdAt: Date | null = null;
export function __setEmbeddedLaunch(v: boolean): void {
  isEmbeddedLaunch = v;
}
export function __setCreatedAt(v: Date | null): void {
  createdAt = v;
}

interface CheckResult {
  isAvailable: boolean;
}
let _checkResult: CheckResult = { isAvailable: false };
export function __setCheckResult(r: CheckResult): void {
  _checkResult = r;
}
export async function checkForUpdateAsync(): Promise<CheckResult> {
  return _checkResult;
}

let _fetchError: Error | null = null;
export function __setFetchError(e: Error | null): void {
  _fetchError = e;
}
export async function fetchUpdateAsync(): Promise<void> {
  if (_fetchError) throw _fetchError;
}
// No __setReloadError hook: the only caller of `reloadAsync` is the Settings
// restart button, and its test spies on this directly. Nothing automatic
// reloads any more (spec/11 § Mobile OTA "NO automatic reload"), so there is no
// automatic failure path left to simulate.
export async function reloadAsync(): Promise<void> {}

// `useUpdates()` — the hook the Settings → Version panel reads. The pending flag
// is the one fact the imperative API cannot give it: once a newer update has
// been downloaded, `checkForUpdateAsync` reports nothing available even though
// the phone is still running the old bundle.
export interface UseUpdatesState {
  isUpdatePending: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  checkError?: Error;
}
let _useUpdates: UseUpdatesState = {
  isUpdatePending: false,
  isChecking: false,
  isDownloading: false,
};
export function __setUseUpdates(s: Partial<UseUpdatesState>): void {
  _useUpdates = { ..._useUpdates, ...s };
}
export function __resetUseUpdates(): void {
  _useUpdates = { isUpdatePending: false, isChecking: false, isDownloading: false };
}
export function useUpdates(): UseUpdatesState {
  return _useUpdates;
}
