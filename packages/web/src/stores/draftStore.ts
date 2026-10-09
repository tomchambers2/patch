// Draft store — unsent new-chat drafts (spec/14 § New chat drafts).
//
// A "draft" is a not-yet-sent new chat: a chosen folder + composer text the
// user isn't ready to send. Drafts persist across navigation AND reloads, and
// the user can keep SEVERAL and switch between them (each `+ New chat` mints a
// fresh draft; the sidebar's Drafts section lists them). A draft is consumed
// when its first message is sent (the real chat spawns) — see NewChatRoute.
//
// A draft only exists while it has TEXT (`hasDraftText` — the one rule, shared
// with the per-chat composer drafts): a blank just-opened draft, and one that
// was typed into and then emptied again, are the same thing and neither is
// listed or kept. `pruneBlank` is what collects them.
//
// SERVER-OWNED (spec/14 § New chat drafts): like per-chat composer drafts, the
// server holds the account's new-chat drafts so one typed on any surface is
// listed on, and deletable from, every other. A draft with text is sent
// (debounced) as `new_chat_draft.set`; a removal as `new_chat_draft.remove`;
// the server's `new_chat_draft.list/updated/removed` come back through the
// `apply*` intakes. localStorage is kept only as an offline-survival cache.
// Blank drafts (no text) are never sent — they are local scratch.
//
// NO FALLBACK: a corrupt/absent blob yields an empty set (a legitimate
// first-run state), never a silently-wrong draft.

import { create } from 'zustand';
import type { NewChatDraftBody } from '@patch/wire';
import { getActiveWs } from '../api/ws.js';
import { hasDraftText } from '../lib/draftText.js';
import { useUiStore } from './uiStore.js';

export interface Draft {
  id: string;
  /** Absolute folder on `daemonId`'s machine, or '' until chosen. */
  folder: string;
  /**
   * The machine the chat will run on. A path means nothing without its host,
   * so a restored draft must come back on the machine it was typed against.
   * Absent on drafts saved before this existed, which take the default.
   */
  daemonId?: string;
  /** Unsent composer text. */
  text: string;
  /** SDK `--model` override for the chat this draft will spawn (spec/13). */
  model?: string;
  updatedAt: number;
}

const STORAGE_KEY = 'patch.drafts.v1';

function load(): { drafts: Record<string, Draft>; order: string[] } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { drafts: {}, order: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { drafts: {}, order: [] };
    const p = parsed as { drafts?: unknown; order?: unknown };
    const drafts: Record<string, Draft> = {};
    if (p.drafts && typeof p.drafts === 'object') {
      for (const [id, d] of Object.entries(p.drafts as Record<string, unknown>)) {
        const dd = d as Partial<Draft>;
        if (typeof dd.folder === 'string' && typeof dd.text === 'string') {
          drafts[id] = {
            id,
            folder: dd.folder,
            text: dd.text,
            ...(typeof dd.model === 'string' ? { model: dd.model } : {}),
            ...(typeof dd.daemonId === 'string' ? { daemonId: dd.daemonId } : {}),
            updatedAt: typeof dd.updatedAt === 'number' ? dd.updatedAt : 0,
          };
        }
      }
    }
    const order = Array.isArray(p.order)
      ? (p.order as unknown[]).filter((x): x is string => typeof x === 'string' && x in drafts)
      : Object.keys(drafts);
    // Include any drafts missing from a stale order array.
    for (const id of Object.keys(drafts)) if (!order.includes(id)) order.push(id);
    return { drafts, order };
  } catch {
    return { drafts: {}, order: [] };
  }
}

function persist(drafts: Record<string, Draft>, order: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ drafts, order }));
  } catch (err) {
    // NO FALLBACK (portfolio CLAUDE.md): a full/blocked localStorage must not
    // crash the app, but a draft quietly not surviving a reload is exactly the
    // "where did my message go?" bug — say so.
    useUiStore
      .getState()
      .pushError(
        'Couldn\u2019t save your draft \u2014 it will be lost if you reload.',
        undefined,
        (err as Error).message,
      );
  }
}

/** How long after the last edit we wait before telling the server. */
export const NEW_CHAT_DRAFT_SEND_DEBOUNCE_MS = 400;
/** The exact string `PatchWs.send` throws when offline — expected, never toasted. */
const NOT_CONNECTED_MESSAGE = 'PatchWs: not connected';

/** Draft ids whose local state the server has not confirmed. */
const pendingOp = new Set<string>();
/** Draft ids -> sends whose echo has not come back yet (our own echo must not clobber newer typing). */
const awaitingEcho = new Map<string, number>();
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>();

function toBody(d: Draft): NewChatDraftBody {
  return {
    id: d.id,
    folder: d.folder,
    text: d.text,
    ...(d.daemonId ? { daemonId: d.daemonId } : {}),
    ...(d.model ? { model: d.model } : {}),
  };
}

function flushPending(id: string): void {
  if (!pendingOp.has(id)) return;
  const ws = getActiveWs();
  if (!ws) return;
  const d = useDraftStore.getState().drafts[id];
  try {
    if (d && hasDraftText(d.text)) ws.send({ type: 'new_chat_draft.set', draft: toBody(d) });
    else ws.send({ type: 'new_chat_draft.remove', id });
    pendingOp.delete(id);
    awaitingEcho.set(id, (awaitingEcho.get(id) ?? 0) + 1);
  } catch (err) {
    if ((err as Error).message === NOT_CONNECTED_MESSAGE) return;
    useUiStore
      .getState()
      .pushError('Couldn\u2019t save your draft to the server.', undefined, (err as Error).message);
  }
}

/** Mark `id` as owed to the server: debounced for edits, immediate for removals. */
function owe(id: string, immediately: boolean): void {
  pendingOp.add(id);
  const t = sendTimers.get(id);
  if (t) clearTimeout(t);
  if (immediately) {
    sendTimers.delete(id);
    flushPending(id);
    return;
  }
  sendTimers.set(
    id,
    setTimeout(() => {
      sendTimers.delete(id);
      flushPending(id);
    }, NEW_CHAT_DRAFT_SEND_DEBOUNCE_MS),
  );
}

function makeId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface DraftStore {
  drafts: Record<string, Draft>;
  /** Most-recent-first display order for the sidebar. */
  order: string[];
  /** Mint a new empty draft (optionally seeded with a folder) and return its id. */
  create(folder?: string): string;
  /** Patch a draft's folder/text/model; no-op if the draft is gone. */
  update(id: string, patch: Partial<Pick<Draft, 'folder' | 'text' | 'model' | 'daemonId'>>): void;
  /** Drop a draft (discarded, or consumed on send). */
  remove(id: string): void;
  /**
   * Drop every draft with no text — never opened, or typed into and emptied
   * again. `keepId` spares the one the user is sitting on, which still owns
   * the screen's folder/model until they leave it.
   */
  pruneBlank(keepId?: string): void;
  get(id: string): Draft | undefined;
  /** Wire intake: the account's full new-chat draft snapshot (after auth.ok). */
  applyList(entries: (NewChatDraftBody & { updatedAt: number })[]): void;
  /** Wire intake: a draft changed, from any surface (including this one's own echo). */
  applyUpdated(draft: NewChatDraftBody, updatedAt: number): void;
  /** Wire intake: a draft is gone, from any surface. */
  applyRemoved(id: string): void;
  /** The link just came back — push every write the server never confirmed. */
  resendPendingOnReconnect(): void;
}

const initial = load();
// Drafts typed before the server owned them live only here: owe them all to
// the server so the first connection uploads them instead of the snapshot
// discarding them.
for (const d of Object.values(initial.drafts)) if (hasDraftText(d.text)) pendingOp.add(d.id);

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafts: initial.drafts,
  order: initial.order,

  create(folder) {
    const id = makeId();
    const draft: Draft = { id, folder: folder ?? '', text: '', updatedAt: Date.now() };
    const drafts = { ...get().drafts, [id]: draft };
    const order = [id, ...get().order];
    persist(drafts, order);
    set({ drafts, order });
    return id;
  },

  update(id, patch) {
    const cur = get().drafts[id];
    if (!cur) return;
    const next: Draft = { ...cur, ...patch, updatedAt: Date.now() };
    const drafts = { ...get().drafts, [id]: next };
    // Bump to the front on edit so the most-recently-touched draft leads.
    const order = [id, ...get().order.filter((x) => x !== id)];
    persist(drafts, order);
    set({ drafts, order });
    if (hasDraftText(next.text) || hasDraftText(cur.text) || pendingOp.has(id)) owe(id, false);
  },

  remove(id) {
    if (!get().drafts[id]) return;
    const drafts = { ...get().drafts };
    delete drafts[id];
    const order = get().order.filter((x) => x !== id);
    persist(drafts, order);
    set({ drafts, order });
    owe(id, true);
  },

  pruneBlank(keepId) {
    const cur = get().drafts;
    const dead = Object.keys(cur).filter((id) => id !== keepId && !hasDraftText(cur[id]!.text));
    if (dead.length === 0) return;
    const drafts = { ...cur };
    for (const id of dead) delete drafts[id];
    const order = get().order.filter((x) => !dead.includes(x));
    persist(drafts, order);
    set({ drafts, order });
  },

  get(id) {
    return get().drafts[id];
  },

  applyList(entries) {
    const incoming = new Map(entries.map((e) => [e.id, e]));
    awaitingEcho.clear();
    const drafts = { ...get().drafts };
    for (const e of entries) {
      if (pendingOp.has(e.id)) continue;
      drafts[e.id] = fromBody(e, e.updatedAt);
    }
    // A text draft the server no longer has was deleted elsewhere while we were
    // away — drop it, but never a write we still owe, nor blank local scratch.
    for (const id of Object.keys(drafts)) {
      if (incoming.has(id) || pendingOp.has(id) || !hasDraftText(drafts[id]!.text)) continue;
      delete drafts[id];
    }
    commit(drafts, get().order, e2ids(entries), set);
    for (const id of [...pendingOp]) flushPending(id);
  },

  applyUpdated(draft, updatedAt) {
    const n = awaitingEcho.get(draft.id) ?? 0;
    if (n > 0) awaitingEcho.set(draft.id, n - 1);
    // Our own newer edit (unsent, or sent with its echo still to come) wins.
    if (pendingOp.has(draft.id) || n > 1) return;
    const drafts = { ...get().drafts, [draft.id]: fromBody(draft, updatedAt) };
    commit(drafts, get().order, [draft.id], set);
  },

  applyRemoved(id) {
    const n = awaitingEcho.get(id) ?? 0;
    if (n > 0) awaitingEcho.set(id, n - 1);
    if (pendingOp.has(id) || n > 1) return;
    if (!(id in get().drafts)) return;
    const drafts = { ...get().drafts };
    delete drafts[id];
    commit(drafts, get().order, [], set);
  },

  resendPendingOnReconnect() {
    for (const id of [...pendingOp]) flushPending(id);
  },
}));

function fromBody(b: NewChatDraftBody, updatedAt: number): Draft {
  return {
    id: b.id,
    folder: b.folder,
    text: b.text,
    ...(b.model ? { model: b.model } : {}),
    ...(b.daemonId ? { daemonId: b.daemonId } : {}),
    updatedAt,
  };
}

function e2ids(entries: { id: string }[]): string[] {
  return entries.map((e) => e.id);
}

/** Apply a remote-driven change: newcomers lead the order, vanished ids leave it. */
function commit(
  drafts: Record<string, Draft>,
  order: string[],
  added: string[],
  set: (p: Partial<DraftStore>) => void,
): void {
  const next = order.filter((id) => id in drafts);
  for (const id of added) if (id in drafts && !next.includes(id)) next.unshift(id);
  for (const id of Object.keys(drafts)) if (!next.includes(id)) next.push(id);
  persist(drafts, next);
  set({ drafts, order: next });
}
