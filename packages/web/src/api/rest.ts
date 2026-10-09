// Thin REST client. Bearer credential threaded from the credential store.
// NO FALLBACK: every non-2xx surfaces as a thrown ApiError so the caller (or
// React Query's error path) can show a red banner.

import type {
  AccountStrategy,
  AttachmentRef,
  AuthOkHost,
  BackgroundTaskStat,
  ChatSearchResponse,
  DocAction,
  DocView,
  PermissionMode,
  ProviderKeyId,
  SettingsChangedEvent,
  SharedSettings,
  TodoItem,
  WatchTaskRow,
} from '@patch/wire';
import type { Hook, HookCreateBody, HookPatchBody, HookCheckResponse } from '@patch/wire/hooks';
import { assertVersionReport } from '@patch/wire';
import { loadCredential } from '../lib/credential.js';
import { hookImages } from '../lib/hookImages.js';
import type { OutgoingFile } from '../lib/sendQueue.js';

/** The backends whose accounts are shared settings. */
export type SharedBackendId = 'claude-code' | 'codex';

/** An uploaded attachment: the wire ref plus the relative URL to render it inline. */
export type UploadedAttachment = AttachmentRef & { url: string };

/** One chat row as the server serves it, from the roster or by id. */
export interface ChatSummaryRow {
  chatId: string;
  name: string | null;
  preview: string | null;
  goal: string | null;
  reminder: string | null;
  pendingWake: { message: string; fireAt: number; notAfter?: number; every?: number } | null;
  /** The chat's task list (spec/02 § Task list); empty until the agent writes one. */
  todos: TodoItem[];
  /** The host this chat lives on (spec/04 § Chat model). */
  daemonId: string;
  folder: string;
  activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
  permissionMode: PermissionMode;
  status: 'active' | 'archived' | 'errored';
  pinned: boolean;
  pinnedAt: number | null;
  /** A special thread turned off (spec/06 § Disabled). `false` for ordinary chats. */
  disabled: boolean;
  lastUpdated: number;
  /**
   * ms epoch of the user's own last activity on this chat (spec/14 § Sidebar
   * ordering) — what sidebar ordering sorts by instead of `lastUpdated`.
   * Optional because an older server does not send it; the store falls back
   * to `lastUpdated`.
   */
  lastUserActivity?: number;
  /** The job whose `spawn` action created this chat, or null (spec/08 § Action). */
  jobId: string | null;
  /**
   * How many of this chat's backgrounded commands and sub-agents are still
   * running (spec/02 § Background task completions). `null` is UNKNOWN — a host
   * whose host does not track them — and is never read as zero.
   *
   * Optional because an older SERVER does not send the field at all, and a
   * missing key must read the same as an unknown count rather than throwing the
   * whole cold-start roster away.
   */
  backgroundTasks?: number | null;
  /**
   * Running out of the active list (spec/04 § Hidden). Optional because an
   * older server does not send it; absent keeps whatever the store knows.
   */
  hidden?: boolean;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface RequestInit2 extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Page size + cursor for a sidebar lifecycle list (spec/14 § Sidebar item 6:
 * "load a limited number... then load more on scroll"). Omitted `limit`
 * fetches the whole list in one call, as every caller did before pagination —
 * only the Sidebar/LifecycleRoute sections pass one.
 */
export interface LifecyclePageOpts {
  limit?: number;
  offset?: number;
}

/** A lifecycle list response: the page's rows, plus the next page's `offset` (`null` once nothing is left). */
export interface LifecycleListResponse {
  chats: Array<unknown>;
  nextOffset: number | null;
}

function pageParams(opts: LifecyclePageOpts): string {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  const s = params.toString();
  return s === '' ? '' : `&${s}`;
}

const HOOK_CHECK_TIMEOUT_MS = 20_000;

async function request<T>(path: string, init: RequestInit2 = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const cred = loadCredential();
  if (cred) headers.set('authorization', `Bearer ${cred}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(path, {
    ...init,
    headers,
    body: init.body === undefined ? null : JSON.stringify(init.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    // A 401 means the credential this surface holds is not one the server will
    // accept — revoked, or minted for an account that no longer exists. Holding
    // on to it traps the app: the boot gate only asks whether a credential is
    // PRESENT, so a rejected one still renders the full shell, every request
    // fails, and the error bar blinks forever with no route back to sign-in.
    // Announce it once so the shell can drop it and show the sign-in screen.
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('patch:credential-rejected', { detail: errMsg }));
    }
    throw new ApiError(res.status, errMsg, parsed);
  }
  return parsed as T;
}

/**
 * The shared settings (spec/01 § Settings): held on the server, sent to every
 * host, and the same on every surface.
 */
export type AccountPreferences = SharedSettings;

/** What a settings write answers with: the committed shared state. */
export type SharedState = Omit<SettingsChangedEvent, 'type'>;

export type VoiceBackend = 'local' | 'gemini' | 'openai';
export type VoiceLayer = 'direct' | 'light' | 'heavy';
export type VoiceHandoff = 'auto' | 'always' | 'never';
export interface VoiceSurfaceConfig {
  backend: VoiceBackend;
  layer: VoiceLayer;
  handoff: VoiceHandoff;
}

/** One Pad as the server serves it (spec/14 § Pads). */
export interface PadScreen {
  id: string;
  name: string;
  path: string;
  /** The width a captured screen was photographed at. */
  width?: number;
  /** Pending changes on this screen. */
  pending: number;
  thumbUrl: string | null;
}
export interface PadView {
  id: string;
  name: string;
  /** The app the Pad designs for ('Patch', 'Dog Log'…), or null for a blank one. */
  app: string | null;
  chatId: string;
  device: 'desktop' | 'phone';
  createdAt: number;
  updatedAt: number;
  pending: number;
  /** A batch was sent and the agent has not replied yet. */
  working: boolean;
  screens: PadScreen[];
  screensError: string | null;
  /** Signed, iframe-able URL of the editor. */
  frameUrl: string;
  thumbUrl: string | null;
  thumbError: string | null;
}
export interface PadLibraryScreen {
  padId: string;
  screenId: string;
  name: string;
  thumbUrl: string | null;
  device: 'desktop' | 'phone';
}
export interface PadCreateBody {
  name: string;
  app?: string;
  device: 'desktop' | 'phone';
  chatId: string;
  /** Screens captured from the live app: each one self-contained HTML. */
  screens?: { name: string; html: string; width?: number }[];
  /** Screens of earlier Pads to start from. */
  from?: { padId: string; screenId: string }[];
}

export const api = {
  listPads: () => request<{ pads: PadView[] }>('/api/pads'),
  padLibrary: () =>
    request<{ apps: { app: string; screens: PadLibraryScreen[] }[] }>('/api/pads/library'),
  getPad: (id: string) => request<PadView>(`/api/pads/${encodeURIComponent(id)}`),
  createPad: (body: PadCreateBody) => request<PadView>('/api/pads', { method: 'POST', body }),
  addPadScreens: (id: string, screens: { name: string; html: string; width?: number }[]) =>
    request<PadView>(`/api/pads/${encodeURIComponent(id)}/screens`, {
      method: 'POST',
      body: { screens },
    }),
  patchPad: (id: string, body: { name?: string; device?: 'desktop' | 'phone' }) =>
    request<PadView>(`/api/pads/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deletePad: (id: string) =>
    request<null>(`/api/pads/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Build/health of the server this surface is actually talking to. Surfaced in
  // Settings so a stale deploy (old gitSha) or unexpected origin is obvious at a
  // glance — a build can never silently masquerade as current (spec/14 § Build).
  healthz: () => request<{ ok: boolean; version: string; gitSha: string }>('/api/healthz'),
  // Provenance of every layer (server, host, deployed SPA, published desktop
  // shell + APK, and each linked device) plus any drift between them. Backs the
  // "Version & updates" panel — spec/11 § Version reporting.
  // Validated at the boundary: a partial report must reach the panel's error state,
  // not render as "all layers agree".
  version: async () => assertVersionReport(await request<unknown>('/api/version')),
  me: () =>
    request<{
      account: { accountId: string; userPublicKey: string; createdAt: number };
      // The server resolves this from the registry by the bearer's surfaceId.
      // It can legitimately be absent (Fastify omits an `undefined` value) — e.g.
      // a freshly minted credential whose surface the running server hasn't
      // reloaded yet — so it is optional and every read must chain through it.
      surface?: {
        surfaceId: string;
        surfaceKind: string;
        label: string;
        issuedAt: number;
      };
    }>('/api/auth/me'),
  createChat: (body: {
    /**
     * The host to run on. Required — the same folder string on two machines is
     * two different directories, so a spawn without a host has nowhere correct
     * to go (spec/04 § Spawn).
     */
    daemonId: string;
    folder: string;
    prompt?: string;
    name?: string;
    localId?: string;
    /**
     * From the NAMED host's catalogue. Omitted, the chat takes that host's
     * last-used model (spec/04 § Spawn) — resolved on the host, not here.
     */
    model?: string;
    /** The shared account the chat's turns start on (spec/10 — preferred account). */
    preferredAccountId?: string;
  }) =>
    request<{ chatId: string; folder: string; status: 'pending' }>('/api/chats', {
      method: 'POST',
      body,
    }),
  // Recoverable soft-delete (spec/04 § Lifecycle): the chat moves to the
  // sidebar's Deleted section and can be restored. NOT a hard removal.
  deleteChat: (chatId: string) =>
    request<{ ok: true }>(`/api/chats/${chatId}`, { method: 'DELETE' }),
  restoreChat: (chatId: string) =>
    request<{ ok: true }>(`/api/chats/${chatId}/restore`, { method: 'POST' }),
  listChatsDeleted: (opts: LifecyclePageOpts = {}) =>
    request<LifecycleListResponse>(`/api/chats?deleted=only${pageParams(opts)}`),
  // spec/04 § Snooze — the sidebar's Snoozed section. Snoozed chats are absent
  // from the default active snapshot, so the section loads them on expand.
  listChatsSnoozed: (opts: LifecyclePageOpts = {}) =>
    request<LifecycleListResponse>(`/api/chats?snoozed=only${pageParams(opts)}`),
  // spec/04 § Hidden — the sidebar's Hidden section. Hidden chats are absent
  // from the default active snapshot, so the section loads them on expand.
  // `order=asc` pages oldest-first, matching the section's own FIFO display
  // (`web/src/lib/chatGroups.ts`), so a scroll-triggered page lands at the
  // bottom of the list instead of splicing into what's already on screen.
  listChatsHidden: (opts: LifecyclePageOpts = {}) =>
    request<LifecycleListResponse>(`/api/chats?hidden=only&order=asc${pageParams(opts)}`),
  listChats: () => request<{ chats: ChatSummaryRow[] }>('/api/chats'),
  // `archived=only`, not `archived=include`: the section only ever draws the
  // `status === 'archived'` rows (`web/src/lib/chatGroups.ts`), and the
  // cold-start `GET /api/chats` already holds every active chat — paging a
  // merged active+archived list by recency would mean a page of mostly-active
  // rows could show no archived chats at all until several scroll-loads in.
  listChatsArchived: (opts: LifecyclePageOpts = {}) =>
    request<LifecycleListResponse>(`/api/chats?archived=only${pageParams(opts)}`),
  // Global chat search (spec/03 § Chat search): names and full transcript text
  // across every chat on every host. The caller trims and enforces
  // CHAT_SEARCH_MIN_QUERY first — the server answers a shorter query with 400.
  searchChats: (
    q: string,
    opts: { limit?: number; offset?: number; fullText?: boolean; signal?: AbortSignal } = {},
  ) => {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts.fullText !== undefined) params.set('fullText', String(opts.fullText));
    return request<ChatSearchResponse>(
      `/api/chats/search?${params.toString()}`,
      opts.signal === undefined ? {} : { signal: opts.signal },
    );
  },
  // One chat by id, whatever lifecycle section it sits in. `listChats()` is
  // deliberately the ACTIVE inbox only, so a chat reached by URL — archived,
  // snoozed or deleted, or spawned elsewhere since this surface's roster loaded
  // — is absent from that snapshot while very much existing. Asking for the
  // single row is what tells "not in the active snapshot" apart from "no such
  // chat": the latter is a 404, not an empty result.
  getChat: (chatId: string) => request<ChatSummaryRow>(`/api/chats/${chatId}`),
  // The folder roster (spec/04 § Folders → Folder roster) — one row per folder
  // that has a non-deleted chat, ARCHIVED INCLUDED. Backs the sidebar's Recent
  // projects and the new-chat picker's recents, both of which must still offer
  // a folder whose chats are all archived. Deliberately not derived from
  // `listChats()`, which excludes archived; and O(folders), so it stays small
  // however many archived chats pile up.
  listChatFolders: () =>
    request<{ folders: Array<{ folder: string; daemonId: string; lastUpdated: number }> }>(
      '/api/chats/folders',
    ),
  // spec/14 § Sidebar — Automations: every spawn-fired chat, wherever else it
  // also sits (active/archived/snoozed) — an additional view, not a mover.
  // `order=asc`: same FIFO-oldest-first pagination rationale as Hidden above.
  listChatsAutomations: (opts: LifecyclePageOpts = {}) =>
    request<LifecycleListResponse>(`/api/chats?automations=only&order=asc${pageParams(opts)}`),
  // Section counts (spec/04 § Section counts) — the size of each collapsed
  // lifecycle section, carrying no rows. Deliberately not derived from the
  // list calls above: those are exactly the unbounded fetches a collapsed
  // section exists to avoid, and the point is knowing the size WITHOUT paying
  // for them.
  chatSectionCounts: () =>
    request<{
      hidden: number;
      archived: number;
      snoozed: number;
      deleted: number;
      automations: number;
    }>('/api/chats/counts'),
  listJobs: () => request<{ jobs: unknown[] }>('/api/jobs'),
  getJob: (id: string) => request<unknown>(`/api/jobs/${id}`),
  createJob: (body: unknown) => request<unknown>('/api/jobs', { method: 'POST', body }),
  patchJob: (id: string, body: unknown) =>
    request<unknown>(`/api/jobs/${id}`, { method: 'PATCH', body }),
  deleteJob: (id: string) => request<unknown>(`/api/jobs/${id}`, { method: 'DELETE' }),
  listHooks: () => request<{ hooks: Hook[] }>('/api/hooks'),
  getHook: (id: string) => request<Hook>(`/api/hooks/${id}`),
  createHook: (body: HookCreateBody) => request<Hook>('/api/hooks', { method: 'POST', body }),
  patchHook: (id: string, body: HookPatchBody) =>
    request<Hook>(`/api/hooks/${id}`, { method: 'PATCH', body }),
  deleteHook: (id: string) => request<void>(`/api/hooks/${id}`, { method: 'DELETE' }),
  enableHook: (id: string) => request<Hook>(`/api/hooks/${id}/enable`, { method: 'POST' }),
  disableHook: (id: string) => request<Hook>(`/api/hooks/${id}/disable`, { method: 'POST' }),
  /** spec/20-hooks.md § Checking a message — called by the composer before send. */
  checkHooks: async (
    chatId: string,
    message: string,
    files: OutgoingFile[] = [],
  ): Promise<HookCheckResponse> => {
    // A hook check never stops a send (spec/20-hooks.md § On the user's
    // message): when the check itself can't be completed, the message goes out
    // and the reason rides on it as a failed-hook note.
    const unchecked = (error: string): HookCheckResponse => ({
      decision: 'advise',
      results: [
        { hookId: 'hook-check', hookName: 'Hook check', status: 'failed', error, durationMs: 0 },
      ],
    });
    let prepared;
    try {
      prepared = await hookImages(files);
    } catch (err) {
      return unchecked((err as Error).message);
    }
    const { images, skipped } = prepared;
    // Bounded client-side: a stalled connection must not leave the composer on
    // Checking… forever. The server's own per-hook timeouts sit well inside this.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HOOK_CHECK_TIMEOUT_MS);
    try {
      const res = await request<HookCheckResponse>('/api/hooks/check', {
        method: 'POST',
        body: { chatId, message, ...(images.length > 0 ? { images } : {}) },
        signal: ctrl.signal,
      });
      if (skipped.length === 0) return res;
      const note = unchecked(skipped.join('; ')).results;
      return {
        decision: res.decision === 'block' ? 'block' : 'advise',
        results: [...res.results, ...note],
      };
    } catch (err) {
      if (ctrl.signal.aborted) return unchecked('timed out waiting for hooks');
      if (err instanceof ApiError && [502, 503, 504].includes(err.status)) {
        return unchecked(`Patch server unreachable (HTTP ${err.status}) — it may be restarting`);
      }
      return unchecked((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  },
  jobRuns: (id: string, limit = 5) =>
    request<{
      runs: Array<{
        ts: number;
        jobId: string;
        status:
          | 'ok'
          | 'filter-rejected'
          | 'filter-error'
          | 'dispatch-error'
          | 'buffered'
          | 'queued'
          | 'slot-timeout'
          | 'chat-error'
          // The two ways a job's gate stops a fire (spec/08 § Gate). Separate
          // statuses because only one of them is news: held is the gate working,
          // error is the gate broken.
          | 'gate-held'
          | 'gate-error';
        trigger: 'cron' | 'recurrence' | 'webhook' | 'todoist' | 'manual';
        error?: string;
        action?: {
          type: 'spawn' | 'message' | 'continue' | 'script';
          chatId?: string;
          folder?: string;
          // `script` fires only: a command has no chat to open and read, so its
          // exit code and output tail ARE the record of what it did (@patch/wire
          // `ScriptAction`). Absent on every other action type — which is not
          // the same as `exitCode: null`, the code a KILLED command reports.
          exitCode?: number | null;
          output?: string;
        };
      }>;
    }>(`/api/jobs/${id}/runs?limit=${limit}`),
  // The concurrency gate's queue for one job (spec/08 § Concurrency): what it
  // is running now and what is waiting behind its limit.
  jobQueue: (id: string) =>
    request<{
      /** null when the job has no limit, in which case nothing can queue. */
      concurrency: number | null;
      inFlight: Array<{
        chatId: string;
        localId: string;
        startedAt: number;
        trigger: 'cron' | 'recurrence' | 'webhook' | 'todoist' | 'manual';
        actionType: 'spawn' | 'message' | 'continue';
        daemonId: string | null;
        folder?: string;
      }>;
      queued: Array<{
        fireId: string;
        queuedAt: number;
        chatId: string;
        trigger: 'cron' | 'recurrence' | 'webhook' | 'todoist' | 'manual';
        actionType: 'spawn' | 'message' | 'continue';
        daemonId: string | null;
        folder?: string;
      }>;
    }>(`/api/jobs/${id}/queue`),
  enableJob: (id: string) => request<unknown>(`/api/jobs/${id}/enable`, { method: 'POST' }),
  disableJob: (id: string) => request<unknown>(`/api/jobs/${id}/disable`, { method: 'POST' }),
  // POST /api/jobs/:id/run (spec/08 ## Manual run) — fires the job's action
  // once, immediately, outside its normal trigger.
  // `draft` fires that unsaved patch body instead of the saved job.
  runJob: (id: string, draft?: unknown) =>
    request<{ status: 'sent' | 'buffered' | 'queued'; fireId: string }>(`/api/jobs/${id}/run`, {
      method: 'POST',
      ...(draft !== undefined ? { body: { draft } } : {}),
    }),
  // POST /api/jobs/recurrence/translate (spec/08 § Recurrence) — the job
  // editor's natural-language schedule input. Round-trips to the named
  // host's one-shot Claude call; the server has already re-validated the
  // rrule and re-described it before this ever resolves, so `description`
  // is safe to show as the confirmation preview verbatim.
  translateRecurrenceRule: (daemonId: string, phrase: string) =>
    request<{ rrule: string; description: string }>('/api/jobs/recurrence/translate', {
      method: 'POST',
      body: { daemonId, phrase },
    }),
  // spec/04 § Moving a chat to another host — resolves once the chat is running
  // there; every refusal is an ApiError whose body carries the reason.
  moveChat: (chatId: string, daemonId: string, folder: string) =>
    request<{ ok: true; chatId: string; daemonId: string; folder: string }>(
      `/api/chats/${chatId}/move`,
      { method: 'POST', body: { daemonId, folder } },
    ),
  archiveChat: (chatId: string, archived: boolean) =>
    request<unknown>(`/api/chats/${chatId}/archive`, {
      method: 'POST',
      body: { archived },
    }),
  // spec/06 § Disabled — the special-thread "off" switch archive is refused for.
  disableChat: (chatId: string, disabled: boolean) =>
    request<unknown>(`/api/chats/${chatId}/disable`, {
      method: 'POST',
      body: { disabled },
    }),
  // spec/06 § Session rotation — manual trigger for a reserved special
  // thread: retire its Claude session and start fresh, seeded with a handoff
  // digest. Refused server-side for anything that isn't Manager/Speakers.
  rotateChat: (chatId: string) =>
    request<{ ok: true }>(`/api/chats/${chatId}/rotate`, { method: 'POST' }),
  // spec/04 § Snooze — `snoozedUntil` is an ABSOLUTE ms epoch (the preset is
  // resolved here so a slow request can't drift the wake time); null unsnoozes.
  snoozeChat: (chatId: string, snoozedUntil: number | null) =>
    request<unknown>(`/api/chats/${chatId}/snooze`, {
      method: 'POST',
      body: { snoozedUntil },
    }),
  // spec/04 § Hidden — `hidden: false` is Show: the chat moves into the active
  // list without anything being sent to it.
  hideChat: (chatId: string, hidden: boolean) =>
    request<unknown>(`/api/chats/${chatId}/hide`, {
      method: 'POST',
      body: { hidden },
    }),
  pinChat: (chatId: string, pinned: boolean) =>
    request<unknown>(`/api/chats/${chatId}/pin`, {
      method: 'POST',
      body: { pinned },
    }),
  // spec/04 § Name — rename: a null clears the name back to the derived label.
  renameChat: (chatId: string, name: string | null) =>
    request<unknown>(`/api/chats/${chatId}/rename`, {
      method: 'POST',
      body: { name },
    }),
  // patch/todo.md — `/goal`: set (or clear, with null) the chat's goal.
  setGoal: (chatId: string, goal: string | null) =>
    request<unknown>(`/api/chats/${chatId}/goal`, {
      method: 'POST',
      body: { goal },
    }),
  // spec/02 § Task list — replace the chat's task list with `todos` (the WHOLE
  // list, not a delta). The host adopts it and tells the agent on its next turn.
  setTodos: (chatId: string, todos: TodoItem[]) =>
    request<unknown>(`/api/chats/${chatId}/todos`, {
      method: 'POST',
      body: { todos },
    }),
  // patch/todo.md — Reminders: set (or clear, with null) the chat's reminder.
  setReminder: (chatId: string, reminder: string | null) =>
    request<unknown>(`/api/chats/${chatId}/reminder`, {
      method: 'POST',
      body: { reminder },
    }),
  // spec/14 § Side threads panel — pulls a side thread's own track (a side
  // branch's content is not broadcast live, spec/04 § Parallel branches).
  getChatHistory: (chatId: string, opts: { branchId: string }) =>
    request<{ events: Array<Record<string, unknown>>; nextFromSeq?: number }>(
      `/api/chats/${chatId}/history?branchId=${encodeURIComponent(opts.branchId)}`,
    ),
  // spec/14 § Main chat panel — Delegate tool row: the parent tool row's
  // "Open transcript" action. A subagent is never in the chat registry
  // (spec/02 § Native subagent dispatch), so this reads its history through
  // the PARENT instead of the ordinary /api/chats/:id/history route.
  getDelegateHistory: (parentId: string, delegateId: string) =>
    request<{ events: Array<Record<string, unknown>>; nextFromSeq?: number }>(
      `/api/chats/${parentId}/delegates/${delegateId}/history`,
    ),
  // 02-daemon.md § Self-wake — `/loop <interval> <message>`: arm (or, with
  // `null`, cancel) a recurring self-wake from the composer, reaching the same
  // scheduler `patch_loop` reaches. `every` is a duration string ("10m", "1h30m",
  // seconds), the same grammar `patch_wake_me`'s `in` accepts.
  setLoop: (
    chatId: string,
    loop: { message: string; every: string | number; notAfter?: string } | null,
  ) =>
    request<unknown>(`/api/chats/${chatId}/loop`, {
      method: 'POST',
      body: { loop },
    }),
  // POST /api/voice/token (spec/07, server voice/token.ts) — mints a one-shot
  // HMAC voice-session token bound to (this surface, chatId). The body is
  // `.strict {chatId, role, surfaceKind}`; the web surface is always `web`.
  // Returns the raw `token` (presented in the host audio WSS session_start
  // frame), the `sessionId`, the relative `audioUrl` (`/audio/<sessionId>`),
  // and the token expiry.
  voiceToken: (chatId: string, role: 'voice-note' | 'voice-call' | 'voice-device-conv') =>
    request<{ token: string; sessionId: string; audioUrl: string; expiresAt: number }>(
      '/api/voice/token',
      {
        method: 'POST',
        body: { chatId, role, surfaceKind: 'web' },
      },
    ),
  // POST /api/voice/note — upload a recorded voice-note clip (multipart:
  // `chatId` + `audio` wav, plus `prefix` — text already typed into the composer
  // the note was started from) the same way mobile does. The server hands the
  // clip to the host (the Whisper owner), injects `prefix` + transcript as the
  // chat's next user turn (`source: { kind: 'voice-app', surfaceKind: 'web' }`),
  // and returns `{ ok, transcript, text }` — `text` being the turn as injected.
  // The caller echoes `text` into the timeline — the RELIABLE path (no dependency
  // on the host streaming a live `audio.transcript_final` over the flaky audio
  // WSS). Any non-2xx throws.
  voiceNote: async (
    chatId: string,
    clip: Blob,
    prefix: string,
  ): Promise<{ ok: true; transcript: string; text: string }> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const form = new FormData();
    form.append('chatId', chatId);
    form.append('surfaceKind', 'web');
    form.append('prefix', prefix);
    form.append('audio', clip, 'voice-note.wav');
    const res = await fetch('/api/voice/note', { method: 'POST', headers, body: form });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, errMsg, parsed);
    }
    return parsed as { ok: true; transcript: string; text: string };
  },
  // POST /api/voice/transcribe — transcribe a recorded clip WITHOUT injecting it
  // as a chat turn. Used by the composer mic (live-transcribe-into-the-input):
  // the recognised text lands in the composer for the user to edit before they
  // send it themselves, so the turn must NOT be submitted server-side. Any
  // non-2xx throws.
  voiceTranscribe: async (clip: Blob): Promise<{ ok: true; transcript: string }> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const form = new FormData();
    form.append('surfaceKind', 'web');
    form.append('audio', clip, 'voice.wav');
    const res = await fetch('/api/voice/transcribe', { method: 'POST', headers, body: form });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, errMsg, parsed);
    }
    return parsed as { ok: true; transcript: string };
  },
  pushRegister: (token: string, platform: string) =>
    request<unknown>('/api/auth/push/register', {
      method: 'POST',
      body: { token, platform },
    }),
  // Revoke the current surface (self, no id) or a specific surface/daemon id.
  revoke: (id?: string) =>
    request<{ ok: true }>('/api/auth/revoke', {
      method: 'POST',
      ...(id ? { body: { id } } : {}),
    }),
  settings: () =>
    request<{
      account: { accountId: string; userPublicKey: string; createdAt: number } | null;
      devices: Array<{
        surfaceId: string;
        surfaceKind: string;
        label: string;
        issuedAt: number;
        status: 'online' | 'stale' | 'offline';
        lastHeartbeat: number | null;
        isCurrent: boolean;
      }>;
      push: { tokenCount: number };
      daemon: {
        registered: boolean;
        status: 'online' | 'offline';
        lastConnectedAt: number | null;
      };
      // Configurable project-launch folders (Settings → Project folders).
      projectFolders: string[];
      // The shared settings (spec/01 § Settings).
      preferences: AccountPreferences;
      /** Secrets as source and last four only, and each host's applied version. */
      shared?: Omit<SharedState, 'settings'>;
    }>('/api/settings'),
  // PATCH /api/settings — write the account-wide preferences. Partial body.
  setPreferences: (patch: Partial<AccountPreferences>) =>
    request<{ preferences: AccountPreferences }>('/api/settings', {
      method: 'PATCH',
      body: patch,
    }),
  // spec/01 § Settings — every write below is committed on the server and
  // answered with the committed shared state; hosts get it from the snapshot.
  sharedSettings: () => request<SharedState>('/api/settings/shared'),
  setProviderKey: (keyId: ProviderKeyId, value: string) =>
    request<SharedState>(`/api/providers/keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT',
      body: { value },
    }),
  revokeProviderKey: (keyId: ProviderKeyId) =>
    request<SharedState>(`/api/providers/keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
    }),
  adoptProviderKey: (keyId: ProviderKeyId, daemonId: string) =>
    request<SharedState>(`/api/providers/keys/${encodeURIComponent(keyId)}/adopt`, {
      method: 'POST',
      body: { daemonId },
    }),
  addAccount: (
    backendId: SharedBackendId,
    body: { token?: string; apiKey?: string; label?: string },
  ) => request<SharedState>(`/api/accounts/${backendId}`, { method: 'POST', body }),
  updateAccount: (
    backendId: SharedBackendId,
    accountId: string,
    body: { token?: string; label?: string },
  ) =>
    request<SharedState>(`/api/accounts/${backendId}/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      body,
    }),
  disconnectAccount: (backendId: SharedBackendId, accountId: string) =>
    request<SharedState>(`/api/accounts/${backendId}/${encodeURIComponent(accountId)}/disconnect`, {
      method: 'POST',
    }),
  removeAccount: (backendId: SharedBackendId, accountId: string) =>
    request<SharedState>(`/api/accounts/${backendId}/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    }),
  orderAccounts: (backendId: SharedBackendId, accountIds: string[]) =>
    request<SharedState>(`/api/accounts/${backendId}/order`, {
      method: 'PUT',
      body: { accountIds },
    }),
  setAccountStrategy: (backendId: SharedBackendId, strategy: AccountStrategy) =>
    request<SharedState>(`/api/accounts/${backendId}/strategy`, {
      method: 'PUT',
      body: { strategy },
    }),
  adoptAccount: (backendId: SharedBackendId, daemonId: string) =>
    request<SharedState>(`/api/accounts/${backendId}/adopt`, {
      method: 'POST',
      body: { daemonId },
    }),
  adoptClaudeSettings: (daemonId: string, target: 'shared' | 'darwin' | 'linux') =>
    request<SharedState>('/api/settings/claude/adopt', {
      method: 'POST',
      body: { daemonId, target },
    }),
  // Remove a host from the account (Settings → Hosts → "Remove this host").
  // Revokes its credential so it cannot reconnect without pairing again. Every
  // connected surface (this one included) is also sent `host.removed
  // {daemonId}` and should drop the host from its list; the answer carries the
  // remaining roster. 404 `unknown_host` for an id the account does not hold.
  removeHost: (daemonId: string) =>
    request<{ ok: true; hosts: AuthOkHost[] }>(`/api/hosts/${encodeURIComponent(daemonId)}`, {
      method: 'DELETE',
    }),
  // The account's secrets (spec/15 § Settings tab — Secrets). The host owns
  // the store and injects the values into chats; the server serves its
  // published mirror and round-trips writes to the host (PUT upserts one,
  // DELETE removes one; 504 `daemon_timeout` when the host does not answer).
  listSecrets: () => request<{ secrets: Array<{ key: string; value: string }> }>('/api/secrets'),
  setSecret: (key: string, value: string) =>
    request<{ ok: true }>(`/api/secrets/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { value },
    }),
  deleteSecret: (key: string) =>
    request<{ ok: true }>(`/api/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  // PUT /api/auth/folders — replace the account's configured launch-folder list.
  setProjectFolders: (folders: string[]) =>
    request<{ folders: string[] }>('/api/auth/folders', {
      method: 'PUT',
      body: { folders },
    }),
  // spec/10 § Surface linking: mint a single-use surface-pairing nonce for the
  // "Link a device" QR the new surface (phone) scans. Any linked surface can
  // link another, so this is available from desktop.
  // GET /api/relay — whether this server is reachable through a relay (spec/10 § Relay).
  relay: () =>
    request<
      | { enabled: false }
      | {
          enabled: true;
          url: string;
          channel: string;
          serverKey: string;
          connected: boolean;
          sessions: number;
          lastError: string | null;
        }
    >('/api/relay'),
  surfacePairStart: () =>
    request<{ nonce: string; expiresAt: number; uri?: string }>('/api/auth/pair/start', {
      method: 'POST',
    }),
  // spec/14 `/settings` add-daemon QR: mint a genuine, single-use,
  // server-issued daemon-registration nonce for the QR the host scans.
  daemonPairStart: () =>
    request<{ nonce: string; expiresAt: number }>('/api/auth/daemon/pair/start', {
      method: 'POST',
    }),
  // Group 19: file browser
  //
  // Editor overhaul: the file tree is now hierarchical (expand/collapse at
  // any depth) instead of one directory at a time, so this recursive walk is
  // the tree's ONLY data source — `listFiles(chatId, path)` (single-directory
  // listing + breadcrumb navigation) is gone, and with it the `['files',
  // chatId, path]` query and the whole "current directory" concept. Entries
  // carry `dirty` too now (the host computes it the same way the old
  // per-directory listing did), so the pending-dot marker works at any depth.
  listFilesRecursive: (chatId: string, maxEntries = 5000) =>
    request<{
      entries: Array<{ name: string; type: 'file' | 'dir'; dirty?: boolean }>;
    }>(`/api/chats/${chatId}/files?recursive=1&maxEntries=${maxEntries}`),
  getFileContent: (chatId: string, path: string) =>
    request<{ path: string; content: string; size: number }>(
      `/api/chats/${chatId}/files?path=${encodeURIComponent(path)}&content=1`,
    ),
  // The file browser's create / rename / delete (spec/14 § File browser). One
  // call per operation, and it is awaited: these destroy or move real files, so
  // the tree is only refreshed once the host says what happened. A rejection
  // throws with the host's own reason.
  fileOp: (
    chatId: string,
    body: { op: 'create' | 'create_dir' | 'delete' | 'rename'; path: string; to?: string },
  ) => request<{ path: string }>(`/api/chats/${chatId}/files`, { method: 'POST', body }),
  // G3: git HEAD blob for "view diff vs HEAD". Untracked files → empty content.
  getFileContentAtHead: (chatId: string, path: string) =>
    request<{ path: string; content: string; size: number }>(
      `/api/chats/${chatId}/files?path=${encodeURIComponent(path)}&content=1&ref=head`,
    ),
  // Editor overhaul (binary preview): the RAW bytes of a file (images, PDF),
  // as a Blob, for the file browser's `<img>`/`<embed>` preview. `request()`
  // always JSON-parses, so this is its own small fetch — same bearer-header
  // auth, same ApiError-on-non-2xx contract, but the body is read as a Blob
  // (real bytes) instead of text. The caller builds an object URL from the
  // Blob and points the preview element at that — a plain `<img src>` can't
  // carry the Authorization header this route requires.
  getFileRawBlob: async (chatId: string, path: string): Promise<Blob> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const res = await fetch(`/api/chats/${chatId}/files/raw?path=${encodeURIComponent(path)}`, {
      headers,
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, errMsg, parsed);
    }
    return res.blob();
  },
  // spec/14 § Document editor, step 2 of 3 — mode, suggestions, threads,
  // versions for one `.md` file.
  getDoc: (chatId: string, path: string) =>
    request<DocView>(`/api/chats/${chatId}/doc?path=${encodeURIComponent(path)}`),
  // Every mode switch, accept/reject (one or all), comment/reply/resolve and
  // restore goes through this one call — the host returns the updated view
  // so the caller never needs a second fetch to see what it just did.
  docAction: (chatId: string, path: string, action: DocAction) =>
    request<DocView>(`/api/chats/${chatId}/doc/action`, { method: 'POST', body: { path, action } }),
  // spec/14 § Document editor, step 3 of 3 — opening a `.docx` converts it to
  // the `.md` the editor actually opens. `warnings` names anything the
  // conversion couldn't carry over, for the open-time banner.
  convertDocx: (chatId: string, path: string) =>
    request<{ mdPath: string; warnings: string[]; reused: boolean }>(
      `/api/chats/${chatId}/doc/convert`,
      { method: 'POST', body: { path } },
    ),
  // Download/Save as .docx, .pdf or .md from the editor's menu, and the
  // agent's `patch_doc_export` tool's web-side twin. The server also writes
  // the file beside the `.md` on the chat's host — this just hands back the
  // same bytes for a real browser download. NO FALLBACK: a non-2xx throws
  // with the host's own reason (same shape `getFileRawBlob` surfaces).
  exportDoc: async (
    chatId: string,
    path: string,
    format: 'docx' | 'pdf' | 'md',
  ): Promise<{ blob: Blob; filename: string; warnings: string[] }> => {
    const cred = loadCredential();
    const headers = new Headers({ 'content-type': 'application/json' });
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const res = await fetch(`/api/chats/${chatId}/doc/export`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, format }),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, errMsg, parsed);
    }
    const exportedPath = res.headers.get('x-patch-doc-path') ?? `export.${format}`;
    let warnings: string[] = [];
    try {
      warnings = JSON.parse(res.headers.get('x-patch-doc-warnings') ?? '[]') as string[];
    } catch {
      warnings = [];
    }
    const blob = await res.blob();
    return { blob, filename: exportedPath.split('/').pop() ?? exportedPath, warnings };
  },
  // What this chat's running background tasks are costing its host (spec/14
  // § Main chat panel — Background task bar). NO FALLBACK: `stats` carries an
  // entry only for a task the host could actually measure, so an id that comes
  // back missing renders nothing rather than a zero.
  backgroundTaskStats: (chatId: string, taskIds: string[]) =>
    request<{ stats: BackgroundTaskStat[] }>(
      `/api/chats/${chatId}/background-task-stats?taskIds=${encodeURIComponent(taskIds.join(','))}`,
    ),
  // This chat's patch_watch tasks, running and recently ended (spec/14 § Main
  // chat panel — Background task bar). Backs the bar's kill button, elapsed
  // time and command preview — real fields off the host's persisted record,
  // not scraped from the transcript.
  watchList: (chatId: string) => request<{ tasks: WatchTaskRow[] }>(`/api/chats/${chatId}/watch`),
  // Kill a running task outright. Idempotent: killing an already-ended task
  // answers `stopped: false` rather than erroring.
  watchStop: (chatId: string, taskId: string) =>
    request<{ stopped: boolean }>(`/api/chats/${chatId}/watch/${encodeURIComponent(taskId)}/stop`, {
      method: 'POST',
    }),
  // Selectable models for a new chat (spec/14 § Model selector). Live list —
  // the host reads it from Anthropic with its Claude OAuth credential, so a
  // newly released model is offered without a redeploy. NO FALLBACK: a failure
  // throws and the picker shows it.
  // Per MACHINE: the server requires the machine whose catalogue is read and
  // rejects a call naming none — the same folder path on two machines is two
  // different directories, and their model lists differ too.
  models: (daemonId: string) =>
    request<{ models: { id: string; label: string }[]; fetchedAt?: string }>(
      `/api/models?daemonId=${encodeURIComponent(daemonId)}`,
    ),
  // Skills available in a folder's `.claude/skills` (job-editor Skill picker,
  // the chat transcript's Skill tool-call link/tooltip, and the composer's `/`
  // preview panel). `paths` names the file each skill is defined in, keyed by
  // name; `descriptions` carries each skill's frontmatter `description:`,
  // keyed by name; `frontmatter` carries the WHOLE parsed frontmatter block
  // per skill, keyed by name then by field — what the preview panel shows
  // beyond the description. All three absent when the host doesn't report
  // them, in which case nothing may link to a skill's source or show a
  // description/preview rather than guess/invent one (spec/01 §
  // GET /api/skills).
  // Per MACHINE, same as `models` above: skills are per-host (a folder's
  // `.claude/skills`, or a machine-level skill that only lives on one
  // machine), so the caller must say which — omitting it let the request
  // fall through to "whichever host last attached" and come back missing a
  // skill that is real on the caller's actual host.
  skills: (folder: string, daemonId: string) =>
    request<{
      skills: string[];
      paths?: Record<string, string>;
      descriptions?: Record<string, string>;
      frontmatter?: Record<string, Record<string, string>>;
    }>(`/api/skills?folder=${encodeURIComponent(folder)}&daemonId=${encodeURIComponent(daemonId)}`),
  // spec/14 § Composer — upload one composer attachment (image or file) for a
  // chat. Multipart (the shared `request` helper is JSON-only), so it builds the
  // FormData itself. The server stores the file, hands a copy to the host (so
  // Claude can read it by path) and returns the ref + inline URL. NO FALLBACK:
  // any non-2xx throws so the composer surfaces the error and keeps the file.
  //
  // `file` is the ORIGINAL — the copy that gets stored, served and rendered.
  // `model` is the downscaled copy the agent reads, passed only when a downscale
  // actually happened (spec/15 § Composer).
  uploadAttachment: async (
    chatId: string,
    file: File,
    model?: File,
  ): Promise<{ ok: true; ref: UploadedAttachment }> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const form = new FormData();
    form.append('file', file);
    if (model) form.append('model', model);
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/attachment`, {
      method: 'POST',
      headers,
      body: form,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, errMsg, parsed);
    }
    return parsed as { ok: true; ref: UploadedAttachment };
  },
  // Host-owned folder list for cold-start (spec/04 § Folders) — the one-tap
  // shortcut list. Live updates arrive over the WS (`folders.list` /
  // `folders.updated`); this serves a surface without a live socket.
  /**
   * Every host's published registry, grouped by host (spec/04 § Folders). A
   * flat union would make two machines' identical paths indistinguishable.
   */
  folders: () =>
    request<{ hosts: Array<{ daemonId: string; roots: string[]; recent: string[] }> }>(
      '/api/folders',
    ),
  // Folder BROWSER (spec/04 § Browsing): list a directory's child directories
  // (or, with no `dir`, the host's browsable roots). Confined to the host's
  // project roots server/host-side — a dir escaping them 404s (NO FALLBACK).
  browseFolders: (daemonId: string, dir?: string) =>
    request<{
      daemonId: string;
      dir: string | null;
      parent: string | null;
      entries: Array<{ name: string; path: string }>;
    }>(
      `/api/folders/browse?daemonId=${encodeURIComponent(daemonId)}${
        dir ? `&dir=${encodeURIComponent(dir)}` : ''
      }`,
    ),
  /**
   * The one-line install command for a new machine, per target OS. The SERVER
   * is its single source (spec/11 § Host installation) — this surface renders
   * what it is handed and never composes a command from its own idea of the
   * server's address or of how a build is named.
   */
  /**
   * What the server has actually published. Drives the OS choices when adding a
   * host: offering an operating system with no build only produces a refusal
   * after the fact.
   */
  daemonManifest: () =>
    request<{ version: string; artifacts: { target: string }[] }>('/api/daemon/daemon-latest.json'),
  daemonInstallCommand: (os: 'macos' | 'linux') =>
    request<{ os: string; version: string; targets: string[]; command: string }>(
      `/api/daemon/install-command?os=${encodeURIComponent(os)}`,
    ),
  // GET /api/link-preview — server-side fetched title/description/image for a
  // message link, powering the inline mini-preview toggle (spec/14 § Message
  // links). Fetched server-side because the target's CORS policy would
  // otherwise block the browser doing it directly.
  linkPreview: (url: string) =>
    request<{ url: string; title?: string; description?: string; image?: string }>(
      `/api/link-preview?url=${encodeURIComponent(url)}`,
    ),
  // GET /api/link-preview/image — same reasoning as getFileRawBlob above: the
  // CSP locks img-src down to 'self'/data:/blob:, so a preview's og:image (an
  // arbitrary third-party URL) can't be a plain `<img src>` either way. Fetched
  // here with the bearer header and turned into a Blob; the caller builds an
  // object URL from it.
  linkPreviewImage: async (url: string): Promise<Blob> => {
    const cred = loadCredential();
    const headers = new Headers();
    if (cred) headers.set('authorization', `Bearer ${cred}`);
    const res = await fetch(`/api/link-preview/image?url=${encodeURIComponent(url)}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, errMsg, parsed);
    }
    return res.blob();
  },
  // spec/14 § Batch mode — one account-wide batch, held server-side.
  getBatch: () => request<BatchResponse>('/api/batch'),
  startBatch: (checkIn: BatchCheckInChoice) =>
    request<BatchResponse>('/api/batch/start', { method: 'POST', body: { checkIn } }),
  removeBatchMember: (chatId: string) =>
    request<BatchResponse>(`/api/batch/members/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    }),
  checkInBatchNow: () => request<BatchResponse>('/api/batch/check-in-now', { method: 'POST' }),
  markBatchOpened: (chatId: string) =>
    request<BatchResponse>('/api/batch/opened', { method: 'POST', body: { chatId } }),
  // spec/09 § bell — what agents sent, with read state.
  getNotifications: () => request<NotificationsResponse>('/api/notifications'),
  markNotificationsRead: (target: { ids: string[] } | { all: true }) =>
    request<NotificationsResponse>('/api/notifications/read', { method: 'POST', body: target }),
  // spec/06 § Sweep — the Manager view's "Last sweep" line + its expanded
  // run list, and the "Check now" button.
  getSweepRuns: (limit?: number) =>
    request<{ runs: SweepRun[] }>(`/api/manager/sweeps${limit ? `?limit=${limit}` : ''}`),
  checkSweepNow: () =>
    request<{ fired: boolean }>('/api/manager/sweep/check-now', { method: 'POST' }),
};

/** spec/09 § bell — one agent-sent notification. */
export interface NotificationEntry {
  id: string;
  chatId: string;
  message: string;
  importance: 'silent' | 'normal' | 'urgent';
  deepLink?: string;
  sentAt: number;
  readAt: number | null;
}
export interface NotificationsResponse {
  items: NotificationEntry[];
  unread: number;
}

/** spec/06 § Sweep — one completed sweep run, as the "Last sweep" line and the sweep-runs list read it. */
export interface SweepRun {
  at: number;
  runId: string;
  candidateCount: number;
  actions: { chatId: string; action: 'nudge' | 'wake' | 'flag' | 'leave' }[];
  tokensUsed: number;
  error?: string;
}

/** spec/14 § Batch mode — the check-in choice `Batch` offers. */
export type BatchCheckInChoice = { type: 'time'; minutes: 15 | 20 | 30 } | { type: 'all-done' };

export interface BatchRecord {
  id: string;
  startedAt: number;
  checkIn: BatchCheckInChoice;
  checkInAt: number;
  members: string[];
  checkedIn: boolean;
  openedMemberIds: string[];
}

export interface BatchResponse {
  batch: BatchRecord | null;
  carryover: string[];
}
