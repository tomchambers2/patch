// Read-watermark persistence.
//
// The inbox unread/read model (spec/04 ## Chat model, spec/14 ## Chat
// lifecycle) is a per-surface UI concern, not server state: "opening the chat
// marks it read · → ✓". The watermark is the highest per-chat `seq` the user
// had seen on their last visit; a chat is unread when `lastSeq > lastReadSeq`.
//
// That watermark MUST survive a page reload. It lives in the zustand store
// (in-memory), and the REST cold-start (`GET /api/chats`) carries no read
// state, so without persistence every reload reset every visited chat back to
// `done` — exactly the failure spec/14 forbids (a visit must durably flip the
// badge to the grey read tick). We persist the per-chat watermark in
// localStorage, keyed per chat, and seed the store from it on hydrate.
//
// NO FALLBACK: a corrupt/absent blob yields an empty map (every chat unread
// until visited), never a silently-wrong watermark.

const STORAGE_KEY = 'patch.readState.v1';

export type ReadState = Record<string, number>;

export function loadReadState(): ReadState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: ReadState = {};
    for (const [chatId, seq] of Object.entries(parsed)) {
      if (typeof seq === 'number' && Number.isFinite(seq)) out[chatId] = seq;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveReadWatermark(chatId: string, lastReadSeq: number): void {
  // A frame the Pad capture opened to photograph a screen is not Tom reading
  // the chat (spec/14 § Pads — Capturing a screen).
  if (new URLSearchParams(window.location.search).has('capture')) return;
  try {
    const current = loadReadState();
    // Never lower a persisted watermark (guards against an out-of-order write).
    if (current[chatId] !== undefined && current[chatId] >= lastReadSeq) return;
    current[chatId] = lastReadSeq;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // localStorage unavailable (private mode / SSR) — read state simply does
    // not persist this session. The in-memory watermark still works.
  }
}
