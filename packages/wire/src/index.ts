// @patch/wire — shared wire-protocol types, schemas, and codec.
//
// See spec/03-wire-protocol.md for the full event catalogue.
// Per spec/18-tech-stack.md: pure TS, zero runtime deps beyond zod.

export const WIRE_PROTOCOL_VERSION = 1;

// Server healthz response — kept here because it's the one shape every
// surface needs even before WS auth, and putting it next to the wire types
// avoids a second tiny shared package.
export interface HealthzResponse {
  ok: true;
  version: string;
  gitSha: string;
}

// ---------------------------------------------------------------------------
// Version + update reporting (`GET /api/version`, spec/11 § Version reporting)
//
// Patch ships as five independently-deployable layers (server, host, web SPA,
// desktop shell, Android app) down two unrelated delivery paths. Nothing used to
// report more than the server's own sha, which is how prod once served an 8-day
// -old SPA while /api/healthz reported the newest commit. These shapes make every
// layer's provenance — and any disagreement between them — explicit.

/** Provenance of one built layer. `null` fields mean "not reported", never "ok". */
export interface LayerBuild {
  /** Semver, monotonic per commit (e.g. `0.1.317`). */
  version: string;
  /** Short git sha, or null when the layer predates build stamping. */
  gitSha: string | null;
  /** ISO instant the layer was built, or null when not stamped. */
  builtAt: string | null;
}

/** The SPA the server is serving right now. */
export interface WebLayer extends LayerBuild {
  /** Content-hashed entry bundle, e.g. `assets/index-C4eo04Yz.js`. */
  bundle: string;
  /** ISO instant this SPA was published onto the box (mtime of its index.html). */
  deployedAt: string;
  /**
   * Newest commit touching server-side code as of this SPA's build. The server
   * compares its OWN sha to this instead of to `gitSha`: a web-only release makes the
   * shas differ while the code does not, and flagging that produced a drift warning
   * nobody could act on. Null when the SPA predates this field.
   */
  expectedServerSha: string | null;
}

/** A build published for download/update, as opposed to one that's running. */
export interface PublishedLayer extends LayerBuild {
  /** ISO instant the artifact was published. */
  publishedAt: string;
  /** Where a client fetches it. */
  url: string;
}

/** What a connected client reported about itself at hello time. */
export interface ClientBuild extends LayerBuild {
  surfaceId: string;
  surfaceKind: string;
  online: boolean;
  /** ISO instant of its last heartbeat. */
  lastSeenAt: string;
}

/**
 * A disagreement between layers that a human should act on. Surfaced verbatim by
 * the update panel — the whole point is that drift is loud, not inferred.
 */
export interface VersionDrift {
  /** Machine-readable kind, e.g. `web-behind-server`, `surface-behind-deployed`. */
  kind: string;
  /** One-line human explanation, e.g. "the deployed SPA is 12 commits behind the server". */
  detail: string;
  /** What the user should do about it, e.g. "run: pnpm ship web". */
  remedy: string;
}

/**
 * Narrow an untrusted `GET /api/version` body to a `VersionReport`, throwing when
 * it isn't one.
 *
 * The panel must not render a partial report: a body missing `drift` would either
 * crash the page or — worse, if we defaulted it to `[]` — silently claim every
 * layer agrees. A malformed response is a real failure and belongs in the panel's
 * error state. NO FALLBACK: we validate the fields the panel depends on rather than
 * coercing them.
 */
export function assertVersionReport(body: unknown): VersionReport {
  const bad = (why: string): never => {
    throw new Error(`malformed /api/version response: ${why}`);
  };
  if (typeof body !== 'object' || body === null) return bad('not an object');
  const r = body as Partial<VersionReport>;
  if (typeof r.checkedAt !== 'string') return bad('missing checkedAt');
  if (typeof r.server !== 'object' || r.server === null) return bad('missing server');
  if (typeof r.server.version !== 'string') return bad('missing server.version');
  if (!Array.isArray(r.drift)) return bad('missing drift');
  if (!Array.isArray(r.clients)) return bad('missing clients');
  // A partial response must reach the panel's error state rather than render as
  // "all layers agree" — an absent host roster would read as "no machines".
  if (!Array.isArray(r.hosts)) return bad('missing hosts');
  return r as VersionReport;
}

export interface VersionReport {
  /** ISO instant this report was generated — the panel's "last checked". */
  checkedAt: string;
  /**
   * The server answering this request. `serverSha` is the newest commit touching
   * server-side code as of its build — the value the SPA's `expectedServerSha` is
   * compared against. Null on an unstamped build.
   */
  server: LayerBuild & { startedAt: string; serverSha: string | null };
  /** The SPA mounted by this server, or null when none is mounted. */
  web: WebLayer | null;
  /**
   * The host, from its authenticated link, or null when it has never
   * connected. RETAINED for the single-machine panel; `hosts` is the per-machine
   * truth now that an account has several.
   */
  daemon: (LayerBuild & { online: boolean }) | null;
  /**
   * Every registered machine and the build it is actually on (spec/11: "the
   * host layer can differ from host to host"). Reporting one `daemon` made
   * drift BETWEEN machines invisible — five hosts on one version and four on
   * another looked like universal agreement. A machine that has never reported
   * a build has nulls: unknown reads as unknown, never as "same as the rest".
   */
  hosts: {
    daemonId: string;
    hostName: string | null;
    online: boolean;
    version: string | null;
    gitSha: string | null;
    builtAt: string | null;
  }[];
  /** Newest desktop shell on the update feed, or null when nothing is published. */
  desktop: PublishedLayer | null;
  /** Newest Android build published for download, or null when nothing is published. */
  android: PublishedLayer | null;
  /** Every client that has connected and reported a build. */
  clients: ClientBuild[];
  /** Empty when every layer agrees. */
  drift: VersionDrift[];
}

export * from './events.js';
export * from './meeting.js';
// A chat's own history log, kept independently of any harness (spec/04 § History).
export * from './chatLog.js';
// Provider keys a host holds, set from Settings → Hosts (spec/02 § Provider keys).
export * from './provider-keys.js';
// Which permission modes each model can actually run in (spec/02 § Permission
// mode). Static, mirroring Claude Code's own denylist — see the module header.
export * from './modelCapabilities.js';
// Which of an account's rate-limit windows can actually stop work (spec/12) —
// one copy of the rule, because the host, the usage probe and every surface
// all render from it.
export * from './usageWindows.js';
export * from './codec.js';
export * from './cron-tz.js';
// The one natural-language renderer for a cron expression, shared by every
// surface that shows a schedule (spec/08 § Cron).
export * from './cron-describe.js';
// The one natural-language renderer for a recurrence trigger's RRULE, shared
// by every surface that shows one (spec/08 § Recurrence).
export * from './recurrence-describe.js';
export * from './background-task.js';
export * from './background-task-tracking.js';
export * from './goal-outcome.js';
// The Manager's Threads list — which chats it shows, needs-you first (spec/14
// § Manager view). Shared by the desktop strip and the phone's Chats tab.
export * from './thread-rows.js';
export * from './tool-runs.js';
export * from './chat-move.js';
export * from './sweep-prompt.js';
export * from './goal-prompt.js';
export { WireDecodeError } from './errors.js';

/**
 * Canonical chatId constants for the special threads (spec/06). Surfaces and
 * server-side ingress (voice-device hook) reference these instead of
 * stringly-typed literals so a typo can't silently mis-route.
 *
 * The host owns the *full* registration list (including thread_manager) in
 * `packages/daemon/src/specialThreads.ts`; only the externally-addressable
 * channels (speakers) need to be visible from server/surfaces.
 */
export const SPECIAL_THREAD_IDS = {
  manager: 'thread_manager',
  speakers: 'thread_speakers',
} as const;
export type SpecialThreadIdValue = (typeof SPECIAL_THREAD_IDS)[keyof typeof SPECIAL_THREAD_IDS];

/**
 * Threads whose web/mobile composer is disabled (spec/06 ## Composer policy):
 * Speakers is a read-only mirror. A human-typed `chat.input` from a
 * surface to one of these is rejected — surfaces must not be able to inject a
 * user turn that bypasses the channel's real ingress (voice device). Manager
 * is NOT read-only (its composer is fully enabled).
 */
export const READ_ONLY_MIRROR_THREAD_IDS: ReadonlySet<string> = new Set([
  SPECIAL_THREAD_IDS.speakers,
]);

/** True when `chatId` is a read-only mirror thread (Speakers). */
export function isReadOnlyMirrorThread(chatId: string): boolean {
  return READ_ONLY_MIRROR_THREAD_IDS.has(chatId);
}

/**
 * The reserved special threads (Manager / Speakers). These are
 * bootstrapped by the host and are part of the install's fixed structure —
 * they cannot be deleted from a surface (spec/14 & spec/15: the "Delete chat"
 * action is hidden for special threads). The server enforces this regardless
 * of the UI hiding the affordance.
 */
export const RESERVED_SPECIAL_THREAD_IDS: ReadonlySet<string> = new Set([
  SPECIAL_THREAD_IDS.manager,
  SPECIAL_THREAD_IDS.speakers,
]);

/** True when `chatId` is a reserved special thread that must not be deleted. */
export function isReservedSpecialThread(chatId: string): boolean {
  return RESERVED_SPECIAL_THREAD_IDS.has(chatId);
}

/**
 * The basename the host gives each special thread's working folder — it lays
 * them out as `<patch home>/threads/<name>` (spec/06 § Where special threads
 * run). Kept beside `SPECIAL_THREAD_IDS` rather than derived from it because
 * the chatId (`thread_manager`) and the folder name (`manager`) are different
 * strings.
 */
const SPECIAL_THREAD_FOLDER_BASENAMES: ReadonlySet<string> = new Set(['manager', 'speakers']);

/**
 * True when `folder` IS a special thread's working directory, judged by path
 * alone (spec/06 § Where special threads run, spec/04 § Folders).
 *
 * Needed as well as the chatId test (`isReservedSpecialThread`) because a
 * folder reaching a picker through the server's folder roster or a host's
 * published registry arrives as a bare path with no chat attached — path is
 * then the only thing there is to test.
 *
 * Needed as well as the dot-directory test in `isJunkFolder` because the patch
 * home these sit under is relocatable (`PATCH_HOME`, spec/02 § Stack): on an
 * ordinary install they are `~/.patch/threads/*` and the dot rule catches them,
 * but a relocated home gives `/daemon-home/threads/manager`, which has no dot
 * segment at all and is still patch's own bookkeeping.
 *
 * The match is the LAST TWO segments — `threads/<manager|speakers>` —
 * so a project of the user's own merely called `manager`, a directory called
 * `threads`, or something nested BELOW a thread dir is not one.
 */
export function isSpecialThreadFolder(folder: string): boolean {
  const segments = folder.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return false;
  return (
    segments[segments.length - 2] === 'threads' &&
    SPECIAL_THREAD_FOLDER_BASENAMES.has(segments[segments.length - 1] as string)
  );
}

/**
 * Recent-folder junk filter (spec/04 § Folders — "show only real user project
 * folders"). The recent/shortcut folder list is seeded from folders seen in
 * recent chats, which can include paths that are never user project roots —
 * throwaway scratch dirs and the host's own internal bookkeeping. Anything
 * matching this predicate is dropped from the picker's recent list, from every
 * dropdown built off that list, and from whatever those surfaces DEFAULT to: a
 * default is drawn from the same filtered set as the list it defaults within,
 * so nothing can be preselected that would not be offered.
 *
 * A folder is junk when it:
 *   - is a special thread's working dir by path (`isSpecialThreadFolder`) —
 *     Manager / Speakers, wherever the patch home happens to be;
 *   - has a dot-directory segment anywhere in its path (`.patch`, `.git`,
 *     `.cache`, …). On a default install this ALSO covers the thread dirs under
 *     `.patch/threads/*` — the source of the stray `/…/.patch/threads/manager`
 *     recent — but it stops covering them the moment `PATCH_HOME` moves, which
 *     is why the path test above is separate;
 *   - is a system scratch dir: `/tmp`, `/var/tmp`, `/private/tmp` (macOS), or
 *     `/var/folders/*` (macOS per-user temp).
 *
 * Explicit user-registered project roots are NOT run through this filter — they
 * are deliberate designations, not recents. Shared by the host registry and
 * the surface pickers so the rule is defined once. NO FALLBACK: this only
 * decides what the picker SHOWS; a stale/ad-hoc path still fails loudly on
 * spawn via the host's `folder exists` check.
 */
export function isJunkFolder(folder: string): boolean {
  if (!folder) return true;
  const segments = folder.split('/').filter((s) => s.length > 0);
  // Patch's own special-thread working dirs, wherever the patch home is.
  if (isSpecialThreadFolder(folder)) return true;
  // A dot-directory anywhere in the path.
  if (segments.some((s) => s.startsWith('.'))) return true;
  // System scratch roots.
  if (folder === '/tmp' || folder.startsWith('/tmp/')) return true;
  if (folder.startsWith('/var/tmp/') || folder.startsWith('/private/tmp/')) return true;
  if (folder === '/var/folders' || folder.startsWith('/var/folders/')) return true;
  return false;
}
/**
 * The display NAME of a folder — its basename (spec/14 § Sidebar, spec/15
 * § New chat flow: "Select a folder is too complex" → show the folder NAME, not
 * the whole absolute path). The full path stays available as muted secondary
 * text / a tooltip; this is only the primary label.
 *
 * Trailing slashes are ignored so `/home/tom/projects/portfolio/` and
 * `/home/tom/projects/portfolio` both read as `portfolio`. A root path (`/`) or
 * an empty string has no basename, so the original string is returned unchanged
 * rather than an empty label.
 */
export function folderName(folder: string): string {
  const segments = folder.split('/').filter((s) => s.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : folder;
}

/**
 * Disambiguating display LABELS for a whole list of folders (spec/14 § Sidebar →
 * Recent folders, spec/15 § New chat flow: "recent should just show the folder
 * NAME, with extra path only when it's needed to tell two apart"). Each label is
 * the folder's basename (`folderName`) when that basename is unique in the list;
 * when several folders share a basename (e.g. two different `portfolio`
 * checkouts) those labels — and ONLY those — grow leftward by the fewest parent
 * segments that make the group distinct, prefixed with `…/` to mark that the
 * path was trimmed (omitted when the shown segments already are the whole path).
 * Order and length match the input, so callers can map labels back positionally.
 * This is the single shared rule so the same folder reads identically in every
 * picker; `folderName` stays the single-folder primitive it builds on.
 */
export function folderLabels(folders: string[]): string[] {
  const segsOf = (f: string): string[] => f.split('/').filter((s) => s.length > 0);
  // Group input positions by the basename everyone starts from.
  const groups = new Map<string, number[]>();
  folders.forEach((f, i) => {
    const name = folderName(f);
    const g = groups.get(name);
    if (g) g.push(i);
    else groups.set(name, [i]);
  });
  const labels = folders.map((f) => folderName(f));
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue; // unique basename — the plain name is enough
    const segs = idxs.map((i) => segsOf(folders[i] as string));
    const maxLen = Math.max(...segs.map((s) => s.length));
    // Grow the shown suffix until every member of this group is distinct (or we
    // run out of segments — identical paths simply share a label).
    let k = 2;
    for (; k < maxLen; k++) {
      const shown = segs.map((s) => s.slice(-k).join('/'));
      if (new Set(shown).size === segs.length) break;
    }
    idxs.forEach((i, j) => {
      const s = segs[j] as string[];
      const shown = s.slice(-k);
      const trimmed = shown.length < s.length;
      labels[i] = (trimmed ? '…/' : '') + shown.join('/');
    });
  }
  return labels;
}

// Jobs canonical types are exported via the subpath import `@patch/wire/jobs`
// to avoid bloating the default surface.
export * from './pairing.js';
