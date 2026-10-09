// ChatRoute — main panel for /chats/:chatId.
//
// Renders header + event stream + composer. Real diff viewer + file browser
// land in group 19 (the Monaco editor right-rail).

import type { JSX } from 'react';
import {
  Fragment,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useMarkChatNotificationsRead } from '../stores/notificationsStore.js';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { sendToNewChat, selectionWithin } from '../lib/sendToNewChat.js';
import { useQuery } from '@tanstack/react-query';
import {
  SPECIAL_THREAD_IDS,
  hasTaskNotification,
  isEditToolCall as isEditToolCallWire,
  isGroupableToolCall,
  parseBackgroundTaskNotice,
  parseGoalOutcome,
  taskNotificationSummary,
  type AttachmentRef,
  type BackgroundTaskNotice,
  type ChatBranch,
  type GoalOutcomeNotice,
  type SystemContextItem,
} from '@patch/wire';
import type { WireEvent } from '@patch/wire';
import type { Job, JobTrigger } from '@patch/wire/jobs';
import { describeTrigger } from '../lib/jobDescribe.js';
import { useChatStore } from '../stores/chatStore.js';
import { loadTranscript, dropTranscript, setBranch, trimCache } from '../lib/transcriptCache.js';
import { patchShared } from './settings/sharedWrite.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { ChatHeader } from '../components/ChatHeader.js';
import { ChatFind } from '../components/ChatFind.js';
import { ArchivedBanner } from '../components/ArchivedBanner.js';
import { SnoozedBanner } from '../components/SnoozedBanner.js';
import { HiddenBanner } from '../components/HiddenBanner.js';
import { GoalBanner } from '../components/GoalBanner.js';
import { TaskBar } from '../components/TaskBar.js';
import { ReminderBanner } from '../components/ReminderBanner.js';
import { WakeBar } from '../components/WakeBar.js';
import { api } from '../api/rest.js';
import { SkillRefChatContext, useSkillTarget } from '../components/SkillRef.js';
import { linkSkillTokens } from '../lib/skillToken.js';
import { parseGoalCommand } from '../lib/goalCommand.js';
import { parseReminderCommand } from '../lib/reminderCommand.js';
import { parseLoopCommand } from '../lib/loopCommand.js';
import { parseClearCommand } from '../lib/clearCommand.js';
import { parseModelCommand, matchModel } from '../lib/modelCommand.js';
import { getModelCatalog } from '../lib/models.js';
import { Composer, type ComposerHandle } from '../components/Composer.js';
import { HookBlockCard } from '../components/HookBlockCard.js';
import type { HookRunResult } from '@patch/wire/hooks';
import { useWholeChatDrop } from '../lib/wholeChatDrop.js';
import { ThreadsStrip } from '../components/ThreadsStrip.js';
import { ClaudeDisconnectedBanner } from '../components/ClaudeDisconnectedBanner.js';
import { OutOfUsageBanner } from '../components/OutOfUsageBanner.js';
import { DaemonOfflineBanner } from '../components/DaemonOfflineBanner.js';
import { EmptyChat } from '../components/EmptyChat.js';
import { ChatNotFound } from '../components/ChatNotFound.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useToolsStore } from '../stores/toolsStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker.js';
import { discardUpload, retryUpload, sendMessage, type OutgoingFile } from '../lib/sendQueue.js';
import type { PatchWs } from '../api/ws.js';
import { getActiveWs } from '../api/ws.js';
import { MeetingActions, MeetingLayout } from '../components/MeetingPanel.js';
import { useMeetingStore } from '../stores/meetingStore.js';
import {
  EXTRA_USAGE_URL,
  EXTRA_USAGE_OFF_SENTENCE,
  OVERAGE_DISABLED_REASON,
  LIMIT_NAME,
  formatDurationWords,
  formatReset,
  formatResetDetail,
  presentFailure,
  routingSentence,
} from '../lib/usage.js';
import { BackgroundTaskBar } from '../components/BackgroundTaskBar.js';
import { ArtifactBar } from '../components/ArtifactBar.js';
import { JobBar } from '../components/JobBar.js';
import type { ChatEventEntry, DelegateUpdateInfo, LocalAttachment } from '../stores/chatStore.js';
import { Markdown, useStreamingMarkdownText } from '../components/Markdown.js';
import { ContextMenu, useContextMenu } from '../components/ContextMenu.js';
import { openSideThreadDraft, openExistingSideThread } from '../lib/sideThreadActions.js';
import { openDiffForFile } from '../lib/openDiff.js';
import { openArtifact } from '../lib/openArtifact.js';
import { closeArtifactPanel, notePanelInset, showArtifactFor } from '../lib/artifactPanel.js';
import { PadCard, padIdOfArtifact } from '../components/PadCard.js';
import { getDesktopBridge } from '../lib/desktopBridge.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { stripControlTokens } from '../lib/controlTokens.js';
import { queueChipLabel, queueChipTitle } from '../lib/queueLabel.js';
import { ASK_USER_QUESTION, isQuestionRowCoveredByCard } from '../lib/askUserQuestion.js';
import { QuestionCard } from '../components/QuestionCard.js';
import { runNarration, toolCallSummary, toolRunNarrative } from '../lib/toolSummary.js';
import { toolLabel } from '../lib/toolsCatalog.js';
import { formatElapsed } from '../lib/backgroundTasks.js';
import {
  ArrowUp,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Bell,
  ExternalLink,
  FileText,
  GitFork,
  MessageSquarePlus,
  LayoutTemplate,
  Mic,
  LoaderCircle,
  Pencil,
  Phone,
  Info,
} from 'lucide-react';
import { CloseIcon } from '../components/icons.js';
import { shortcutLabel } from '../lib/shortcuts.js';
import { isSubmitChord } from '../lib/submitChord.js';
import { failed } from '../lib/errorCopy.js';
import { isStoppable } from '../stores/types.js';

// How many unresolved, sweepable permission requests this chat has right now.
// A question card is not one: approve-all deliberately steps past it (spec/14
// § Question prompts). Carried in context rather than as a <TimelineEntry>
// prop so a change re-renders only the permission cards, not the whole
// memoised transcript (spec/14 § "Transcript render cost is O(changed)").
const PendingApprovalCountContext = createContext(0);

// Which chat's transcript is being drawn, for building blob URLs.
//
// Replay sends tool output as a REFERENCE, never a body (spec/04 § History —
// blobs), so a row that wants its picture or its result has to know the chat
// to fetch it under. Carried in context rather than threaded as a prop
// through every nesting level of ToolFields, which recurses arbitrarily deep.
const BlobChatIdContext = createContext<string | null>(null);

/** Where a blob's bytes are served from. Immutable — the sha is the content. */
function blobUrl(chatId: string, sha: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}/blob/${sha}`;
}

/** Bytes as something a person reads at a glance. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A whole tool result left in the blob store, as replay sends it. */
interface ToolBlobRef {
  $blob: string;
  bytes: number;
  preview: string;
}

function asBlobRef(value: unknown): ToolBlobRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const sha = v['$blob'];
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return null;
  const bytes = typeof v['bytes'] === 'number' ? v['bytes'] : 0;
  const preview = typeof v['preview'] === 'string' ? v['preview'] : '';
  return { $blob: sha, bytes, preview };
}

function isSweepablePermission(e: ChatEventEntry): boolean {
  return Boolean(e.requestId) && !e.permissionResolved && e.tool !== ASK_USER_QUESTION;
}

// Stable empty-array reference. Returning a literal `[]` from a Zustand
// selector creates a new reference on every call — Zustand's default
// Object.is equality treats it as changed → re-render → selector → new []
// → infinite loop → React #185. Hoist module-level so the identity is
// stable across calls when the underlying value is undefined.
const EMPTY_TIMELINE: ChatEventEntry[] = [];

// Per-chat scroll memory (spec/14 § Main chat panel — open on the latest
// message, or restore the user's last position if they had scrolled up in that
// chat). Module-level so a chat's position survives navigating away and back
// within a session. We store the last offset AND whether it was pinned to the
// bottom, so reopening either re-pins (the common case) or restores the read
// position.
//
// `offset` is a raw pixel fallback for when no message straddles the saved
// position (an empty/near-empty transcript); whenever one does, `anchor`
// pins to THAT message instead of a bare pixel count. A raw offset is only
// ever right if the content above it lays out identically both times, which
// async markdown/code-block measurement, image loads and late-arriving
// messages routinely break — restoring 3000px into a transcript whose above-
// the-fold content just got taller lands short of where the user actually
// was (Todoist: "switching chat puts you in a different position when you
// come back"). Anchoring to a message and re-applying it through the
// content's own settle window (below) keeps that message in place instead.
const chatScrollMemory = new Map<
  string,
  { offset: number; atBottom: boolean; anchor: ScrollAnchor | null }
>();

// Jump-to (`?seq=N`, opened from a sidebar search result): how long an open
// waits for the named message to appear before giving up and leaving the chat
// at its normal position; how long after landing the jump keeps re-centring
// through the transcript's own late layout; and how long the ring stays.
const JUMP_WAIT_MS = 5000;
const JUMP_SETTLE_MS = 1000;
const JUMP_HIGHLIGHT_MS = 2000;

// How long a restored (non-bottom) open keeps re-pinning to its anchor
// message as the transcript's own late layout (async markdown measurement,
// image loads, a permission card resolving) shifts height above it. Same
// order of magnitude as JUMP_SETTLE_MS — the cause is identical, just for an
// implicit restore rather than an explicit `?seq=` jump.
const RESTORE_SETTLE_MS = 1500;

// How long a restore waits for its anchor message to render at all — returning
// to a chat whose transcript is still being fetched has nothing to anchor to on
// the first layout pass, and must not spend the memory on that pass.
const RESTORE_WAIT_MS = 5000;

/** A message seq plus the pixel offset already scrolled past its top. */
interface ScrollAnchor {
  seq: number;
  delta: number;
}

/** A pending or just-applied jump to one message of one chat. */
interface JumpTarget {
  chatId: string;
  seq: number;
  found: boolean;
  /** Until when layout changes re-centre the target (set once found). */
  settleUntil: number;
  /** When a target that never appeared is dropped. */
  expireAt: number;
}

// How far a finger must travel DOWN the screen before the drag counts as
// scrolling the transcript up. Small enough to feel instant, large enough that
// the jitter of a finger landing on a tap target isn't a scroll.
const TOUCH_SCROLL_UP_SLOP = 2;

/**
 * spec/04 § Branching — the track switcher shown on ONE forked turn: which of
 * that fork point's tracks is active, how many there are, and the branch on
 * either side. `null` for an end of the range (the arrow is disabled).
 */
export interface TrackNav {
  index: number;
  total: number;
  prevBranchId: string | null;
  nextBranchId: string | null;
}

/**
 * Build the per-fork-point track navigation from a chat's branch graph.
 *
 * A fork point is a seq at which one or more branches were forked; its tracks
 * are the branch they forked FROM followed by the forks themselves, in creation
 * order. The active one is whichever track the active branch is on — the active
 * branch itself, or (for a fork of a fork) the ancestor of it that sits in this
 * fork point's track list.
 *
 * Returns a Map keyed by seq so the transcript can hand each entry a stable
 * object and keep its memoisation (spec/14 § Transcript render cost).
 */
export function buildTrackNav(
  branches: ChatBranch[],
  activeBranchId: string,
): Map<number, TrackNav> {
  const byId = new Map(branches.map((b) => [b.branchId, b]));
  // The active branch and every ancestor of it — the path through the graph.
  // Deepest-first: the active branch, then its parent, then its grandparent…
  const activePath: string[] = [];
  let cursor: string | null = activeBranchId;
  while (cursor !== null && !activePath.includes(cursor)) {
    activePath.push(cursor);
    cursor = byId.get(cursor)?.parentBranchId ?? null;
  }

  const bySeq = new Map<number, string[]>();
  for (const b of branches) {
    // spec/14 § Side threads panel — a side thread is never a track to
    // SWITCH to (it never becomes active, spec/04 § Branching), so it gets
    // its own marker (§ Side threads panel — "IN THE MAIN CHAT"), not a slot
    // in the edit-fork `‹ n/m ›` switcher.
    if (b.forkFromSeq === null || b.parentBranchId === null || b.sideThread) continue;
    const tracks = bySeq.get(b.forkFromSeq) ?? [b.parentBranchId];
    tracks.push(b.branchId);
    bySeq.set(b.forkFromSeq, tracks);
  }

  const out = new Map<number, TrackNav>();
  for (const [seq, tracks] of bySeq) {
    // The parent track is an ancestor of every fork made here, so it matches the
    // active path even when a FORK is the one being viewed. Resolve deepest-first
    // so the active track is the specific one on screen, not its ancestor.
    const activeId = activePath.find((id) => tracks.includes(id));
    const index = activeId === undefined ? -1 : tracks.indexOf(activeId);
    // A fork point on a track the user isn't currently on has no active member;
    // it isn't rendered (its turn isn't in this transcript either).
    if (index < 0) continue;
    out.set(seq, {
      index,
      total: tracks.length,
      prevBranchId: index > 0 ? (tracks[index - 1] ?? null) : null,
      nextBranchId: index < tracks.length - 1 ? (tracks[index + 1] ?? null) : null,
    });
  }
  return out;
}

export function ChatRoute({
  ws,
  chatId: chatIdProp,
  focused = true,
  initialSeq = null,
  onSeqConsumed,
}: {
  ws: PatchWs | null;
  /**
   * Panes and tabs (spec/14 § Panes and tabs): an explicit chatId, bypassing
   * the `:chatId` route param. More than one `ChatRoute` can be mounted at
   * once (one per open tab across panes), so only ONE render site — the
   * `/chats/:chatId` route itself — omits this and reads the URL.
   */
  chatId?: string;
  /**
   * Whether this is the focused pane's active tab. With several `ChatRoute`s
   * mounted at once, only the focused one may claim `chatStore.activeChatId`
   * and the desktop artifact panel — both are singular, app-wide "the chat
   * you're looking at right now" concepts (spec/14 § Panes and tabs).
   * Defaults to true so every pre-existing render site (still one `ChatRoute`
   * at a time) is unaffected.
   */
  focused?: boolean;
  /** Panes and tabs: a `?seq=` jump carried on the tab instead of the URL. */
  initialSeq?: number | null;
  onSeqConsumed?: () => void;
}): JSX.Element {
  const { chatId: paramChatId = '' } = useParams<{ chatId: string }>();
  const chatId = chatIdProp ?? paramChatId;
  // `?seq=N` — a sidebar search result asking for this chat opened AT that
  // message rather than at its latest (see the jump-to effects below). In
  // pane/tab mode (`chatIdProp` set) the jump rides on the tab instead — the
  // URL belongs to the focused pane alone, not every open tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const seqParam =
    chatIdProp === undefined
      ? searchParams.get('seq')
      : initialSeq === null
        ? null
        : String(initialSeq);
  useMarkChatNotificationsRead(chatId);
  const row = useChatStore((s) => s.chats[chatId]);
  const setActiveChat = useChatStore((s) => s.setActiveChat);
  const addLocalMessage = useChatStore((s) => s.addLocalMessage);
  const setGoal = useChatStore((s) => s.setGoal);
  const setReminder = useChatStore((s) => s.setReminder);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const patchLocalMessage = useChatStore((s) => s.patchLocalMessage);
  const clearTimeline = useChatStore((s) => s.clearTimeline);
  // spec/04 § Branching — the chat's track graph (undefined until the host
  // publishes one; a single-root graph shows no switcher).
  const branchGraph = useChatStore((s) => s.branchGraphs[chatId]);
  const resolvePermission = useChatStore((s) => s.resolvePermission);
  const timeline = useChatStore((s) => s.timelines[chatId] ?? EMPTY_TIMELINE);
  const pushError = useUiStore((s) => s.pushError);
  // Delivery-pending user turns render "sending…" when the host is online and
  // "queued — will send when the agent reconnects" when it is offline (spec/12).
  const daemonOnline = usePresenceStore((s) => s.daemonOnline);

  // spec/06 ## Composer policy: Speakers is a read-only mirror —
  // no composer, no mic. Manager keeps its full composer.
  const readOnlyMirror: boolean = chatId === SPECIAL_THREAD_IDS.speakers;
  // spec/06 § Disabled — a turned-off special thread also loses its composer,
  // Manager included: there is nothing to type into a thread whose ingress
  // (watch loop / bot / voice) has been told to stop delivering turns.
  const disabledThread: boolean = row?.disabled ?? false;
  const composerBlocked: boolean = readOnlyMirror || disabledThread;

  // Only the FOCUSED pane's tab may claim `activeChatId` — with panes and
  // tabs (spec/14 § Panes and tabs) several `ChatRoute`s can be mounted at
  // once, but it is a singular "the chat you're looking at right now" concept
  // (sidebar highlight, notification suppression, voice focus-follow, …).
  useEffect(() => {
    if (!focused) return;
    setActiveChat(chatId);
    // The chat stays mounted (and "active") across a mere backgrounding —
    // phone locked, switched app, occluded desktop window — so `chatStore`
    // stops pinning its read watermark while hidden (see the `activeTabVisible`
    // guard there), which means a turn that finished off-screen correctly
    // shows the green `done` dot rather than skipping straight to `read`. That
    // dot has to clear once the user is actually back looking at this already-
    // open chat, which nothing else re-triggers: re-run the same mark-read
    // `setActiveChat` does at mount whenever the tab becomes visible again.
    const onVisibility = (): void => {
      if (!document.hidden) setActiveChat(chatId);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      setActiveChat(null);
    };
  }, [chatId, focused, setActiveChat]);

  // spec/14 § Batch mode — ending: opening a chat anywhere counts, so this
  // reports it unconditionally; the server no-ops unless `chatId` is a member
  // of the running batch. Best-effort: a dropped call just leaves the chat
  // waiting to be opened again, which is not worth an error toast.
  useEffect(() => {
    if (!focused) return;
    void api.markBatchOpened(chatId).catch(() => undefined);
  }, [chatId, focused]);

  // spec/14 § Artifacts — the desktop web panel shows the artifact belonging to
  // the chat you are looking at. Opening a chat shows its artifact (or closes
  // the panel if it has none), and a width-0 inset we did not drive is the user
  // closing the panel themselves, which makes this chat forget its artifact.
  // The browser surface has no panel and no bridge, so all of this no-ops.
  // Gated on `focused` for the same reason as `activeChatId` above — the panel
  // is one Electron view shared across every pane, not one per tab.
  useEffect(() => {
    if (!focused) return;
    const bridge = getDesktopBridge();
    const off = bridge?.onPanelInset?.(({ width }) => notePanelInset(chatId, width));
    showArtifactFor(chatId);
    return off;
  }, [chatId, focused]);

  // Leaving the chat route entirely (settings, jobs, a new chat) — or losing
  // focus to a different pane — puts the panel away; regaining it re-opens
  // the chat's artifact through the effect above. Separate from it so a chat
  // SWITCH (same focused tab, different chatId) does not close-then-reopen.
  useEffect(() => {
    if (!focused) return;
    return closeArtifactPanel;
  }, [focused]);

  // Load this chat's transcript on open. The connect-time replay loop only
  // covers chats known when the socket opened; a chat that first appears
  // afterward — spawned on another surface (e.g. the phone) and learned about
  // via the always-on state-level fanout — has an empty transcript until it is
  // replayed on open, which also subscribes this surface to its live detail
  // events (spec/12 § Replay vs history cursors, spec/14 § Main chat panel).
  //
  // The device's own copy is painted FIRST (spec/12 § Cold start): a chat you
  // have opened before is on screen immediately, even offline, and the ask
  // that follows is only for what is newer than the last seq it holds —
  // `requestReplay` derives its cursor from the timeline, so feeding the
  // cache in is all it takes. Nothing is re-downloaded just because the app
  // restarted.
  useEffect(() => {
    if (!ws) return;
    let cancelled = false;
    void (async () => {
      if ((useChatStore.getState().timelines[chatId]?.length ?? 0) === 0) {
        const cached = await loadTranscript(chatId);
        if (cancelled) return;
        if (cached && cached.events.length > 0) {
          cachedBranch.current = cached.branchId;
          useChatStore.getState().applyEvents(cached.events as WireEvent[]);
        }
      }
      if (!cancelled) ws.requestReplay(chatId);
    })();
    void trimCache();
    return () => {
      cancelled = true;
    };
  }, [chatId, ws]);

  // The host is the record, and this is the moment it says which track the
  // chat is actually on. A fork, an edit or a branch switch makes everything
  // painted from the cache the WRONG track — so it is thrown away whole and
  // refetched, never merged into something that looks plausible. Loud,
  // because a cache disagreeing with its host is worth knowing about.
  const cachedBranch = useRef<string | null>(null);
  const activeBranchId = useChatStore((s) => s.branchGraphs[chatId]?.activeBranchId ?? null);
  useEffect(() => {
    if (!ws || activeBranchId === null) return;
    const stale = cachedBranch.current;
    if (stale !== null && stale !== activeBranchId) {
      console.warn(
        `[patch] cached transcript for ${chatId} is branch ${stale}, host says ${activeBranchId} — refetching`,
      );
      cachedBranch.current = null;
      void dropTranscript(chatId);
      useChatStore.getState().clearTimeline(chatId);
      ws.requestReplay(chatId, { force: true });
      return;
    }
    cachedBranch.current = activeBranchId;
    void setBranch(chatId, activeBranchId);
  }, [chatId, ws, activeBranchId]);

  // spec/14 ## Main chat panel — the stream is a transcript: opening a chat
  // lands you on the LATEST message (bottom), and a new message/reply scrolls
  // into view. Without this the .chat-stream stays pinned at scrollTop 0 (the
  // oldest message) on load, and freshly-sent turns land off-screen below.
  const streamRef = useRef<HTMLElement>(null);
  // Mirrors `followRef` for the floating down arrow (spec/14 § Main chat panel).
  const [showScrollDown, setShowScrollDown] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  // spec/14 § Composer — dropping a file anywhere over the chat panel (header,
  // banners, transcript) attaches it, same as dropping onto the composer
  // strip itself. `composerRef` is how the whole-panel zone below reaches the
  // composer's own attachment state, which it doesn't otherwise have access to.
  const composerRef = useRef<ComposerHandle>(null);
  const meeting = useMeetingStore((s) => s.byChat[chatId]);
  const chatDrop = useWholeChatDrop(composerRef);
  // Follow mode: while true we keep the latest message pinned in view. A fresh
  // open starts in follow mode; the user scrolling UP to read history turns it
  // off; scrolling back to the bottom turns it on again. Programmatic scrolls
  // we issue must NOT be mistaken for the user scrolling away.
  const followRef = useRef(true);
  // Remembers the exact scrollTop value WE last set programmatically, so the
  // scroll handler can recognise the browser's own echo of it and ignore that
  // event (Todoist: "when sending a message, does not reliably scroll all the
  // way to the bottom, still have to scroll down a bit further"). This used
  // to be a boolean cleared on a fixed one-frame timer, on the assumption
  // that the echo always arrives before that timer fires — which isn't
  // guaranteed (main thread busy right after a send), so a late echo got
  // misread as the user scrolling away and permanently disengaged follow.
  // Comparing against the value we actually set instead of racing a timer
  // holds regardless of how late the echo is dispatched: we never animate
  // scrollTop, so any value that doesn't match it is a genuine user scroll.
  const selfScrollTopRef = useRef<number | null>(null);
  // The last scroll geometry we know about, from ANY source — our own
  // programmatic pins as well as the browser's scroll events. A position test
  // ("are we within 50px of the bottom?") cannot answer "is the user scrolling
  // up" while the transcript is streaming, because the content grows under
  // them: a small wheel up still measures as at-bottom, follow stays on, and
  // the next pin yanks them back down. A MOVEMENT test can — we only ever
  // scroll DOWN (to the bottom), so any drop in scrollTop beyond what a
  // shrinking scroll range accounts for is the user going up.
  const lastScrollRef = useRef({ top: 0, maxTop: 0 });
  // Where the current touch drag started, so a finger dragged DOWN the screen
  // (which scrolls the transcript UP) reads as scroll-up intent.
  const touchStartYRef = useRef<number | null>(null);
  // The initial restore/scroll-to-end runs once per open, on the first content
  // measurement — the timeline hydrates a frame or two after mount.
  const restoredRef = useRef(false);
  // Every optimistic-echo localId this open has ever seen. A send is an echo
  // APPEARING, so the effect below re-pins on a localId that is not in here,
  // which is once per send (spec/14 § Main chat panel).
  //
  // The whole set, not just the newest: echoes lose their localId one at a
  // time as the host's persisted copies reconcile (chatStore § chat.message),
  // so with two sends in flight the newer one reconciling first makes the OLDER
  // one the newest still-pending echo again. Against a single remembered
  // localId that reads as a fresh send and yanks the stream for a turn sent
  // minutes ago; against a set of everything seen, it is correctly nothing.
  //
  // `null` means "not seeded for this open yet": an echo already in the
  // transcript when the chat opens was sent before this open, so the first run
  // records it WITHOUT scrolling — the open's own restore-or-pin owns where
  // that lands.
  const seenLocalIdsRef = useRef<Set<string> | null>(null);
  // Whether a send has re-pinned since this chat was opened.
  const repinnedForSendRef = useRef(false);
  // The message a `?seq=` open is heading for. Held in a ref, not read from the
  // URL, because the param is cleared as soon as it is taken — so a later
  // re-render (or reopening the chat) never jumps again.
  const jumpRef = useRef<JumpTarget | null>(null);
  // A restore-to-remembered-position that landed on an anchor message: kept
  // here so the ResizeObserver can keep re-pinning to that message (not a bare
  // pixel offset) for RESTORE_SETTLE_MS after open, the same way `jumpRef`
  // keeps a `?seq=` jump re-centred through the transcript's late layout.
  // `null` once settled, cleared, or overtaken by a genuine user scroll.
  const restoreAnchorRef = useRef<{
    chatId: string;
    anchor: ScrollAnchor;
    /** The anchor message has rendered and been put back in place. */
    found: boolean;
    settleUntil: number;
    /** When an anchor message that never rendered is given up on. */
    expireAt: number;
  } | null>(null);

  function setSelfScrollTop(el: HTMLElement, value: number): void {
    el.scrollTop = value;
    // Read back the (possibly clamped) applied value, not `value` itself.
    selfScrollTopRef.current = el.scrollTop;
    // Our own pin is the new "last known position": without this, a user wheel
    // that lands before the browser has dispatched the pin's own scroll event
    // would be measured against a position two pins old and read as downward.
    lastScrollRef.current = { top: el.scrollTop, maxTop: el.scrollHeight - el.clientHeight };
  }

  // The user has asked to go UP. Stop following immediately and unconditionally
  // (spec/14 § Main chat panel): a re-pin scheduled for this same frame must not
  // land, and no position test gets a say, because during streaming the content
  // grows under the user and a small scroll up still measures as "at bottom".
  // Only when there is somewhere above to go — a wheel against a stream already
  // at its top scrolls nothing, so it is not a scroll at all.
  function cancelFollow(): void {
    const el = streamRef.current;
    if (!el || el.scrollTop <= 0) return;
    followRef.current = false;
  }

  // Wheel/trackpad up.
  function onStreamWheel(e: React.WheelEvent<HTMLElement>): void {
    if (e.deltaY < 0) cancelFollow();
  }

  // A touch drag: the finger moving DOWN the screen scrolls the transcript UP.
  function onStreamTouchStart(e: React.TouchEvent<HTMLElement>): void {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }

  function onStreamTouchMove(e: React.TouchEvent<HTMLElement>): void {
    const startY = touchStartYRef.current;
    const y = e.touches[0]?.clientY;
    if (startY === null || y === undefined) return;
    if (y > startY + TOUCH_SCROLL_UP_SLOP) cancelFollow();
  }

  function onStreamTouchEnd(): void {
    touchStartYRef.current = null;
  }

  // The keys that scroll a scrollport up. Shift+Space is Space's reverse.
  function onStreamKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'PageUp' || k === 'Home' || (k === ' ' && e.shiftKey)) {
      cancelFollow();
    }
  }

  function scrollToBottom(): void {
    const el = streamRef.current;
    if (!el) return;
    setSelfScrollTop(el, el.scrollHeight);
  }

  // The message currently straddling the stream's top edge, and how far
  // scrolled past its top — the anchor a remembered position is really
  // about, rather than the pixel count that happened to land there. `null`
  // when nothing renders yet (an empty transcript, or the stream itself not
  // mounted), in which case the caller falls back to the raw offset.
  function captureScrollAnchor(el: HTMLElement): ScrollAnchor | null {
    const box = el.getBoundingClientRect();
    const msgs = el.querySelectorAll<HTMLElement>('[data-testid="msg"][data-seq]');
    for (const m of msgs) {
      const r = m.getBoundingClientRect();
      if (r.bottom <= box.top) continue;
      const seq = Number(m.dataset.seq);
      if (!Number.isFinite(seq)) return null;
      return { seq, delta: box.top - r.top };
    }
    return null;
  }

  // Put `anchor`'s message back at the same offset past its top that it was
  // at when the anchor was captured. Returns false if the message hasn't
  // rendered (yet) — the caller keeps the raw-offset restore, or (during the
  // settle window) simply tries again on the next layout pass.
  function applyScrollAnchor(el: HTMLElement, anchor: ScrollAnchor): boolean {
    const target = el.querySelector<HTMLElement>(
      `[data-testid="msg"][data-seq="${String(anchor.seq)}"]`,
    );
    if (target === null) return false;
    const box = el.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const top = el.scrollTop + (t.top - box.top) + anchor.delta;
    setSelfScrollTop(el, Math.max(0, top));
    return true;
  }

  // Centre the jump target in the stream if it is on screen yet. Returns true
  // when it positioned something. The first landing turns follow mode off (the
  // user asked to read HERE, not at the latest message) and rings the message
  // briefly. Positioned through `setSelfScrollTop`, so the scroll handler reads
  // it as ours rather than as the user scrolling away.
  function tryJump(): boolean {
    const jump = jumpRef.current;
    const el = streamRef.current;
    if (jump === null || jump.chatId !== chatId || el === null) return false;
    if (!jump.found && Date.now() > jump.expireAt) {
      jumpRef.current = null;
      return false;
    }
    const target = el.querySelector<HTMLElement>(
      `[data-testid="msg"][data-seq="${String(jump.seq)}"]`,
    );
    if (target === null) return false;
    const box = el.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const offset = el.scrollTop + (t.top - box.top);
    // A message taller than the stream can't be centred; show its start.
    const top =
      t.height > el.clientHeight ? offset - 16 : offset - (el.clientHeight - t.height) / 2;
    followRef.current = false;
    setSelfScrollTop(el, Math.max(0, top));
    if (!jump.found) {
      jump.found = true;
      jump.settleUntil = Date.now() + JUMP_SETTLE_MS;
      target.classList.add('msg-jump-target');
      window.setTimeout(() => target.classList.remove('msg-jump-target'), JUMP_HIGHLIGHT_MS);
    }
    return true;
  }

  // Initial position for an open: restore the remembered position if the user
  // had scrolled up in this chat, otherwise pin to the latest message. The
  // remembered position restores by ANCHOR (the message that was at the top
  // edge, held in place) when one was captured; that also arms the settle
  // window the ResizeObserver re-applies it through, below. Only a chat with
  // no anchor (nothing had rendered under the saved position yet) falls back
  // to the bare pixel offset, which has no settle correction.
  function applyInitialScroll(): void {
    const el = streamRef.current;
    if (!el) return;
    const saved = chatScrollMemory.get(chatId);
    if (saved && !saved.atBottom) {
      if (saved.anchor) {
        const found = applyScrollAnchor(el, saved.anchor);
        // Not rendered yet: hold the raw offset for now and keep the restore
        // pending so the ResizeObserver lands it once the message appears.
        if (!found) setSelfScrollTop(el, saved.offset);
        restoreAnchorRef.current = {
          chatId,
          anchor: saved.anchor,
          found,
          settleUntil: Date.now() + RESTORE_SETTLE_MS,
          expireAt: Date.now() + RESTORE_WAIT_MS,
        };
      } else {
        setSelfScrollTop(el, saved.offset);
      }
    } else {
      scrollToBottom();
    }
  }

  // A chatId change is a fresh open: seed follow mode from the remembered
  // position (re-pin unless the user had scrolled up) and re-arm the restore.
  // The authoritative positioning happens on the first ResizeObserver fire once
  // the content has laid out; this best-effort pass covers an already-cached
  // timeline and avoids a flash at the top.
  useEffect(() => {
    const saved = chatScrollMemory.get(chatId);
    followRef.current = saved ? saved.atBottom : true;
    restoredRef.current = false;
    restoreAnchorRef.current = null;
    // Declared BEFORE the send-re-pin effect on purpose: within the commit that
    // changes chatId this runs first, so that effect re-seeds against the chat
    // now on screen rather than carrying the last one's echoes over.
    seenLocalIdsRef.current = null;
    repinnedForSendRef.current = false;
    lastScrollRef.current = { top: 0, maxTop: 0 };
    touchStartYRef.current = null;
    applyInitialScroll();
  }, [chatId]);

  // Take a `?seq=` jump. Declared AFTER the open effect above so, in the commit
  // that opens a chat at a message, the open's own restore-or-pin runs first
  // and this then overrides it. The param is removed straight away (a replace,
  // so Back doesn't return to it); the target lives on in `jumpRef`. A target
  // that is not on screen yet is retried as the timeline hydrates (below) and on
  // every layout change (the ResizeObserver); until it appears the chat sits at
  // its normal position, and if it never does it simply stays there.
  useEffect(() => {
    if (seqParam === null) {
      if (jumpRef.current !== null && jumpRef.current.chatId !== chatId) jumpRef.current = null;
      return;
    }
    if (chatIdProp === undefined) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('seq');
          return next;
        },
        { replace: true },
      );
    } else {
      onSeqConsumed?.();
    }
    const seq = Number(seqParam);
    if (!Number.isInteger(seq) || seq < 0) {
      jumpRef.current = null;
      return;
    }
    jumpRef.current = {
      chatId,
      seq,
      found: false,
      settleUntil: 0,
      expireAt: Date.now() + JUMP_WAIT_MS,
    };
    tryJump();
  }, [chatId, seqParam, chatIdProp, setSearchParams, onSeqConsumed]);

  // The timeline hydrates over several frames after an open; retry a jump
  // whose message has not rendered yet each time it grows.
  useEffect(() => {
    const jump = jumpRef.current;
    if (jump === null || jump.found) return;
    tryJump();
  }, [timeline]);

  // While in follow mode, keep the latest message in view after every timeline
  // change (new turn, streaming token, tool block). rAF so the DOM has settled
  // its height for this paint before we measure scrollHeight.
  useEffect(() => {
    if (!followRef.current) return;
    requestAnimationFrame(() => {
      if (followRef.current) scrollToBottom();
    });
  }, [timeline]);

  // Sending a message re-pins to the bottom (spec/14 § Main chat panel): even if
  // the user had scrolled up to read history, their new turn — and the reply
  // that follows — must be in view. The freshly-sent turn is the optimistic user
  // message (it carries a `localId`), so a NEW localId anywhere in the timeline
  // is a send: re-engage follow and scroll.
  //
  // "Anywhere", not "at the end". The echo is the last entry at the instant it
  // is appended, but only then: anything the turn emits next — a
  // permission-mode marker, a permission card, the first tool call, an error —
  // lands after it, and a test that only ever reads `timeline[length - 1]`
  // silently stops re-pinning the moment a send and one of those share a
  // commit. Identity is the localId, not the position. Matches mobile's
  // `app/chats/[chatId].tsx`.
  useEffect(() => {
    const seen = seenLocalIdsRef.current;
    const pending = new Set<string>();
    let newest: string | undefined;
    for (const e of timeline) {
      if (e.kind === 'message' && e.role === 'user' && e.localId !== undefined) {
        pending.add(e.localId);
        newest = e.localId;
      }
    }
    // Union, never a replacement: a localId that has reconciled away must not
    // be able to look new if an older pending echo puts it back in play.
    seenLocalIdsRef.current = seen === null ? pending : new Set([...seen, ...pending]);
    if (seen === null) return;
    if (newest === undefined || seen.has(newest)) return;
    repinnedForSendRef.current = true;
    followRef.current = true;
    requestAnimationFrame(() => scrollToBottom());
  }, [timeline]);

  // The timeline hydrates and streams in over several frames AFTER the first
  // render — markdown/diff/tool blocks measure and grow the scrollHeight long
  // after the effects above ran, which would otherwise strand us mid-history.
  // A ResizeObserver on the content re-pins through every post-mount height
  // change for as long as we're in follow mode; it self-disengages the moment
  // the user scrolls up (followRef flips false).
  //
  // Also observes the STREAM (the scrollport itself, not just its content):
  // opening the mobile keyboard shrinks `.chat-stream`'s own height (the
  // viewport meta's `interactive-widget=resizes-content` — index.html — makes
  // the browser resize the layout instead of panning the page over it), which
  // is a resize of the container, not the content, so it would otherwise never
  // reach this callback. Reusing the exact same callback means the outcome
  // matches what follow mode already dictates: still following → the newest
  // message re-pins into the now-shorter view (same as mobile's
  // `keyboardDidShow` re-pin in `app/chats/[chatId].tsx`); reading history →
  // `followRef.current` is false, scrollTop is untouched, and whatever was on
  // screen stays exactly where it was.
  useEffect(() => {
    const content = contentRef.current;
    const stream = streamRef.current;
    if (!content || !stream) return;
    const ro = new ResizeObserver(() => {
      // A jump target outranks both the restore-or-pin and follow: while it is
      // still landing (or settling through late layout), re-centre on it. Not
      // found yet → fall through to the normal position until it appears.
      const jump = jumpRef.current;
      if (
        jump !== null &&
        jump.chatId === chatId &&
        (!jump.found || Date.now() < jump.settleUntil) &&
        tryJump()
      ) {
        restoredRef.current = true;
        return;
      }
      /* v8 ignore next 7 -- unreachable under jsdom: the test-suite's ResizeObserver shim (src/__tests__/setup.ts) has no-op observe()/disconnect() and never actually invokes this callback (jsdom has no layout engine to trigger a real resize). The equivalent restore-or-pin behavior IS exercised directly via `applyInitialScroll`/`scrollToBottom` in the mount-time and follow-mode effects above; only the ResizeObserver wiring itself is unverifiable here. */
      // First measurement after an open: do the authoritative restore-or-pin.
      // A send that has already happened this open outranks the remembered
      // position — the user has said where they want to be more recently than
      // the memory has — so pin to the bottom instead of undoing it.
      if (!restoredRef.current) {
        restoredRef.current = true;
        if (repinnedForSendRef.current) scrollToBottom();
        else applyInitialScroll();
        return;
      }
      // A restore that landed on an anchor message keeps re-pinning to it
      // for RESTORE_SETTLE_MS: the same late layout that needs `follow` mode
      // re-pinned to the bottom on every fire (above) also moves an anchored
      // message that isn't at the bottom, and nothing else corrects it — see
      // the block comment above `chatScrollMemory`.
      /* v8 ignore start -- unreachable under jsdom, same as the ignore above: this only runs on a LATER ResizeObserver fire, which the test-suite's no-op shim never produces. The anchor math itself IS exercised directly via `applyInitialScroll` → `applyScrollAnchor` in ChatRoute.test.tsx's "restores by anchoring…" case; only this re-firing wiring is unverifiable here. */
      const restore = restoreAnchorRef.current;
      if (restore !== null && restore.chatId === chatId) {
        const el = streamRef.current;
        if (!restore.found && Date.now() < restore.expireAt) {
          if (el && applyScrollAnchor(el, restore.anchor)) {
            restore.found = true;
            restore.settleUntil = Date.now() + RESTORE_SETTLE_MS;
          }
          return;
        }
        if (restore.found && Date.now() < restore.settleUntil) {
          if (el) applyScrollAnchor(el, restore.anchor);
          return;
        }
        restoreAnchorRef.current = null;
      }
      /* v8 ignore stop */
      if (followRef.current) scrollToBottom();
    });
    ro.observe(content);
    ro.observe(stream);
    return () => ro.disconnect();
  }, [chatId]);

  function onStreamScroll(e: React.UIEvent<HTMLElement>): void {
    const el = e.currentTarget;
    const maxTop = el.scrollHeight - el.clientHeight;
    const prev = lastScrollRef.current;
    lastScrollRef.current = { top: el.scrollTop, maxTop };
    // Ignore the scroll event our own scrollToBottom()/restore just produced
    // — only a genuine USER scroll should toggle follow mode. Otherwise the
    // progressive height growth during load would flip follow off mid-pin.
    // Value-based, not timing-based: see `selfScrollTopRef`'s comment.
    if (
      selfScrollTopRef.current !== null &&
      Math.abs(el.scrollTop - selfScrollTopRef.current) < 2
    ) {
      selfScrollTopRef.current = null;
      return;
    }
    selfScrollTopRef.current = null;
    // The user has taken over: a jump still landing or settling must not pull
    // them back, and neither must a still-settling restore (above).
    jumpRef.current = null;
    restoreAnchorRef.current = null;
    // A shrinking scroll range (a tool block collapsing, a placeholder being
    // replaced) drops scrollTop by exactly the amount the range lost, with no
    // input from anyone — subtract it before reading the rest as intent.
    const shrank = Math.max(0, prev.maxTop - maxTop);
    const movedUp = el.scrollTop < prev.top - shrank - 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
    // Moving up wins over the position test: mid-stream the bottom is moving
    // away from the user faster than they are scrolling, so "still within 50px
    // of the bottom" is true for the first few wheel notches of a deliberate
    // scroll up — and re-engaging follow there is exactly the yank.
    followRef.current = movedUp ? false : atBottom;
    setShowScrollDown(!followRef.current);
    // Remember this chat's position so reopening restores it (spec/14 § Main
    // chat panel) — anchored to whichever message is at the top edge rather
    // than the bare pixel offset, so it survives that message's own content
    // laying out differently between now and the reopen.
    chatScrollMemory.set(chatId, {
      offset: el.scrollTop,
      atBottom: followRef.current,
      anchor: followRef.current ? null : captureScrollAnchor(el),
    });
  }

  // spec/14 ## Main chat panel — "Transcript render cost is O(changed), not
  // O(transcript)". <TimelineEntry> is memoised on its entry object, which the
  // store replaces only for the entry an event actually touches. That
  // memoisation is only worth anything if the callbacks we hand each entry keep
  // their identity across renders — a fresh closure per render would make every
  // memo comparison fail and put us straight back to re-rendering the whole
  // transcript on every streaming token. Hence useCallback on all four, and a
  // ref (not the `timeline` value) for the approve-all sweep, whose whole point
  // is to read the LATEST timeline at click time.
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  // `answers` is only ever supplied for an `AskUserQuestion` card: the user's
  // selections have to reach the tool's `answers` argument, and the wire
  // protocol carries them on the existing `approve_with_edits` channel rather
  // than a new field, so a host running behind the web surface still
  // decodes the frame (spec/03 § Answering with content).
  const handlePermission = useCallback(
    (requestId: string, approve: boolean, answers?: Record<string, string>): void => {
      if (!ws) {
        pushError('not connected');
        return;
      }
      try {
        // Routed through `permissionDeliveryTracker`, not a bare `ws.send`: a
        // response sent down a socket that LOOKS open but is actually dead
        // (the zombie-link window ws.ts's heartbeat exists to close) used to
        // be silently lost — the card still resolved optimistically below,
        // but the host never heard about it and its own expiry timer denied
        // the request anyway (Tom, Todoist: "questions are timing out after I
        // answer them"). The tracker redelivers until it observes the
        // host's echo.
        permissionDeliveryTracker.send(
          answers
            ? {
                type: 'chat.permission_response',
                chatId,
                requestId,
                approve: true,
                decision: 'approve_with_edits',
                editedNewString: JSON.stringify(answers),
              }
            : { type: 'chat.permission_response', chatId, requestId, approve },
          (event) => ws.send(event),
        );
        // Optimistically clear the pause locally so the badge + waiting-pill
        // drop immediately; the host's follow-up `chat.state` settles activity.
        // `answers` (only ever set for an `AskUserQuestion`) rides along so the
        // resolved card can still show what was picked after a remount — see
        // `permissionAnswers` on `ChatEventEntry`.
        resolvePermission(chatId, requestId, approve ? 'approve' : 'deny', answers);
        // G2-d3/d4: a single permission_request is presented by BOTH the inline
        // card here AND the right-rail DiffPanel (Deny/Approve). Resolving from
        // either must tear down the other so there is never a stale, still-
        // actionable Approve/Deny for an already-decided request — clicking such
        // a stale control would also throw the Monaco "TextModel got disposed"
        // error (d4). Clear the right-rail pending diff for this chat.
        useUiStore.getState().clearPendingDiffForChat(chatId, requestId);
      } catch (err) {
        pushError(failed('permission'), undefined, (err as Error).message);
      }
    },
    [ws, chatId, pushError, resolvePermission],
  );

  // `2` / "Approve all outstanding": approve EVERY currently-unresolved
  // permission request
  // in this chat, and nothing beyond them — it is a one-off sweep of what is
  // outstanding right now, not a mode that keeps approving what arrives next.
  // The wire protocol has no server-side "approve all" decision (only approve /
  // deny / approve_with_edits), so this is faithfully a client-side sweep of
  // the cards on screen. A question card is skipped: an `AskUserQuestion` has no answer a
  // blanket approval could honestly give, and approving it is precisely the
  // empty-answer bug (spec/14 § Main chat panel — Question prompts).
  const handleApproveAllPending = useCallback((): void => {
    timelineRef.current
      .filter(isSweepablePermission)
      .forEach((e) => handlePermission(e.requestId as string, true));
  }, [handlePermission]);

  // Tom, Todoist: "what does approve all actually do in patch, need to be
  // clearer" → the control only earns its place when there is genuinely more
  // than one request to sweep; on the ordinary single-approval card it just
  // duplicates Approve, and reading it as a mode ("approve everything from now
  // on") is the confusion. One pending request shows Approve / Deny only.
  const pendingApprovalCount = useMemo(
    () => timeline.reduce((n, e) => (isSweepablePermission(e) ? n + 1 : n), 0),
    [timeline],
  );

  const handleQuestionAnswer = useCallback(
    (requestId: string, answers: Record<string, string>): void => {
      handlePermission(requestId, true, answers);
    },
    [handlePermission],
  );

  const handleQuestionCancel = useCallback(
    (requestId: string): void => {
      handlePermission(requestId, false);
    },
    [handlePermission],
  );

  const handleUnqueue = useCallback(
    (localId: string): void => {
      // spec/04 ## Message queueing: cancel a still-pending queued turn.
      // Optimistic local removal + fire chat.unqueue_request; the host's
      // chat.dequeued echo then no-ops.
      removeQueued(chatId, localId);
      if (ws) {
        try {
          ws.send({ type: 'chat.unqueue_request', chatId, localId });
        } catch (err) {
          pushError(failed('unqueue'), undefined, (err as Error).message);
        }
      }
    },
    [ws, chatId, pushError, removeQueued],
  );

  const handlePromote = useCallback(
    (localId: string): void => {
      // spec/04 ## Message queueing § Promote: interrupt the running turn so
      // the queue starts draining now instead of waiting for it to finish
      // naturally. This never reorders the queue — turns already queued above
      // this one are already scheduled to run sooner and get pushed along
      // with it, not shoved behind it.
      if (ws) {
        try {
          ws.send({ type: 'chat.promote_request', chatId, localId });
          patchLocalMessage(chatId, localId, { sentNow: true });
        } catch (err) {
          pushError(failed('promote'), undefined, (err as Error).message);
        }
      }
    },
    [ws, chatId, pushError, patchLocalMessage],
  );

  // spec/04 ## Message queueing § Edit — the queued message whose editor is
  // open, and what is typed in it. Held HERE rather than in the row: a queued
  // row is keyed on its localId and a row that starts running is re-keyed, so
  // row state would vanish at exactly the moment it is needed (the edit that
  // lost the race has to go into the composer).
  const [queuedEdit, setQueuedEdit] = useState<{ localId: string; text: string } | null>(null);
  // Text handed to the mounted composer (a queued edit that lost the race).
  const [composerInsert, setComposerInsert] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  // spec/20-hooks.md § On the user's message — `checking` drives the
  // composer's "Checking…" state; `hookBlock` is the pending send a `block`
  // (or a failed/timed-out hook) held, shown as a card above the composer
  // until the user picks Use suggestion / Edit / Send anyway.
  const [hookChecking, setHookChecking] = useState(false);
  const [hookBlock, setHookBlock] = useState<{
    message: string;
    files: OutgoingFile[];
    results: HookRunResult[];
  } | null>(null);
  const [composerReplace, setComposerReplace] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  useEffect(() => {
    setQueuedEdit(null);
    setComposerInsert(null);
    setHookChecking(false);
    setHookBlock(null);
  }, [chatId]);

  const handleQueuedDraft = useCallback((localId: string, text: string | null): void => {
    setQueuedEdit(text === null ? null : { localId, text });
  }, []);

  // The message left the queue while its editor was open: it went in (or was
  // removed) with its OLD text. Close the editor, say so, and keep the edit.
  useEffect(() => {
    if (!queuedEdit) return;
    const still = timeline.find((e) => e.kind === 'message' && e.localId === queuedEdit.localId);
    if (still?.queued) return;
    pushError(
      still
        ? 'That message had already been sent — your edit is in the composer.'
        : 'That message was removed from the queue — your edit is in the composer.',
    );
    setComposerInsert({ text: queuedEdit.text, nonce: Date.now() });
    setQueuedEdit(null);
  }, [timeline, queuedEdit, pushError]);

  const handleEditQueued = useCallback(
    (entry: ChatEventEntry, text: string): void => {
      const localId = entry.localId!;
      setQueuedEdit(null);
      // An edit to nothing on a message with nothing attached is a remove.
      if (text.length === 0 && !(entry.attachments && entry.attachments.length > 0)) {
        handleUnqueue(localId);
        return;
      }
      if (!ws) {
        pushError('not connected');
        return;
      }
      try {
        ws.send({ type: 'chat.edit_queued_request', chatId, localId, message: text });
      } catch (err) {
        pushError(failed('editing the queued message'), undefined, (err as Error).message);
      }
    },
    [ws, chatId, pushError, handleUnqueue],
  );

  const handleRetryDelivery = useCallback(
    (localId: string): void => {
      deliveryTracker.retry(chatId, localId);
    },
    [chatId],
  );

  // A `turnFailed` message was already delivered and run — its `localId` is
  // permanently used up (the host dedups a repeat), so retrying it is a
  // brand new turn with the same text, not a re-send of the old localId
  // (unlike `handleRetryDelivery`, which re-sends one that never took effect).
  const handleRetryTurn = useCallback(
    (entry: ChatEventEntry): void => {
      if (!ws) {
        pushError('not connected');
        return;
      }
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      addLocalMessage(chatId, entry.content ?? '', localId, undefined, entry.attachments);
      const disabledTools = useToolsStore.getState().disabledFor(chatId);
      deliveryTracker.submit(
        chatId,
        entry.content ?? '',
        localId,
        entry.attachments,
        (e) => ws.send(e),
        disabledTools,
      );
    },
    [ws, chatId, addLocalMessage, pushError],
  );

  // spec/14 § Running-turn controls — a `turnStopped` message was already seen
  // by the agent before the user stopped it, so "Continue" sends a fresh nudge
  // turn rather than re-submitting this message's text (which the agent already
  // has in context and would just see twice).
  const handleContinueTurn = useCallback((): void => {
    if (!ws) {
      pushError('not connected');
      return;
    }
    sendMessage(chatId, 'Continue', [], { send: (e) => ws.send(e) });
  }, [ws, chatId, pushError]);

  // spec/04 § Branching — one stable TrackNav per fork point, rebuilt only when
  // the graph itself changes so the transcript's memoisation survives.
  const trackNav = useMemo(
    () =>
      branchGraph
        ? buildTrackNav(branchGraph.branches, branchGraph.activeBranchId)
        : new Map<number, TrackNav>(),
    [branchGraph],
  );

  const handleFork = useCallback(
    (seq: number, message: string): void => {
      if (!ws) {
        pushError('not connected');
        return;
      }
      // Everything from the edited turn down belongs to the track we're
      // leaving. The prefix ABOVE it is shared with the new track, so keep it
      // and let the fork's turn stream in beneath — no replay round-trip, and
      // never a moment showing a conversation that no longer exists.
      useChatStore.setState((s) => ({
        timelines: {
          ...s.timelines,
          [chatId]: (s.timelines[chatId] ?? []).filter((e) => e.seq < seq),
        },
      }));
      try {
        ws.send({
          type: 'chat.fork_request',
          chatId,
          seq,
          message,
          localId: `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
      } catch (err) {
        pushError(failed('edit'), undefined, (err as Error).message);
      }
    },
    [ws, chatId, pushError],
  );

  const handleSwitchTrack = useCallback(
    (branchId: string): void => {
      if (!ws) {
        pushError('not connected');
        return;
      }
      // A different track is a different conversation: drop this one and let
      // the host's replay of the newly-active track repopulate it. The
      // requests travel in order on the same socket, so the replay reflects the
      // switch that preceded it.
      clearTimeline(chatId);
      try {
        ws.send({ type: 'chat.branch_switch_request', chatId, branchId });
        // force: the just-cleared timeline recomputes fromSeq -1, which can
        // collide with the cursor cached by this chat's very first load
        // (see api/ws.ts's requestReplay) and get silently dropped.
        ws.requestReplay(chatId, { force: true });
      } catch (err) {
        pushError(failed('switching track'), undefined, (err as Error).message);
      }
    },
    [ws, chatId, pushError, clearTimeline],
  );

  if (!row) {
    return <ChatNotFound chatId={chatId} />;
  }

  async function handleSend(message: string, files?: OutgoingFile[]): Promise<boolean | void> {
    // patch/todo.md — `/goal <text>` sets the chat's goal INSTEAD of sending a
    // chat turn (a bare `/goal` clears it). It's a REST mutation (no WS needed),
    // handled before the connection check so it works even while a turn's WS is
    // down. Optimistic set, reverting + surfacing a toast on failure (NO FALLBACK).
    // `/clear` clears the visible chat transcript from the UI without touching
    // server-side history. The host still has the full history; the surface
    // just starts with a blank screen so the chat feels fresh.
    if (parseClearCommand(message)) {
      clearTimeline(chatId);
      return;
    }
    // spec/04 § Goals — `/goal <condition>` sets the goal AND starts a turn
    // with `condition` as the directive, exactly as typing it yourself would
    // (Claude Code's own `/goal`). A bare `/goal` (goal: null) clears it and
    // sends nothing — there is no condition to act on. Either way the set is
    // a REST mutation (no WS needed), optimistic, reverting + toasting on
    // failure (NO FALLBACK).
    const parsedGoal = parseGoalCommand(message);
    if (parsedGoal.isGoal) {
      const prev = row?.goal ?? null;
      setGoal(chatId, parsedGoal.goal);
      void api.setGoal(chatId, parsedGoal.goal).catch((err) => {
        setGoal(chatId, prev);
        pushError(failed('setting goal'), undefined, (err as Error).message);
      });
      if (parsedGoal.goal === null) return;
      message = parsedGoal.goal;
    }
    // patch/todo.md — `/remind <text>` sets the chat's reminder INSTEAD of
    // sending a chat turn (a bare `/remind` clears it). REST mutation (no WS),
    // optimistic set, reverting + surfacing a toast on failure (NO FALLBACK).
    const parsedReminder = parseReminderCommand(message);
    if (parsedReminder.isReminder) {
      const prev = row?.reminder ?? null;
      setReminder(chatId, parsedReminder.reminder);
      void api.setReminder(chatId, parsedReminder.reminder).catch((err) => {
        setReminder(chatId, prev);
        pushError(failed('setting reminder'), undefined, (err as Error).message);
      });
      return;
    }
    // 02-daemon.md § Self-wake — `/loop <interval> <message>` arms a durable
    // recurring self-wake INSTEAD of sending a chat turn; a bare `/loop`
    // cancels it. Unlike `/goal`/`/remind` this is not local banner state — it
    // is a REST call straight through to the host's WakeScheduler (the same
    // one `patch_loop` reaches), so there is nothing to set optimistically
    // here: the wake bar picks it up off the `chat.state` echo, same as an
    // agent-armed wake already does today.
    const parsedLoop = parseLoopCommand(message);
    if (parsedLoop.isLoop) {
      if (parsedLoop.every === null) {
        void api.setLoop(chatId, null).catch((err) => {
          pushError(failed('stopping loop'), undefined, (err as Error).message);
        });
      } else if (parsedLoop.message === null) {
        pushError('usage: /loop <interval> <message>');
      } else {
        void api
          .setLoop(chatId, { every: parsedLoop.every, message: parsedLoop.message })
          .catch((err) => {
            pushError(failed('starting loop'), undefined, (err as Error).message);
          });
      }
      return;
    }
    // spec/04-chats-and-folders.md § Model — `/model <name>` changes the
    // chat's model INSTEAD of sending a chat turn, the same way the picker
    // does (`chat.model_request` on the live socket), matched against the
    // host's catalogue by id/label. A bare `/model`, or a query matching zero
    // or more than one catalogue entry, is a usage error and sends nothing —
    // never rounded to a near match (spec/04 § Model).
    const parsedModel = parseModelCommand(message);
    if (parsedModel.isModel) {
      if (parsedModel.query === null) {
        pushError('usage: /model <name>');
        return;
      }
      const catalog = getModelCatalog();
      const result = matchModel(parsedModel.query, catalog.models);
      if (result.status === 'not_found') {
        pushError(`model not found: ${parsedModel.query}`);
        return;
      }
      if (result.status === 'ambiguous') {
        pushError(
          `"${parsedModel.query}" matches more than one model: ${result.candidates.join(', ')}`,
        );
        return;
      }
      if (result.modelId === row?.model) return;
      if (!ws) {
        pushError('not connected');
        return;
      }
      ws.send({ type: 'chat.model_request', chatId, model: result.modelId });
      return;
    }
    if (!ws) {
      pushError('not connected');
      return;
    }
    // spec/20-hooks.md § Checking a message — every ordinary send is checked
    // before it is handed to delivery. "Send anyway" (the block card) bypasses
    // this and calls `doSend` directly with the hooks it already has results
    // for, rather than asking the server to check the same message twice.
    setHookChecking(true);
    const check = await api.checkHooks(chatId, message, files ?? []);
    setHookChecking(false);
    if (check.decision === 'block') {
      setHookBlock({ message, files: files ?? [], results: check.results });
      return false;
    }
    doSend(message, files ?? [], check.results);
  }

  /**
   * The actual send, past every hook check — called once a message has
   * either passed, only advised, or the user chose Send anyway. `results`
   * carries whatever `advise` outcomes matched, attached to the sent
   * message's bubble (spec/20-hooks.md § On the user's message).
   */
  function doSend(message: string, files: OutgoingFile[], results: HookRunResult[]): void {
    if (!ws) {
      pushError('not connected');
      return;
    }
    // Optimistically render the user's own message immediately — the host
    // streams back only the assistant reply, never a live echo of the input.
    // A message with attachments shows its local files, uploading, and goes
    // out once they have all landed; turns reach delivery in send order
    // (lib/sendQueue.ts, spec/15 § Composer → Attachments). From there the
    // tracker holds it pending, redelivers on a flap/restart, and marks it
    // "not delivered — tap to retry" if it stays unacked (spec/12). The
    // per-chat Tools panel OFF set is captured at send time.
    const localId = sendMessage(chatId, message, files, {
      send: (e) => ws.send(e),
    });
    const advise = (Array.isArray(results) ? results : []).filter(
      (r) => r.status !== 'ok' || r.decision === 'advise',
    );
    if (advise.length > 0) {
      useChatStore.getState().patchLocalMessage(chatId, localId, {
        hookAdvise: advise.map((r) => ({
          hookId: r.hookId,
          hookName: r.hookName,
          ...(r.status !== 'ok'
            ? { analysis: `Hook failed: ${r.error ?? r.status}` }
            : r.analysis !== undefined
              ? { analysis: r.analysis }
              : {}),
        })),
      });
    }
  }

  function handleHookSendAnyway(): void {
    if (!hookBlock) return;
    doSend(hookBlock.message, hookBlock.files, hookBlock.results);
    setHookBlock(null);
  }

  function handleHookEdit(): void {
    setHookBlock(null);
  }

  function handleHookUseSuggestion(suggestion: string): void {
    setComposerReplace({ text: suggestion, nonce: Date.now() });
    setHookBlock(null);
  }

  function handleStop(): void {
    // Parity with Claude Code's interrupt: stop the in-flight turn. The host
    // closes the SDK query (interrupts tool calls + the model turn) and settles
    // the chat back to idle; queued turns then drain as normal.
    if (!ws) {
      pushError('not connected');
      return;
    }
    try {
      ws.send({ type: 'chat.stop_request', chatId });
    } catch (err) {
      pushError(failed('stop'), undefined, (err as Error).message);
    }
  }

  // "Thinking…" indicator. A `running` chat must NEVER look dead. The host can
  // take several seconds before the first token (send→first-token), and — the
  // important case — the agent often pauses BETWEEN messages while it does
  // extended thinking or tool calls (e.g. sends "let me research this", then
  // works for a while before the answer). Show the indicator throughout, and
  // hide it ONLY while a message is actively STREAMING, where the streaming
  // bubble's caret already shows progress. A SETTLED assistant message with
  // `activity` still `running` means more output is coming, so we keep showing
  // it (previously we hid on any assistant message, which made the mid-turn
  // thinking gap look stuck). The one cost is a brief flash after the FINAL
  // message for the ~1s before `activity` flips running→idle — an acceptable
  // trade for never looking dead mid-turn.
  // spec/04 ## Message queueing — queued turns are held at the tail of the
  // timeline and render BELOW the indicator, so everything about the live turn
  // (including "is the last message streaming?") is read from the entries above
  // that block. Reading the raw tail instead would let a queued turn mask an
  // actively streaming reply and put the dots back under the caret.
  let queuedFrom = timeline.length;
  while (queuedFrom > 0 && timeline[queuedFrom - 1]?.queued) queuedFrom--;
  const lastEntry = timeline[queuedFrom - 1];
  const lastIsStreaming =
    lastEntry?.kind === 'message' && lastEntry.role === 'assistant' && lastEntry.streaming === true;
  // A message still uploading its attachments is not a running turn: it is in
  // the stream at once, pending, with its own `Uploading n/total` line (spec/15
  // § Composer → Attachments), so it needs no indicator of its own here.
  const showThinking = row.activity === 'running' && !lastIsStreaming;

  // The live transcript and the queued block sit either side of the indicator,
  // so the timeline is emitted in two passes. A live entry's key carries its
  // real index so it stays unique across the split; a queued entry's key is its
  // own `localId` (see below), which is stable no matter where the split falls.
  //
  // spec/08 § Action — a job-spawned chat's first user turn is the trigger
  // prompt/payload the job service sent (a `spawn` action's rendered `prompt`
  // or `/<skill>\n<payload>`), never something Tom typed. Only that ONE entry
  // is flagged: later turns in a persistent (`ensure`) job chat could be a
  // later fire OR Tom chiming in, and there's no per-message signal to tell
  // those apart, so only the unambiguous first turn gets the quiet treatment.
  const firstUserSeq = row.jobId
    ? timeline.find((e) => e.kind === 'message' && e.role === 'user')?.seq
    : undefined;

  // spec/14 § Main chat panel — "Tool runs collapse to one row": a maximal run
  // of groupable tool entries making MORE than one call is emitted as a single
  // <ToolGroup> instead of one row per call and one per result.
  const renderEntries = (from: number, to: number): JSX.Element[] => {
    const out: JSX.Element[] = [];
    // Each `view_file` call paired with its own result, and the indices of the
    // results those pairs use up. Resolved before rendering because a batch puts
    // a call and its result several entries apart, so neither the row that draws
    // the file nor the run that must not redraw its result can be decided by
    // looking only at what sits next to them.
    const viewFileResult = new Map<number, ChatEventEntry>();
    const usedByViewFile = new Set<number>();
    for (let k = from; k < to; k++) {
      const call = timeline[k];
      if (!call || !isViewFileCall(call)) continue;
      const j = resultIndexFor(timeline, call, k, to);
      if (j === -1) continue;
      const found = timeline[j];
      if (!found) continue;
      viewFileResult.set(k, found);
      usedByViewFile.add(j);
    }
    let i = from;
    while (i < to) {
      const entry = timeline[i];
      if (!entry) break;
      // Already drawn inside the file's own row above.
      if (usedByViewFile.has(i)) {
        i++;
        continue;
      }
      // The question card already IS this tool's row — call and result would
      // repeat it (spec/14 § Question prompts).
      if (isQuestionRowCoveredByCard(entry, timeline)) {
        i++;
        continue;
      }
      // Shown, not summarised: a `view_file` takes its own row so the file is
      // on screen unconditionally, next to other calls or not.
      const ownResult = viewFileResult.get(i);
      if (ownResult) {
        out.push(
          <ToolCall key={`${entry.seq}-${i}`} entry={entry} result={ownResult} chatId={chatId} />,
        );
        i++;
        continue;
      }
      if (isGroupableToolEntry(entry)) {
        let end = i;
        let calls = 0;
        for (let j = i; j < to; j++) {
          const next = timeline[j];
          if (!next || !isGroupableToolEntry(next) || usedByViewFile.has(j)) break;
          if (next.kind === 'tool_call') calls++;
          end = j + 1;
        }
        if (calls > 1) {
          out.push(
            <ToolGroup
              key={`g-${entry.seq}-${i}`}
              entries={timeline.slice(i, end)}
              narration={runNarration(timeline[i - 1])}
              chatId={chatId}
            />,
          );
          i = end;
          continue;
        }
        // One call and its own result are ONE thing that happened, not two
        // (Tom: "tool call appears twice"). A run of 2+ folds into a ToolGroup
        // above; a lone call folds its result into the same row here, so the
        // result never gets a second "Read →" line of its own.
        const paired = pairedResult(timeline, i, to);
        if (paired) {
          out.push(
            <ToolCall key={`${entry.seq}-${i}`} entry={entry} result={paired} chatId={chatId} />,
          );
          i += 2;
          continue;
        }
      }
      out.push(
        <TimelineEntry
          // A queued entry is keyed on its own `localId`, not its rendered
          // index: the index of every queued turn shifts each time the running
          // turn emits an entry above it (they are held at the tail), and an
          // index key made React unmount and remount the row on each of those,
          // resetting its local state (an open queued-message editor, say).
          // `localId` is unique within the queued block (the store's
          // `chat.queued` case matches on it), and the `q-` prefix keeps it from
          // ever colliding with the `<seq>-<index>` form used by everything else.
          key={
            entry.queued && entry.localId !== undefined ? `q-${entry.localId}` : `${entry.seq}-${i}`
          }
          entry={entry}
          chatId={chatId}
          isJobTrigger={entry.seq === firstUserSeq}
          // spec/04 ## Message queueing — 1-based place within the queued block
          // (which is the timeline tail from `queuedFrom`), so the chip renumbers
          // the moment a promote or remove reorders it.
          queuePos={entry.queued ? i - queuedFrom + 1 : undefined}
          daemonOnline={daemonOnline}
          onPermission={handlePermission}
          onApproveAll={handleApproveAllPending}
          onQuestionAnswer={handleQuestionAnswer}
          onQuestionCancel={handleQuestionCancel}
          onUnqueue={handleUnqueue}
          onPromote={handlePromote}
          onQueuedDraft={handleQueuedDraft}
          onEditQueued={handleEditQueued}
          {...(queuedEdit !== null && entry.queued && entry.localId === queuedEdit.localId
            ? { queuedDraft: queuedEdit.text }
            : {})}
          onRetryDelivery={handleRetryDelivery}
          onRetryTurn={handleRetryTurn}
          onContinueTurn={handleContinueTurn}
          onFork={handleFork}
          onSwitchTrack={handleSwitchTrack}
          tracks={trackNav.get(entry.seq)}
        />,
      );
      i++;
    }
    return out;
  };

  return (
    <main
      className={`chat-main${chatDrop.dragActive ? ' chat-drag-active' : ''}`}
      data-testid="chat-main"
      onDragEnter={chatDrop.handlers.onDragEnter}
      onDragOver={chatDrop.handlers.onDragOver}
      onDragLeave={chatDrop.handlers.onDragLeave}
      onDrop={chatDrop.handlers.onDrop}
    >
      {chatDrop.dragActive ? (
        <div className="chat-drop-hint" data-testid="chat-drop-hint" aria-hidden>
          {chatDrop.dropBlocked ? 'Can’t attach right now' : 'Drop to attach'}
        </div>
      ) : null}
      <ChatHeader row={row} />
      <JobBar row={row} />
      <ChatFind key={chatId} streamRef={streamRef} contentVersion={timeline.length} />
      <GoalBanner row={row} />
      <TaskBar row={row} />
      <ReminderBanner row={row} />
      <ProviderContextPanel row={row} />
      <WakeBar row={row} />
      <BackgroundTaskBar chatId={chatId} />
      <ArtifactBar chatId={chatId} />
      <ArchivedBanner row={row} />
      <HiddenBanner row={row} />
      <SnoozedBanner row={row} />
      {/* Credentials are per host (spec/10): this banner speaks only for the
          machine THIS chat runs on. */}
      <ClaudeDisconnectedBanner daemonId={row.daemonId} model={row.model ?? undefined} />
      {/* And so is credit. Every chat on a spent machine says so, because the
          per-chat bubble only reaches whichever chat you happen to have open —
          it cannot tell you that the other twenty are stuck too. */}
      <OutOfUsageBanner daemonId={row.daemonId} model={row.model ?? undefined} />
      <MeetingLayout chatId={chatId}>
        <DaemonOfflineBanner />
        <BlobChatIdContext.Provider value={chatId}>
          <PendingApprovalCountContext.Provider value={pendingApprovalCount}>
            <section
              className="chat-stream"
              data-testid="chat-stream"
              ref={streamRef}
              onScroll={onStreamScroll}
              onWheel={onStreamWheel}
              onTouchStart={onStreamTouchStart}
              onTouchMove={onStreamTouchMove}
              onTouchEnd={onStreamTouchEnd}
              onKeyDown={onStreamKeyDown}
            >
              <div className="chat-stream-content" ref={contentRef}>
                {timeline.length === 0 && !showThinking ? (
                  <EmptyChat />
                ) : (
                  renderEntries(0, queuedFrom)
                )}
                <VoiceLiveBubble chatId={chatId} />
                {showThinking ? (
                  <div
                    className="msg msg-assistant thinking"
                    data-testid="thinking-indicator"
                    aria-live="polite"
                  >
                    <div className="content thinking-dots" aria-label="assistant is thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                ) : null}
                {renderEntries(queuedFrom, timeline.length)}
                {/* The limit notice belongs HERE, under the last message, not
                    in the banner stack above the transcript. It is about the
                    turn you just sent — the reply that is not coming yet — so
                    it reads as the next thing in the conversation. Up in the
                    chrome it was one more permanent-looking strip among six. */}
                <RateLimitBubble row={row} />
              </div>
              {showScrollDown ? (
                <div className="scroll-down-anchor">
                  <button
                    type="button"
                    className="scroll-down-btn"
                    data-testid="scroll-to-bottom"
                    aria-label="Scroll to latest message"
                    title="Scroll to latest message"
                    onClick={() => {
                      followRef.current = true;
                      setShowScrollDown(false);
                      scrollToBottom();
                    }}
                  >
                    <ChevronDown size={18} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </section>
          </PendingApprovalCountContext.Provider>
        </BlobChatIdContext.Provider>
        {composerBlocked ? (
          <div className="composer-readonly" data-testid="composer-readonly">
            {disabledThread
              ? 'Disabled. Re-enable from the header to use it again.'
              : 'Read-only transcript. Speak to a voice device.'}
          </div>
        ) : (
          // `key={chatId}` forces a remount on every chat switch — the
          // composer's typed-but-unsent text is local `useState`, and
          // without this React reuses the same instance across a chatId
          // change (same type + position in the tree), leaking one chat's
          // draft text into whatever chat is now open (Tom, Todoist —
          // "when archiving, the draft input text is not cleared... the
          // page itself should be isolated to avoid leaking"). This isolates
          // it for EVERY navigation path (archive, sidebar click, keyboard
          // switch), not just archive.
          <>
            {hookBlock ? (
              <HookBlockCard
                results={hookBlock.results.filter(
                  (r) => r.status !== 'ok' || r.decision === 'block',
                )}
                onUseSuggestion={handleHookUseSuggestion}
                onEdit={handleHookEdit}
                onSendAnyway={handleHookSendAnyway}
              />
            ) : null}
            {meeting ? <MeetingActions chatId={chatId} meeting={meeting} /> : null}
            <DelegateStrip chatId={chatId} />
            <Composer
              key={chatId}
              ref={composerRef}
              chatId={chatId}
              daemonId={row.daemonId}
              folder={row.folder}
              // spec/14 § Composer — unsent text belongs to the chat it was
              // typed in. Read non-reactively: `initialValue` is seeded once
              // per mount and the `key={chatId}` remount above is what re-seeds
              // it, so subscribing here would only re-render the whole route on
              // every keystroke.
              initialValue={useComposerDraftStore.getState().get(chatId)}
              onValueChange={(t) => useComposerDraftStore.getState().setDraft(chatId, t)}
              // spec/14 § Composer — opening a chat puts the cursor in the
              // composer, so you can type straight away without clicking it.
              // The `key={chatId}` above is what makes this fire on EVERY
              // navigation into a chat rather than only the first mount: the
              // remount re-runs the mount effect. The composer declines the
              // cursor when something else already owns it (a permission or
              // question card, an open modal, a field being typed into).
              autoFocus
              onSend={handleSend}
              insert={composerInsert}
              replace={composerReplace}
              checking={hookChecking}
              running={isStoppable(row)}
              onStop={handleStop}
            />
          </>
        )}
      </MeetingLayout>
      {/* spec/14 § Manager view — the sit-and-watch layout: the Manager
          conversation above, everything it is watching underneath. Only the
          Manager gets it; every other chat is a chat. */}
      {chatId === SPECIAL_THREAD_IDS.manager ? <ThreadsStrip /> : null}
    </main>
  );
}

// spec/14 ## Main chat panel — "Transcript render cost is O(changed), not
// O(transcript)". One transcript entry = one memoised render unit. The store
// keeps the object identity of every entry an event did NOT touch, so with
// stable callbacks from ChatRoute a streaming delta (one per token) re-renders
// exactly the one entry that changed instead of the whole conversation. Without
// this the chat page gets slower the longer it runs — Tom's "Chat page slow".
const TimelineEntry = memo(function TimelineEntry({
  entry,
  chatId,
  isJobTrigger,
  queuePos,
  daemonOnline,
  onPermission,
  onApproveAll,
  onQuestionAnswer,
  onQuestionCancel,
  onUnqueue,
  onPromote,
  queuedDraft,
  onQueuedDraft,
  onEditQueued,
  onRetryDelivery,
  onRetryTurn,
  onContinueTurn,
  onFork,
  onSwitchTrack,
  tracks,
}: {
  entry: ChatEventEntry;
  chatId: string;
  /** spec/08 § Action — this is the job-spawned chat's trigger turn (see `firstUserSeq` above). */
  isJobTrigger?: boolean;
  /** 1-based place in the queued block; set only on a queued entry. */
  queuePos?: number;
  daemonOnline?: boolean;
  onPermission(requestId: string, approve: boolean): void;
  onApproveAll(): void;
  /** spec/14 § Question prompts — the user's `AskUserQuestion` selections. */
  onQuestionAnswer(requestId: string, answers: Record<string, string>): void;
  onQuestionCancel(requestId: string): void;
  onUnqueue?(localId: string): void;
  onPromote?(localId: string): void;
  /**
   * spec/04 ## Message queueing § Edit — the text in this queued message's
   * open editor; absent while it is closed. Owned by `ChatRoute`.
   */
  queuedDraft?: string;
  /** Open (text), update (text) or close (null) this queued message's editor. */
  onQueuedDraft?(localId: string, text: string | null): void;
  /** Save a queued message's edit (`chat.edit_queued_request`). */
  onEditQueued?(entry: ChatEventEntry, text: string): void;
  onRetryDelivery?(localId: string): void;
  /** spec/12 — retry a `turnFailed` message (a brand new turn, not a re-send). */
  onRetryTurn?(entry: ChatEventEntry): void;
  /** spec/14 § Running-turn controls — nudge a `turnStopped` chat onward with a fresh turn. */
  onContinueTurn?(): void;
  /** spec/04 § Branching — edit this user turn, forking a new track from it. */
  onFork?(seq: number, message: string): void;
  onSwitchTrack?(branchId: string): void;
  /** Set when this turn is a fork point with more than one track. */
  tracks?: TrackNav;
}): JSX.Element {
  // spec/14 § Background task completions — a completion notice reported by the
  // layer underneath is its own entry, not a system message the reader has to
  // decode. A system message that is not one falls through to the ordinary
  // message render below.
  if (entry.kind === 'message' && entry.role === 'system') {
    // spec/02 § Per-turn process / warm sessions — a reply Claude Code wrote
    // itself, not the agent. A muted line that says whose words they are.
    if (entry.synthetic) return <SyntheticNoticeLine entry={entry} />;
    // spec/07 § Call cost — the one quiet line a finished call leaves.
    if ((entry.content ?? '').startsWith('[call] ')) {
      return (
        <div className="call-summary-line" data-testid="call-summary">
          {(entry.content ?? '').slice('[call] '.length)}
        </div>
      );
    }
    const notice = parseBackgroundTaskNotice(entry.content ?? '');
    if (notice) return <BackgroundTaskEntry notice={notice} />;
    // spec/04 § Goals — a goal resolving met/impossible marks the transcript
    // with a quiet system-role row rather than a new agent turn (there is
    // none to tag — see `goalTrigger` below for the `not_met` case, which IS one).
    const goalOutcome = parseGoalOutcome(entry.content ?? '');
    if (goalOutcome) return <GoalOutcomeLine outcome={goalOutcome} />;
  }
  // spec/14 § Background task completions — the same completion, but arriving
  // still wrapped in its raw block because the host only lifts it on the live
  // path (spec/02). Nobody typed it and none of its plumbing is worth reading,
  // so it gets the quiet-line-with-disclosure treatment rather than a user
  // bubble. Checked before the job-trigger branch: a notification is what it is
  // even when it lands as a job chat's first user turn.
  if (
    entry.kind === 'message' &&
    entry.role === 'user' &&
    hasTaskNotification(entry.content ?? '')
  ) {
    return <RawBackgroundTaskLine entry={entry} />;
  }
  // spec/14 § Job trigger turn — a job's trigger prompt/payload (spec/08 §
  // Action) is transcript furniture like a compaction boundary, not a message
  // Tom wrote: one quiet line, click to expand, instead of a full user bubble.
  // `isJobTrigger` catches only the chat's unambiguous FIRST turn (the
  // `spawn` action's own prompt, which carries no per-message signal of its
  // own — see `firstUserSeq` above); `entry.jobTrigger` catches every OTHER
  // turn a job fired in (a `continue`/`message` action's later fire), which
  // the host flags from that turn's own `chat.input.source.kind === 'job'`.
  if (entry.kind === 'message' && entry.role === 'user' && (isJobTrigger || entry.jobTrigger)) {
    return <JobTriggerLine entry={entry} />;
  }
  // spec/20-hooks.md § On the agent's response, spec/14 § Agent-response
  // hooks — a `block` resubmit the host fired is transcript furniture like
  // a job trigger turn, not a message Tom wrote. Unlike the job trigger's
  // generic label, this one names the blocking hook(s) — the row's content
  // IS the hook's own analysis (spec/20-hooks.md: "no invisible injection"),
  // so showing it collapsed-by-default rather than as a full bubble is the
  // only difference from an ordinary turn.
  // spec/07 § The fast voice and the chat's agent — what the call's fast voice
  // asked the agent. Not the user's words (those are their own bubble above).
  if (entry.kind === 'message' && entry.role === 'user' && entry.voiceHandoff) {
    return (
      <ToolDisclosure
        testid="voice-handoff"
        variant="trigger"
        summary={`Asked the agent: ${entry.content ?? ''}`}
        detail={<code>{entry.content ?? ''}</code>}
      />
    );
  }
  if (entry.kind === 'message' && entry.role === 'user' && entry.hookTrigger) {
    return <HookTriggerLine entry={entry} />;
  }
  // spec/04 § Goals — a `not_met` resubmit, the same quiet-furniture
  // treatment as a hook's `block` (it IS one, functionally): the row's
  // content is the evaluator's own reason, verbatim.
  if (entry.kind === 'message' && entry.role === 'user' && entry.goalTrigger) {
    return <GoalTriggerLine entry={entry} />;
  }
  if (entry.kind === 'message') {
    return (
      <MessageEntry
        entry={entry}
        chatId={chatId}
        {...(queuePos !== undefined ? { queuePos } : {})}
        {...(daemonOnline !== undefined ? { daemonOnline } : {})}
        {...(onUnqueue ? { onUnqueue } : {})}
        {...(onPromote ? { onPromote } : {})}
        {...(queuedDraft !== undefined ? { queuedDraft } : {})}
        {...(onQueuedDraft ? { onQueuedDraft } : {})}
        {...(onEditQueued ? { onEditQueued } : {})}
        {...(onRetryDelivery ? { onRetryDelivery } : {})}
        {...(onRetryTurn ? { onRetryTurn } : {})}
        {...(onContinueTurn ? { onContinueTurn } : {})}
        {...(onFork ? { onFork } : {})}
        {...(onSwitchTrack ? { onSwitchTrack } : {})}
        {...(tracks ? { tracks } : {})}
      />
    );
  }
  if (entry.kind === 'tool_call') {
    return <ToolCall entry={entry} chatId={chatId} />;
  }
  if (entry.kind === 'artifact') {
    return <ArtifactCard entry={entry} chatId={chatId} />;
  }
  if (entry.kind === 'compaction') {
    return <CompactionLine entry={entry} />;
  }
  if (entry.kind === 'permission_mode') {
    return <PermissionModeLine entry={entry} />;
  }
  // (attachments render inline within the message branch above)
  if (entry.kind === 'tool_result') {
    return <ToolResult entry={entry} />;
  }
  if (entry.kind === 'permission') {
    // spec/14 § Question prompts — the agent asking the user to choose is not
    // an approval, and gets the question card instead of Approve/Deny.
    if (entry.tool === ASK_USER_QUESTION) {
      return <QuestionCard entry={entry} onAnswer={onQuestionAnswer} onCancel={onQuestionCancel} />;
    }
    return (
      <PermissionCard
        entry={entry}
        chatId={chatId}
        onPermission={onPermission}
        onApproveAll={onApproveAll}
      />
    );
  }
  if (entry.kind === 'error') {
    // A failed turn, rendered in the transcript where the missing reply is
    // (spec/12 § No fallbacks). The code sits alongside the message because
    // `sdk_error` is the half that makes a report actionable.
    return (
      <div className="turn-error" role="alert" data-testid="turn-error">
        <span className="turn-error-body">{presentFailure(entry.content ?? '')}</span>
        {entry.errorCode !== undefined && entry.errorCode !== 'sdk_error' ? (
          <code className="turn-error-code">{entry.errorCode}</code>
        ) : null}
      </div>
    );
  }
  return <div className="system">{entry.content}</div>;
});

/**
 * A background task the agent layer has finished (spec/14 § Background task
 * completions). The badge is what marks it as coming from the layer underneath
 * rather than from the conversation — without it the line reads as something
 * Patch itself said.
 */
function BackgroundTaskEntry({ notice }: { notice: BackgroundTaskNotice }): JSX.Element {
  const meta = [
    notice.kind,
    notice.status,
    ...(notice.exitCode === null ? [] : [`exit ${notice.exitCode}`]),
  ].join(' · ');
  return (
    <div className="bg-task" data-testid="bg-task">
      <span className="bg-task-badge" data-testid="bg-task-badge" title="Claude Code">
        <ClaudeMark />
      </span>
      <span className="bg-task-title" data-testid="bg-task-title">
        {notice.description}
      </span>
      <span className="bg-task-meta">{meta}</span>
    </div>
  );
}

/**
 * A background task completion the surface received as a raw
 * `<task-notification>` user turn (spec/14 § Background task completions). One
 * line: Claude's mark, the block's own summary sentence, and a chevron onto the
 * block itself. A block with no summary reads as a bare `Background task` — the
 * sentence is the block's to give, not ours to invent.
 */
function RawBackgroundTaskLine({ entry }: { entry: ChatEventEntry }): JSX.Element {
  const content = entry.content ?? '';
  return (
    <ToolDisclosure
      testid="bg-task-notice"
      variant="trigger bg-task-line"
      summary={taskNotificationSummary(content) ?? 'Background task'}
      badge={
        <span className="bg-task-badge" data-testid="bg-task-notice-badge" title="Claude Code">
          <ClaudeMark />
        </span>
      }
      detail={<code>{content}</code>}
    />
  );
}

/** Claude's burst mark, drawn so the badge needs no image asset. */
function ClaudeMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-label="Claude Code" role="img">
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" transform="translate(12 12)">
        {[0, 36, 72, 108, 144].map((deg) => (
          <line key={deg} x1="0" y1="-8.5" x2="0" y2="8.5" transform={`rotate(${deg})`} />
        ))}
      </g>
    </svg>
  );
}

// spec/14 § Messages — Long user messages collapse (accordion). Line/char
// thresholds, whichever comes first: a long paste is usually many short
// lines (a list, a log, a stack trace) OR one dense block, so either signal
// alone must trigger the collapse.
const LONG_MESSAGE_LINE_THRESHOLD = 8;
const LONG_MESSAGE_CHAR_THRESHOLD = 600;

/**
 * A message's markdown. In a sent user message a `/skill` links to its
 * SKILL.md; the skills query only runs for a message that has a `/word` in it,
 * so ordinary messages cost nothing.
 */
function MessageMarkdown({
  role,
  chatId,
  content,
  streaming,
}: {
  role: string | undefined;
  chatId: string;
  content: string;
  streaming: boolean;
}): JSX.Element {
  if (role === 'user' && /(^|\s)\/[A-Za-z]/.test(content)) {
    return <UserSkillMarkdown chatId={chatId} content={content} streaming={streaming} />;
  }
  return <Markdown content={content} streaming={streaming} />;
}

function UserSkillMarkdown({
  chatId,
  content,
  streaming,
}: {
  chatId: string;
  content: string;
  streaming: boolean;
}): JSX.Element {
  const folder = useChatStore((st) => st.chats[chatId]?.folder ?? '');
  const daemonId = useChatStore((st) => st.chats[chatId]?.daemonId ?? '');
  const { data } = useQuery({
    queryKey: ['skills', folder, daemonId],
    queryFn: () => api.skills(folder, daemonId),
    enabled: folder.trim() !== '' && daemonId.trim() !== '',
  });
  const linked = data ? linkSkillTokens(content, new Set(data.skills ?? [])) : content;
  return (
    <SkillRefChatContext.Provider value={chatId}>
      <Markdown content={linked} streaming={streaming} />
    </SkillRefChatContext.Provider>
  );
}

/**
 * One message turn. Split out of `TimelineEntry` because a USER turn is
 * EDITABLE (spec/04 § Branching) and therefore holds state — hooks can't live
 * behind `TimelineEntry`'s kind branches.
 */
function MessageEntry({
  entry,
  chatId,
  queuePos,
  daemonOnline,
  onUnqueue,
  onPromote,
  queuedDraft,
  onQueuedDraft,
  onEditQueued,
  onRetryDelivery,
  onRetryTurn,
  onContinueTurn,
  onFork,
  onSwitchTrack,
  tracks,
}: {
  entry: ChatEventEntry;
  chatId: string;
  /** 1-based place in the queued block; set only on a queued entry. */
  queuePos?: number;
  daemonOnline?: boolean;
  onUnqueue?(localId: string): void;
  onPromote?(localId: string): void;
  /**
   * spec/04 ## Message queueing § Edit — the text in this queued message's
   * open editor; absent while it is closed. Owned by `ChatRoute`.
   */
  queuedDraft?: string;
  /** Open (text), update (text) or close (null) this queued message's editor. */
  onQueuedDraft?(localId: string, text: string | null): void;
  /** Save a queued message's edit (`chat.edit_queued_request`). */
  onEditQueued?(entry: ChatEventEntry, text: string): void;
  onRetryDelivery?(localId: string): void;
  onRetryTurn?(entry: ChatEventEntry): void;
  /** spec/14 § Running-turn controls — nudge a `turnStopped` chat onward with a fresh turn. */
  onContinueTurn?(): void;
  onFork?(seq: number, message: string): void;
  onSwitchTrack?(branchId: string): void;
  tracks?: TrackNav;
}): JSX.Element {
  const [forkDraft, setForkDraft] = useState<string | null>(null);
  // spec/14 § Side threads panel TRIGGER — hover button + right-click "Open
  // side thread" on ANY message, user or agent.
  const sideThreadMenu = useContextMenu();
  const navigate = useNavigate();
  // What "Send to new chat" carries: the selection made inside this message
  // when the menu was opened, else the whole message. Captured on open — by the
  // time an item is clicked the selection may be gone.
  const [menuSelection, setMenuSelection] = useState('');
  // Subscribe to the stable `branchGraphs[chatId]` reference (reassigned only
  // by `chat.branches`) and filter in a memo — a selector that returns a
  // fresh `.filter()` array every render never settles for
  // `useSyncExternalStore`, which re-renders forever comparing it to itself.
  const branchGraphHere = useChatStore((s) => s.branchGraphs[chatId]);
  const sideBranchesHere = useMemo(
    () =>
      (branchGraphHere?.branches ?? []).filter((b) => b.sideThread && b.forkFromSeq === entry.seq),
    [branchGraphHere, entry.seq],
  );
  // spec/04 ## Message queueing § Edit — a QUEUED message opens the same
  // editor, but its text lives in `ChatRoute` (see `queuedEdit` there), since
  // this row is re-keyed the moment the message starts running.
  const isQueuedEdit = entry.queued === true && entry.localId !== undefined && !!onQueuedDraft;
  const draft = isQueuedEdit ? (queuedDraft ?? null) : forkDraft;
  const setDraft = (text: string | null): void => {
    if (isQueuedEdit) onQueuedDraft!(entry.localId!, text);
    else setForkDraft(text);
  };
  // spec/04 § Branching — saving an edited turn forks a new track from it. One
  // function, so the Save button and `⌘↵` cannot disagree about when a fork is
  // allowed (an empty edit is not a turn, so neither can send one). A queued
  // message's edit replaces its text in the queue instead; emptying it is a
  // remove, which `onEditQueued` decides.
  function saveEdit(): void {
    if (draft === null) return;
    const next = draft.trim();
    if (isQueuedEdit) {
      onEditQueued?.(entry, next);
      return;
    }
    if (next.length === 0) return;
    setDraft(null);
    onFork?.(entry.seq, next);
  }
  // spec/14 § Messages — Long user messages collapse (accordion). Plain React
  // state, not persisted: reopening the chat resets to collapsed, same as the
  // `draft` state on this component.
  const [expanded, setExpanded] = useState(false);
  // spec/12 § A turn is owed until it settles — which ATTEMPT of this turn the
  // `< >` pager is parked on. `null` means "the one that settled", which is the
  // last: a turn that recovered shows its recovered self at rest, and its
  // failed attempts only when the user walks back to them.
  const [attemptAt, setAttemptAt] = useState<number | null>(null);
  // G2-d1: strip internal [[…]] control markers so they never render as
  // literal transcript text — they are turned into their UI affordance
  // (edit/permission card) elsewhere.
  const text = stripControlTokens(entry.content ?? '');
  // The text to RENDER, which is `text` except while it is still arriving: a
  // streaming bubble re-parses the whole message on every frame it changes, so
  // `useStreamingMarkdownText` holds the intermediate frames to a rate the
  // parse can afford (see its note — this is what stopped the window locking up
  // for as long as an agent was talking). Called here, above every conditional
  // return below, because it is a hook.
  const renderedText = useStreamingMarkdownText(text, entry.streaming === true);
  // G2-d2: a message whose ENTIRE content was a control marker (e.g. the
  // user typed exactly `[[permission]]`) strips to empty. Rendering it would
  // produce a confusing blank labelled bubble with a role header and no body.
  // A still-streaming entry is kept (its text is arriving); a settled empty
  // message is intentionally omitted. spec/14: control tokens are "either
  // suppressed or transformed into their intended UI affordance". BUT an
  // image-only message (a pasted/attached image with no typed text) has empty
  // text yet MUST still render — otherwise the attachment vanishes with the
  // bubble (spec/14 § Composer — attachments render inline).
  const hasAttachments =
    (!!entry.attachments && entry.attachments.length > 0) ||
    (!!entry.localAttachments && entry.localAttachments.length > 0);
  // spec/14 § Messages — Long user messages collapse (accordion). Only a
  // SETTLED user turn qualifies: a still-streaming turn is actively growing,
  // so clamping arriving text would read as broken rather than tidy — it
  // re-evaluates once `entry.streaming` clears. Assistant replies are never
  // clamped; they already render unboxed at full reading measure.
  const isLongUserMessage =
    entry.role === 'user' &&
    !entry.streaming &&
    (text.split('\n').length > LONG_MESSAGE_LINE_THRESHOLD ||
      text.length > LONG_MESSAGE_CHAR_THRESHOLD);
  const collapsed = isLongUserMessage && !expanded;
  // spec/12 § A turn is owed until it settles — every run of THIS turn. A turn
  // run once has no list at all, which is almost all of them.
  const attempts = entry.attempts;
  const attemptCount = attempts?.length ?? 1;
  // The meta strip names where and on what the turn ran: the chat's host and model.
  const metaModel = useChatStore((st) => st.chats[chatId]?.model ?? null);
  const metaHost = usePresenceStore((st) => {
    const daemonId = useChatStore.getState().chats[chatId]?.daemonId ?? '';
    return (st.hosts[daemonId]?.host?.hostName ?? daemonId).trim();
  });
  // Tom: "< > to show the retries IF THERE IS FAILED CONTENT". A turn that went
  // round again with nothing to show for the earlier go gets the marker but no
  // pager — arrows onto an empty page are a control that does nothing.
  const pagedAttempts =
    attempts !== undefined && attempts.some((a) => a.error !== undefined) ? attempts : undefined;
  const attemptIdx = attemptAt ?? attemptCount - 1;
  const shownAttempt = pagedAttempts?.[attemptIdx];
  // A voice note appears LIVE (Tom, patch/todo.md): its bubble renders the
  // instant the user finishes speaking, before any transcript exists — so an
  // empty-content `transcribing` entry must NOT be dropped by the empty guard.
  if (text.length === 0 && !entry.streaming && !hasAttachments && !entry.transcribing) return <></>;
  // spec/04 § Branching — only a SETTLED user turn is editable. A turn still
  // carrying a `localId` is the optimistic echo of something in flight: it has
  // no place in the transcript yet, so the host has no fork point for it and
  // offering the pencil would promise something it can't do (NO FALLBACK).
  const editable =
    entry.role === 'user' &&
    entry.localId === undefined &&
    !entry.queued &&
    !entry.transcribing &&
    !entry.streaming &&
    onFork !== undefined;
  // spec/14 § Side threads panel TRIGGER — "Hovering any message (user or
  // agent)". Same settled-turn restriction as the edit pencil (above), minus
  // the user-only role check: a seq the host has no persisted record of yet
  // has no fork point to hang a side thread off (NO FALLBACK).
  const canSideThread =
    (entry.role === 'user' || entry.role === 'assistant') &&
    entry.localId === undefined &&
    !entry.queued &&
    !entry.transcribing &&
    !entry.streaming &&
    text.length > 0;
  return (
    <div
      className={`msg msg-${entry.role}${entry.streaming ? ' streaming' : ''}${entry.queued ? ' queued' : ''}${entry.deliveryPending || entry.upload ? ' sending' : ''}${entry.deliveryFailed || entry.turnFailed ? ' delivery-failed' : ''}${entry.transcribing ? ' transcribing' : ''}${entry.voice ? ' voice' : ''}${isLongUserMessage ? ' collapsible' : ''}${collapsed ? ' collapsed' : ''}${editable && draft === null ? ' has-edit' : ''}`}
      {...(canSideThread
        ? {
            onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => {
              setMenuSelection(selectionWithin(e.currentTarget));
              sideThreadMenu.openAt(e);
            },
          }
        : {})}
      data-testid="msg"
      data-seq={entry.seq}
      data-streaming={entry.streaming ? 'true' : undefined}
      data-queued={entry.queued ? 'true' : undefined}
      data-delivery-pending={entry.deliveryPending ? 'true' : undefined}
      data-delivery-failed={entry.deliveryFailed ? 'true' : undefined}
      data-turn-failed={entry.turnFailed ? 'true' : undefined}
      data-turn-interrupted={entry.turnInterrupted ? 'true' : undefined}
      data-turn-stopped={entry.turnStopped ? 'true' : undefined}
      data-transcribing={entry.transcribing ? 'true' : undefined}
    >
      {/* Live voice-note placeholder: the bubble is up while the clip is still
          being transcribed. An animated mic + "Transcribing…" reads as live
          feedback; it is replaced in place by the recognised text. */}
      {entry.transcribing ? (
        <div className="content transcribing" data-testid="msg-transcribing" aria-live="polite">
          <Mic size={14} aria-hidden="true" />
          <span className="transcribing-label">Transcribing…</span>
        </div>
      ) : null}
      {/* B1 (DESKTOP-REVIEW): don't render the text bubble when there's no
          text — an image-only message would otherwise show an empty
          accent-tint bubble. A still-streaming turn keeps the bubble (its
          caret + arriving text belong there). */}
      {/* spec/04 § Branching — editing a turn opens it in place. Saving forks a
          new track from it; cancelling puts the turn back untouched. */}
      {draft !== null ? (
        <div className="msg-editor" data-testid="msg-editor">
          <textarea
            className="msg-edit-input"
            data-testid="msg-edit-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (!isSubmitChord(e)) return;
              e.preventDefault();
              saveEdit();
            }}
          />
          <div className="msg-edit-actions">
            <button
              type="button"
              className="msg-edit-cancel"
              data-testid="msg-edit-cancel"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="msg-edit-save"
              data-testid="msg-edit-save"
              disabled={!isQueuedEdit && draft.trim().length === 0}
              onClick={saveEdit}
            >
              Save
              <span className="btn-chord" data-testid="msg-edit-save-chord" aria-hidden="true">
                {shortcutLabel('⌘↵')}
              </span>
            </button>
          </div>
        </div>
      ) : text.length > 0 || entry.streaming ? (
        <>
          <div
            className={`content md${collapsed ? ' clamped' : ''}${isQueuedEdit ? ' queued-editable' : ''}`}
            data-testid="msg-content"
            // spec/04 ## Message queueing § Edit — clicking a queued message's
            // text opens it for editing in place.
            {...(isQueuedEdit
              ? {
                  role: 'button',
                  tabIndex: 0,
                  title: 'Edit',
                  onClick: () => setDraft(entry.content ?? ''),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    setDraft(entry.content ?? '');
                  },
                }
              : {})}
          >
            {entry.voice ? (
              <>
                <span className="msg-voice-mark" data-testid="msg-voice" title="Said in a call">
                  <Phone size={12} aria-label="said in a call" />
                </span>
                <div className="msg-voice-body">
                  <MessageMarkdown
                    role={entry.role}
                    chatId={chatId}
                    content={renderedText}
                    streaming={entry.streaming === true}
                  />
                  {entry.streaming ? <span className="stream-caret" aria-hidden="true" /> : null}
                </div>
              </>
            ) : (
              <>
                <MessageMarkdown
                  role={entry.role}
                  chatId={chatId}
                  content={renderedText}
                  streaming={entry.streaming === true}
                />
                {entry.streaming ? <span className="stream-caret" aria-hidden="true" /> : null}
              </>
            )}
          </div>
          {/* spec/14 § Messages — Long user messages collapse (accordion).
              Icon-only, no label — the content itself (truncated or not) is
              the summary, unlike `ToolDisclosure`'s one-line stand-in text. */}
          {isLongUserMessage ? (
            <button
              type="button"
              className="msg-collapse-toggle"
              data-testid="msg-collapse-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? 'collapse message' : 'expand message'}
              title={expanded ? 'Collapse message' : 'Expand message'}
              onClick={() => setExpanded((v) => !v)}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          ) : null}
        </>
      ) : null}
      {editable && draft === null ? (
        <button
          type="button"
          className="msg-edit"
          data-testid="msg-edit"
          aria-label="edit this message"
          title="Edit"
          onClick={() => setDraft(entry.content ?? '')}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      ) : null}
      {/* spec/04 § Branching — this turn is a fork point: switch tracks. */}
      {tracks && tracks.total > 1 ? (
        <div className="track-switcher" data-testid="track-switcher">
          <button
            type="button"
            className="track-prev"
            data-testid="track-prev"
            aria-label="previous track"
            disabled={tracks.prevBranchId === null}
            onClick={() => tracks.prevBranchId && onSwitchTrack?.(tracks.prevBranchId)}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span className="track-count" data-testid="track-count">
            {tracks.index + 1}/{tracks.total}
          </span>
          <button
            type="button"
            className="track-next"
            data-testid="track-next"
            aria-label="next track"
            disabled={tracks.nextBranchId === null}
            onClick={() => tracks.nextBranchId && onSwitchTrack?.(tracks.nextBranchId)}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {/* spec/12 § A turn is owed until it settles — page the ATTEMPTS of this
          one turn. The SAME control as the track switcher above, deliberately:
          Tom asked for "< >", and a second, differently-shaped pager for the
          same gesture would be a new thing to learn. Arrows and a count, no
          explanatory copy (spec/14 § Branching). Only drawn when a superseded
          attempt has failed content to walk back to. */}
      {pagedAttempts ? (
        <div className="track-switcher" data-testid="attempt-switcher">
          <button
            type="button"
            className="track-prev"
            data-testid="attempt-prev"
            aria-label="previous attempt"
            disabled={attemptIdx === 0}
            onClick={() => setAttemptAt(Math.max(0, attemptIdx - 1))}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span className="track-count" data-testid="attempt-count">
            {attemptIdx + 1}/{pagedAttempts.length}
          </span>
          <button
            type="button"
            className="track-next"
            data-testid="attempt-next"
            aria-label="next attempt"
            disabled={attemptIdx === pagedAttempts.length - 1}
            onClick={() => setAttemptAt(Math.min(pagedAttempts.length - 1, attemptIdx + 1))}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {/* The failed content of the attempt the pager is parked on. Only a
          SUPERSEDED attempt has any — the settled one is what the transcript
          around this bubble already is. */}
      {shownAttempt?.error !== undefined ? (
        <div className="attempt-error" role="status" data-testid="attempt-error">
          <span className="attempt-error-body">{shownAttempt.error}</span>
          {shownAttempt.errorCode !== undefined ? (
            <code className="turn-error-code">{shownAttempt.errorCode}</code>
          ) : null}
        </div>
      ) : null}
      {/* A turn sent from this browser draws its files from the local copies
          (spec/15 § Composer → Attachments) — they are on screen before any
          upload lands. */}
      {entry.localAttachments && entry.localAttachments.length > 0 ? (
        <MessageAttachments
          chatId={chatId}
          attachments={entry.localAttachments}
          {...(entry.attachments ? { refs: entry.attachments } : {})}
        />
      ) : entry.attachments && entry.attachments.length > 0 ? (
        <MessageAttachments chatId={chatId} attachments={entry.attachments} />
      ) : null}
      {/* spec/04 ## Message queueing: a parked turn shows a chip saying when it
          goes in (Queued / 2nd in queue, titled with the event that releases
          it), a promote (↑) affordance that interrupts the running turn so
          the queue starts draining now (it does not reorder the queue), and a
          remove (×) that cancels it. The ↑ is always visible (spec/14 §
          Running-turn controls) — it is the queued message's most useful
          control and must not depend on discovering hover. It is the only
          thing on a queued message that interrupts: sending never does, and
          nothing interrupts on a timer (spec/04 § Message queueing). */}
      {entry.queued ? (
        <div className="queued-tools" data-testid="queued-tools">
          <span
            className="queued-badge"
            data-testid="queued-badge"
            title={queueChipTitle(queuePos!)}
          >
            {queueChipLabel(queuePos!)}
          </span>
          {entry.localId && onPromote ? (
            <button
              type="button"
              className="queued-promote"
              data-testid="queued-promote"
              aria-label="run this queued message next"
              title="Run next"
              onClick={() => onPromote(entry.localId!)}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
          ) : null}
          {entry.localId && onUnqueue ? (
            <button
              type="button"
              className="queued-remove"
              data-testid="queued-remove"
              aria-label="remove queued message"
              title="Remove from queue"
              onClick={() => onUnqueue(entry.localId!)}
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
      ) : null}
      {/* spec/12 § Guaranteed input delivery — a distinct delivery-status line
          for an OUTGOING turn we haven't yet observed take effect. Kept
          separate from the type-ahead queue-position chip above, and worded
          differently on purpose (spec/04 ## Message queueing): when the daemon
          is offline the input waits on reconnection, not on the running turn,
          so it never reads as a queue place; otherwise it is simply in-flight
          ("Sending…"). A failed delivery offers a tap-to-retry, never a silent
          forever-spinner. */}
      {/* spec/15 § Composer → Attachments — before it is sent, a turn with
          attachments says how its uploads are going: `Uploading 1/3`, or `Not
          uploaded` with Retry and × (discard). */}
      {entry.upload && entry.localId ? (
        entry.upload.failed ? (
          <div className="delivery-status failed" data-testid="upload-failed">
            <span data-testid="upload-status">Not uploaded</span>
            <button
              type="button"
              className="delivery-retry"
              data-testid="upload-retry"
              onClick={() => retryUpload(chatId, entry.localId!)}
            >
              Retry
            </button>
            <button
              type="button"
              className="upload-discard"
              data-testid="upload-discard"
              aria-label="discard message"
              title="Discard"
              onClick={() => discardUpload(chatId, entry.localId!)}
            >
              <CloseIcon />
            </button>
          </div>
        ) : (
          <div className="delivery-status" data-testid="upload-status" role="status">
            {`Uploading ${entry.upload.done}/${entry.upload.total}`}
          </div>
        )
      ) : entry.deliveryFailed ? (
        <div className="delivery-status failed" data-testid="delivery-failed">
          <span>Not delivered.</span>
          {entry.localId && onRetryDelivery ? (
            <button
              type="button"
              className="delivery-retry"
              data-testid="delivery-retry"
              onClick={() => onRetryDelivery(entry.localId!)}
            >
              Tap to retry
            </button>
          ) : null}
        </div>
      ) : entry.turnFailed ? (
        // spec/12 — this turn WAS delivered and ran, then failed generically
        // partway through. Same treatment as an undelivered message (not a
        // separate error line): the failure reads as "this message needs
        // resending", regardless of which hop actually broke.
        <div
          className="delivery-status failed"
          data-testid="turn-failed"
          title={
            entry.turnErrorMessage === undefined
              ? undefined
              : presentFailure(entry.turnErrorMessage)
          }
        >
          <span>Turn failed.</span>
          {onRetryTurn ? (
            <button
              type="button"
              className="delivery-retry"
              data-testid="turn-retry"
              onClick={() => onRetryTurn(entry)}
            >
              Tap to retry
            </button>
          ) : null}
        </div>
      ) : entry.turnInterrupted ? (
        // spec/14 § Running-turn controls — a newer message got promoted ahead
        // of this one. The agent DID see it (the promoted turn resumed the same
        // session), so there is nothing to retry — just say so, muted, with no
        // action, rather than offer a retry that would duplicate it.
        <div className="delivery-status interrupted" data-testid="turn-interrupted">
          <span>Interrupted.</span>
        </div>
      ) : entry.turnStopped ? (
        // spec/14 § Running-turn controls — the user pressed Stop / Esc with
        // nothing queued behind it. The agent saw this turn and started on it,
        // so Continue nudges it onward with a fresh turn rather than
        // resubmitting this message's text, which it already has in context.
        // Muted, not the danger colour — a stop is what the user asked for.
        <div className="delivery-status stopped" data-testid="turn-stopped">
          <span>Stopped.</span>
          {onContinueTurn ? (
            <button
              type="button"
              className="delivery-retry"
              data-testid="turn-stopped-continue"
              onClick={() => onContinueTurn()}
            >
              Continue
            </button>
          ) : null}
        </div>
      ) : entry.deliveryPending && !entry.queued ? (
        <div
          className="delivery-status pending"
          data-testid="delivery-pending"
          data-daemon-offline={daemonOnline ? undefined : 'true'}
          aria-live="polite"
        >
          {daemonOnline ? 'Sending…' : 'Queued until the agent reconnects'}
        </div>
      ) : null}
      {/* spec/14 § Messages — the per-message meta strip: facts ABOUT the turn
          rather than of it, hidden until the message is hovered or focused, the
          same reveal `.msg-edit` uses (and permanently visible where there is
          no hover, so it exists on the phone). Tom: "subtle marker on hover
          below chat with the rest of the stuff like time".

          The time this turn actually arrived sits FIRST (left-hand side of the
          strip) when known — `entry.messageAt`, sourced from the daemon's own
          `chat.message.createdAt`, never the store's `at` (the moment the
          FRAME arrived at this client, which is "now" on every replay). Absent
          entirely when the daemon/transcript carried no real time: showing
          nothing beats inventing one. The retry marker follows it.

          Host and model follow the time on agent messages only: they are the
          chat's current ones, which says nothing about a message Tom typed. */}
      {attemptCount > 1 ||
      entry.messageAt !== undefined ||
      entry.midTurn === true ||
      entry.sentNow === true ? (
        <div className="msg-meta" data-testid="msg-meta">
          {entry.messageAt !== undefined ? (
            <span data-testid="msg-meta-time">{formatMessageTime(entry.messageAt)}</span>
          ) : null}
          {entry.sentNow === true ? (
            <span data-testid="msg-meta-interrupted">interrupted</span>
          ) : null}
          {entry.midTurn === true ? (
            <span data-testid="msg-meta-position">{midTurnPositionLabel(entry.midTurnStep)}</span>
          ) : null}
          {entry.role !== 'user' && entry.messageAt !== undefined && metaHost !== '' ? (
            <span data-testid="msg-meta-host">{metaHost}</span>
          ) : null}
          {entry.role !== 'user' && entry.messageAt !== undefined && metaModel ? (
            <span data-testid="msg-meta-model">{metaModel}</span>
          ) : null}
          {attemptCount > 1 ? (
            <span data-testid="msg-meta-retries">{retriedLabel(attemptCount - 1)}</span>
          ) : null}
        </div>
      ) : null}
      {entry.systemContext && entry.systemContext.length > 0 ? (
        <SystemContextDisclosures items={entry.systemContext} />
      ) : null}
      {/* spec/14 § Side threads panel TRIGGER — hover-revealed on every
          settled message (user or agent), mirroring the edit pencil's reveal.
          Right-click offers the same action via the context menu. */}
      {canSideThread ? (
        <button
          type="button"
          className="msg-side-thread"
          data-testid="msg-side-thread-trigger"
          aria-label="Open side thread"
          title="Open side thread"
          onClick={() => openSideThreadDraft(chatId, entry.seq, text)}
        >
          <GitFork size={14} aria-hidden="true" />
        </button>
      ) : null}
      {canSideThread ? (
        <ContextMenu
          anchor={sideThreadMenu.anchor}
          onClose={sideThreadMenu.close}
          label="Message actions"
          testId="msg-context-menu"
          items={[
            {
              id: 'open-side-thread',
              label: 'Open side thread',
              icon: <GitFork size={14} aria-hidden="true" />,
              run: () => openSideThreadDraft(chatId, entry.seq, text),
            },
            {
              id: 'send-to-new-chat',
              label: 'Send to new chat',
              icon: <MessageSquarePlus size={14} aria-hidden="true" />,
              run: () => navigate(sendToNewChat(chatId, menuSelection || text)),
            },
          ]}
        />
      ) : null}
      {/* spec/14 § Side threads panel — "IN THE MAIN CHAT": a message with
          side threads carries a marker per thread. Clicking opens the panel
          on that tab. */}
      {sideBranchesHere.map((b) => (
        <SideThreadMarker key={b.branchId} chatId={chatId} branch={b} />
      ))}
      {entry.hookAdvise && entry.hookAdvise.length > 0 ? (
        <HookAdviseNote advise={entry.hookAdvise} />
      ) : null}
    </div>
  );
}

/**
 * spec/20-hooks.md § On the user's message — a small note naming the hook(s)
 * that advised on this message, expandable to each one's analysis. This
 * surface's own session only (§ Never reaches the agent): client-local state
 * attached to the sent message, not part of the persisted transcript.
 */
function HookAdviseNote({
  advise,
}: {
  advise: NonNullable<ChatEventEntry['hookAdvise']>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg-hook-advise" data-testid="msg-hook-advise">
      <button
        type="button"
        className="msg-hook-advise-toggle"
        data-testid="msg-hook-advise-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {advise.map((a) => a.hookName).join(', ')}
      </button>
      {open ? (
        <div className="msg-hook-advise-body" data-testid="msg-hook-advise-body">
          {advise.map((a) => (
            <div key={a.hookId}>{a.analysis}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * spec/14 § Side threads panel — "Side thread · N messages · running" marker
 * under a message that has a side thread forked from it. The message count
 * is read through the same branch-history query the panel itself uses
 * (`['side-thread-history', chatId, branchId]`), so opening the panel right
 * after costs nothing extra — TanStack Query dedupes the identical key.
 */
function SideThreadMarker({ chatId, branch }: { chatId: string; branch: ChatBranch }): JSX.Element {
  const needsYou = useChatStore(
    (s) => (s.sideThreadPermissions[`${chatId}::${branch.branchId}`]?.length ?? 0) > 0,
  );
  const { data } = useQuery({
    queryKey: ['side-thread-history', chatId, branch.branchId],
    queryFn: () => api.getChatHistory(chatId, { branchId: branch.branchId }),
    refetchInterval: branch.running ? 2000 : false,
  });
  const count = data?.events.length ?? 0;
  const status = needsYou ? 'needs you' : branch.running ? 'running' : null;
  const dotClass = needsYou ? 'stp-dot-needs-you' : branch.running ? 'stp-dot-running' : '';
  return (
    <button
      type="button"
      className="msg-side-thread-marker"
      data-testid={`side-thread-marker-${branch.branchId}`}
      onClick={() => openExistingSideThread(chatId, branch.branchId)}
    >
      <span className={`stp-dot ${dotClass}`} aria-hidden="true" />
      Side thread{count > 0 ? ` · ${count} message${count === 1 ? '' : 's'}` : ''}
      {status ? ` · ${status}` : ''}
    </button>
  );
}

/**
 * spec/02 § System-reminder disclosure — every `<system-reminder>` block this
 * turn actually carried, collapsed by default (Tom: "hidden in a box, allow
 * user to see"). Quiet furniture like `CompactionLine`/`JobTriggerLine`, not a
 * banner: it sits at the turn it affected and says nothing unless clicked.
 * Usually one item; a turn can carry more than one (e.g. a todo-edit reminder
 * and a broadcast digest together), so each gets its own row.
 */
function SystemContextDisclosures({ items }: { items: SystemContextItem[] }): JSX.Element {
  return (
    <div className="system-context-group" data-testid="system-context-group">
      {items.map((item, i) => (
        <ToolDisclosure
          key={i}
          testid="system-context"
          variant="system-context"
          summary={item.label}
          detail={<pre className="system-context-text">{item.text}</pre>}
        />
      ))}
    </div>
  );
}

/**
 * spec/02 § Provider-level context — Claude Code's OWN provider-level context
 * this chat has received (environment, model identity, token counts, ...), as
 * distinct from `SystemContextDisclosures` above (Patch's own five
 * hand-injected reminders, captured per-turn). Chat-scoped rather than
 * per-message: one row per `providerType`, upserted in place as it recurs
 * (`ChatRow.providerContext` — a token-count reminder alone can fire hundreds
 * of times in a session, so this is never "one row per occurrence"). Sits
 * with the chat's other standing banners (GoalBanner, ReminderBanner, ...)
 * above the transcript — sorted by first sighting, so a row's position never
 * jumps as it updates. `null` when the chat has received none.
 */
function ProviderContextPanel({
  row,
}: {
  row: import('../stores/types.js').ChatRow;
}): JSX.Element | null {
  const verbosity = usePreferencesStore((s) => s.preferences.providerContextVerbosity);
  const entries = Object.entries(row.providerContext ?? {}).sort(
    ([, a], [, b]) => a.firstSeq - b.firstSeq,
  );
  if (entries.length === 0 || verbosity === 'off') return null;
  return (
    <div className="provider-context-panel" data-testid="provider-context-panel">
      {entries.map(([providerType, entry]) => (
        <ToolDisclosure
          key={providerType}
          testid="provider-context"
          variant="system-context"
          summary={entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label}
          detail={<pre className="system-context-text">{entry.text}</pre>}
          defaultOpen={verbosity === 'full'}
        />
      ))}
    </div>
  );
}

/**
 * How many times this turn had to go round again, in words (spec/12 § A turn is
 * owed until it settles). Tom asked for it in exactly this register — "Retried
 * twice" — so one and two are words and anything beyond counts, which is where
 * words stop being quicker to read than a digit.
 */
export function retriedLabel(retries: number): string {
  if (retries === 1) return 'Retried once';
  if (retries === 2) return 'Retried twice';
  return `Retried ${retries} times`;
}

/** Where in the running turn a mid-turn message reached the agent (spec/04 § Message delivery). */
export function midTurnPositionLabel(step: number | undefined): string {
  return step === undefined || step === 0 ? 'at the start' : `after step ${step}`;
}

/**
 * The real time a message arrived, for the per-message meta strip
 * (`entry.messageAt` — spec/14 § Messages). `HH:MM` when the turn arrived
 * today — the surrounding transcript already gives the day — with the date
 * prepended (`D MMM HH:MM`) when it didn't, so a message from a previous day
 * doesn't read as if it just arrived.
 */
export function formatMessageTime(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${day} ${time}`;
}

// A page the agent published with `patch_artifact` (spec/14 § Artifacts).
// Title + source file, nothing else; clicking shows it in the web panel
// (desktop) or a new tab (browser).
function ArtifactCard({ entry, chatId }: { entry: ChatEventEntry; chatId: string }): JSX.Element {
  const padId = padIdOfArtifact(entry.artifactId);
  if (padId !== null) {
    return <PadCard padId={padId} title={entry.artifactTitle ?? padId} chatId={chatId} />;
  }
  const url = entry.artifactUrl ?? '';
  return (
    <button
      type="button"
      className="artifact-card"
      data-testid="artifact-card"
      onClick={() => openArtifact(url, chatId)}
    >
      <LayoutTemplate size={16} aria-hidden />
      <span className="artifact-title">{entry.artifactTitle}</span>
      <span className="artifact-path">{entry.artifactPath}</span>
    </button>
  );
}

// Inline attachments carried by a user turn (spec/14 § Composer — "render
// inline in the stream"). Images render as pictures, other files as chips
// linking to the served copy. The URL is built from the chatId + ref id, so a
// persisted message and an optimistic echo render identically.
// A turn sent from this browser passes its LOCAL files instead (an image drawn
// from its object URL) plus, once they have uploaded, the matching `refs`
// (index for index): an image keeps showing the local copy, a file chip links
// to the served copy — and to nothing until there is one.
function MessageAttachments({
  chatId,
  attachments,
  refs,
}: {
  chatId: string;
  attachments: AttachmentRef[] | LocalAttachment[];
  refs?: AttachmentRef[];
}): JSX.Element {
  // spec/14 § Composer — tapping an inline image opens an IN-APP zoomable
  // lightbox, never a new browser tab. Non-image files still open their served
  // copy (there's nothing to zoom).
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);
  return (
    <div className="msg-attachments" data-testid="msg-attachments">
      {attachments.map((att: AttachmentRef | LocalAttachment, i) => {
        const ref = 'id' in att ? att : refs?.[i];
        const served =
          ref === undefined
            ? undefined
            : `/api/chats/${encodeURIComponent(chatId)}/attachment/${encodeURIComponent(ref.id)}`;
        const itemKey = `${i}-${att.name}`;
        if (att.kind === 'image') {
          const url = 'id' in att ? served! : att.url!;
          return (
            <button
              key={itemKey}
              type="button"
              className="msg-attachment-img-btn"
              data-testid="msg-attachment-img"
              aria-label={`View ${att.name}`}
              onClick={() => setLightbox({ url, alt: att.name })}
            >
              <img className="msg-attachment-img" src={url} alt={att.name} />
            </button>
          );
        }
        return (
          <a
            key={itemKey}
            className="msg-attachment-file"
            {...(served !== undefined ? { href: served } : { 'aria-disabled': true })}
            target="_blank"
            rel="noreferrer"
            data-testid="msg-attachment-file"
          >
            <FileText size={14} aria-hidden />
            {att.name}
          </a>
        );
      })}
      {lightbox ? (
        <ImageLightbox url={lightbox.url} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

// Full-screen, zoomable image viewer rendered INSIDE the app (spec/14 §
// Composer — "in-app zoomable viewer, never navigate away"). Click/scroll to
// zoom, drag to pan when zoomed, Esc or a backdrop click to close.
//
// Portalled to <body>: `.chat-main` carries `contain: layout`, which makes it
// the containing block for `position: fixed` descendants, so an in-tree overlay
// is clipped to the chat panel instead of covering the window (Tom,
// `patch/todo.md` — "viewing the image should be full screen. currently its
// trapped in the window").
function ImageLightbox({
  url,
  alt,
  onClose,
}: {
  url: string;
  alt: string;
  onClose(): void;
}): JSX.Element {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  function clampScale(s: number): number {
    return Math.min(8, Math.max(1, s));
  }
  function reset(): void {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  return createPortal(
    <div
      className="lightbox-backdrop"
      data-testid="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      onWheel={(e) => {
        e.preventDefault();
        setScale((s) => {
          const next = clampScale(s - e.deltaY * 0.002 * s);
          if (next === 1) setOffset({ x: 0, y: 0 });
          return next;
        });
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        data-testid="lightbox-close"
        aria-label="Close image viewer"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <CloseIcon size={22} />
      </button>
      <img
        className="lightbox-img"
        src={url}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'zoom-in',
        }}
        onClick={(e) => {
          e.stopPropagation();
          // Click toggles between fit and 2.5× zoom.
          if (scale > 1) reset();
          else setScale(2.5);
        }}
        onPointerDown={(e) => {
          if (scale <= 1) return;
          e.stopPropagation();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setOffset({
            x: drag.current.ox + (e.clientX - drag.current.x),
            y: drag.current.oy + (e.clientY - drag.current.y),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
    </div>,
    document.body,
  );
}

// Tool calls render COLLAPSED by default (spec/14 ## Main chat panel: "Tool
// calls: collapsed by default with one-line summary; click to expand full args
// + result"). File-edit tools expand to a read-only unified diff (spec/14
// "Diffs: inline unified diff view for file-edit tools").
function ToolCall({
  entry,
  result,
  chatId,
}: {
  entry: ChatEventEntry;
  /** This call's own tool_result, folded into the same row (spec/14). */
  result?: ChatEventEntry;
  chatId: string;
}): JSX.Element {
  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const isEdit = isEditToolCall(entry);
  // A call with no result AND still in the chat's own open-call set is still
  // running: the row says so (spinner + elapsed) instead of reading like a
  // finished one. Keyed on THIS call's id, not the chat-wide `activity`/
  // `openToolCalls` — those go back to `running`/positive the moment a turn
  // the user queued behind a stop gets promoted, which used to make an
  // already-cancelled call's row keep ticking for as long as that later turn
  // ran, looking exactly like a still-running (or stuck) command.
  const isCallOpen = useChatStore((s) => {
    const callId = entry.callId;
    return !!callId && !!s.chats[chatId]?.openCallIds?.includes(callId);
  });
  // The clock runs from when the call really started (`startedAt`, from the
  // wire), never from when this surface received it — reopening a chat must
  // not restart it. A call with no known start shows the spinner and no clock.
  // A question is the agent waiting on Tom, not a tool doing work: no timer.
  // Nor is a call still waiting on Approve/Deny: it has not started, so a
  // clock on it counts the user's own hesitation as the command's runtime.
  const awaitingApproval = useChatStore((s) => {
    const args = JSON.stringify(entry.toolArgs ?? {});
    return !!s.chats[chatId]?.pendingPermissions.some(
      (p) => p.tool === entry.tool && JSON.stringify(p.args ?? {}) === args,
    );
  });
  const runningSince =
    !result && isCallOpen && !awaitingApproval && !isQuestionTool(entry.tool)
      ? { at: entry.startedAt }
      : undefined;

  // spec/14 § Tool calls — `view_file` exists to SHOW the user a file, so its
  // row is the file itself rather than a disclosure that has to be opened.
  // Matched on the label so it works whether the stream carries the bare name
  // or the `mcp__patch__` id. A result that ISN'T a valid ack (an error, say)
  // falls through to the ordinary row — no empty frame, no fallback.
  if (entry.tool && toolLabel(entry.tool) === 'view_file' && result) {
    const view = viewFilePayload(result.toolResult);
    if (view) return <ViewFileCard view={view} />;
  }

  // One-line summary naming what the call is doing (spec/14 ## Main chat
  // panel) — the same derivation a collapsed run labels its calls with, so a
  // call reads identically whether or not it happened to land in a run. A file
  // edit keeps naming its path directly: that summary is the click target that
  // opens the file's diff, so it must name the file even when the model wrote
  // a description. The rest of the args still live only in the expanded detail.
  const summary = isEdit
    ? `Editing ${String(args.file_path)}`
    : entry.tool === 'TaskStop'
      ? `Stopping task ${String(args['task_id'] ?? args['taskId'] ?? '')}`
      : toolCallSummary(entry.tool, entry.toolArgs);

  // spec/09 § `### push`, spec/14 ## Main chat panel — every `patch_notify`
  // call renders as a green box carrying the message, so the transcript shows
  // when the chat fired a notification and what it said. A `deepLink` is a
  // tappable row inside the box (not buried in the expanded JSON), opening the
  // same URI a push tap would.
  if (entry.tool && toolLabel(entry.tool) === 'patch_notify') {
    const message = typeof args['message'] === 'string' ? args['message'] : '';
    const importance = typeof args['importance'] === 'string' ? args['importance'] : 'normal';
    const deepLink =
      typeof args['deepLink'] === 'string' && args['deepLink'] ? args['deepLink'] : null;
    return (
      <div
        className="tool-call tool-call-notify"
        data-testid="notify-box"
        data-importance={importance}
        {...(deepLink ? { 'data-deeplink': 'true' } : {})}
      >
        <div className="tool-summary tool-summary-notify">
          <Bell size={13} aria-hidden />
          <span className="tool-call-notify-label">Patch notify · {importance}</span>
        </div>
        {message ? <div className="tool-call-notify-message">{message}</div> : null}
        {deepLink ? (
          <a
            className="tool-call-deeplink"
            href={deepLink}
            target="_blank"
            rel="noreferrer"
            data-testid="tool-call-deeplink"
          >
            <ExternalLink size={13} aria-hidden />
            {deepLink}
          </a>
        ) : null}
      </div>
    );
  }

  // spec/14 ## Main chat panel — a `patch_job_*` call changes what runs on a
  // SCHEDULE, so its row announces itself instead of collapsing into the same
  // one-liner an `ls` gets. Reported 11 Sep 2026: a chat created a 30-minute
  // recurring job and the user "didn't see anything at all". The effect
  // outlives the turn and is not re-readable from the transcript, so the row
  // names the change and links to the job itself.
  const jobRow = jobCallRow(entry.tool, args, result?.toolResult);
  if (jobRow) {
    return (
      <div className="tool-call tool-call-job" data-testid="tool-call" data-job="true">
        <div className="tool-summary tool-summary-job">
          <span className="tool-call-job-verb" data-testid="tool-call-job-verb">
            {jobRow.verb}
          </span>
          {jobRow.name ? <span className="tool-call-job-name">{jobRow.name}</span> : null}
          {jobRow.trigger ? (
            <span className="tool-call-job-trigger" data-testid="tool-call-job-trigger">
              {jobRow.trigger}
            </span>
          ) : null}
        </div>
        {jobRow.jobId ? (
          <Link
            className="tool-call-job-link"
            to={`/jobs/${jobRow.jobId}`}
            data-testid="tool-call-job-link"
          >
            <CalendarClock size={13} aria-hidden />
            Open job
          </Link>
        ) : null}
      </div>
    );
  }

  // spec/14 § Main chat panel — Delegate tool row: a `patch_delegate` call is
  // the one tool row that never collapses to the ordinary one-liner — it
  // carries a live status pill and an "Open transcript" link instead.
  if (entry.tool && toolLabel(entry.tool) === 'patch_delegate') {
    return <DelegateToolCall chatId={chatId} args={args} result={result} summary={summary} />;
  }

  // A `Skill` call invoked a named skill from `.claude/skills` — the row names
  // it and, where the file is reachable, links straight to its `SKILL.md` (the
  // same Edit-link mechanism the Jobs view's Skill field already offers —
  // `resolveSkillLink`, `openFileInBrowser`). Split into its own component
  // because it needs its own `useQuery` for that folder's skills, which must
  // not run for every other tool call in the transcript.
  if (entry.tool === 'Skill') {
    return <SkillToolCall chatId={chatId} args={args} summary={summary} />;
  }

  // A `Monitor` call arms a background watcher that outlives this turn, so the
  // row names what it watches and shows the command whose stdout lines become
  // events. Its standing state is a row in the background task bar above the
  // transcript (spec/14 § Main chat panel — Background task bar).
  if (entry.tool === 'Monitor') {
    const description = typeof args['description'] === 'string' ? args['description'] : '';
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    return (
      <div className="tool-call tool-call-monitor" data-testid="tool-call" data-monitor="true">
        <span className="tool-summary tool-summary-monitor">
          {`Monitor · ${description || command}`}
        </span>
        <code className="tool-call-monitor-command">{command}</code>
      </div>
    );
  }

  // G3-1: clicking a file-edit tool-call line opens the docked diff editor in
  // the right rail (Monaco) for that file — including every file in the SAME
  // agent edit, so the change-set rail can navigate between them. A separate
  // chevron toggles an inline read-only unified diff preview computed from
  // the stream's old/new strings (spec/14 ## Main chat panel: "Diffs: inline
  // unified diff view for file-edit tools (read-only preview from the
  // stream); collapsed by default, like other tool calls"). The two controls
  // are independent: the chevron never opens the Monaco editor, and the
  // summary click never toggles the inline preview.
  if (isEdit) {
    const filePath = String(args.file_path);
    const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
    const newStr = typeof args.new_string === 'string' ? args.new_string : '';
    return (
      <EditToolCall
        chatId={chatId}
        filePath={filePath}
        oldStr={oldStr}
        newStr={newStr}
        summary={summary}
      />
    );
  }

  // Collapsed the row still reads as the call; expanded it shows the args it
  // was made with AND what came back, since those are two halves of one event.
  return (
    <ToolDisclosure
      {...(entry.callId ? { openKey: entry.callId } : {})}
      testid="tool-call"
      summary={result ? `${summary} →` : summary}
      {...(runningSince !== undefined ? { runningSince } : {})}
      detail={
        <>
          <ToolFields value={entry.toolArgs} />
          {result ? (
            <div className="tool-result-inline" data-testid="tool-call-result">
              <ToolFields value={result.toolResult} />
            </div>
          ) : null}
        </>
      }
    />
  );
}

/**
 * The row for a `Skill` tool call: names the skill and, where its `SKILL.md`
 * is reachable through a chat on the same (host, folder), makes the row a
 * link to it — same containment rule and same `resolveSkillLink` the Jobs
 * view's Skill field already uses, so a skill living outside this chat's
 * folder (a machine-wide one) states why instead of offering a link that
 * would 404. The tooltip is the skill's own frontmatter `description:`,
 * fetched alongside its path via `GET /api/skills`.
 */
function SkillToolCall({
  chatId,
  args,
  summary,
}: {
  chatId: string;
  args: Record<string, unknown>;
  summary: string;
}): JSX.Element {
  const skillName = typeof args['skill'] === 'string' ? args['skill'] : '';
  const { target, description, open } = useSkillTarget(chatId, skillName);

  if (target && !('reason' in target)) {
    return (
      <div className="tool-call tool-call-skill" data-testid="tool-call" data-skill="true">
        <button
          type="button"
          className="tool-summary tool-summary-skill link-btn"
          data-testid="tool-call-skill-link"
          title={description || undefined}
          onClick={open}
        >
          {summary}
        </button>
      </div>
    );
  }
  return (
    <div className="tool-call tool-call-skill" data-testid="tool-call" data-skill="true">
      <span className="tool-summary tool-summary-skill" title={description || undefined}>
        {summary}
      </span>
      {target && 'reason' in target ? (
        <span className="tool-call-skill-reason" data-testid="tool-call-skill-unavailable">
          {target.reason}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The tool_result at `i + 1` belonging to the tool_call at `i`, or undefined
 * if the call has no result yet (still running) or the next entry is somebody
 * else's. Matched on `callId` — the id the host pairs them with on the wire
 * (`ChatToolCallEvent.callId` / `ChatToolResultEvent.callId`) — so an
 * interleaved run can never fold the wrong result into a call.
 */
/**
 * This call's own result, wherever it landed.
 *
 * `pairedResult` takes the result immediately after the call, which is what a
 * lone call looks like. A BATCH does not: the agent emits every call and then
 * every result, so `[call a, call b, result a, result b]` leaves no call
 * adjacent to its own result. That is the ordinary case rather than the odd one
 * — agents batch constantly — and for `view_file` it decides whether the file is
 * rendered at all, so the result is matched by `callId` across the range.
 */
function resultIndexFor(
  timeline: ChatEventEntry[],
  call: ChatEventEntry,
  i: number,
  to: number,
): number {
  if (!call.callId) return -1;
  for (let j = i + 1; j < to; j++) {
    const next = timeline[j];
    if (next?.kind === 'tool_result' && next.callId === call.callId) return j;
  }

  return -1;
}

function pairedResult(
  timeline: ChatEventEntry[],
  i: number,
  to: number,
): ChatEventEntry | undefined {
  const call = timeline[i];
  const next = timeline[i + 1];
  if (!call || !next || i + 1 >= to) return undefined;
  if (next.kind !== 'tool_result') return undefined;
  if (!call.callId || call.callId !== next.callId) return undefined;
  return next;
}

// Generic key/value formatting for a tool call's args or a tool result's
// payload. spec/14 only requires "click to expand full args + result" — it
// doesn't mandate a raw JSON dump, and a wall of braces/quotes is hard to
// scan. Each field gets its own `key: value` row; a nested object/array
// recurses into its own indented field list rather than collapsing back to a
// JSON blob. Renders nothing for `null`/`undefined`/`{}` (no empty dl), which
// keeps the "toolArgs entirely omitted" case an empty detail pane rather than
// literal "{}" text.
//
// spec/14 § Tool calls — an image content block (e.g. from `Read` loading a
// screenshot) renders as the actual picture instead of recursing into its
// `source.data` field and dumping a wall of base64 text (Tom: "is it trying
// to show an image?" — it wasn't; now it does).
function ToolFields({ value }: { value: unknown }): JSX.Element {
  const chatId = useContext(BlobChatIdContext);
  if (value === null || value === undefined) return <></>;
  const blob = asBlobRef(value);
  if (blob) return <ToolBlobBody blob={blob} />;
  const image = imageDataUri(value, chatId);
  if (image) return <ToolImage {...image} />;
  if (typeof value !== 'object') {
    return <span className="tool-field-scalar">{formatFieldScalar(value)}</span>;
  }
  // An array's positions are not field names. Labelling them printed a literal
  // "0:" / "1:" above every element — most visibly under a `Read` image result,
  // whose payload is the two-element content array [text, image] (Tom: "0:
  // artifact"). Elements stack unlabelled; only real object keys get a <dt>.
  if (Array.isArray(value)) {
    if (value.length === 0) return <></>;
    return (
      <div className="tool-field-list" data-testid="tool-field-list">
        {value.map((v, i) => (
          <div className="tool-field-item" key={i}>
            <ToolFieldValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <></>;
  return (
    <dl className="tool-fields">
      {entries.map(([key, v]) => (
        <div className="tool-field-row" key={key}>
          <dt className="tool-field-key">{key}</dt>
          <dd className="tool-field-value">
            <ToolFieldValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One field's value: a picture, a nested field list, or a scalar. */
function ToolFieldValue({ value }: { value: unknown }): JSX.Element {
  const chatId = useContext(BlobChatIdContext);
  const image = imageDataUri(value, chatId);
  if (image) return <ToolImage {...image} />;
  if (value !== null && typeof value === 'object') return <ToolFields value={value} />;
  return <>{formatFieldScalar(value)}</>;
}

/**
 * A data: URI for a value shaped like Anthropic's image content block
 * (`{ type: 'image', source: { type: 'base64', media_type, data } }`), or
 * `null` if `value` isn't one. This is the shape a tool result's content
 * carries when e.g. `Read` loads an image file — the only image shape any
 * tool call/result currently produces, so nothing else is treated as one.
 * Matches the `image` variant of `@patch/wire`'s `ChatToolResultContentBlock`
 * (see the doc comment on `ChatToolResultEvent.result`) — checked
 * field-by-field here rather than parsed against that type directly, since a
 * real image block may carry extra fields (e.g. `cache_control`) that must
 * not stop it from being recognised.
 */
function imageDataUri(value: unknown, chatId: string | null): ToolImageSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['type'] !== 'image') return null;
  const source = v['source'];
  if (typeof source !== 'object' || source === null) return null;
  const s = source as Record<string, unknown>;
  const mediaType = s['media_type'];
  if (typeof mediaType !== 'string' || mediaType.length === 0) return null;
  const width = typeof s['width'] === 'number' ? s['width'] : undefined;
  const height = typeof s['height'] === 'number' ? s['height'] : undefined;
  if (s['type'] === 'blob') {
    // The common case since replay stopped carrying image bytes: the browser
    // streams the picture itself, on its own schedule, and caches it for good.
    const sha = s['$blob'];
    if (typeof sha !== 'string' || chatId === null) return null;
    return { src: blobUrl(chatId, sha), width, height };
  }
  if (s['type'] !== 'base64') return null;
  const data = s['data'];
  if (typeof data !== 'string' || data.length === 0) return null;
  // Still reached by a LIVE result, which carries its bytes inline — only the
  // logged copy is externalised.
  return { src: `data:${mediaType};base64,${data}`, width, height };
}

/** Where a tool image comes from, and the box to hold for it. */
interface ToolImageSource {
  src: string;
  width?: number | undefined;
  height?: number | undefined;
}

// A tool call/result's image content block, expanded inline: same
// click-to-zoom in-app lightbox as a message's own image attachments
// (`MessageAttachments`/`ImageLightbox`), so an image renders identically
// whether Tom attached it or a tool call produced it.
function ToolImage({ src, width, height }: ToolImageSource): JSX.Element {
  const [open, setOpen] = useState(false);
  // The intrinsic `width`/`height` below are what reserve the picture's box
  // before any of its bytes arrive (with `max-width: 100%; height: auto` in
  // index.css). Without them a transcript full of images shoves itself around
  // as each one lands — which is half of what "it scrolls through the
  // messages one by one" actually looks like.
  return (
    <>
      <button
        type="button"
        className="tool-field-img-btn"
        data-testid="tool-field-image"
        aria-label="View image"
        onClick={() => setOpen(true)}
      >
        <img
          className="tool-field-img"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          {...(width !== undefined ? { width } : {})}
          {...(height !== undefined ? { height } : {})}
        />
      </button>
      {open ? <ImageLightbox url={src} alt="Tool image" onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * A tool result whose body replay deliberately left in the blob store
 * (spec/04 § History — blobs). The row shows what it always showed — the
 * start of the text — and fetches the rest only if asked. Most of these are
 * never opened, which is the entire reason the body is not sent.
 *
 * NO FALLBACK: a failed fetch says so and stays failed. Quietly showing the
 * preview as though it were the whole result would turn a truncated tool
 * output into something that reads complete.
 */
function ToolBlobBody({ blob }: { blob: ToolBlobRef }): JSX.Element {
  const chatId = useContext(BlobChatIdContext);
  const [state, setState] = useState<
    { phase: 'loading' } | { phase: 'done'; value: unknown } | { phase: 'failed'; error: string }
  >({ phase: 'loading' });

  const load = useCallback((): void => {
    if (chatId === null) return;
    setState({ phase: 'loading' });
    fetch(blobUrl(chatId, blob.$blob))
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return r.json() as Promise<unknown>;
      })
      .then((value) => setState({ phase: 'done', value }))
      .catch((err: unknown) =>
        setState({ phase: 'failed', error: err instanceof Error ? err.message : String(err) }),
      );
  }, [chatId, blob.$blob]);

  // Fetched on MOUNT, and this only mounts when the row is opened — the
  // detail pane is `{open ? … : null}`. So opening a row reads like opening a
  // row: no second click to see what the tool actually said. Nothing is
  // fetched for the rows nobody opens, which is the entire point of replay
  // not sending the bodies. The sha is the content, so the response is
  // `immutable` and reopening the row costs nothing.
  useEffect(() => load(), [load]);

  if (state.phase === 'done') return <ToolFields value={state.value} />;

  return (
    <div className="tool-blob" data-testid="tool-blob">
      {blob.preview ? <span className="tool-field-scalar">{blob.preview}</span> : null}
      {state.phase === 'failed' ? (
        <>
          <span className="tool-blob-error" data-testid="tool-blob-error">
            Could not load the rest: {state.error}
          </span>
          {/* NO FALLBACK: the preview stays visible but is never passed off as
              the whole result — there is always something saying it is not. */}
          <button
            type="button"
            className="tool-blob-load"
            data-testid="tool-blob-load"
            onClick={load}
          >
            Retry ({formatBytes(blob.bytes)})
          </button>
        </>
      ) : (
        <span className="tool-blob-load" data-testid="tool-blob-load">
          Loading {formatBytes(blob.bytes)}…
        </span>
      )}
    </div>
  );
}

/** What `view_file` hands back: where the rendered page lives, and what it is. */
interface ViewFileView {
  kind: 'image' | 'pdf' | 'html';
  /** Server-relative URL of the wrapped page (`/api/chats/:id/artifact/:aid`). */
  url: string;
  name: string;
  /** An image's real pixel size, so its box is held before it loads. */
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * Parse a `view_file` tool result. The host returns a SMALL json ack (the
 * point of the tool is that the bytes go to the screen, not into Claude's
 * context), which reaches the UI inside MCP's `{ content: [{ type: 'text',
 * text }] }` envelope — unwrapped here, with the bare-object shape also
 * accepted so a direct host payload renders the same.
 *
 * A live chat delivers the BARE content-block array, not the envelope:
 * `chatRunner.ts` sets `ChatToolResultEvent.result` to the SDK block's own
 * `content` (see the comment on that field in `packages/wire/src/events.ts`),
 * so the `{ content }` wrapper is already gone by the time a surface sees it.
 * Accept the array too, or every real `view_file` falls through to an
 * ordinary tool row and the file is never shown.
 */
function viewFilePayload(result: unknown): ViewFileView | null {
  const direct = asViewFile(result);
  if (direct) return direct;
  if (typeof result !== 'object' || result === null) return null;
  const content = Array.isArray(result) ? result : (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as Record<string, unknown>)['text'];
    if (typeof text !== 'string') continue;
    try {
      const parsed = asViewFile(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // Not this block — a `view_file` ack is always valid JSON, so a block
      // that isn't simply is not the ack. No fallback rendering.
    }
  }
  return null;
}

function asViewFile(value: unknown): ViewFileView | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const kind = v['kind'];
  const url = v['url'];
  const name = v['name'];
  if (kind !== 'image' && kind !== 'pdf' && kind !== 'html') return null;
  if (typeof url !== 'string' || !url.startsWith('/api/')) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  const width = typeof v['width'] === 'number' ? v['width'] : undefined;
  const height = typeof v['height'] === 'number' ? v['height'] : undefined;
  return { kind, url, name, width, height };
}

/**
 * spec/14 ## Main chat panel — what a `patch_job_*` row announces. A job call
 * changes what runs on a SCHEDULE, so unlike an `ls` its effect outlives the
 * turn and cannot be re-read from the transcript: the row has to say what
 * changed and hand over a way to go and look at it.
 */
interface JobCallRow {
  /** Past-tense verb for the mutation — "Job created", "Job disabled". */
  verb: string;
  /** The job's name where the call or its result names it. */
  name: string | null;
  /** Schedule, via the SAME derivation the Jobs list row uses. */
  trigger: string | null;
  /** Id to link to, from the result or from the args it was called with. */
  jobId: string | null;
}

/**
 * The mutating `patch_job_*` tools and what each one DID. Read-only calls
 * (`patch_job_list`, `patch_job_runs`, `patch_job_webhooks`) are deliberately
 * absent: they change nothing, so they stay on the ordinary collapsed row.
 */
const JOB_CALL_VERBS: Record<string, string> = {
  patch_job_create: 'Job created',
  patch_job_update: 'Job updated',
  patch_job_delete: 'Job deleted',
  patch_job_enable: 'Job enabled',
  patch_job_disable: 'Job disabled',
};

/** A `{ jobId, job }` ack, however the tool layer happened to wrap it. */
function asJobAck(value: unknown): { jobId?: string; job?: Job } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const jobId = typeof v['jobId'] === 'string' ? v['jobId'] : undefined;
  const job = typeof v['job'] === 'object' && v['job'] !== null ? (v['job'] as Job) : undefined;
  if (jobId === undefined && job === undefined) return null;
  return { jobId, job };
}

/**
 * Unwrap a job ack from a tool result. Same three shapes `view_file` has to
 * cope with: the bare object, MCP's `{ content: [{ type: 'text', text }] }`
 * envelope, and the bare content-block ARRAY a live chat delivers (see
 * `viewFilePayload` — `chatRunner.ts` strips the envelope before a surface
 * sees it). Missing the array shape is exactly how a real job create renders
 * as nothing while the test-shaped one renders fine.
 */
function jobAckPayload(result: unknown): { jobId?: string; job?: Job } | null {
  const direct = asJobAck(result);
  if (direct) return direct;
  if (typeof result !== 'object' || result === null) return null;
  const content = Array.isArray(result) ? result : (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as Record<string, unknown>)['text'];
    if (typeof text !== 'string') continue;
    try {
      const parsed = asJobAck(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // Not this block — a job ack is always valid JSON, so a block that
      // isn't simply is not the ack.
    }
  }
  return null;
}

/** A value shaped enough like a trigger for `describeTrigger` to read it. */
function asTrigger(value: unknown): JobTrigger | null {
  if (typeof value !== 'object' || value === null) return null;
  return typeof (value as Record<string, unknown>)['type'] === 'string'
    ? (value as JobTrigger)
    : null;
}

/**
 * What a `patch_job_*` call should announce, or null for a call that is not a
 * job mutation. The result is the better source — it carries the job the
 * server actually stored — but a call with no usable result still announces
 * itself from the args it was made with, because "nothing visible happened"
 * is the failure this row exists to fix.
 */
function jobCallRow(
  tool: string | undefined,
  args: Record<string, unknown>,
  result: unknown,
): JobCallRow | null {
  if (!tool) return null;
  const verb = JOB_CALL_VERBS[toolLabel(tool)];
  if (!verb) return null;
  const ack = jobAckPayload(result);
  const job = ack?.job;
  const name = job?.name ?? (typeof args['name'] === 'string' ? args['name'] : null);
  const trigger = asTrigger(job?.trigger) ?? asTrigger(args['trigger']);
  const jobId = ack?.jobId ?? job?.id ?? (typeof args['jobId'] === 'string' ? args['jobId'] : null);
  return { verb, name, trigger: trigger ? describeTrigger(trigger) : null, jobId };
}

/** A `{ id, label }` delegate-create ack, however the tool layer wrapped it. */
function asDelegateAck(value: unknown): { id: string; label: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const id = v['id'];
  const label = v['label'];
  if (typeof id === 'string' && id !== '' && typeof label === 'string' && label !== '') {
    return { id, label };
  }
  return null;
}

/**
 * Unwrap `patch_delegate`'s `{ id, label }` ack from its tool result — same
 * bare-object / MCP-envelope shapes `jobAckPayload` copes with (see there).
 */
function delegateAckPayload(result: unknown): { id: string; label: string } | null {
  const direct = asDelegateAck(result);
  if (direct) return direct;
  if (typeof result !== 'object' || result === null) return null;
  const content = Array.isArray(result) ? result : (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as Record<string, unknown>)['text'];
    if (typeof text !== 'string') continue;
    try {
      const parsed = asDelegateAck(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // Not this block.
    }
  }
  return null;
}

const DELEGATE_STATUS_LABEL: Record<DelegateUpdateInfo['status'], string> = {
  running: 'Running',
  'awaiting-permission': 'Awaiting permission',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

/**
 * spec/14 § Main chat panel — Delegate tool row: a `patch_delegate` call
 * is a collapsible row INSIDE the parent transcript. It carries a live status pill
 * — sourced from `chat.delegate_update`, keyed by the subagent's own chatId
 * (the `id` its own tool result returns) — and a trailing "Open transcript"
 * link, because the subagent is never a chat this surface can open the
 * ordinary way (spec/04 § Chats and folders — Subagent). Until the result
 * lands (a near-instant gap — `patch_delegate` acks synchronously) there is
 * no id to key anything on, so it falls back to the ordinary disclosure row
 * rather than showing a pill with nothing behind it.
 */
function DelegateToolCall({
  chatId,
  args,
  result,
  summary,
}: {
  chatId: string;
  args: Record<string, unknown>;
  result?: ChatEventEntry;
  summary: string;
}): JSX.Element {
  const ack = delegateAckPayload(result?.toolResult);
  const live = useChatStore((s) => (ack ? s.delegateUpdates[chatId]?.[ack.id] : undefined));
  const [open, setOpen] = useState(false);

  if (!ack) {
    return (
      <ToolDisclosure
        testid="tool-call"
        summary={result ? `${summary} →` : summary}
        detail={
          <>
            <ToolFields value={args} />
            {result ? (
              <div className="tool-result-inline" data-testid="tool-call-result">
                <ToolFields value={result.toolResult} />
              </div>
            ) : null}
          </>
        }
      />
    );
  }

  const status = live?.status ?? 'running';

  return (
    <div className="tool-call tool-call-delegate" data-testid="tool-call" data-delegate="true">
      <button
        type="button"
        className="tool-summary tool-summary-delegate"
        data-testid="delegate-open-transcript"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-summary-text">{summary}</span>
        <span
          className={`delegate-pill delegate-pill-${status}`}
          data-testid="delegate-status-pill"
        >
          {DELEGATE_STATUS_LABEL[status]}
        </span>
        <ChevronDown
          size={13}
          aria-hidden
          className={open ? 'delegate-chevron open' : 'delegate-chevron'}
        />
      </button>
      {open ? <DelegateTranscript parentId={chatId} delegateId={ack.id} status={status} /> : null}
    </div>
  );
}

const NO_DELEGATES: Record<string, DelegateUpdateInfo> = {};

/**
 * spec/14 § Main chat panel — Running delegates strip: one line per
 * `patch_delegate` subagent still going (label + running time) above the
 * composer, so it stays on screen after the tool-call row has scrolled away.
 * Each line opens the subagent's read-only transcript; a subagent leaves the
 * strip the moment it is no longer running or awaiting permission.
 */
function DelegateStrip({ chatId }: { chatId: string }): JSX.Element | null {
  const updates = useChatStore((s) => s.delegateUpdates[chatId] ?? NO_DELEGATES);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = Object.entries(updates).filter(
    ([, d]) => d.status === 'running' || d.status === 'awaiting-permission',
  );
  const any = running.length > 0;
  useEffect(() => {
    if (!any) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [any]);
  if (!any) return null;
  return (
    <div className="delegate-strip" data-testid="delegate-strip">
      {running.map(([id, d]) => (
        <div key={id} className="delegate-strip-item" data-testid="delegate-strip-item">
          <button
            type="button"
            className="delegate-strip-row"
            data-testid="delegate-strip-open"
            aria-expanded={openId === id}
            onClick={() => setOpenId(openId === id ? null : id)}
          >
            <span className="delegate-strip-label">{d.label}</span>
            <span className="delegate-strip-time" data-testid="delegate-strip-time">
              {formatElapsed(d.since, now)}
            </span>
          </button>
          {openId === id ? (
            <DelegateTranscript parentId={chatId} delegateId={id} status={d.status} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

interface DelegateHistoryEvent {
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * The read-only transcript a Delegate tool row's "Open transcript" opens
 * (spec/14 § Main chat panel — Delegate tool row): the subagent's own
 * message exchange, no composer, no tool calls, no permission cards — a
 * transcript, not a second chat window. Polls while the subagent is still
 * going, the same way the Side threads panel polls a running branch, since
 * nothing broadcasts a subagent's own traffic to this surface.
 */
function DelegateTranscript({
  parentId,
  delegateId,
  status,
}: {
  parentId: string;
  delegateId: string;
  status: DelegateUpdateInfo['status'];
}): JSX.Element {
  const live = status === 'running' || status === 'awaiting-permission';
  const { data, isLoading, error } = useQuery({
    queryKey: ['delegate-history', parentId, delegateId],
    queryFn: () => api.getDelegateHistory(parentId, delegateId),
    refetchInterval: live ? 2000 : false,
    // A failed pull can already have sat out the server's 5s daemon timeout;
    // the app-wide retry would double that "Loading…" before the error shows.
    retry: false,
  });
  const events = (data?.events ?? []) as unknown as DelegateHistoryEvent[];

  return (
    <div className="delegate-transcript-stream" data-testid="delegate-transcript-stream">
      {isLoading ? <div className="delegate-transcript-loading">Loading…</div> : null}
      {error ? <div className="delegate-transcript-error">Couldn't load transcript.</div> : null}
      {events.map((e) => (
        <div key={e.seq} className={`msg msg-${e.role}`} data-testid="delegate-transcript-msg">
          <div className="content md">
            <Markdown content={e.content} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A `view_file` result, rendered where it happened. The page is served from
 * the artifact origin with `Content-Security-Policy: sandbox allow-scripts`,
 * and mounted in a `sandbox`ed iframe on top of that — an agent-named file
 * cannot reach the SPA's credential from either side of the boundary.
 *
 * An image is shown at a readable size and expands; an HTML file gets a taller
 * frame, since a page needs room to be a page.
 */
function ViewFileCard({ view }: { view: ViewFileView }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const isImage = view.kind === 'image';
  return (
    <div
      className={`view-file view-file-${view.kind}${expanded ? ' expanded' : ''}`}
      data-testid="view-file"
      data-kind={view.kind}
      data-expanded={expanded}
    >
      <div className="view-file-bar">
        {isImage ? (
          <span className="view-file-name">{view.name}</span>
        ) : (
          <button
            type="button"
            className="view-file-name"
            data-testid="view-file-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Shrink' : 'Expand'}
          >
            {view.name}
          </button>
        )}
        <a
          className="view-file-open"
          href={view.url}
          target="_blank"
          rel="noreferrer"
          data-testid="view-file-open"
        >
          <ExternalLink size={13} aria-hidden />
        </a>
      </div>
      {isImage ? (
        <button
          type="button"
          className="view-file-img-btn"
          data-testid="view-file-image"
          aria-label={`View ${view.name}`}
          onClick={() => setLightboxOpen(true)}
        >
          <img
            className="view-file-img"
            src={view.url}
            alt={view.name}
            loading="lazy"
            decoding="async"
            {...(view.width !== undefined ? { width: view.width } : {})}
            {...(view.height !== undefined ? { height: view.height } : {})}
          />
        </button>
      ) : (
        <iframe
          className="view-file-frame"
          data-testid="view-file-frame"
          src={view.url}
          title={view.name}
          sandbox="allow-scripts"
          loading="lazy"
        />
      )}
      {isImage && lightboxOpen ? (
        <ImageLightbox url={view.url} alt={view.name} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </div>
  );
}

function formatFieldScalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  return JSON.stringify(v);
}

// File-edit tool-call row: a click-to-open-editor summary plus a chevron
// that toggles the inline diff preview, collapsed by default like every
// other tool call (spec/14 ## Main chat panel: "Tool calls: collapsed by
// default with one-line summary; click to expand"). The chevron and the
// summary are separate click targets — expanding the preview must not also
// open the Monaco editor, and vice versa.
function EditToolCall({
  chatId,
  filePath,
  oldStr,
  newStr,
  summary,
}: {
  chatId: string;
  filePath: string;
  oldStr: string;
  newStr: string;
  summary: string;
}): JSX.Element {
  const [diffOpen, setDiffOpen] = useState(false);
  return (
    <div
      className={`tool-call tool-call-edit${diffOpen ? ' open' : ''}`}
      data-testid="tool-call"
      data-edit="true"
      data-open={diffOpen}
    >
      <div className="tool-summary-edit-row">
        <button
          type="button"
          className="tool-chevron-btn"
          data-testid="tool-call-diff-toggle"
          aria-expanded={diffOpen}
          onClick={() => setDiffOpen((v) => !v)}
          title={diffOpen ? 'Collapse diff preview' : 'Expand diff preview'}
        >
          <span className="tool-chevron" aria-hidden>
            {diffOpen ? '▾' : '▸'}
          </span>
        </button>
        <button
          type="button"
          className="tool-summary-edit"
          data-testid="tool-call-open-diff"
          onClick={() => {
            void openDiffForFile(chatId, filePath).catch((err) => {
              useUiStore.getState().pushError(`editor: ${(err as Error).message}`);
            });
          }}
          title="Open diff in editor"
        >
          {summary}
        </button>
      </div>
      {diffOpen ? (
        <div className="tool-detail" data-testid="tool-call-diff-detail">
          <InlineDiff filePath={filePath} oldStr={oldStr} newStr={newStr} />
        </div>
      ) : null}
    </div>
  );
}

// Inline read-only unified diff for a file-edit tool, computed from the
// old/new strings carried in the stream's tool-call args (spec/14 ## Main chat
// panel — "inline unified diff view for file-edit tools (read-only preview
// from the stream)"). This is the lightweight in-stream preview; the docked
// Monaco diff editor (opened by clicking the summary) is the full surface.
// Removed lines are prefixed `−`, added lines `+`, colour-coded via the
// existing .diff-del / .diff-add styles.
function InlineDiff({
  filePath,
  oldStr,
  newStr,
}: {
  filePath: string;
  oldStr: string;
  newStr: string;
}): JSX.Element {
  const oldLines = oldStr === '' ? [] : oldStr.replace(/\n$/, '').split('\n');
  const newLines = newStr === '' ? [] : newStr.replace(/\n$/, '').split('\n');
  return (
    <pre className="diff" data-testid="inline-diff" data-path={filePath}>
      <div className="diff-path">{filePath}</div>
      {oldLines.map((line, i) => (
        <div className="diff-line diff-del" data-testid="diff-del-line" key={`del-${i}`}>
          <span className="diff-sign" aria-hidden>
            −
          </span>
          {line}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div className="diff-line diff-add" data-testid="diff-add-line" key={`add-${i}`}>
          <span className="diff-sign" aria-hidden>
            +
          </span>
          {line}
        </div>
      ))}
    </pre>
  );
}

function ToolResult({ entry }: { entry: ChatEventEntry }): JSX.Element {
  return (
    <ToolDisclosure
      testid="tool-result"
      summary={`${entry.tool} →`}
      detail={<ToolFields value={entry.toolResult} />}
    />
  );
}

// A file-edit call renders its own row with an inline diff, so it is never
// folded into a tool-run group (spec/14 ## Main chat panel — "File-edit calls
// and Monitor calls stay directly in the transcript").
function isEditToolCall(entry: ChatEventEntry): boolean {
  return typeof entry.tool === 'string' && isEditToolCallWire(entry.tool, entry.toolArgs);
}

/**
 * Can this entry be folded into a tool-run group? The call half of the rule is
 * `@patch/wire`'s, shared with mobile and with the host that summarises runs.
 */
function isGroupableToolEntry(entry: ChatEventEntry): boolean {
  if (entry.kind === 'tool_result') return true;
  if (entry.kind !== 'tool_call') return false;
  return isGroupableToolCall(entry.tool, entry.toolArgs);
}

/** A `view_file` call, however the stream spelled the tool's name. */
function isViewFileCall(entry: ChatEventEntry): boolean {
  return (
    entry.kind === 'tool_call' &&
    !!entry.tool &&
    (toolLabel(entry.tool) === 'view_file' || toolLabel(entry.tool) === 'patch_notify')
  );
}

// spec/14 ## Main chat panel — "Tool runs collapse to one row". A consecutive
// run of tool calls + results is one line saying what the batch did: once the
// run has closed, the host's AI summary of it ("Set up the project
// locally"); until then, or if that summary failed, a count of the work by
// kind ("Ran 3 commands, read 2 files"). Never every call and its target —
// that detail is a click away, not on screen before it's asked for; expanding
// mounts the very same rows the run would have rendered ungrouped. Memoised
// element-wise on its entries: the store keeps the identity of untouched
// entries, so a live turn appending to the tail re-renders only the group it
// lands in, not every group above it.
const ToolGroup = memo(
  function ToolGroup({
    entries,
    narration,
    chatId,
  }: {
    entries: ChatEventEntry[];
    narration: string | null;
    chatId: string;
  }) {
    const calls = entries.filter((e) => e.kind === 'tool_call');
    // A run that grew out of a call the user already opened starts open.
    const [open, setOpen] = useState(() =>
      calls.some((c) => c.callId !== undefined && toolRowOpen.get(c.callId) === true),
    );
    const ai = useChatStore((s) => {
      const first = calls[0]?.callId;
      return first === undefined ? undefined : s.toolRunSummaries[chatId]?.[first];
    });
    // The summary names the run it was written for; a run this surface cut
    // differently (a rule drift) gets the count, not a label for other calls.
    const matches =
      ai !== undefined &&
      ai.callIds.length === calls.length &&
      ai.callIds.every((id, i) => calls[i]?.callId === id);
    const aiSummary = matches ? ai.summary : null;
    const aiError = matches ? ai.error : undefined;
    // No label yet: the agent's own sentence before the run, else the count. A
    // failed label keeps the count so the failure reads as one.
    const summary =
      aiSummary ?? (aiError === undefined ? narration : null) ?? toolRunNarrative(calls);
    // A collapsed run hides its calls, so the unreturned one's own spinner is
    // out of sight: surface the oldest still-open call on the run's row.
    const openCallIds = useChatStore((s) => s.chats[chatId]?.openCallIds);
    const runningCall = calls.find(
      (c) =>
        c.callId !== undefined &&
        !isQuestionTool(c.tool) &&
        openCallIds?.includes(c.callId) &&
        !entries.some((e) => e.kind === 'tool_result' && e.callId === c.callId),
    );
    return (
      <div
        className={`tool-group${open ? ' open' : ''}`}
        data-testid="tool-group"
        data-open={open}
        data-count={calls.length}
        data-summary={
          aiSummary !== null
            ? 'ai'
            : aiError !== undefined
              ? 'failed'
              : narration !== null
                ? 'narration'
                : 'count'
        }
      >
        <button
          type="button"
          className="tool-summary"
          data-testid="tool-group-summary"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tool-chevron" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          <span className="tool-summary-text">{summary}</span>
          {runningCall && !open ? <ToolRunning since={runningCall.startedAt} /> : null}
          {aiError !== undefined ? (
            <span
              className="tool-summary-failed"
              data-testid="tool-group-summary-failed"
              title={`Summary failed: ${aiError}`}
            >
              <Info size={16} strokeWidth={2} aria-hidden />
            </span>
          ) : null}
        </button>
        {open ? (
          <div className="tool-group-detail" data-testid="tool-group-detail">
            {entries.map((e, i) => {
              // Same call+result folding as the ungrouped path: a result that
              // belongs to the call above it renders inside that call's row,
              // not as a second row (it is skipped when reached).
              if (e.kind === 'tool_call') {
                const paired = pairedResult(entries, i, entries.length);
                return (
                  <ToolCall
                    key={`${e.seq}-${i}`}
                    entry={e}
                    {...(paired ? { result: paired } : {})}
                    chatId={chatId}
                  />
                );
              }
              const prev = entries[i - 1];
              if (prev?.kind === 'tool_call' && prev.callId && prev.callId === e.callId)
                return null;
              return <ToolResult key={`${e.seq}-${i}`} entry={e} />;
            })}
          </div>
        ) : null}
      </div>
    );
  },
  (a, b) =>
    a.chatId === b.chatId &&
    a.narration === b.narration &&
    a.entries.length === b.entries.length &&
    a.entries.every((e, i) => e === b.entries[i]),
);

// Spinner and ticking elapsed time on a tool row whose call has not returned.
function ToolRunning({ since }: { since: number | undefined }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return (
    <span className="tool-running" data-testid="tool-running">
      <LoaderCircle className="tool-running-spinner" size={13} aria-hidden />
      {since !== undefined ? (
        <span data-testid="tool-running-elapsed">{formatElapsed(since, now)}</span>
      ) : null}
    </span>
  );
}

/** A question to Tom (`AskUserQuestion` / `patch_ask_human`) waits on him; it is not a tool at work. */
function isQuestionTool(tool: string | undefined): boolean {
  return (
    tool === ASK_USER_QUESTION || (tool !== undefined && toolLabel(tool) === 'patch_ask_human')
  );
}

// Generic collapse/expand wrapper. Collapsed shows only the one-line summary;
// the full payload mounts on expand. Plain React state (not <details>) so the
// collapsed state is assertable and the expanded body is unambiguous.
// Open state of tool rows, keyed by call id. A lone in-progress call becomes
// part of a group when the next call arrives, which remounts it; without this
// the row the user just tapped open snaps shut under their finger.
const toolRowOpen = new Map<string, boolean>();

function ToolDisclosure({
  openKey,
  testid,
  summary,
  detail,
  variant,
  badge,
  defaultOpen,
  runningSince,
}: {
  /** Present while the call is running: draws a spinner, and the elapsed time when `at` (the real start) is known. */
  runningSince?: { at: number | undefined };
  /** Call id this row's open state survives remounts under. */
  openKey?: string;
  testid: string;
  summary: string;
  detail: JSX.Element;
  /** Extra class on the container, for a row that reads quieter than a tool call. */
  variant?: string;
  /** Mark shown before the summary, saying where the row came from. */
  badge?: JSX.Element;
  /** Initial expand state. Defaults to collapsed; a click always still toggles it. */
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpenState] = useState(
    (openKey !== undefined ? toolRowOpen.get(openKey) : undefined) ?? defaultOpen ?? false,
  );
  const setOpen = (fn: (v: boolean) => boolean): void => {
    setOpenState((v) => {
      const next = fn(v);
      if (openKey !== undefined) toolRowOpen.set(openKey, next);
      return next;
    });
  };
  return (
    <div
      className={`tool-call${variant ? ` ${variant}` : ''}${open ? ' open' : ''}`}
      data-testid={testid}
      data-open={open}
    >
      <button
        type="button"
        className="tool-summary"
        data-testid={`${testid}-summary`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {badge}
        <span className="tool-summary-text">{summary}</span>
        {runningSince !== undefined ? <ToolRunning since={runningSince.at} /> : null}
      </button>
      {open ? (
        <div className="tool-detail" data-testid={`${testid}-detail`}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

// spec/14 § Context compression — the compaction boundary as one quiet line.
// The summary text is the host's (spec/02 § Context compression), so every
// surface words it the same way; expanding shows the exact figures behind it.
// Counts the SDK never reported are absent from both, never shown as zero.
function CompactionLine({ entry }: { entry: ChatEventEntry }): JSX.Element {
  const c = entry.compaction!;
  const rows: [string, string][] = [
    ['Trigger', c.trigger === 'auto' ? 'Automatic' : 'Manual'],
    ['Before', `${c.preTokens.toLocaleString('en-GB')} tokens`],
  ];
  if (c.postTokens !== undefined) {
    rows.push(['After', `${c.postTokens.toLocaleString('en-GB')} tokens`]);
  }
  if (c.durationMs !== undefined) rows.push(['Took', `${(c.durationMs / 1000).toFixed(1)}s`]);
  return (
    <ToolDisclosure
      testid="compaction"
      variant="compaction"
      summary={entry.content ?? ''}
      detail={
        <dl className="compaction-figures">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      }
    />
  );
}

// spec/14 § Main chat panel — where the permission mode changed, as one rule
// across the stream. There is nothing behind it to expand: the line IS the
// whole fact, and the mode is named with the agent's own word for it, the same
// as every control that offers the choice.
/**
 * spec/07 § Latency — the words being spoken on a call, as the user's own
 * bubble at the end of the call's chat, in italics while they are a live
 * guess. Gone the moment the transcript is final; the persisted message takes
 * its place.
 */
function VoiceLiveBubble({ chatId }: { chatId: string }): JSX.Element | null {
  const words = useVoiceStore((s) =>
    s.call !== null && s.call.chatId === chatId ? s.call.transcript : '',
  );
  if (words === '') return null;
  return (
    <div className="msg msg-user voice-live" data-testid="voice-live-bubble" aria-live="polite">
      <div className="content">{words}</div>
    </div>
  );
}

// spec/02 § Per-turn process — words Claude Code put in the agent's mouth. The
// placeholder it writes on resuming a turn that got no reply is named for what
// it means; anything else it injects is shown as itself.
const RESUME_PLACEHOLDER = 'No response requested.';

function SyntheticNoticeLine({ entry }: { entry: ChatEventEntry }): JSX.Element {
  const text = entry.content ?? '';
  const quoted = `Claude Code inserted “${text}”`;
  return (
    <div className="synthetic-notice" data-testid="synthetic-notice">
      {text === RESUME_PLACEHOLDER ? (
        <>
          <span className="synthetic-notice-source">› Turn interrupted</span>
          <span>{quoted}</span>
        </>
      ) : (
        <span className="synthetic-notice-source">› {quoted}</span>
      )}
    </div>
  );
}

function PermissionModeLine({ entry }: { entry: ChatEventEntry }): JSX.Element {
  return (
    <div className="mode-change" data-testid="permission-mode-change">
      <span className="mode-change-label">{entry.content ?? ''}</span>
    </div>
  );
}

// spec/14 § Automations, spec/08 § Action — the trigger prompt/payload that
// spawned this job-linked chat, as one quiet furniture line (same treatment
// as `CompactionLine`) instead of a full user bubble, so a raw webhook
// payload or mustached prompt never reads as if Tom typed it. Expanding
// shows the exact text the job service sent.
function JobTriggerLine({ entry }: { entry: ChatEventEntry }): JSX.Element {
  return (
    <ToolDisclosure
      testid="job-trigger"
      variant="trigger"
      summary="Automated trigger"
      detail={<code>{entry.content ?? ''}</code>}
    />
  );
}

// spec/20-hooks.md § On the agent's response, spec/14 § Agent-response
// hooks — a `block` resubmit, named by the hook(s) that forced it; expanding
// shows the exact text (the hook's own analysis/suggestion) the agent
// received, since that IS this turn's content.
function HookTriggerLine({ entry }: { entry: ChatEventEntry }): JSX.Element {
  const hooks = entry.hookTrigger?.hooks ?? [];
  const names = hooks.map((h) => h.hookName).join(', ');
  return (
    <ToolDisclosure
      testid="hook-trigger"
      variant="trigger"
      summary={names.length > 0 ? `Hook blocked — ${names}` : 'Hook blocked'}
      detail={<code>{entry.content ?? ''}</code>}
    />
  );
}

// spec/04 § Goals — a `not_met` resubmit, the SAME collapsed-furniture
// treatment as a hook's `block` (it is one, functionally): the summary names
// the reason (truncated); expanding shows the exact text, since that IS this
// turn's content (the evaluator's reason, verbatim).
function GoalTriggerLine({ entry }: { entry: ChatEventEntry }): JSX.Element {
  const reason = entry.goalTrigger?.reason ?? '';
  const truncated = reason.length > 80 ? `${reason.slice(0, 79)}…` : reason;
  return (
    <ToolDisclosure
      testid="goal-trigger"
      variant="trigger"
      summary={truncated.length > 0 ? `Goal not met — ${truncated}` : 'Goal not met'}
      detail={<code>{entry.content ?? ''}</code>}
    />
  );
}

// spec/04 § Goals — a goal resolving met/impossible: no turn to attach to (the
// host never resubmits either of these), so this is the plain system-role
// row's own render, collapsed the same way as every other quiet furniture
// line, expanding to the evaluator's full final reason.
function GoalOutcomeLine({ outcome }: { outcome: GoalOutcomeNotice }): JSX.Element {
  const label = outcome.outcome === 'met' ? 'Goal met' : 'Goal impossible';
  return (
    <ToolDisclosure
      testid="goal-outcome"
      variant="trigger"
      summary={label}
      detail={<code>{outcome.reason}</code>}
    />
  );
}

/** The shell command a Bash-style permission request is asking to run. */
function permissionCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' && command.length > 0 ? command : undefined;
}

// Read-only unified diff for a file-edit tool, computed from the old/new
// strings in the tool args (the stream's preview — the real Monaco diff editor
// rail lands separately). Each changed line is prefixed +/− and colour-coded.
function PermissionCard({
  entry,
  chatId,
  onPermission,
  onApproveAll,
}: {
  entry: ChatEventEntry;
  chatId: string;
  onPermission(requestId: string, approve: boolean): void;
  onApproveAll(): void;
}): JSX.Element {
  // spec/02 § Permission mode — Plan Mode gates every tool call, including
  // ordinary ones that would never otherwise reach here, because the SDK
  // itself entered it (the agent's own `EnterPlanMode` tool, not something
  // the user chose from the dropdown). The chat exits it on its own once the
  // agent calls `ExitPlanMode`, but that can be a while — this is the
  // impatient-user escape hatch: approve this one AND drop the chat back to
  // bypass for what comes after, in one click instead of two.
  const permissionMode = useChatStore((s) => s.chats[chatId]?.permissionMode);
  const showBypassEscape = permissionMode === 'plan';
  function approveAndResumeBypass(requestId: string): void {
    onPermission(requestId, true);
    getActiveWs()?.send({ type: 'chat.settings', chatId, permissionMode: 'bypassPermissions' });
  }
  // 1 / 2 / 3 are component-local: only fire while the card is focused so the
  // same keys don't leak into other unrelated UI. `1` approves this request,
  // `2` approves ALL currently-outstanding requests in the chat, `3` denies
  // (spec/14). `2` stays live even when this is the only outstanding request —
  // it then does exactly what `1` does — but the button is only drawn when
  // there is genuinely more than one to sweep (spec/14 § Permission prompts).
  const resolved = entry.permissionResolved;
  const pendingApprovalCount = useContext(PendingApprovalCountContext);
  const cardRef = useRef<HTMLDivElement>(null);
  // Auto-focus the card the moment a permission is shown so the documented
  // `1` / `2` / `3` chords (spec/14 ## Keyboard shortcuts → "Permission shown")
  // fire immediately — the user shouldn't have to click into the card first.
  // Mirrors Claude Code's behaviour. Re-focus is keyed on the requestId so a
  // fresh request re-grabs focus; once resolved we release it.
  useEffect(() => {
    if (!resolved && entry.requestId) {
      cardRef.current?.focus();
    }
  }, [resolved, entry.requestId]);
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (!entry.requestId || resolved) return;
    if (e.key === '1') {
      e.preventDefault();
      onPermission(entry.requestId, true);
      return;
    }
    if (e.key === '2') {
      e.preventDefault();
      onApproveAll();
      return;
    }
    if (e.key === '3') {
      e.preventDefault();
      onPermission(entry.requestId, false);
      return;
    }
    if (e.key === '4' && showBypassEscape) {
      e.preventDefault();
      approveAndResumeBypass(entry.requestId);
    }
  }
  return (
    <div
      ref={cardRef}
      className={`permission${resolved ? ` resolved resolved-${resolved}` : ''}`}
      data-testid="permission"
      data-resolved={resolved ?? undefined}
      tabIndex={resolved ? -1 : 0}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="permission request"
    >
      <p>
        <strong>{entry.tool}</strong>
        {entry.permissionDescription ? ` — ${entry.permissionDescription}` : ''}
      </p>
      {permissionCommand(entry.toolArgs) !== undefined ? (
        <pre className="permission-command" data-testid="permission-command">
          {permissionCommand(entry.toolArgs)}
        </pre>
      ) : null}
      {entry.requestId && !resolved ? (
        <div className="permission-buttons">
          <button
            type="button"
            onClick={() => entry.requestId && onPermission(entry.requestId, true)}
          >
            Approve <span className="kbd-hint">1</span>
          </button>
          {pendingApprovalCount > 1 ? (
            <button
              type="button"
              data-testid="permission-approve-all"
              onClick={() => onApproveAll()}
            >
              Approve all outstanding <span className="kbd-hint">2</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => entry.requestId && onPermission(entry.requestId, false)}
          >
            Deny <span className="kbd-hint">3</span>
          </button>
          {showBypassEscape ? (
            <button
              type="button"
              className="permission-bypass-escape"
              data-testid="permission-approve-resume-bypass"
              onClick={() => entry.requestId && approveAndResumeBypass(entry.requestId)}
            >
              Approve &amp; resume bypass <span className="kbd-hint">4</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {resolved ? (
        <p className="permission-outcome" data-testid="permission-outcome">
          {resolved === 'approve'
            ? entry.permissionCancelled
              ? 'Approved, cancelled by interrupt'
              : 'Approved'
            : 'Denied'}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The limit notice, as a message in the conversation.
 *
 * It used to be a strip above the transcript reading "Extra usage limit on
 * Default, resuming at 15:40 (in 1 h)", with two explanatory sentences stacked
 * under it. Everything about that was wrong to read. It named the OVERFLOW pool
 * as the limit, which is not a thing anyone spends. It gave a clock time and a
 * unit symbol rather than how long the wait is. And it put three lines of
 * explanation in the chrome, where they sit permanently, instead of one
 * sentence where the reply would have been.
 *
 * So: a bubble under the last message saying which limit you reached and how
 * long it is, counting down, in words. The two things you can DO about it are
 * controls, not prose — turn extra usage on, and choose whether it picks itself
 * back up.
 */
function RateLimitBubble({
  row,
}: {
  row: import('../stores/types.js').ChatRow;
}): JSX.Element | null {
  const resumingAt = row.rateLimitResumingAt;
  const block = row.limitBlock ?? null;
  // Shared by every host (spec/01 § Settings).
  const autoResume = usePreferencesStore((s) => s.preferences.autoResumeRateLimit);

  // When it lifts. The block's own figure where there is one — the window's
  // reading, rather than the instant a resume happens to have been armed for.
  // A non-positive value (epoch 0) is folded into null here too: `??` only
  // treats null/undefined as absent, so a 0 that slipped past an upstream
  // guard would otherwise survive as a "stated" reset and render as
  // `now - 0`, a decades-old elapsed time (spec/12 § nothing said when
  // nothing stated a reset — this is that case, not a real timestamp).
  const rawResetsAt = block?.resetsAt ?? resumingAt ?? null;
  const resetsAt = rawResetsAt !== null && rawResetsAt > 0 ? rawResetsAt : null;

  // A countdown that does not count is a timestamp with extra steps. Ten
  // seconds is under the minute it renders, so the number is never visibly
  // stale, and it costs one render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (resetsAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, [resetsAt]);

  // A limit with no resume armed still gets the notice (spec/12): auto-resume
  // being off decides whether there is a countdown, not whether the reader is
  // told what happened. Gating this on `resumingAt` alone is what left the
  // unparked case showing the provider's sentence and nothing else.
  if (!resumingAt && !block) return null;
  // The limit's own instant has passed and the pause is still here, so the wait
  // is no longer the thing standing between the user and their reply — the
  // un-run turn is. `Try now` stops being one of three equal controls and
  // becomes the action.
  const pastReset = resetsAt !== null && resetsAt <= now;
  const isOverload = row.resumeKind === 'overloaded';
  const limitName = LIMIT_NAME[block?.scope ?? 'unknown'];

  const resumeNow = (): void => {
    getActiveWs()?.send({ type: 'chat.resume_now_request', chatId: row.chatId });
  };
  const toggleAutoResume = (): void => {
    void patchShared('auto-resume', { autoResumeRateLimit: !autoResume });
  };

  return (
    <div className="msg msg-system rate-limit-bubble" data-testid="rate-limit-bar">
      <div className="content">
        <p className="rate-limit-headline" data-testid="rate-limit-headline">
          {isOverload ? (
            <>Claude is busy right now.</>
          ) : (
            <>
              You&rsquo;ve reached your <strong>{limitName}</strong>
              {block?.accountLabel ? (
                <>
                  {' on '}
                  <span data-testid="rate-limit-account">{block.accountLabel}</span>
                </>
              ) : null}
              .
            </>
          )}{' '}
          {/* Nothing said when nothing stated a reset — an invented one reads
              as a promise the limit has not made. */}
          {resetsAt === null ? null : (
            <span data-testid="rate-limit-countdown" title={formatResetDetail(resetsAt)}>
              {resetsAt > now ? (
                <>
                  It resets in <strong>{formatDurationWords(resetsAt - now)}</strong>, at{' '}
                  {formatReset(resetsAt, now)}.
                </>
              ) : (
                /* Past the reset, and the notice is STILL up — which now means
                   something definite rather than nothing: a chat whose turn has
                   started clears the pause, so this turn demonstrably has not
                   run. "It should be back now" said the opposite, and left the
                   only thing left to do looking optional. */
                <>
                  {/* Floored at 1ms: `formatDurationWords(0)` is "any moment
                      now", which lands on the tick the reset passes and reads
                      as "That was any moment now ago". */}
                  That was <strong>{formatDurationWords(Math.max(1, now - resetsAt))}</strong> ago
                  and this turn has not run.
                </>
              )}
            </span>
          )}
        </p>

        {block?.routing ? (
          <p className="rate-limit-routing" data-testid="rate-limit-routing">
            {routingSentence(block.routing, now)}
          </p>
        ) : null}

        <div className="rate-limit-actions">
          {/* No tooltip: the label says it (spec/14 § Copy — a tooltip names a
              control, it does not explain one). */}
          <label className="rate-limit-auto">
            <input
              type="checkbox"
              checked={autoResume}
              onChange={toggleAutoResume}
              data-testid="rate-limit-auto-resume"
            />
            Resume when the limit resets
          </label>
          <button
            type="button"
            className={pastReset ? 'ctrl rate-limit-retry-now' : 'ctrl'}
            data-testid="rate-limit-retry"
            data-past-reset={pastReset ? 'true' : 'false'}
            onClick={resumeNow}
          >
            Try now
          </button>
          {block?.overageBlocked ? (
            <a
              className="ctrl"
              data-testid="rate-limit-extra-usage"
              href={EXTRA_USAGE_URL}
              target="_blank"
              rel="noreferrer"
              // Patch cannot flip this — it is an Anthropic account setting, so
              // the control is a way there, not a switch that lies.
              // One sentence for this state, shared with the Settings line —
              // two wordings for it read as two different situations.
              title={
                block.overageReason === OVERAGE_DISABLED_REASON
                  ? `${EXTRA_USAGE_OFF_SENTENCE} Opens your Claude usage settings.`
                  : 'Extra usage did not cover this limit. Opens your Claude usage settings.'
              }
            >
              Turn on extra usage
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
