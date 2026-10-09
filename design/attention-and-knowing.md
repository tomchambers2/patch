# Attention and knowing — proposal

Status: PROPOSAL, three decisions open (bottom). Written 2026-09-13.

The ask: a standing place for things Tom should know, plus a visual state that
tells a chat which has *merely finished* from one that *needs him to do
something* — given the app is hidden most of the time.

## What already exists

- `StatusKind` = `question | complete` on every chat, generated per-turn by a
  Haiku one-shot (`packages/daemon/src/statusGen.ts`), rendered nested under the
  sidebar row with distinct treatment per kind.
- Needs-attention mode: `uiStore.attentionOnly`, `chatGroups.needsAttention`,
  FIFO oldest-first via `sortAttentionQueue`.
- Escalation, all wired: `patch_notify` (silent/normal/urgent), `patch_ask_human`,
  `patch_call`. The Manager watch loop (`packages/server/src/manager-watch.ts`,
  `managerWatching` defaults true) watches every chat on every host for
  permission / question / idle / errored / host-offline / job-failed edges.
- Mobile has no attention mode at all.

## The gaps

1. **Merely finished already counts as attention.** `deriveBadge` returns `done`
   for any chat with `lastSeq > lastReadSeq`, and `needsAttention()` includes
   `done`. The two states we want to separate are currently the same state.

2. **`patch_ask_human` leaves no trace.** `control.ts:1929` un-archives and emits
   one push. The task text lives only in a transient notification. Miss it and
   the chat looks idle like every other. This is the exact case, with no
   persistent state at all.

3. **No record, by design.** spec/09 §7: "A notification is a doorbell, not a
   record... no in-app notifications drawer, cross-channel timeline view, or
   aggregated bell." The `silent`/aside rung is already documented as "the rung
   for a watcher's daily line, anything worth knowing and not worth interrupting
   for" — the quiet rung exists, it has nowhere to land. This proposal
   deliberately reverses that principle for the quiet rung only.

4. **Escalation is edge-triggered, never state-triggered.** The watch loop fires
   on the crossing into blocked. Nothing re-checks "unanswered for six hours".
   A missed push is missed permanently.

## Proposal

Four outcomes instead of two:

| kind       | meaning                                   | mark                              | badges when hidden |
|------------|-------------------------------------------|-----------------------------------|--------------------|
| `action`   | blocked on you **in the world**            | strong; task text + tick on row   | yes                |
| `question` | blocked on you **in the chat**             | strong                            | yes                |
| `note`     | finished, produced something worth knowing | quiet, clears on read             | no — digest only   |
| `complete` | finished, nothing for you                  | **nothing at all**                | no                 |

- Drop `done` from `needsAttention()`. A chat earns the queue by declaring a
  state, not by having unread bytes.
- `patch_ask_human` persists `{ task, why, since }` on chat state and sets
  `statusKind: 'action'`, instead of evaporating into a push. Cleared by the row
  tick or the next user turn.
- `note` set by `patch_notify` at the `silent` rung, or a small `patch_note`.
- Ageing rule: an `action` untouched for N hours climbs a rung on its own. This
  is the missing state-triggered half of escalation.

Existing jobs and skills read `complete` until taught to declare.

## Open decisions

1. **Surface** — (a) the attention queue becomes the home view and notes join it
   as a quiet rank; (b) a separate reserved "Bits" thread beside
   Manager/Speakers; (c) both, feed as a filtered view of one store.
   Leaning (a): one place to look.
2. **Who decides** — only explicit tool calls set `action`/`note` (badge is never
   wrong, but empty until skills are updated), or Haiku guesses all four kinds
   (works day one, some wrong "you must act" marks). Leaning explicit-only.
3. **Ambient loudness** — tray/dock count + Android silent persistent
   notification, plus one daily digest for notes; or badge only; or digest only.
   Leaning badge + digest.
