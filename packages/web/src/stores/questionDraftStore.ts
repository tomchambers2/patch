// Question drafts — the half-made selections on an OPEN `AskUserQuestion` card
// (spec/14 § Main chat panel — Question prompts).
//
// The card's `picked`/`otherOn`/`otherText` used to live only in the component
// instance, and a resolved card was redrawn from `entry.permissionAnswers`.
// That left the WHOLE answerable life of the card with nowhere durable to put
// what had been chosen so far, and the card remounts constantly: switching
// chats and back (`ChatRoute`'s `key={chatId}` forces it), a reload, opening
// the chat in another tab, the timeline row's `${seq}-${index}` key shifting.
// Every one of those silently emptied the form. Worse than losing a selection,
// it loses the SUBMIT: "Submit is disabled until every question has an answer"
// (spec/14), so a card that reset itself sits there looking answerable with a
// dead Send answer button, and the agent is still waiting (Tom: "i answer and
// it never gets to the chat. on returning, the form is reset").
//
// LOCAL ONLY, unlike `composerDraftStore.ts` which is server-owned. A composer
// draft is a message you mean to send and should follow you between devices; a
// half-made selection is one surface's work-in-progress on a request that is
// resolved exactly once, by whoever answers first, and usually within a
// deadline the card is already counting down. Syncing it would buy nothing and
// would race two surfaces editing one answer.
//
// NO FALLBACK: a corrupt or absent cache yields no draft (a legitimate
// first-run state), never a silently-wrong set of selections — restoring the
// wrong answer to a question is worse than restoring none.

import { create } from 'zustand';
import { useUiStore } from './uiStore.js';

const STORAGE_KEY = 'patch.question-drafts.v1';

const SAVE_FAILED_MESSAGE =
  'Couldn’t save your answer in progress — it will be lost if you reload.';

/**
 * How long a draft survives. Drafts are keyed by `requestId`, which is never
 * reused, so nothing here is ever read again once its request resolves — the
 * entries that reach this age are the ones whose card was never resolved on
 * this surface (the question expired, the host went away, the tab was closed
 * mid-answer). Without a sweep they accumulate in localStorage forever.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface QuestionDraft {
  /** question text -> chosen option labels. */
  picked: Record<string, string[]>;
  /** question text -> whether the free-text `Other` row is chosen. */
  otherOn: Record<string, boolean>;
  /** question text -> what has been typed into `Other`. */
  otherText: Record<string, string>;
  /** ms-epoch of the last edit, for the age sweep above. */
  updatedAt: number;
}

/** An untouched card writes nothing: a draft of no selections is not a draft. */
export function isEmptyDraft(draft: Omit<QuestionDraft, 'updatedAt'>): boolean {
  if (Object.values(draft.picked).some((labels) => labels.length > 0)) return false;
  if (Object.values(draft.otherOn).some((on) => on)) return false;
  return !Object.values(draft.otherText).some((text) => text.length > 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Read the cache, keeping only entries that are BOTH the documented shape and
 * young enough. Anything else is dropped rather than coerced.
 */
function loadCache(): Record<string, QuestionDraft> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const now = Date.now();
    const out: Record<string, QuestionDraft> = {};
    for (const [requestId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const d = value as Record<string, unknown>;
      if (typeof d.updatedAt !== 'number' || now - d.updatedAt > MAX_AGE_MS) continue;
      const picked: Record<string, string[]> = {};
      const otherOn: Record<string, boolean> = {};
      const otherText: Record<string, string> = {};
      if (typeof d.picked === 'object' && d.picked !== null && !Array.isArray(d.picked)) {
        for (const [q, labels] of Object.entries(d.picked as Record<string, unknown>)) {
          if (isStringArray(labels)) picked[q] = labels;
        }
      }
      if (typeof d.otherOn === 'object' && d.otherOn !== null && !Array.isArray(d.otherOn)) {
        for (const [q, on] of Object.entries(d.otherOn as Record<string, unknown>)) {
          if (typeof on === 'boolean') otherOn[q] = on;
        }
      }
      if (typeof d.otherText === 'object' && d.otherText !== null && !Array.isArray(d.otherText)) {
        for (const [q, text] of Object.entries(d.otherText as Record<string, unknown>)) {
          if (typeof text === 'string') otherText[q] = text;
        }
      }
      if (isEmptyDraft({ picked, otherOn, otherText })) continue;
      out[requestId] = { picked, otherOn, otherText, updatedAt: d.updatedAt };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(drafts: Record<string, QuestionDraft>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch (err) {
    // NO FALLBACK: a full or blocked localStorage must not crash the card, but
    // it must not be silent either — the selections are still on screen and
    // still submittable, and the only thing lost is surviving a remount, so
    // say exactly that (the same bargain `composerDraftStore` strikes).
    useUiStore.getState().pushError(SAVE_FAILED_MESSAGE, undefined, (err as Error).message);
  }
}

interface QuestionDraftStore {
  /** requestId -> selections in progress. A card never touched has no key. */
  drafts: Record<string, QuestionDraft>;
  /** What `requestId`'s card should be seeded with; `undefined` when nothing. */
  get(requestId: string): QuestionDraft | undefined;
  /** Record what is currently chosen on `requestId`'s card. */
  set(requestId: string, draft: Omit<QuestionDraft, 'updatedAt'>): void;
  /** Drop `requestId`'s entry — it was answered, cancelled, or expired. */
  clear(requestId: string): void;
  /** Test seam — the store loads once at module init and outlives a render. */
  _reset(): void;
}

export const useQuestionDraftStore = create<QuestionDraftStore>((set, get) => ({
  drafts: loadCache(),

  get(requestId) {
    return get().drafts[requestId];
  },

  set(requestId, draft) {
    // Emptying the card back out is not a draft either: deselecting everything
    // must leave the request exactly as it found it, so a later remount shows
    // a clean card rather than resurrecting a selection that was taken back.
    if (isEmptyDraft(draft)) {
      get().clear(requestId);
      return;
    }
    const drafts = { ...get().drafts, [requestId]: { ...draft, updatedAt: Date.now() } };
    persist(drafts);
    set({ drafts });
  },

  clear(requestId) {
    if (!(requestId in get().drafts)) return;
    const drafts = { ...get().drafts };
    delete drafts[requestId];
    persist(drafts);
    set({ drafts });
  },

  _reset() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clear if storage is unavailable.
    }
    set({ drafts: {} });
  },
}));
