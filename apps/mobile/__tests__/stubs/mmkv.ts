// In-memory MMKV stand-in for unit tests. Real MMKV persists to disk keyed
// by `id`, surviving a JS reload — so two `new MMKV({id: 'x'})` calls (e.g.
// across a test's `vi.resetModules()`, which gives credential.ts/config.ts a
// fresh module instance and hence a fresh MMKV construction) must share the
// same underlying storage. A plain per-instance Map would NOT do that (each
// `new MMKV()` would start empty), so the backing maps live in a
// `globalThis`-keyed registry — untouched by resetModules(), which only
// clears the module cache, not global object state.
const registry: Map<string, Map<string, string | number | boolean>> = ((
  globalThis as unknown as { __mmkvRegistry?: Map<string, Map<string, string | number | boolean>> }
).__mmkvRegistry ??= new Map());

export class MMKV {
  private map: Map<string, string | number | boolean>;
  constructor(opts?: { id?: string }) {
    const id = opts?.id ?? 'default';
    let m = registry.get(id);
    if (!m) {
      m = new Map();
      registry.set(id, m);
    }
    this.map = m;
  }
  set(key: string, v: string | number | boolean): void {
    this.map.set(key, v);
  }
  getString(key: string): string | undefined {
    const v = this.map.get(key);
    return typeof v === 'string' ? v : undefined;
  }
  getNumber(key: string): number | undefined {
    const v = this.map.get(key);
    return typeof v === 'number' ? v : undefined;
  }
  getBoolean(key: string): boolean | undefined {
    const v = this.map.get(key);
    return typeof v === 'boolean' ? v : undefined;
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  clearAll(): void {
    this.map.clear();
  }
  contains(key: string): boolean {
    return this.map.has(key);
  }
  getAllKeys(): string[] {
    return [...this.map.keys()];
  }
}

/** Test helper: wipe every MMKV-backed store (all ids). Call in afterEach/
 * beforeEach if a test suite needs a clean slate across resetModules().
 *
 * NOTE: composer drafts (`src/lib/composerDraft.ts`) additionally keep an
 * in-memory mirror of MMKV for reactive live-sync (spec/14 § Composer) — a
 * suite that mounts `<Composer>` for the same chatId more than once must ALSO
 * reset `useComposerDraftStore` (see its own `_reset()`), or the mirror keeps
 * showing what a previous test typed even after this clears the disk-backed
 * maps. Not done here: importing the store from this generic stub would wire
 * a real circular load-order dependency (composerDraft -> credential ->
 * 'react-native-mmkv' -> this file) into every test, for a reset only
 * Composer-mounting suites need.
 */
export function __clearAllMmkv(): void {
  for (const m of registry.values()) m.clear();
  seedRoute();
}

/**
 * The paired server is part of the fixture: nothing in the app can build a URL
 * without one (config.ts), and clearing the store is meant to forget the
 * conversation, not who it is with. Tests of the no-route case delete it.
 */
export const TEST_SERVER_URL = 'https://patch.test';
export function seedRoute(): void {
  new MMKV({ id: 'patch.mobile' }).set(
    'patch.route.v1',
    JSON.stringify({ kind: 'direct', url: TEST_SERVER_URL }),
  );
}
seedRoute();
