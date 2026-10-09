// Per-chat meta.json: persisted to ~/.patch/chats/<chatId>/meta.json.
//
// Atomic write via temp + fsync + rename so a host crash never corrupts the
// file or rewinds nextSeq, and the bytes are durably on disk before the rename
// makes them visible (spec/02-daemon.md "Sequence durability" / atomic write).
// Mirrors the server's registry.ts fsync discipline. Read-modify-write callers
// go through `update` to keep updates serialised per chatId.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ChatContextUsage, HarnessId, PermissionMode, TurnOrigin } from '@patch/wire';

export const ChatMeta = z
  .object({
    chatId: z.string().min(1),
    folder: z.string().min(1),
    name: z.string().nullable(),
    /**
     * One-line snippet of the first user message (G2-d4). Persisted so an
     * unnamed, never-reopened archived chat still has a distinguishing label
     * after a host restart. Captured once when the first user turn lands and
     * never overwritten. Optional for back-compat with meta files written
     * before this field existed.
     */
    preview: z.string().nullable().optional(),
    /**
     * The chat's goal (patch/todo.md — `/goal`). Persisted so the goal survives
     * a host restart and shows at the top of the chat on re-open. `null`/absent
     * when no goal is set. Optional for back-compat with meta files written
     * before this field existed.
     */
    goal: z.string().nullable().optional(),
    /**
     * The chat's most recently FINISHED goal (spec/04 § Goals — "A finished
     * goal stays viewable from the chat header"). `null`/absent until a goal
     * has resolved met/impossible at least once. Optional for back-compat.
     */
    lastGoal: z
      .object({
        condition: z.string().min(1),
        startedAt: z.number().int(),
        endedAt: z.number().int(),
        turns: z.number().int().nonnegative(),
        tokens: z.number().int().nonnegative(),
        outcome: z.enum(['met', 'impossible']),
        reason: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
    /**
     * The chat's reminder (patch/todo.md — Reminders). Persisted so the reminder
     * survives a host restart and shows at the top of the chat on re-open.
     * `null`/absent when no reminder is set. Optional for back-compat with meta
     * files written before this field existed.
     */
    reminder: z.string().nullable().optional(),
    /**
     * This chat's permission-mode override (spec/02 § Permission mode).
     * Persisted so a restart does not silently return an overridden chat to its
     * host default. Absent means no override — the chat follows the host
     * default. Optional for back-compat with meta files written before this
     * field existed.
     */
    permissionMode: z
      .enum(['auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan'])
      .optional(),
    /**
     * Every mid-conversation change of this chat's permission mode, oldest
     * first (spec/02 § Permission mode). The transcript Claude Code writes
     * knows nothing about these, so without a record here the marker line would
     * survive only as long as the host process that emitted it — and this
     * host restarts on every deploy. `seq` is the canonical seq the marker
     * was emitted under, so replay puts it back exactly where it happened.
     * Absent means the chat has never had its mode changed.
     */
    permissionModeMarks: z
      .array(
        z
          .object({
            seq: z.number().int().nonnegative(),
            mode: PermissionMode,
            at: z.number().int(),
            /**
             * Claude Code made this change itself (spec/02 § Permission
             * mode's plan-mode exception), not the mode control. Absent for
             * every ordinary change.
             */
            automatic: z.literal(true).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * The model this chat runs on (spec/04 § Model) — the one chosen at spawn,
     * or whatever it was last changed to. Persisted for the same reason
     * `permissionMode` is: the model is a choice made about THIS chat, and a
     * restart that silently returned it to the host's last-used model would run
     * later turns on a model nobody picked. Absent means the chat has no model
     * of its own, and the backend's own default stands. Optional for back-compat
     * with meta files written before this field existed.
     */
    model: z.string().min(1).optional(),
    /**
     * The stored Claude account this chat's turns START on (spec/10 § Backend
     * credentials — preferred account), chosen at spawn and fixed for the
     * chat's life. A preference, not the retired `accountId` pin: a spent
     * preferred key is walked past like any other, and a failure is attributed
     * to the key the turn actually ran on. Absent — every chat before this, and
     * every chat that names none — means the host's strategy alone decides.
     */
    preferredAccountId: z.string().min(1).optional(),
    /**
     * The chat's last context-window reading (spec/14 § Composer — context
     * ring). Absent until the chat has run a Claude turn.
     */
    context: ChatContextUsage.optional(),
    /**
     * Last known Claude Code session id; absent until SDK emits its first
     * `result`. ALWAYS mirrors the ACTIVE branch's `sessionId` (spec/04 §
     * Branching) so resume/replay/title/status paths need to know nothing about
     * branches.
     */
    claudeSessionId: z.string().min(1).optional(),
    /**
     * The chat's track graph (spec/04 § Branching). A chat is a graph, not a
     * line: editing a user turn forks a new track from it. Oldest-first, root
     * (`parentBranchId: null`) at index 0. Optional for back-compat — a meta
     * written before branching existed gets its root branch synthesised on
     * first read (see chatRunner `ensureBranches`), never a second source of
     * truth.
     */
    branches: z
      .array(
        z
          .object({
            branchId: z.string().min(1),
            parentBranchId: z.string().min(1).nullable(),
            forkFromSeq: z.number().int().nonnegative().nullable(),
            label: z.string().min(1),
            createdAt: z.number().int(),
            /** Claude session backing this track; absent until its first turn lands. */
            sessionId: z.string().min(1).optional(),
            /**
             * True for a side thread (spec/04 § Side threads): `forkFromSeq`
             * names a message this track SHARES with its parent (the anchor
             * itself replays on both), unlike an edit fork, where the message at
             * `forkFromSeq` is being REPLACED and belongs to the parent only.
             * Absent/false means an edit fork. Read by the history log's
             * `readTrack` to know whether the parent's contribution to this
             * track's replay is inclusive or exclusive of `forkFromSeq` itself.
             */
            sideThread: z.literal(true).optional(),
            /**
             * A side branch's own name (spec/04 § Branching — "Side branches
             * get a name"), derived like a chat name from its first message
             * and renameable. `null`/absent until generated.
             */
            name: z.string().min(1).nullable().optional(),
            /**
             * True once this branch has posted its conclusion back into its
             * parent track (spec/04 § Send back). One-way.
             */
            sentBack: z.literal(true).optional(),
            /**
             * The last session this track had on EACH harness it has ever run
             * on, keyed by harness (spec/04 § History — riding the prompt
             * cache back: a return to a harness the track used before resumes
             * this session and appends only what happened since, instead of
             * rebuilding the whole track from scratch). `lastSeq` is the
             * highest seq that session already had context for at the moment
             * the track left it — `readTrack(..., fromSeq: lastSeq)` is
             * exactly the delta a later return must append.
             */
            harnessSessions: z
              .record(
                HarnessId,
                z.object({ sessionId: z.string().min(1), lastSeq: z.number().int() }).strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .optional(),
    /** Which track the chat IS right now (spec/04 § Branching). */
    activeBranchId: z.string().min(1).optional(),
    /** Per-chat monotonic sequence — next value to stamp. Strictly increasing. */
    nextSeq: z.number().int().nonnegative(),
    /** Pinned chats appear above the folder list (spec/04). */
    pinned: z.boolean().optional(),
    /** ms epoch when the chat was last pinned (drives sidebar ordering). */
    pinnedAt: z.number().int().nullable().optional(),
    /** A special thread turned off (spec/06 § Disabled). See wire's ChatState. */
    disabled: z.boolean().optional(),
    /** Lifecycle status. Defaults to 'active'. `deleted` is a recoverable
     *  soft-delete (spec/04 § Lifecycle). */
    status: z.enum(['active', 'archived', 'errored', 'deleted']).optional(),
    /**
     * The error detail that drove the chat into `status: 'errored'`. Persisted
     * (not just in-memory) so an errored chat surviving a host restart still
     * exposes WHY it errored — `patch threads list` / `chats get` would
     * otherwise show `status: errored` with `lastError: null`, hiding the
     * cause. Cleared (omitted) whenever the chat leaves the errored status.
     */
    lastError: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        at: z.number().int(),
      })
      .nullable()
      .optional(),
    /**
     * Turns this chat owes the agent, oldest first: index 0 is the turn that is
     * RUNNING right now, the rest are queued behind it (spec/04 ## Message
     * queueing). Written as the pump's contents change and emptied as it drains,
     * so on a clean shutdown this is absent or `[]`.
     *
     * It exists to survive an UNclean one. A host restart — every deploy does
     * one — kills the SDK query mid-turn; `runQuery`'s finally never runs, so
     * this file is left holding exactly the turns that died. `hydrate` re-sends
     * them (chatRunner `resumeInterruptedTurns`), which is the only reason a
     * killed chat can carry on instead of sitting `errored` with
     * "Connection to the host was lost. Message will resend."
     */
    pendingTurns: z
      .array(
        z
          .object({
            message: z.string(),
            /** The surface's id for the turn; absent for daemon-originated turns. */
            localId: z.string().min(1).optional(),
            /**
             * Present when the turn opens a new track (spec/04 § Branching).
             * Carried so a resumed fork turn still lands in its own session
             * rather than being replayed into the parent's.
             */
            fork: z.object({ resumeAtUuid: z.string().nullable() }).strict().optional(),
            /**
             * Who started the turn (spec/09 § Whose turn it was). Persisted so a
             * turn re-sent after a restart is still attributed to whoever
             * started it — a self-wake killed mid-tick must not come back as a
             * user turn and ring the doorbell for a loop nobody asked about.
             * Absent means `user`, matching the wire field.
             */
            origin: TurnOrigin.optional(),
            /**
             * The seq of the ORIGINAL user message for this turn, once the turn
             * has been persisted as a bubble at least once (spec/12 § A turn is
             * owed until it settles). Carried so a re-send emits its
             * `chat.message` with `retryOfSeq` set and every surface folds it
             * into the bubble already on screen rather than drawing a second
             * one. Absent on a turn that died BEFORE its `chat.message` landed
             * — there is no bubble to fold into, so the re-send is the first.
             */
            retryOfSeq: z.number().int().nonnegative().optional(),
            /**
             * This turn is a job's own fire into the chat (spec/08 § Action), not
             * something the user typed. Persisted so a turn re-sent after a
             * restart still carries the quiet transcript-furniture treatment
             * (spec/14 § Job trigger turn) instead of coming back as a plain user
             * bubble just because the host that remembered why died.
             */
            jobTrigger: z.literal(true).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Which persisted user messages are RE-SENDS, and of what (spec/12 § A turn
     * is owed until it settles). `seq` is the re-sent copy's own canonical seq;
     * `retryOfSeq` is the original turn's.
     *
     * Claude Code's transcript persists every re-sent prompt as an ordinary user
     * turn and knows nothing about the relationship between them, so without
     * this a reload re-expands a folded turn back into one bubble per attempt.
     * `replayChat` reads it and re-decorates those messages by seq, the same way
     * `permissionModeMarks` is spliced back in.
     */
    retryMarks: z
      .array(
        z
          .object({
            seq: z.number().int().nonnegative(),
            retryOfSeq: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    /**
     * A status the AGENT declared for itself (spec/04 § Current status): the
     * chat is blocked on the user (`question` — `patch_ask_human`), or it has
     * something the user should see though nothing is blocked (`report`).
     *
     * PERSISTED, unlike the generated `statusSummary`/`statusKind`, which are
     * in-memory and rebuilt each turn. A declared status is the whole reason a
     * hidden job is in the list at all, so it has to survive the restart every
     * deploy performs — the alternative is a chat that asked for something,
     * came out of hiding, and quietly went back to looking like the other
     * nineteen the next time the host bounced.
     *
     * `text` is what the row shows: for a `question` the task as an instruction
     * the user could act on without opening the chat. Cleared by a USER turn
     * and nothing else (see `chatRunner.sendInput`) — a machine turn is the
     * chat carrying on, not evidence anybody read it.
     */
    declaredStatus: z
      .object({
        kind: z.enum(['question', 'report']),
        text: z.string().min(1),
        at: z.number().int(),
      })
      .strict()
      .nullable()
      .optional(),
    /** ms epoch when the chat was archived; cleared on un-archive. */
    archivedAt: z.number().int().nullable().optional(),
    /**
     * Running out of the active list (spec/04 § Hidden). Orthogonal to
     * `status`, and deliberately NOT cleared by archiving: while archived it
     * has no effect, and it is where a machine message starting the chat again
     * returns it to. Cleared by a user message, a declared status, a
     * permission block, or Show. Absent ⇒ not hidden.
     */
    hidden: z.boolean().optional(),
    /**
     * ms epoch the chat is snoozed until (spec/04 § Snooze), or `null`/absent
     * when it is not snoozed. Persisted so a snooze survives a host restart —
     * on hydrate a future value re-arms its wake timer and a lapsed one clears.
     */
    snoozedUntil: z.number().int().nullable().optional(),
    /**
     * Marks this chat as a `patch_delegate` subagent (spec/06 § Cross-chat
     * tools — patch_delegate) rather than an ordinary chat. Present only on a
     * subagent; absent means an ordinary chat. `parentChatId` is the chat that
     * created it; `label` is the short description shown on the parent's tool
     * row and in the `[from <label>]` result it delivers. `outcome` is unset
     * while it is still running and is stamped exactly once, when it settles
     * — `done`/`failed` by its own turn, `stopped` by the parent stopping or
     * archiving it (chatRunner.ts `maybeSettleDelegate`/`finishDelegate`).
     * Every enumeration a user can see (`listWithFilter`, search, the outbound
     * wire relay) excludes a chat carrying this field — it is how a subagent
     * stays invisible everywhere except the parent's own tool row.
     */
    subagent: z
      .object({
        parentChatId: z.string().min(1),
        label: z.string().min(1),
        outcome: z.enum(['done', 'failed', 'stopped']).optional(),
        finishedAt: z.number().int().optional(),
        /** Tools the parent withheld from this subagent (patch_delegate `disallowedTools`). */
        disallowedTools: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    /** ISO ms epoch of creation. */
    createdAt: z.number().int(),
    /** ISO ms epoch of last persisted update. */
    updatedAt: z.number().int(),
    /**
     * ms epoch of the user's own last activity on this chat — when they last
     * sent a message, via composer, voice note, fork or side message
     * (`fromUser: true`, spec/09 § Whose turn it was). Persisted so sidebar
     * ordering (spec/14 § Sidebar ordering) survives a host restart.
     * Optional for back-compat with meta files written before this field
     * existed; `chatStateFromMeta` falls back to `createdAt`.
     */
    lastUserActivity: z.number().int().optional(),
  })
  .strict();
export type ChatMeta = z.infer<typeof ChatMeta>;

/** A chat directory whose meta.json exists but cannot be read or parsed. */
export interface UnreadableChat {
  chatId: string;
  path: string;
  error: string;
}

export interface MetaStore {
  /** Returns absolute path of meta.json for chatId (file may not exist). */
  pathFor(chatId: string): string;
  /**
   * Every chat whose meta.json reads and parses. A chat whose meta is
   * unreadable is left out and recorded in `unreadable()` — one bad file (a
   * hand edit, a schema change) must not stop the host loading every other
   * chat. It is not hidden: the host logs it at error level and `patch
   * doctor` lists it.
   */
  list(): ChatMeta[];
  /** The chats the most recent `list()` could not read, and why. */
  unreadable(): UnreadableChat[];
  read(chatId: string): ChatMeta | undefined;
  write(meta: ChatMeta): void;
  /** Atomic increment helper: reads, runs `mut`, writes back. Caller must serialise. */
  update(chatId: string, mut: (m: ChatMeta) => ChatMeta): ChatMeta;
  /**
   * Atomically persist the per-chat monotonic sequence to
   * `~/.patch/chats/<chatId>/seq` (spec/02-daemon.md "Sequence durability").
   * Written after every emit; `readSeq` recovers it on restart. This is the
   * canonical seq location named by the spec; meta.json mirrors it as
   * `nextSeq` for the single-read hydrate path.
   */
  writeSeq(chatId: string, nextSeq: number): void;
  /** Read the persisted seq counter; undefined if the file is absent. */
  readSeq(chatId: string): number | undefined;
}

/** A zod failure names each offending field; anything else, its message. */
function describeReadError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

export function createMetaStore(patchHome: string): MetaStore {
  const root = join(patchHome, 'chats');

  function ensureRoot(): void {
    mkdirSync(root, { recursive: true });
  }

  function pathFor(chatId: string): string {
    return join(root, chatId, 'meta.json');
  }

  function seqPathFor(chatId: string): string {
    return join(root, chatId, 'seq');
  }

  /**
   * Crash-durable atomic write: write to a temp file, fsync the file
   * descriptor so the bytes hit stable storage, close, then rename over the
   * target. The rename is atomic and only becomes visible after the fsync, so
   * a crash never leaves a half-written or unflushed target. Mirrors
   * packages/server/src/registry.ts. NO FALLBACK — any fs error propagates.
   */
  function atomicWrite(p: string, data: string): void {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  }

  function writeSeq(chatId: string, nextSeq: number): void {
    if (!Number.isInteger(nextSeq) || nextSeq < 0) {
      throw new Error(`writeSeq: invalid nextSeq ${nextSeq} for ${chatId}`);
    }
    atomicWrite(seqPathFor(chatId), String(nextSeq));
  }

  function readSeq(chatId: string): number | undefined {
    let raw: string;
    try {
      raw = readFileSync(seqPathFor(chatId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`readSeq: corrupt seq file for ${chatId}: ${JSON.stringify(raw)}`);
    }
    return n;
  }

  /**
   * Keys a chat's meta used to carry and no longer may.
   *
   * `ChatMeta` is `.strict()`, so a key that has been retired makes every meta
   * file written before the retirement unreadable — which for `accountId` would
   * have been every chat on the host. Dropped on read; the key leaves the disk
   * for good the next time that chat's meta is written.
   *
   * `accountId` — a chat pinned the Claude account its turns ran on. A chat has
   * no account now: every turn resolves the host's stored keys in order and
   * takes the first with credit (spec/10-auth.md § Backend credentials).
   */
  const RETIRED_META_KEYS = ['accountId'] as const;

  function dropRetiredKeys(parsed: unknown): unknown {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
    const rest = { ...(parsed as Record<string, unknown>) };
    for (const key of RETIRED_META_KEYS) delete rest[key];
    return rest;
  }

  function read(chatId: string): ChatMeta | undefined {
    const p = pathFor(chatId);
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    return ChatMeta.parse(dropRetiredKeys(parsed));
  }

  function write(meta: ChatMeta): void {
    atomicWrite(pathFor(meta.chatId), JSON.stringify(meta, null, 2));
  }

  function list(): ChatMeta[] {
    ensureRoot();
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: ChatMeta[] = [];
    const bad: UnreadableChat[] = [];
    for (const id of entries) {
      // `.incoming-<id>` is a chat moving in from another host, still being
      // written (chatMove.ts); it becomes a chat when it is renamed into place.
      if (id.startsWith('.')) continue;
      const sub = join(root, id);
      try {
        const s = statSync(sub);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      let m: ChatMeta | undefined;
      try {
        m = read(id);
      } catch (err) {
        bad.push({ chatId: id, path: pathFor(id), error: describeReadError(err) });
        continue;
      }
      if (m) out.push(m);
    }
    lastUnreadable = bad;
    return out;
  }

  let lastUnreadable: UnreadableChat[] = [];

  function unreadable(): UnreadableChat[] {
    return lastUnreadable;
  }

  function update(chatId: string, mut: (m: ChatMeta) => ChatMeta): ChatMeta {
    const cur = read(chatId);
    if (!cur) throw new Error(`meta.json missing for chatId=${chatId}`);
    const next = mut(cur);
    if (next.nextSeq < cur.nextSeq) {
      throw new Error(
        `meta.update for ${chatId} attempted to rewind nextSeq ${cur.nextSeq} → ${next.nextSeq}`,
      );
    }
    write(next);
    return next;
  }

  ensureRoot();

  return { pathFor, read, write, list, unreadable, update, writeSeq, readSeq };
}
