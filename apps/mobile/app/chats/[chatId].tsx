// Chat detail screen: full-screen stream + composer.

import { presentFailure } from '../../src/lib/usage';
import React from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Image,
  Keyboard,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { dismissChatNotifications } from '../../src/lib/chatNotifications';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronLeft,
  Search,
  Phone,
  Ear,
  MessageSquare,
  Mic,
  FileText,
  X,
  ExternalLink,
  LayoutTemplate,
} from 'lucide-react-native';
import { ArrowUp, ChevronDown, ChevronRight } from 'lucide-react-native';
import {
  SPECIAL_THREAD_IDS,
  folderName,
  hasTaskNotification,
  isReservedSpecialThread,
  taskNotificationSummary,
  type AttachmentRef,
} from '@patch/wire';
import { apiUrl, getRoute } from '../../src/config';
import { loadTranscript, dropTranscript, setBranch } from '../../src/lib/transcriptCache';
import { api } from '../../src/api/rest';
import {
  useChatStore,
  type ChatEventEntry,
  type LocalAttachment,
} from '../../src/stores/chatStore';
import { toolLabel } from '../../src/lib/toolsCatalog';
import { DelegateTranscript } from '../../src/components/DelegateTranscript';
import { DelegateStrip } from '../../src/components/DelegateStrip';
import { DELEGATE_STATUS_LABEL, delegateStatusColor } from '../../src/lib/delegateStatus';
import { usePresenceStore } from '../../src/stores/presenceStore';
import { deliveryTracker } from '../../src/lib/deliveryTracker';
import { permissionDeliveryTracker } from '../../src/lib/permissionDeliveryTracker';
import { openExistingSideThread } from '../../src/lib/sideThreadActions';
import { discardUpload, retryUpload } from '../../src/lib/sendQueue';
import { Composer } from '../../src/components/Composer';
import { queueChipLabel, queueChipTitle } from '../../src/lib/queueLabel';
import { editQueuedMessage, promoteMessage, unqueueMessage } from '../../src/lib/queuedActions';
import { getComposerDraft, setComposerDraft } from '../../src/lib/composerDraft';
import { useUiStore } from '../../src/stores/uiStore';
import { CallDock } from '../../src/components/CallBar';
import {
  ManagerChatsList,
  ManagerSegments,
  type ManagerTab,
} from '../../src/components/ManagerChats';
import { ChatBars } from '../../src/components/ChatBars';
import { ChatFindBar } from '../../src/components/ChatFindBar';
import { findMessageSeqs, stepIndex } from '../../src/lib/chatFind';
import { ContextDisclosure } from '../../src/components/ContextDisclosure';
import { ChatActionsMenu } from '../../src/components/ChatActionsMenu';
import { EmptyState } from '../../src/components/EmptyState';
import { EMPTY_STATES } from '../../src/lib/emptyStates';
import { deriveChatTitle } from '../../src/lib/labels';
import {
  toolCallSummary,
  toolRunNarrative,
  groupToolRuns,
  pairedResult,
  type TimelineRow,
} from '../../src/lib/toolSummary';
import {
  JUMP_HIGHLIGHT_MS,
  JUMP_MAX_RETRIES,
  JUMP_RETRY_DELAY_MS,
  JUMP_WAIT_MS,
  parseSeqParam,
  rowIndexForSeq,
} from '../../src/lib/chatJump';
import { deriveBadge } from '../../src/stores/types';
import { UnifiedDiff, diffFromToolCall } from '../../src/components/UnifiedDiff';
import { ChatMarkdown } from '../../src/components/ChatMarkdown';
import {
  MessageActionsHost,
  MessageLongPress,
  showMessageActions,
} from '../../src/components/MessageActions';
import {
  ArtifactViewerHost,
  openArtifactViewer,
  openServed,
} from '../../src/components/ArtifactViewer';
import { useLocalUri } from '../../src/lib/servedFile';
import { copyableText } from '../../src/lib/messageText';
import { EmptyChatArt } from '../../src/components/EmptyChatArt';
import { fixed, fonts, radii, space, textMin, typography, useTheme } from '../../src/lib/theme';
import { startVoiceCall } from '../../src/lib/voiceCall';
import { getWs } from '../../src/api/ws';
import { ASK_USER_QUESTION, isQuestionRowCoveredByCard } from '../../src/lib/askUserQuestion';
import { goBack } from '../../src/lib/goBack';
import { QuestionCard } from '../../src/components/QuestionCard';

// The transcript renders as an INVERTED FlatList (spec/15 § Chat detail): data
// goes in newest-first, and `inverted` flips the render direction back to the
// normal reading order on screen (oldest at the top, newest at the bottom).
// This is the standard chat-app pattern, and it buys two things a
// non-inverted list can't: the newest message sits at array index 0, which is
// where a fresh mount naturally starts WITHOUT an imperative scroll — no more
// "mount from the top, then race to catch up" — and offset 0 stays the
// newest-message end regardless of how much the transcript grows, because a
// new message becomes the new index 0 and everything else shifts away from
// it, not the other way round. A prior version of this screen fought both of
// those problems with a lot of compensating logic (documented removals
// below); inverting removes the problems instead of compensating for them.
//
// Per-chat scroll memory (spec/15 § Chat detail — "open at the latest message,
// or restore the user's last position if they had scrolled up"). Module-level
// so a chat's position survives navigating away and back within a session. We
// record the last offset AND whether that offset was pinned to the newest
// message, so reopening either re-pins (the common case) or restores the read
// position.
//
// `offset` is a raw pixel fallback for when no anchor was captured (nothing
// had rendered under the saved position yet); whenever one was, `anchorSeq`
// restores by THAT message's identity instead of a bare pixel count. A raw
// offset is only ever right if the rows above it lay out identically both
// times, which async markdown/image measurement and new messages arriving
// above the saved spot routinely break (Todoist: "switching chat puts you in
// a different position when you come back" — fixed on web in a4a1256a by
// anchoring to the DOM element at the top edge; a FlatList has no DOM to
// re-measure, so `onViewableItemsChanged` + `scrollToIndex` — the same
// primitive the search-jump feature already uses — stand in for that here).
const chatScrollMemory = new Map<
  string,
  { offset: number; atBottom: boolean; anchorSeq: number | null }
>();
// Treat "within this many px of offset 0" as at-the-newest-message. Unlike a
// non-inverted list's "bottom", offset 0 doesn't drift as the transcript
// grows or streams (see the block comment above), so this alone is a reliable
// test — no content-size/viewport comparison needed.
const AT_BOTTOM_SLOP = 24;

// Hoisted so the style object identity is stable — an inline literal here is a
// new prop on every render, which defeats FlatList's own bail-outs.
const LIST_CONTENT_STYLE = { padding: space.lg, flexGrow: 1 } as const;

const keyExtractor = (r: TimelineRow): string => r.key;

// A freshly opened chat paints the transcript hidden (opacity 0, `settled`
// state below) until it has gone quiet — not just until the landing call is
// issued. For the common "open at the latest message" case that call is
// nothing at all (offset 0 is already where an inverted mount starts), but
// `windowSize` still mounts several screens either side of view in the
// background afterward, and on a real device that background work is not
// free: it visibly took a couple of seconds even after the position itself
// was already correct, reading as the transcript "loading in" underneath
// something that had supposedly already landed. Opacity, never
// `display`/conditional render, so onContentSizeChange keeps firing normally
// underneath.
//
// Debounced on content-size CHANGES, not a fixed delay: a short chat goes
// quiet and reveals almost immediately, a long one waits out however many
// background batches it actually takes. `SETTLE_MAX_MS` is the escape hatch —
// a chat opened mid-stream never goes quiet on its own (new tokens keep
// arriving), and without a ceiling that would hide the transcript, and the
// typing indicator with it, for as long as the reply keeps generating.
const SETTLE_DEBOUNCE_MS = 80;
const SETTLE_MAX_MS = 500;

// Nothing below can draw without a server: apiUrl() throws with no route, and
// it is called during render (view_file cards, attachment URLs). A throw there
// takes the app down and it restart-loops, so an unpaired device never reaches
// the body — it goes to pairing.
export default function ChatDetailScreen(): React.ReactElement {
  if (getRoute() === null) return <Redirect href="/pair" />;
  return <ChatDetailBody />;
}

function ChatDetailBody(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  // `seq` — opened from a search hit (spec/03 § Chat search): land on that
  // message instead of the newest one. `justCreated` — this is the reveal
  // `newChatRoute` sent us into straight off the send that made this chat
  // exist (Todoist 6hfFww7fH7JQFWj4 — see the comment on the settle effect
  // below).
  const params = useLocalSearchParams<{ chatId: string; seq?: string; justCreated?: string }>();
  const chatId = params.chatId;
  const targetSeq = parseSeqParam(params.seq);
  const justCreated = params.justCreated === '1';
  const row = useChatStore((s) => s.chats[chatId]);
  // Which machine the chat runs on, for the header crumb (spec/15 § Chat detail).
  const hostLabel = usePresenceStore((s) =>
    row?.daemonId ? (s.hosts[row.daemonId]?.host?.hostName ?? row.daemonId).trim() : '',
  );
  const timeline = useChatStore((s) => s.timelines[chatId]) ?? [];
  // What the list actually draws: the timeline with each consecutive run of
  // tool calls folded into one row (spec/15 § Chat detail). Everything else on
  // this screen still reasons about `timeline` itself — the fold is a
  // presentation step, not a change to what the chat contains. An
  // `AskUserQuestion` call/result already rendered by its question card is
  // dropped first — the card IS that tool's row (spec/15 § Chat detail).
  // spec/04 ## Message queueing — queued (type-ahead) turns are held apart from
  // the live transcript and drawn as the last thing in the stream, below the
  // working indicator, so their position reads as not yet sent.
  const queuedEntries = React.useMemo(() => timeline.filter((e) => e.queued === true), [timeline]);
  const liveTimeline = React.useMemo(
    () => (queuedEntries.length === 0 ? timeline : timeline.filter((e) => e.queued !== true)),
    [timeline, queuedEntries],
  );
  const visibleTimeline = React.useMemo(
    () => liveTimeline.filter((e) => !isQuestionRowCoveredByCard(e, liveTimeline)),
    [liveTimeline],
  );
  // The queued message whose editor is open and what is typed in it. Held here
  // (not in the row) so an edit that loses the race with the message starting
  // can still be handed to the composer (§ Edit).
  const [queuedEdit, setQueuedEdit] = React.useState<{ localId: string; text: string } | null>(
    null,
  );
  React.useEffect(() => setQueuedEdit(null), [chatId]);
  React.useEffect(() => {
    if (!queuedEdit) return;
    const still = timeline.find((e) => e.kind === 'message' && e.localId === queuedEdit.localId);
    if (still?.queued) return;
    useUiStore
      .getState()
      .pushError(
        still
          ? 'That message had already been sent — your edit is in the composer.'
          : 'That message was removed from the queue — your edit is in the composer.',
      );
    const held = getComposerDraft(chatId);
    setComposerDraft(chatId, held.length > 0 ? `${held}\n${queuedEdit.text}` : queuedEdit.text);
    setQueuedEdit(null);
  }, [timeline, queuedEdit, chatId]);
  const onQueuedDraft = React.useCallback((localId: string, text: string | null): void => {
    setQueuedEdit(text === null ? null : { localId, text });
  }, []);
  const onEditQueued = React.useCallback(
    (entry: ChatEventEntry, text: string): void => {
      setQueuedEdit(null);
      editQueuedMessage(chatId, entry, text);
    },
    [chatId],
  );
  const rows = React.useMemo(() => groupToolRuns(visibleTimeline), [visibleTimeline]);
  // FlatList's `inverted` mode wants data newest-first (see the block comment
  // above) — `rows` stays chronological for everything else on this screen
  // (badge/title derivation, the send-re-pin effect, ...), this reversal is a
  // rendering-only concern.
  const invertedRows = React.useMemo(() => [...rows].reverse(), [rows]);
  // Human title — the AI-generated name; until it lands, the folder basename,
  // then "New chat" (never the raw chatId/ULID; spec/04 § Name).
  const title = row ? deriveChatTitle(row) : 'Chat';
  // The agent is composing a reply → show an in-thread loading indicator
  // (spec/15 § Pending-response indicator) so the user isn't left staring at a
  // static screen after sending. It CLEARS as soon as the turn produces its
  // first assistant-side event (message, tool call, or tool result) after the
  // user's most recent message — the row's `activity` can lag behind the last
  // event, so we don't rely on it alone (that lag is why "Working…" used to
  // stick after the reply had landed).
  // Over the live transcript only: a queued turn has not started, so it must
  // not make the running turn's own replies look like they precede it.
  const lastUserIdx = liveTimeline.reduce(
    (idx, e, i) => (e.kind === 'message' && e.role === 'user' ? i : idx),
    -1,
  );
  const assistantResponded = liveTimeline.some(
    (e, i) =>
      i > lastUserIdx &&
      (e.kind === 'tool_call' ||
        e.kind === 'tool_result' ||
        (e.kind === 'message' && e.role === 'assistant')),
  );
  const working = row ? deriveBadge(row) === 'working' && !assistantResponded : false;

  // The Manager chat's Conversation | Chats switch (spec/15 § Voice tab (Manager));
  // only ever 'conversation' on any other chat.
  const [managerTab, setManagerTab] = React.useState<ManagerTab>('conversation');

  // spec/06 ## Composer policy: Speakers is a read-only mirror —
  // no composer, no mic. Manager keeps its full composer. Typing on a mirror
  // thread would create a reply that never reaches the source channel, which
  // breaks the user's mental model — so the composer is replaced by a hint.
  const readOnlyMirror = chatId === SPECIAL_THREAD_IDS.speakers;

  React.useEffect(() => {
    useChatStore.getState().setActiveChat(chatId);
    // Reading the chat clears its notifications — on open, and again when the
    // app returns to the foreground with this chat still open.
    const clear = () =>
      void dismissChatNotifications(chatId).catch((e) =>
        console.error('dismissChatNotifications failed', e),
      );
    clear();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') clear();
    });
    return () => {
      sub.remove();
      useChatStore.getState().setActiveChat(null);
    };
  }, [chatId]);

  // spec/15 § Batch view — ending: opening a chat anywhere counts, so this
  // reports it unconditionally; the server no-ops unless `chatId` is a
  // member of the running batch. Best-effort — a dropped call just leaves
  // the chat waiting to be opened again.
  React.useEffect(() => {
    void api.markBatchOpened(chatId).catch(() => undefined);
  }, [chatId]);

  // Subscribe this surface to the open chat's DETAIL-level event stream
  // (chat.message / tool_call / tool_result / permission_request). The server
  // only fans detail events to surfaces that have explicitly subscribed via
  // chat.replay / chat.focus_change (ws-hub DETAIL_LEVEL_EVENT_TYPES); the
  // connect-time replay loop only covers chats already hydrated when the WS
  // opened, so a chat opened later — or any chat whose roster hydrated after
  // connect — would render its history but miss LIVE permission prompts and
  // tool calls. Ask for a chat.replay on open so the open chat is always a
  // watched chat AND any events missed since our cursor are backfilled.
  //
  // Nothing happens here on a COLD START — the socket is not open yet, so the
  // request is dropped. `setActiveChat` above is what covers that case: the
  // connect handler replays the active chat unconditionally once the link is
  // up (src/api/ws.ts). The cursor itself lives there too, so both callers ask
  // the same question and the chat is never replayed twice on one connection.
  //
  // The phone's own copy is painted FIRST, synchronously (spec/15 § Instant
  // open): a chat opened before is on screen in this very frame, even with
  // the socket still connecting, and the ask that follows is only for what
  // is newer — `requestReplay` derives its cursor from the timeline, so
  // feeding the cache in is all it takes. This is also exactly what makes a
  // cold start instant, which is where the socket is not up anyway.
  const cachedBranch = React.useRef<string | null>(null);
  React.useEffect(() => {
    if ((useChatStore.getState().timelines[chatId]?.length ?? 0) === 0) {
      const cached = loadTranscript(chatId);
      if (cached && cached.events.length > 0) {
        cachedBranch.current = cached.branchId;
        useChatStore.getState().applyEvents(cached.events as never[]);
      }
    }
    getWs().requestReplay(chatId);
  }, [chatId]);

  // The host is the record, and this is where it says which track the chat is
  // on. A fork, an edit or a branch switch makes everything painted from the
  // cache the WRONG track — thrown away whole and refetched, never merged
  // into something that merely looks right.
  const activeBranchId = useChatStore((s) => s.branchGraphs?.[chatId]?.activeBranchId ?? null);
  React.useEffect(() => {
    if (activeBranchId === null) return;
    const stale = cachedBranch.current;
    if (stale !== null && stale !== activeBranchId) {
      cachedBranch.current = null;
      dropTranscript(chatId);
      useChatStore.getState().clearTimeline(chatId);
      getWs().requestReplay(chatId, { force: true });
      return;
    }
    cachedBranch.current = activeBranchId;
    setBranch(chatId, activeBranchId);
  }, [chatId, activeBranchId]);

  // ── Scroll behaviour (spec/15 § Chat detail) ───────────────────────────────
  // Opening a chat lands on the LATEST message; if the user had scrolled up in
  // this chat before, their position is restored instead. `followRef` is the
  // pin-to-newest flag: true while the user is at the newest message (so new
  // turns and the keyboard keep it in view), false the moment they scroll away
  // to read history — so auto-scroll never fights a deliberate scroll.
  const listRef = React.useRef<FlatList>(null);
  const followRef = React.useRef(true);
  // Mirrors `followRef` into React state so the floating "scroll to bottom"
  // button can react to it — the ref alone doesn't trigger a re-render.
  const [showScrollToBottom, setShowScrollToBottom] = React.useState(false);
  // True between the user putting a finger on the list and the resulting
  // momentum settling. Follow mode is turned off ONLY inside that window — a
  // drag is a real, unambiguous signal of intent, so use it rather than
  // inferring intent from position (see `AT_BOTTOM_SLOP` above: on an inverted
  // list that position test is stable across streaming growth, which is what
  // makes a plain "are we dragging" gate enough here — a prior non-inverted
  // version of this screen needed a second, movement-based test to catch a
  // drag that a growing "bottom" was masking; that case doesn't exist here).
  const draggingRef = React.useRef(false);
  // Whether a user gesture is still in flight — open on touch, and NOT closed
  // by the finger lifting, because the fling it throws outlives the touch and
  // comes to rest later. Android reports `onMomentumScrollEnd` for a
  // programmatic animation exactly as it does for a fling, so the momentum end
  // alone cannot say who caused it; this is what distinguishes them. Anything
  // we start ourselves closes it (see `scrollToNewest`), so the only momentum
  // end we ever act on is one a finger set off. Same principle as web's
  // `selfScrollTopRef` (`ChatRoute.tsx`) — identify our own scroll rather than
  // trying to date it.
  const gestureOpenRef = React.useRef(false);
  // The initial restore/pin runs once per open, on the first content
  // measurement (the timeline hydrates a frame or two after mount).
  const restoredRef = React.useRef(false);
  // Every optimistic-echo localId this open has ever seen (spec/15 § Chat
  // detail — "sending a message re-pins to the bottom"). A send is an echo
  // APPEARING, so the effect below re-pins on a localId that is not in here,
  // which is once per send and never on a later timeline change.
  //
  // The whole set, not just the newest: echoes lose their localId one at a
  // time as the host's persisted copies reconcile (chatStore § chat.message),
  // so with two sends in flight the newer one reconciling first makes the OLDER
  // one the newest still-pending echo again. Against a single remembered
  // localId that reads as a fresh send and yanks the list for a turn sent
  // minutes ago; against a set of everything seen, it is correctly nothing.
  //
  // `null` means "not seeded for this open yet": an echo already in the
  // transcript when the chat opens was sent before this open, so the first run
  // records it WITHOUT scrolling — the open's own restore-or-pin owns where
  // that lands.
  const seenLocalIdsRef = React.useRef<Set<string> | null>(null);
  // Whether a send has re-pinned since this chat was opened.
  const repinnedForSendRef = React.useRef(false);
  // Drives the FlatList's opacity — see the comment on the constant above.
  // The ref lets `onContentSizeChange` read/arm the debounce without being a
  // dependency (it fires far more often than a render needs to know about).
  const [settled, setSettled] = React.useState(false);
  const settledRef = React.useRef(false);
  const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedAtRef = React.useRef(0);
  // Jump-to (spec/03 § Chat search): the message this open should land on,
  // until it is found or `JUMP_WAIT_MS` runs out. The transcript hydrates over
  // several frames, so the target is looked for on every content measurement
  // rather than once. Cleared the moment it lands — a later render never
  // re-jumps — and it never writes `chatScrollMemory`: only the user's own
  // scroll does, so a later open without a seq behaves exactly as before.
  const jumpRef = React.useRef<{ seq: number; deadline: number } | null>(null);
  // The list's data as of the last render, for `onContentSizeChange` to search
  // without taking the rows as a dependency.
  const invertedRowsRef = React.useRef(invertedRows);
  invertedRowsRef.current = invertedRows;
  // The message identity a remembered (non-bottom) scroll position anchors to
  // — see the block comment on `chatScrollMemory`. Kept as whichever row sits
  // nearest the middle of FlatList's own reported `viewableItems`, so it never
  // needs the row's actual pixel geometry (which, unlike a DOM node, is not
  // ours to read back out of the list).
  const anchorSeqRef = React.useRef<number | null>(null);
  // The list's own height as last laid out, and its offset as last reported by
  // ANY scroll (ours or the user's) — for `onLayout`'s hold-the-top-edge rule.
  const listHeightRef = React.useRef<number | null>(null);
  const offsetRef = React.useRef(0);
  const onViewableItemsChanged = React.useRef(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }): void => {
      if (viewableItems.length === 0) return;
      const mid = viewableItems[Math.floor((viewableItems.length - 1) / 2)];
      const index = mid?.index;
      if (index === null || index === undefined) return;
      const row = invertedRowsRef.current[index];
      if (!row) return;
      anchorSeqRef.current = row.kind === 'group' ? (row.entries[0]?.seq ?? null) : row.entry.seq;
    },
  ).current;
  const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 50 }).current;
  const jumpRetriesRef = React.useRef(0);
  const jumpRetryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row jumped to, tinted for `JUMP_HIGHLIGHT_MS` so the eye finds it.
  const [highlightKey, setHighlightKey] = React.useState<string | null>(null);

  // Inverted: the newest message is offset 0, not `scrollToEnd` — there is no
  // dedicated "scroll to end" the way a non-inverted list has one, because
  // "end" IS the start of the (reversed) data (see the block comment above).
  const scrollToNewest = React.useCallback(
    (animated: boolean): void => {
      if (timeline.length === 0) return;
      // An animated scroll of ours supersedes any gesture still notionally in
      // flight: from here the next momentum end is OUR animation coming to
      // rest, not the user's fling, so it must not be read as a user settle.
      // (Only an animated one — an instant scroll produces no momentum and so
      // no settle to disown.) This is also what stops a release that produced
      // no momentum from leaving the gesture open indefinitely, waiting for a
      // momentum end that never comes and swallowing ours when it arrives.
      if (animated) gestureOpenRef.current = false;
      listRef.current?.scrollToOffset({ offset: 0, animated });
    },
    [timeline.length],
  );

  // A chatId change is a fresh open: seed follow mode from the remembered
  // position (re-pin unless the user had scrolled up) and re-arm the restore.
  React.useEffect(() => {
    const saved = chatScrollMemory.get(chatId);
    followRef.current = saved ? saved.atBottom : true;
    setShowScrollToBottom(!followRef.current);
    restoredRef.current = false;
    // Declared BEFORE the send-re-pin effect on purpose: within the commit
    // that changes chatId this runs first, so that effect re-seeds against the
    // chat now on screen rather than carrying the last one's echoes over.
    seenLocalIdsRef.current = null;
    repinnedForSendRef.current = false;
    // A stale anchor from the chat just left must never be written into this
    // one's memory if the user drags before this chat reports its own
    // viewable items.
    anchorSeqRef.current = null;
    listHeightRef.current = null;
    offsetRef.current = 0;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    // `justCreated` skips the hide entirely rather than just shortening it:
    // this chat's only content is the message this same send already put in
    // the store, synchronously, before navigating here — there is no history
    // fetch and no background window of it to paint over (Todoist
    // 6hfFww7fH7JQFWj4). Every other open still hides first; only the
    // brand-new-chat arrival is exempt.
    settledRef.current = justCreated;
    setSettled(justCreated);
    openedAtRef.current = Date.now();
    // Cleanup, not just re-seeding: this also covers unmount, so a chat closed
    // mid-settle never fires its reveal into a torn-down screen.
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, [chatId, justCreated]);

  // Arm the jump for this open. After the chatId effect above, so a fresh open
  // has already re-armed the restore; a seq arriving on an open whose first
  // measurement is past looks straight away (the content may never change).
  React.useEffect(() => {
    jumpRef.current =
      targetSeq === null ? null : { seq: targetSeq, deadline: Date.now() + JUMP_WAIT_MS };
    setHighlightKey(null);
    if (restoredRef.current) tryJumpRef.current();
    return () => {
      if (jumpRetryTimerRef.current) clearTimeout(jumpRetryTimerRef.current);
    };
  }, [chatId, targetSeq]);

  React.useEffect(() => {
    if (highlightKey === null) return;
    const t = setTimeout(() => setHighlightKey(null), JUMP_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightKey]);

  // Sending a message re-pins to the bottom (spec/15 § Chat detail): even if
  // the user had scrolled up to read history, their new turn — and the reply
  // that follows — must be in view. The freshly-sent turn is the optimistic
  // user echo (it carries a `localId`, spec/15 § "Sending a message echoes
  // optimistically"), so a NEW localId anywhere in the timeline is a send:
  // re-engage follow and scroll. Matches web's `ChatRoute.tsx`.
  //
  // "Anywhere", not "at the end". The echo is the last entry at the instant it
  // is appended, but only then: anything the turn emits next — a
  // permission-mode marker, a permission card, the first tool call, an error —
  // lands after it, and a test that only ever reads `timeline[length - 1]`
  // silently stops re-pinning the moment a send and one of those share a
  // commit. Identity is the localId, not the position.
  React.useEffect(() => {
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
    setShowScrollToBottom(false);
    scrollToNewest(false);
  }, [timeline, scrollToNewest]);

  // Re-arms on every content-size change this open has not yet settled from —
  // see `SETTLE_DEBOUNCE_MS` above.
  const armSettleTimer = React.useCallback((): void => {
    if (settledRef.current) return;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    const elapsed = Date.now() - openedAtRef.current;
    const wait = Math.max(0, Math.min(SETTLE_DEBOUNCE_MS, SETTLE_MAX_MS - elapsed));
    settleTimerRef.current = setTimeout(() => {
      settledRef.current = true;
      setSettled(true);
    }, wait);
  }, []);

  // Scroll to the pending jump target if the list now holds it. True when it
  // jumped. The target sits mid-screen, following stops (the user is reading
  // history now, so the scroll-to-bottom button shows) and the row is tinted.
  const tryJump = React.useCallback((): boolean => {
    const jump = jumpRef.current;
    if (jump === null) return false;
    if (Date.now() > jump.deadline) {
      // Never arrived: give up and leave the chat where it normally opens.
      jumpRef.current = null;
      return false;
    }
    const rows = invertedRowsRef.current;
    const index = rowIndexForSeq(rows, jump.seq);
    if (index === -1) return false;
    jumpRef.current = null;
    followRef.current = false;
    setShowScrollToBottom(true);
    jumpRetriesRef.current = 0;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
    setHighlightKey(rows[index]!.key);
    return true;
  }, []);
  const tryJumpRef = React.useRef(tryJump);
  tryJumpRef.current = tryJump;

  // Find in chat (spec/15 § Find in chat): the matches are messages, and each
  // step jumps to one through the same path a search hit uses.
  const [findOpen, setFindOpen] = React.useState(false);
  const [findQuery, setFindQuery] = React.useState('');
  const [findIndex, setFindIndex] = React.useState(-1);
  const findSeqs = React.useMemo(
    () => (findOpen ? findMessageSeqs(visibleTimeline, findQuery) : []),
    [findOpen, visibleTimeline, findQuery],
  );
  React.useEffect(() => {
    setFindIndex(findSeqs.length === 0 ? -1 : 0);
  }, [findOpen, findQuery, chatId]);
  React.useEffect(() => {
    const seq = findSeqs[findIndex];
    if (seq === undefined) return;
    jumpRef.current = { seq, deadline: Date.now() + JUMP_WAIT_MS };
    tryJumpRef.current();
  }, [findIndex, findSeqs.length]);
  const closeFind = React.useCallback((): void => {
    setFindOpen(false);
    setFindQuery('');
  }, []);

  // `scrollToIndex` on a row the list has not measured yet fails — routinely,
  // with variable-height rows far from the newest. The standard answer: jump to
  // the estimated offset so the list renders that neighbourhood, then ask for
  // the index again once it has. Bounded, so a row that never measures cannot
  // loop forever.
  const onScrollToIndexFailed = React.useCallback(
    (info: { index: number; averageItemLength: number }): void => {
      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: false,
      });
      if (jumpRetriesRef.current >= JUMP_MAX_RETRIES) return;
      jumpRetriesRef.current += 1;
      if (jumpRetryTimerRef.current) clearTimeout(jumpRetryTimerRef.current);
      jumpRetryTimerRef.current = setTimeout(() => {
        jumpRetryTimerRef.current = null;
        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: false });
      }, JUMP_RETRY_DELAY_MS);
    },
    [],
  );

  // Fires as the list content grows (hydration + streaming). The first fire
  // for an open performs the initial restore-or-pin — for the common "no
  // remembered position" case that's a no-op, since offset 0 is already the
  // newest message by construction (see the block comment above), and only a
  // restore to a remembered scrolled-away offset is an actual imperative
  // call. Later fires re-assert offset 0 while following; on an inverted list
  // that's normally already true (new content extends away from offset 0,
  // never displaces it — see the block comment), so this is a cheap,
  // idempotent no-op in the common case, not a chase.
  const onContentSizeChange = React.useCallback((): void => {
    armSettleTimer();
    if (!restoredRef.current) {
      restoredRef.current = true;
      // Opened at a search hit: that outranks both the remembered position and
      // the newest message. Not there yet → open normally, and keep looking.
      if (tryJump()) return;
      const saved = chatScrollMemory.get(chatId);
      // A send that has already happened this open outranks the remembered
      // position: the user has said where they want to be more recently than
      // the memory has. Without this the first measurement of a chat opened
      // and typed into straight away restores the old offset ON TOP of the
      // send's re-pin — and turns following off with it, so the reply never
      // scrolls in either.
      if (saved && !saved.atBottom && !repinnedForSendRef.current) {
        // The user had scrolled up in this chat: honour that and stop
        // following, rather than yanking them back to the newest message.
        followRef.current = false;
        setShowScrollToBottom(true);
        // Prefer the anchor message's current index over the raw offset — see
        // the block comment on `chatScrollMemory`. Falls back to the offset
        // when nothing was anchored (or the anchor message is gone, e.g.
        // trimmed history) exactly as before.
        const anchorIndex =
          saved.anchorSeq === null ? -1 : rowIndexForSeq(invertedRowsRef.current, saved.anchorSeq);
        if (anchorIndex !== -1) {
          listRef.current?.scrollToIndex({
            index: anchorIndex,
            viewPosition: 0.5,
            animated: false,
          });
        } else {
          listRef.current?.scrollToOffset({ offset: saved.offset, animated: false });
        }
      } else {
        scrollToNewest(false);
      }
      return;
    }
    if (tryJump()) return;
    if (followRef.current) scrollToNewest(false);
  }, [chatId, scrollToNewest, armSettleTimer, tryJump]);

  const onScroll = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const { contentOffset } = e.nativeEvent;
      offsetRef.current = contentOffset.y;
      // Offset alone, not a content-size comparison — see `AT_BOTTOM_SLOP`
      // above: offset 0 IS the newest message, stable regardless of how much
      // the transcript has grown since the last event, so there's no moving
      // target here to be fooled by mid-stream.
      const atNewest = contentOffset.y <= AT_BOTTOM_SLOP;
      // Follow mode answers "does the user want to stay pinned to the newest
      // message?", which only the user can change — so only a drag changes it.
      // A programmatic re-pin must never turn it off.
      if (draggingRef.current) {
        followRef.current = atNewest;
        setShowScrollToBottom(!atNewest);
        // Only remember a position the user actually chose. Recording our own
        // mid-load offsets meant a chat could be "remembered" at a spot the
        // user never scrolled to. No anchor needed once pinned to the newest
        // message — reopening re-pins there regardless.
        chatScrollMemory.set(chatId, {
          offset: contentOffset.y,
          atBottom: atNewest,
          anchorSeq: atNewest ? null : anchorSeqRef.current,
        });
      }
    },
    [chatId],
  );

  // Stable across renders so FlatList doesn't treat every store commit as a
  // reason to re-render every mounted cell (which is what makes the memo on
  // TimelineItem / ToolGroupItem actually bite).
  const renderItem = React.useCallback(
    ({ item }: { item: TimelineRow }): React.ReactElement => {
      const cell =
        item.kind === 'group' ? (
          <ToolGroupItem entries={item.entries} narration={item.narration} chatId={chatId} />
        ) : (
          <TimelineItem entry={item.entry} chatId={chatId} result={item.result} />
        );
      if (item.key !== highlightKey) return cell;
      return (
        <View
          testID="jump-highlight"
          style={{ backgroundColor: colors.accentTint, borderRadius: radii.md }}
        >
          {cell}
        </View>
      );
    },
    [chatId, highlightKey, colors.accentTint],
  );

  // A finger on the list opens a gesture that owns everything it produces: the
  // release, and the fling that outlives the touch.
  const onScrollBeginDrag = React.useCallback((): void => {
    draggingRef.current = true;
    gestureOpenRef.current = true;
  }, []);

  // Where the list has come to rest under the user's own hand. Both halves of a
  // release record: `onScrollEndDrag` when the finger lifts, then
  // `onMomentumScrollEnd` where the fling it threw actually stops. The later
  // one wins, so what is kept is where the list ended up rather than wherever
  // the finger happened to leave it — and a release with no momentum produces
  // only the first and is complete in itself.
  const recordUserSettle = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const { contentOffset } = e.nativeEvent;
      const atNewest = contentOffset.y <= AT_BOTTOM_SLOP;
      followRef.current = atNewest;
      setShowScrollToBottom(!atNewest);
      chatScrollMemory.set(chatId, {
        offset: contentOffset.y,
        atBottom: atNewest,
        anchorSeq: atNewest ? null : anchorSeqRef.current,
      });
    },
    [chatId],
  );

  // The finger is off the list, but the gesture is not over: whatever it threw
  // is still moving, and its resting place is the position that counts.
  const onScrollEndDrag = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      draggingRef.current = false;
      recordUserSettle(e);
    },
    [recordUserSettle],
  );

  // A momentum end is only the user's if a finger set it off. Android reports
  // one for a programmatic animation exactly as it does for a fling, and the
  // keyboard-show re-pin below is animated — an un-owned momentum end landing
  // mid-send used to read as the user scrolling away and write a false
  // `atBottom: false` into `chatScrollMemory` (back when the position test
  // depended on content height, which a keyboard resize could catch
  // mid-measurement — the offset-only test above isn't exposed to that, but
  // the ownership question below still matters on its own terms).
  //
  // Identify the scroll, do not date it: "is a drag in progress" is NOT the
  // test either, because a fling's own settle legitimately arrives after the
  // drag is over, and rejecting on that basis throws away the resting position
  // of every fling — which strands follow mode off at the newest message.
  // Ownership is the question, so `gestureOpenRef` is the answer.
  const onMomentumScrollEnd = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      if (!gestureOpenRef.current) return;
      gestureOpenRef.current = false;
      recordUserSettle(e);
    },
    [recordUserSettle],
  );

  // When the composer keyboard opens, keep the newest message visible above it
  // (spec/15 § Composer). The window is `adjustResize`, so the list shrinks;
  // on an inverted list offset 0 stays at the (now smaller) viewport's bottom
  // edge on its own — this re-pin is a defensive re-assert, not a chase. A
  // user reading history (not following) is left where they are.
  React.useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      if (followRef.current) scrollToNewest(true);
    });
    return () => sub.remove();
  }, [scrollToNewest]);

  // A reader who is NOT following keeps what they were looking at when the
  // list changes height — the keyboard opening or closing, the composer
  // growing (spec/15 § Composer). Left alone, an inverted list keeps its
  // offset, which is measured from the NEWEST end: the whole transcript slides
  // up by the keyboard's height and the top of the view — where the reader's
  // eye is — goes off screen. Holding the top edge still means moving the
  // offset by exactly the height the list lost (or gained). Same outcome as
  // web, where a shrinking scrollport leaves `scrollTop` — the top edge — as
  // it was (spec/14 § Main chat panel).
  const onLayout = React.useCallback((e: LayoutChangeEvent): void => {
    const height = e.nativeEvent.layout.height;
    const previous = listHeightRef.current;
    listHeightRef.current = height;
    if (previous === null || previous === height) return;
    // Following: the newest message is what is in view, and offset 0 keeps
    // it there with no help (the keyboard re-pin above re-asserts it).
    // Mid-gesture: the finger owns the offset. Still settling: the open's
    // own restore-or-pin owns it, and its scroll may not have reported back
    // yet, so `offsetRef` could be stale.
    if (followRef.current || draggingRef.current || !settledRef.current) return;
    const offset = Math.max(0, offsetRef.current + (previous - height));
    offsetRef.current = offset;
    listRef.current?.scrollToOffset({ offset, animated: false });
  }, []);

  // Tapping the title/folder crumb: both are clipped to one line in the
  // header (§ header layout above), with no way to read the rest of a long
  // one. Opens the full text in a modal instead of growing the header.
  const [titleModalOpen, setTitleModalOpen] = React.useState(false);

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        testID="chat-header"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          // Small, normal padding only: the root layout's SafeAreaView already
          // clears the status bar (spec/15 § Safe area) — adding a whole
          // space.xl on top of it counted the inset twice.
          paddingTop: space.sm,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
          backgroundColor: colors.paperRaised,
          borderBottomWidth: 1,
          borderColor: colors.lineSoft,
        }}
      >
        <Pressable
          onPress={() => goBack(router, '/(tabs)/chats')}
          style={{ padding: space.sm }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Pressable
          onPress={() => setTitleModalOpen(true)}
          style={{ flex: 1, paddingHorizontal: space.sm }}
          accessibilityRole="button"
          accessibilityLabel="Chat name — tap to view in full"
        >
          {/*
            The folder NAME, on ONE line (spec/15 § Chat detail). Both halves
            matter: with no `numberOfLines` a long absolute path wrapped inside
            this `flex: 1` box into a tall, ~6-character-wide column — this box
            competes for width with the awaiting-permission pill and the call +
            kebab buttons — and crushed the title beside it to a single letter.
            Showing the name rather than the path is the same rule the folder
            pickers and the tool rows use (`folderName`); the path is not what
            identifies a chat at a glance. A tap opens both lines' full text in
            a modal for anything long enough to still be clipped here.
          */}
          {/* No crumb for a special thread: its fixed label IS the title, and
              its folder is the same word again ("Manager" over "Manager"). */}
          {isReservedSpecialThread(chatId) ? null : (
            <Text
              testID="chat-folder"
              style={{ ...typography.meta, color: colors.ink3 }}
              numberOfLines={1}
            >
              {[row?.folder ? folderName(row.folder) : null, hostLabel !== '' ? hostLabel : null]
                .filter((p): p is string => p !== null)
                .join(' · ') || '—'}
            </Text>
          )}
          <Text style={{ ...typography.title, color: colors.ink }} numberOfLines={1}>
            {title}
          </Text>
        </Pressable>
        {row?.awaitingPermission ? (
          <View
            style={{
              backgroundColor: colors.waitingTint,
              paddingHorizontal: space.sm,
              paddingVertical: 2,
              borderRadius: radii.pill,
              marginRight: space.sm,
            }}
          >
            <Text style={{ ...typography.meta, fontFamily: fonts.bodyMedium, color: colors.ink }}>
              waiting on you
            </Text>
          </View>
        ) : null}
        {/* Call button — the ONLY place a sustained voice CALL is started on
            mobile (spec/15 § Chat detail). Read-only mirror threads have no
            voice call, so it is hidden there. */}
        {!readOnlyMirror ? (
          <Pressable
            onPress={() => startVoiceCall(chatId)}
            style={{ padding: space.sm }}
            accessibilityRole="button"
            accessibilityLabel="Start voice call"
          >
            <Phone size={20} color={colors.ink} />
          </Pressable>
        ) : null}
        {/* Hands-free — the same sustained session, with the line left open
            (spec/07 § Session modes). It never ends itself on silence, so
            there is nothing to reopen an hour into plastering a wall, and only
            an utterance addressed to Patch counts as a turn. */}
        {!readOnlyMirror && chatId === SPECIAL_THREAD_IDS.manager ? (
          <Pressable
            onPress={() => startVoiceCall(chatId, 'hands-free')}
            style={{ padding: space.sm }}
            accessibilityRole="button"
            accessibilityLabel="Start hands-free"
          >
            <Ear size={20} color={colors.ink} />
          </Pressable>
        ) : null}
        {/* Find in this chat (spec/15 § Find in chat). */}
        <Pressable
          testID="chat-find-toggle"
          onPress={() => (findOpen ? closeFind() : setFindOpen(true))}
          style={{ padding: space.sm }}
          accessibilityRole="button"
          accessibilityLabel="Find in chat"
        >
          <Search size={20} color={colors.ink} />
        </Pressable>
        {/* ⋯ — New chat, Call, Tools, Pin, Snooze, Archive, Disable, Delete:
            whichever apply to this chat (spec/15 § Chat detail). */}
        <ChatActionsMenu chatId={chatId} row={row} />
      </View>
      {findOpen ? (
        <ChatFindBar
          query={findQuery}
          onQuery={setFindQuery}
          position={findIndex}
          count={findSeqs.length}
          onStep={(d) => setFindIndex((i) => stepIndex(i, d, findSeqs.length))}
          onClose={closeFind}
        />
      ) : null}
      {/* Manager only: Conversation | Chats (spec/15 § Voice tab (Manager)). */}
      <ManagerSegments chatId={chatId} value={managerTab} onChange={setManagerTab} />
      {/* Connection banners + goal / tasks / reminder / wake / monitors /
          background tasks / archived / snoozed / sign-in bars (spec/15 §
          Chat detail → Status bars). */}
      <ChatBars chatId={chatId} row={row} />
      {/* KeyboardAvoidingView keeps the composer + stream above the soft keyboard
          (spec/15 § Composer). On Android the window is `adjustResize`, so no
          behavior is needed; iOS pads. The scrollToNewest re-assert on
          keyboardDidShow (see above) covers the list shrinking. */}
      <KeyboardAvoidingView
        style={{ flex: 1, display: managerTab === 'chats' ? 'none' : 'flex' }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList
          ref={listRef}
          style={{ flex: 1, opacity: settled ? 1 : 0 }}
          pointerEvents={settled ? 'auto' : 'none'}
          // See the block comment above `chatScrollMemory`: data goes in
          // newest-first, `inverted` renders it back in normal reading order.
          data={invertedRows}
          inverted
          keyExtractor={keyExtractor}
          contentContainerStyle={LIST_CONTENT_STYLE}
          renderItem={renderItem}
          onScroll={onScroll}
          onLayout={onLayout}
          onScrollBeginDrag={onScrollBeginDrag}
          onScrollEndDrag={onScrollEndDrag}
          onMomentumScrollEnd={onMomentumScrollEnd}
          scrollEventThrottle={16}
          onContentSizeChange={onContentSizeChange}
          onScrollToIndexFailed={onScrollToIndexFailed}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          // A long transcript is thousands of rows, and each one can be a whole
          // markdown document. The defaults mount far more of them than the
          // screen can show. `removeClippedSubviews` is deliberately NOT set:
          // it drops real content on Android, and the win here comes from
          // mounting fewer cells, not from detaching mounted ones.
          //
          // This used to need a much higher `initialNumToRender` (80, briefly
          // — 12 before that): on a non-inverted list, the first synchronous
          // paint always starts at row 0 regardless of chat length, so opening
          // any chat longer than that batch-mounted top-to-bottom while
          // simultaneously auto-scrolling to the end, reading as messages
          // "loading one at a time". Inverted, row 0 IS the newest message —
          // the first paint already mounts what's on screen, at any chat
          // length — so this only needs to comfortably cover one viewport.
          initialNumToRender={20}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={50}
          // `windowSize` (RN's default is 21 "screens", centred on the visible
          // one) is how much of the REST of a long chat gets pre-mounted in the
          // background after that first paint. On the old non-inverted list a
          // big number here was deliberate — the freshly-scrolled-to tail
          // needed to survive the default recycling window while the
          // auto-scroll-to-end was still settling (see history above). That
          // reason is gone: there is no tail to protect, nothing to settle
          // into. Left at 21, every row this screen exists to virtualize away
          // still got mounted in the background over the following few
          // seconds — visibly, since Android's rendering thread and this JS
          // thread share the phone. Cut down to cover a handful of screens
          // either side of view, enough for smooth scrolling into history
          // without eagerly paying for rows nobody has scrolled to yet.
          windowSize={5}
          ListEmptyComponent={
            working ? null : readOnlyMirror ? (
              <EmptyState
                icon={MessageSquare}
                title={EMPTY_STATES.mirror.title}
                body={EMPTY_STATES.mirror.body}
              />
            ) : (
              // On-brand graphic empty state for a real chat (spec/15 § Empty
              // states) — the illustration + just the title. The "Type below…"
              // hint body is dropped for parity with web (spec/15 § Empty states
              // — it wasn't useful).
              <View
                style={{
                  alignItems: 'center',
                  paddingHorizontal: space.xl,
                  paddingVertical: space.xxl,
                }}
              >
                <EmptyChatArt />
                <Text
                  style={{
                    fontFamily: fonts.brand,
                    fontSize: 20,
                    color: colors.ink,
                    marginTop: space.md,
                    textAlign: 'center',
                  }}
                >
                  {EMPTY_STATES.chat.title}
                </Text>
              </View>
            )
          }
          // A real "footer" renders after the last DATA item, which on an
          // inverted list is the OLDEST message — visually the top of the
          // screen. The typing indicator belongs after the NEWEST message
          // (the bottom), which is "before" index 0 — the header slot.
          ListHeaderComponent={
            working || queuedEntries.length > 0 ? (
              <View>
                {working ? <WorkingIndicator /> : null}
                {queuedEntries.map((entry, i) => (
                  <TimelineItem
                    key={`q-${entry.localId ?? entry.seq}`}
                    entry={entry}
                    chatId={chatId}
                    queuePos={i + 1}
                    {...(queuedEdit !== null && entry.localId === queuedEdit.localId
                      ? { queuedDraft: queuedEdit.text }
                      : {})}
                    onQueuedDraft={onQueuedDraft}
                    onEditQueued={onEditQueued}
                  />
                ))}
              </View>
            ) : null
          }
        />
        {/* Floating "scroll to bottom" affordance: shown only once the user has
            scrolled away from the newest message (mirrors `followRef`, spec/15
            § Chat detail scroll behaviour above), so following the chat never
            has a button sitting over it doing nothing. */}
        {showScrollToBottom ? (
          <Pressable
            testID="scroll-to-bottom"
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest message"
            onPress={() => {
              followRef.current = true;
              setShowScrollToBottom(false);
              scrollToNewest(true);
            }}
            style={{
              position: 'absolute',
              right: space.md,
              bottom: space.xl * 2,
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: colors.paperRaised,
              borderWidth: 1,
              borderColor: colors.divider,
              alignItems: 'center',
              justifyContent: 'center',
              elevation: 4,
              shadowColor: fixed.shadow,
              shadowOpacity: 0.15,
              shadowRadius: 4,
            }}
          >
            <ChevronDown size={20} color={colors.ink} />
          </Pressable>
        ) : null}
        {/* A call on this chat docks its control bar here; a call on another
            chat shows as the on-call pill (spec/15 § Voice states). */}
        <CallDock chatId={chatId} />
        {readOnlyMirror ? (
          <View
            testID="composer-readonly"
            style={{
              paddingVertical: space.md,
              paddingHorizontal: space.md,
              backgroundColor: colors.paperRaised,
              borderTopWidth: 1,
              borderColor: colors.lineSoft,
            }}
          >
            <Text style={{ ...typography.meta, color: colors.ink3, fontStyle: 'italic' }}>
              Read-only transcript — speak to a voice device.
            </Text>
          </View>
        ) : (
          <>
            <DelegateStrip chatId={chatId} />
            <Composer key={chatId} chatId={chatId} folder={row?.folder} autoFocus />
          </>
        )}
      </KeyboardAvoidingView>
      {managerTab === 'chats' ? <ManagerChatsList /> : null}
      <MessageActionsHost />
      <ArtifactViewerHost />
      <Modal
        testID="chat-title-modal"
        visible={titleModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTitleModalOpen(false)}
      >
        <Pressable
          testID="chat-title-modal-backdrop"
          onPress={() => setTitleModalOpen(false)}
          style={{
            flex: 1,
            backgroundColor: fixed.backdrop,
            alignItems: 'center',
            justifyContent: 'center',
            padding: space.xl,
          }}
        >
          {/* Stop the tap from bubbling to the backdrop — the card itself
              should not dismiss the modal. */}
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.paperRaised,
              borderRadius: radii.lg,
              padding: space.lg,
              width: '100%',
            }}
          >
            <Text
              testID="chat-title-modal-folder"
              style={{ ...typography.meta, color: colors.ink3 }}
            >
              {row?.folder ?? '—'}
            </Text>
            <Text style={{ ...typography.title, color: colors.ink, marginTop: space.sm }}>
              {title}
            </Text>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// A tool call renders collapsed by default with a one-line summary; tapping
// the row expands its args + (for Edit/Write/MultiEdit) an inline unified
// diff (spec/15 ## Chat detail). NO side-by-side — the unified renderer is
// the only diff view on mobile.
function ToolCallItem({
  chatId,
  entry,
  result,
}: {
  chatId: string;
  entry: ChatEventEntry;
  /** This call's own tool_result, folded into the same row (spec/15). */
  result?: ChatEventEntry;
}): React.ReactElement {
  // spec/15 § Chat detail — Delegate tool row: a `patch_delegate` call is the
  // one tool row that does not collapse like the rest, on web's rules
  // (spec/14 § Main chat panel — Delegate tool row). Checked before any hook
  // below runs — `entry.tool` is fixed for the life of this mounted row, so
  // the branch is as stable as any other component-selection dispatch.
  if (entry.tool && toolLabel(entry.tool) === 'patch_delegate') {
    return <DelegateToolCallItem chatId={chatId} entry={entry} result={result} />;
  }
  // `view_file` exists to SHOW the file, so a valid ack renders the file itself
  // (mirrors web's ViewFileCard). An invalid ack (an error) falls through to the
  // ordinary row. Same stability argument as the delegate branch above.
  const viewFile =
    entry.tool && toolLabel(entry.tool) === 'view_file' && result
      ? viewFilePayload(result.toolResult)
      : null;
  if (viewFile) return <ViewFileCard view={viewFile} />;
  const colors = useTheme();
  const [expanded, setExpanded] = React.useState(false);
  const diff = diffFromToolCall(entry.tool, entry.toolArgs);
  // What the call is DOING (spec/15 § Chat detail) — the tool plus its own
  // description or the thing it acted on, not the NAMES of its arguments. A
  // settled call reads with a trailing arrow, same as web, so the row itself
  // says the call is done without a second "↳ ... done" row underneath it.
  const summary = result
    ? `${toolCallSummary(entry.tool, entry.toolArgs)} →`
    : toolCallSummary(entry.tool, entry.toolArgs);
  // patch_notify calls carrying a deepLink render a tappable link row on the
  // collapsed summary itself — same tap-target the push notification itself
  // opens (spec/09 § `### push`, spec/15 § Chat detail) — rather than
  // requiring expansion first.
  const deepLink =
    entry.tool === 'patch_notify' &&
    entry.toolArgs &&
    typeof entry.toolArgs === 'object' &&
    typeof (entry.toolArgs as Record<string, unknown>)['deepLink'] === 'string'
      ? ((entry.toolArgs as Record<string, unknown>)['deepLink'] as string)
      : null;
  return (
    <View
      style={{
        backgroundColor: colors.paperRaised,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        marginBottom: space.sm,
      }}
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        onLongPress={() => showMessageActions(copyableText(entry) ?? '')}
        delayLongPress={350}
        style={{ flexDirection: 'row', alignItems: 'center' }}
        accessibilityLabel={`Tool call ${entry.tool ?? ''} — tap to ${expanded ? 'collapse' : 'expand'}`}
      >
        {expanded ? (
          <ChevronDown size={14} color={colors.ink3} />
        ) : (
          <ChevronRight size={14} color={colors.ink3} />
        )}
        <Text
          style={{ ...typography.meta, color: colors.ink2, marginLeft: space.xs, flexShrink: 1 }}
          numberOfLines={1}
        >
          {summary}
        </Text>
      </Pressable>
      {deepLink ? (
        <Pressable
          onPress={() => void Linking.openURL(deepLink)}
          style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.xs }}
          accessibilityLabel={`Open link ${deepLink}`}
          testID="tool-call-deeplink"
        >
          <ExternalLink size={13} color={colors.leaf} />
          <Text
            style={{ ...typography.meta, color: colors.leaf, marginLeft: space.xs }}
            numberOfLines={1}
          >
            {deepLink}
          </Text>
        </Pressable>
      ) : null}
      {expanded ? (
        <View style={{ marginTop: space.xs }}>
          {diff ? (
            <UnifiedDiff pairs={diff} />
          ) : (
            <Text style={{ ...typography.code, color: colors.ink2 }} selectable>
              {JSON.stringify(entry.toolArgs, null, 2)}
            </Text>
          )}
          {result ? <ToolResultBody chatId={chatId} value={result.toolResult} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** A whole tool result left in the blob store, as replay sends it. */
interface ToolBlobRef {
  $blob: string;
  bytes: number;
  preview: string;
}

function asBlobRef(value: unknown): ToolBlobRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const sha = v['$blob'];
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return {
    $blob: sha,
    bytes: typeof v['bytes'] === 'number' ? v['bytes'] : 0,
    preview: typeof v['preview'] === 'string' ? v['preview'] : '',
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A tool result's body. Usually just the JSON, as before — but replay now
 * sends a REFERENCE for anything bulky (spec/04 § History — blobs), because
 * tool output is 85-99% of a long chat's bytes and these rows arrive
 * collapsed. A reference draws as its preview plus what it would cost, and
 * fetches the rest only if asked.
 *
 * NO FALLBACK: a failed fetch says so and offers to retry. Quietly leaving
 * the preview up would turn a truncated result into one that reads whole.
 */
function ToolResultBody({ chatId, value }: { chatId: string; value: unknown }): React.ReactElement {
  const colors = useTheme();
  const blob = asBlobRef(value);
  const [loaded, setLoaded] = React.useState<unknown>(undefined);
  const [error, setError] = React.useState<string | null>(null);

  const body = (text: string): React.ReactElement => (
    <Text
      testID="tool-call-result"
      style={{ ...typography.code, color: colors.ink3, marginTop: space.xs }}
      selectable
    >
      {text}
    </Text>
  );

  const sha = blob?.$blob;
  const load = React.useCallback((): void => {
    if (sha === undefined) return;
    setError(null);
    fetch(apiUrl(`/api/chats/${encodeURIComponent(chatId)}/blob/${sha}`))
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as unknown;
      })
      .then((v) => setLoaded(v))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [chatId, sha]);

  // Fetched on MOUNT, and this only mounts when the row is expanded. So
  // opening a tool row shows what the tool said, with no second tap — while
  // the rows nobody opens still cost nothing, which is why replay leaves the
  // bodies behind in the first place.
  React.useEffect(() => {
    if (sha !== undefined) load();
  }, [sha, load]);

  if (!blob) return body(JSON.stringify(value, null, 2));
  if (loaded !== undefined) return body(JSON.stringify(loaded, null, 2));

  return (
    <View testID="tool-blob" style={{ marginTop: space.xs }}>
      {blob.preview ? body(blob.preview) : null}
      {error !== null ? (
        <>
          <Text testID="tool-blob-error" style={{ ...typography.meta, color: colors.red }}>
            Could not load the rest: {error}
          </Text>
          {/* NO FALLBACK: the preview stays, but never unlabelled as partial. */}
          <Pressable
            testID="tool-blob-load"
            accessibilityRole="button"
            onPress={load}
            style={{ marginTop: space.xs, alignSelf: 'flex-start' }}
          >
            <Text style={{ ...typography.meta, color: colors.leaf }}>
              Retry ({formatBytes(blob.bytes)})
            </Text>
          </Pressable>
        </>
      ) : (
        <Text
          testID="tool-blob-load"
          style={{ ...typography.meta, color: colors.ink3, marginTop: space.xs }}
        >
          Loading {formatBytes(blob.bytes)}…
        </Text>
      )}
    </View>
  );
}

interface ViewFileView {
  kind: 'image' | 'pdf' | 'html';
  /** Server-relative URL of the wrapped page (`/api/chats/:id/artifact/:aid`). */
  url: string;
  name: string;
  /** An image's real pixel size, when the host could read its header. */
  width?: number | undefined;
  height?: number | undefined;
}

function asViewFile(v: unknown): ViewFileView | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { kind, url, name } = v as Record<string, unknown>;
  if (kind !== 'image' && kind !== 'pdf' && kind !== 'html') return null;
  if (typeof url !== 'string' || !url.startsWith('/api/')) return null;
  if (typeof name !== 'string' || name === '') return null;
  const { width, height } = v as Record<string, unknown>;
  return {
    kind,
    url,
    name,
    width: typeof width === 'number' ? width : undefined,
    height: typeof height === 'number' ? height : undefined,
  };
}

/**
 * Parse a `view_file` result: the host's small json ack, delivered either as
 * the bare content-block array (live chat) or inside `{ content }` (replay).
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
      // Not this block — a `view_file` ack is always valid JSON.
    }
  }
  return null;
}

/** An image the server serves: shown from its URL, or from a local copy when the route is relayed. */
function ServedImage({
  url,
  ...image
}: { url: string } & Omit<
  React.ComponentProps<typeof Image>,
  'source'
>): React.ReactElement | null {
  const { uri } = useLocalUri(url);
  return uri ? <Image source={{ uri }} {...image} /> : null;
}

// An image shows inline; a pdf/html file is a card. Either opens the in-app
// artifact viewer, the one place a served page opens on mobile.
function ViewFileCard({ view }: { view: ViewFileView }): React.ReactElement {
  const colors = useTheme();
  const url = apiUrl(view.url);
  return (
    <Pressable
      testID="view-file"
      accessibilityRole="button"
      accessibilityLabel={`View ${view.name}`}
      onPress={() => openArtifactViewer(url, view.name)}
      style={{
        backgroundColor: colors.paperRaised,
        borderColor: colors.lineSoft,
        borderWidth: 1,
        borderRadius: radii.lg,
        padding: space.sm,
        marginBottom: space.sm,
      }}
    >
      <Text style={{ ...typography.meta, color: colors.ink3, marginBottom: space.xs }}>
        {view.name}
      </Text>
      {view.kind === 'image' ? (
        <ServedImage
          url={url}
          // The picture's own aspect ratio when the host could read it, so
          // the card is the shape of the image instead of letterboxing it
          // into a fixed box — and the row's height is settled before a byte
          // of it loads. 320 is the height to hold when the header was not
          // one we parse; it is a layout default, not a swallowed failure.
          style={
            view.width !== undefined && view.height !== undefined
              ? { width: '100%', aspectRatio: view.width / view.height, borderRadius: radii.sm }
              : { width: '100%', height: 320, borderRadius: radii.sm }
          }
          resizeMode="contain"
          accessibilityLabel={view.name}
        />
      ) : null}
    </Pressable>
  );
}

/** A `{ id, label }` delegate-create ack, however the tool layer wrapped it. */
function delegateAckPayload(result: unknown): { id: string; label: string } | null {
  const asAck = (v: unknown): { id: string; label: string } | null => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const id = (v as Record<string, unknown>)['id'];
    const label = (v as Record<string, unknown>)['label'];
    return typeof id === 'string' && id !== '' && typeof label === 'string' && label !== ''
      ? { id, label }
      : null;
  };
  const direct = asAck(result);
  if (direct) return direct;
  if (typeof result !== 'object' || result === null) return null;
  const content = Array.isArray(result) ? result : (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as Record<string, unknown>)['text'];
    if (typeof text !== 'string') continue;
    try {
      const parsed = asAck(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // Not this block.
    }
  }
  return null;
}

/**
 * spec/15 § Chat detail — Delegate tool row: a live status pill (from
 * `chat.delegate_update`, keyed by the subagent's own chatId — the `id` its
 * tool result returns) on a collapsible row that expands the read-only
 * transcript inline, since the subagent is never a chat this surface can open the
 * ordinary way (spec/04 § Chats and folders — Subagent). Before the ack
 * lands (`patch_delegate` acks synchronously, so this is a near-instant
 * gap) there is no id to key anything on, so it falls back to the ordinary
 * collapsed row rather than a pill with nothing behind it.
 */
function DelegateToolCallItem({
  chatId,
  entry,
  result,
}: {
  chatId: string;
  entry: ChatEventEntry;
  result?: ChatEventEntry;
}): React.ReactElement {
  const colors = useTheme();
  const [expanded, setExpanded] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const ack = delegateAckPayload(result?.toolResult);
  const live = useChatStore((s) => (ack ? s.delegateUpdates[chatId]?.[ack.id] : undefined));
  const summary = toolCallSummary(entry.tool, entry.toolArgs);

  if (!ack) {
    return (
      <View
        style={{
          backgroundColor: colors.paperRaised,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.lineSoft,
          marginBottom: space.sm,
        }}
      >
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          style={{ flexDirection: 'row', alignItems: 'center' }}
          accessibilityLabel={`Tool call ${entry.tool ?? ''} — tap to ${expanded ? 'collapse' : 'expand'}`}
        >
          {expanded ? (
            <ChevronDown size={14} color={colors.ink3} />
          ) : (
            <ChevronRight size={14} color={colors.ink3} />
          )}
          <Text
            style={{ ...typography.meta, color: colors.ink2, marginLeft: space.xs, flexShrink: 1 }}
            numberOfLines={1}
          >
            {result ? `${summary} →` : summary}
          </Text>
        </Pressable>
        {expanded ? (
          <Text style={{ ...typography.code, color: colors.ink2, marginTop: space.xs }} selectable>
            {JSON.stringify(entry.toolArgs, null, 2)}
          </Text>
        ) : null}
      </View>
    );
  }

  const status = live?.status ?? 'running';
  const label = live?.label ?? ack.label;

  return (
    <View
      testID="delegate-tool-call"
      style={{
        backgroundColor: colors.paperRaised,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        marginBottom: space.sm,
      }}
    >
      <Pressable
        testID="delegate-open-transcript"
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
        accessibilityLabel={`Subagent ${label} — tap to ${open ? 'collapse' : 'expand'}`}
      >
        {open ? (
          <ChevronDown size={14} color={colors.ink3} />
        ) : (
          <ChevronRight size={14} color={colors.ink3} />
        )}
        <Text style={{ ...typography.meta, color: colors.ink2, flexShrink: 1 }} numberOfLines={1}>
          {summary}
        </Text>
        <View
          testID="delegate-status-pill"
          style={{
            paddingHorizontal: space.sm,
            paddingVertical: 1,
            borderRadius: 999,
            backgroundColor: delegateStatusColor(status, colors),
          }}
        >
          <Text
            style={{
              ...typography.meta,
              fontSize: textMin,
              fontWeight: '600',
              color: colors.onAccent,
            }}
          >
            {DELEGATE_STATUS_LABEL[status]}
          </Text>
        </View>
      </Pressable>
      {open ? <DelegateTranscript chatId={chatId} delegateId={ack.id} /> : null}
    </View>
  );
}

// A background task completion the surface received as a raw
// `<task-notification>` user turn (spec/15 ## Chat detail). One collapsed line
// reading the block's own summary sentence — `Background task` where it has
// none, since the sentence is the block's to give — and the raw block a tap
// away, on the same collapsed-by-default rules as a tool call.
function TaskNotificationItem({ entry }: { entry: ChatEventEntry }): React.ReactElement {
  const colors = useTheme();
  const [expanded, setExpanded] = React.useState(false);
  const content = entry.content ?? '';
  const summary = taskNotificationSummary(content) ?? 'Background task';
  return (
    <View testID="bg-task-notice" style={{ marginBottom: space.xs }}>
      <Pressable
        testID="bg-task-notice-summary"
        onPress={() => setExpanded((v) => !v)}
        onLongPress={() => showMessageActions(content)}
        delayLongPress={350}
        style={{ flexDirection: 'row', alignItems: 'center' }}
        accessibilityLabel={`Background task — tap to ${expanded ? 'collapse' : 'expand'}`}
      >
        {expanded ? (
          <ChevronDown size={14} color={colors.ink3} />
        ) : (
          <ChevronRight size={14} color={colors.ink3} />
        )}
        <Text
          style={{ ...typography.meta, color: colors.ink3, marginLeft: space.xs, flexShrink: 1 }}
          numberOfLines={1}
        >
          {summary}
        </Text>
      </Pressable>
      {expanded ? (
        <Text style={{ ...typography.code, color: colors.ink2, marginTop: space.xs }} selectable>
          {content}
        </Text>
      ) : null}
    </View>
  );
}

// A settled tool result: the quiet line under the call it belongs to.
function ToolResultItem({ entry }: { entry: ChatEventEntry }): React.ReactElement {
  const colors = useTheme();
  return (
    <MessageLongPress
      text={copyableText(entry)}
      style={{ marginBottom: space.xs, paddingLeft: space.md }}
    >
      <Text style={{ ...typography.meta, color: colors.ink3 }}>↳ {entry.tool} done</Text>
    </MessageLongPress>
  );
}

// A published artifact's own card (spec/15 § Artifacts; mirrors web's
// ArtifactCard in `packages/web/src/routes/ChatRoute.tsx`) — title, the source
// filename, nothing else. Tapping it opens the full-screen in-app viewer
// (`ArtifactViewer.tsx`), the one place an artifact opens on mobile.
function ArtifactCard({ entry }: { entry: ChatEventEntry }): React.ReactElement {
  const colors = useTheme();
  // The card sizes itself from its content: a plain column cell (like the tool
  // group above it), the Pressable only a row of icon + text. No `flex: 1` in
  // the row — on Android in the inverted list it was measured against the cell
  // and the card drew as a tall blank oval over the next message.
  return (
    <View testID="artifact-card-cell" style={{ alignSelf: 'stretch', marginBottom: space.sm }}>
      <Pressable
        testID="artifact-card"
        accessibilityRole="button"
        accessibilityLabel={`Open artifact ${entry.artifactTitle ?? ''}`}
        onPress={() =>
          openArtifactViewer(apiUrl(entry.artifactUrl ?? ''), entry.artifactTitle ?? '')
        }
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          maxWidth: '100%',
          gap: space.sm,
          backgroundColor: colors.paperRaised,
          borderColor: colors.lineSoft,
          borderWidth: 1,
          borderRadius: radii.md,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        }}
      >
        <LayoutTemplate size={16} color={colors.ink2} />
        <View style={{ flexShrink: 1 }}>
          <Text style={{ ...typography.meta, fontFamily: fonts.bodyMedium, color: colors.ink }}>
            {entry.artifactTitle}
          </Text>
          <Text style={{ ...typography.meta, color: colors.ink3 }}>{entry.artifactPath}</Text>
        </View>
      </Pressable>
    </View>
  );
}

// spec/15 § Chat detail — a consecutive run of more than one tool call is ONE
// row narrating what the batch did (e.g. "Ran 3 commands, read 2 files"), not naming
// every call and its target — that detail is a tap away, not on screen before
// it's asked for. Tapping it mounts exactly the rows it stands in for.
// Memoised: the transcript re-renders on every store commit, and without this
// every mounted row re-rendered with it. `entries` is a stable slice — the
// store only ever replaces a timeline array wholesale, so reference equality is
// the right test.
const ToolGroupItem = React.memo(function ToolGroupItem({
  entries,
  narration,
  chatId,
}: {
  entries: ChatEventEntry[];
  narration: string | null;
  chatId: string;
}): React.ReactElement {
  const colors = useTheme();
  const [expanded, setExpanded] = React.useState(false);
  const calls = entries.filter((e) => e.kind === 'tool_call');
  // The host's AI label for this run once it has closed (spec/14 § Tool
  // runs); until then, or when it failed, the count of the work by kind.
  const ai = useChatStore((s) => {
    const first = calls[0]?.callId;
    return first === undefined ? undefined : s.toolRunSummaries[chatId]?.[first];
  });
  const matches =
    ai !== undefined &&
    ai.callIds.length === calls.length &&
    ai.callIds.every((id, i) => calls[i]?.callId === id);
  const aiError = matches ? ai.error : undefined;
  // No label yet: the agent's own sentence before the run, else the count.
  // A failed label keeps the count so the failure reads as one.
  const summary =
    (matches ? ai.summary : null) ??
    (aiError === undefined ? narration : null) ??
    toolRunNarrative(calls);
  return (
    <View
      testID="tool-group"
      style={{
        backgroundColor: colors.paperRaised,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        marginBottom: space.sm,
      }}
    >
      <Pressable
        testID="tool-group-summary"
        onPress={() => setExpanded((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center' }}
        accessibilityLabel={`${summary} — tap to ${expanded ? 'collapse' : 'expand'}`}
      >
        {expanded ? (
          <ChevronDown size={14} color={colors.ink3} />
        ) : (
          <ChevronRight size={14} color={colors.ink3} />
        )}
        <Text
          style={{ ...typography.meta, color: colors.ink2, marginLeft: space.xs, flexShrink: 1 }}
          numberOfLines={1}
        >
          {summary}
        </Text>
        {aiError !== undefined ? (
          <Text
            testID="tool-group-summary-failed"
            style={{ ...typography.meta, color: colors.ink3, marginLeft: space.xs }}
            accessibilityLabel={`Summary failed: ${aiError}`}
          >
            ⓘ
          </Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={{ marginTop: space.xs }}>
          {entries.map((e, i) => {
            // Same call+result folding as the ungrouped path (spec/15): a
            // result that belongs to the call right above it renders inside
            // that call's row, not as a second "↳ ... done" row — it is
            // skipped here when reached.
            if (e.kind === 'tool_call') {
              const result = pairedResult(entries, i);
              return (
                <ToolCallItem key={`${e.seq}-${i}`} chatId={chatId} entry={e} result={result} />
              );
            }
            const prev = entries[i - 1];
            if (prev?.kind === 'tool_call' && prev.callId && prev.callId === e.callId) return null;
            return <ToolResultItem key={`${e.seq}-${i}`} entry={e} />;
          })}
        </View>
      ) : null}
    </View>
  );
});

// In-thread pending-response indicator (spec/15 § Pending-response indicator):
// an assistant-aligned bubble with three dots blinking together on one beat —
// a typing indicator, NOT a spinner + label — shown while the agent is
// composing a reply so a send is never followed by a static, silent screen.
// No per-dot delay and no translateY hop (matches web's fix, 3ab7e910): a
// stagger reads as the dots travelling, and a shared vertical hop reads as
// the whole row jumping rather than as dots thinking.
function TypingDot(): React.ReactElement {
  const colors = useTheme();
  const anim = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });
  return (
    <Animated.View
      style={{
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: colors.ink3,
        opacity,
      }}
    />
  );
}

function WorkingIndicator(): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '85%', marginBottom: space.sm }}>
      <View
        style={{
          backgroundColor: colors.paperRaised,
          paddingHorizontal: space.md,
          paddingVertical: space.md,
          borderRadius: radii.md,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
        }}
        accessibilityLabel="Claude is working"
      >
        <TypingDot />
        <TypingDot />
        <TypingDot />
      </View>
    </View>
  );
}

// spec/15 § Side threads screen — "IN THE MAIN CHAT" marker(s) under a
// message that has one or more side threads forked from it. Tapping opens
// the screen on that tab. No message-count fetch here (mobile has no
// TanStack Query dependency) — the status dot (running/needs-you) is enough
// signal without one, matching the surface's simpler-by-design conventions.
function SideThreadMarkers({
  chatId,
  seq,
}: {
  chatId: string;
  seq: number;
}): React.ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const branches = useChatStore((s) => s.branchGraphs[chatId]?.branches);
  const sideThreadPermissions = useChatStore((s) => s.sideThreadPermissions);
  const here = (branches ?? []).filter((b) => b.sideThread && b.forkFromSeq === seq);
  if (here.length === 0) return null;
  return (
    <>
      {here.map((b) => {
        const needsYou = (sideThreadPermissions[`${chatId}::${b.branchId}`]?.length ?? 0) > 0;
        const status = needsYou ? 'needs you' : b.running ? 'running' : null;
        // Mobile's palette has no distinct "awaiting permission" hue the way
        // web's `--permission` does — both active states read the same
        // `waiting` amber dot, told apart by the label text instead.
        const dotColor = needsYou || b.running ? colors.waiting : colors.ink3;
        return (
          <Pressable
            key={b.branchId}
            testID={`side-thread-marker-${b.branchId}`}
            onPress={() => {
              openExistingSideThread(chatId, b.branchId);
              router.push(`/chats/${chatId}/threads`);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'flex-start',
              gap: space.xs,
              marginTop: space.xs,
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
              borderRadius: radii.pill,
              backgroundColor: colors.accentTint,
            }}
          >
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dotColor }} />
            <Text style={{ fontSize: textMin, color: colors.leafSoft }}>
              {`Side thread${status ? ` · ${status}` : ''}`}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
}

// Memoised for the same reason as ToolGroupItem: entries are immutable, so a
// row only needs to re-render when its own entry object is replaced.
const TimelineItem = React.memo(function TimelineItem({
  entry,
  chatId,
  result,
  queuePos,
  queuedDraft,
  onQueuedDraft,
  onEditQueued,
}: {
  entry: ChatEventEntry;
  chatId: string;
  /** This call's own tool_result, folded into the same row (spec/15). */
  result?: ChatEventEntry;
  /** 1-based place in the queued block; set only on a queued entry. */
  queuePos?: number;
  /** spec/04 § Edit — the text in this queued message's open editor. */
  queuedDraft?: string;
  onQueuedDraft?(localId: string, text: string | null): void;
  onEditQueued?(entry: ChatEventEntry, text: string): void;
}): React.ReactElement | null {
  const colors = useTheme();
  const daemonOnline = usePresenceStore((s) => s.daemon === 'online');
  // spec/15 ## Chat detail, spec/02 § Background task completions — a
  // completion that arrived still wrapped in its raw block (replay, or a host
  // on a pre-lifting host) is not a turn anyone typed and none of its
  // plumbing is worth reading, so it gets a quiet collapsed row instead of a
  // bubble. Same rules as web (spec/14).
  if (
    entry.kind === 'message' &&
    (entry.role ?? 'assistant') === 'user' &&
    hasTaskNotification(entry.content ?? '')
  ) {
    return <TaskNotificationItem entry={entry} />;
  }
  // spec/02 § Per-turn process / warm sessions — a reply Claude Code wrote
  // itself, not the agent: one muted line that says whose words they are.
  // spec/07 § The fast voice and the chat's agent — what a call's fast voice
  // asked the agent; § Call cost — the line a finished call leaves.
  if (entry.kind === 'message' && entry.voiceHandoff) {
    return (
      <Text
        testID="voice-handoff"
        style={{ fontSize: textMin, color: colors.ink3, marginBottom: space.sm }}
      >
        {`Asked the agent: ${entry.content ?? ''}`}
      </Text>
    );
  }
  if (
    entry.kind === 'message' &&
    entry.role === 'system' &&
    (entry.content ?? '').startsWith('[call] ')
  ) {
    return (
      <Text
        testID="call-summary"
        style={{
          fontSize: textMin,
          color: colors.ink3,
          marginBottom: space.sm,
          alignSelf: 'center',
        }}
      >
        {(entry.content ?? '').slice('[call] '.length)}
      </Text>
    );
  }
  if (entry.kind === 'message' && entry.synthetic) {
    return (
      <Text
        testID="synthetic-notice"
        style={{ fontSize: textMin, color: colors.ink3, marginBottom: space.sm }}
      >
        <Text style={{ fontWeight: '500' }}>Claude Code</Text>
        {`  ${entry.content ?? ''}`}
      </Text>
    );
  }
  if (entry.kind === 'message') {
    const role = entry.role ?? 'assistant';
    // spec/15 § Chat detail — "Messages — one-sided bubbles". Only the user's
    // turn is a bubble (green, right-aligned, 85%); the assistant's reply is
    // plain text on the page, flush-left at the FULL stream width, the way the
    // Claude app reads on a phone. A narrow screen can't afford to box the long
    // side of the conversation in a card.
    const isUser = role === 'user';
    const fg = colors.ink;
    const hasText = (entry.content ?? '').length > 0;
    return (
      <View
        testID={isUser ? 'message-user' : 'message-assistant'}
        style={{
          alignSelf: isUser ? 'flex-end' : 'stretch',
          maxWidth: isUser ? '85%' : '100%',
          marginBottom: space.sm,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          {/* Voice-origin turns show a small mic glyph beside the bubble instead
              of the daemon's literal `[voice • …]` tag (spec/15 § Chat detail). */}
          {entry.voice ? <Mic size={14} color={colors.ink3} /> : null}
          {/* Long-press opens Copy text / Select text / Show time (spec/15 §
              Chat detail — Copying message text). */}
          <MessageLongPress
            text={copyableText(entry)}
            messageAt={entry.messageAt}
            // spec/15 § Side threads screen TRIGGER — a settled message only:
            // one still carrying a localId is the optimistic echo of a turn
            // the host has no persisted record of yet, so there is no fork
            // point to hang a side thread off (NO FALLBACK) — mirrors web's
            // `canSideThread`.
            {...(entry.localId === undefined ? { sideThread: { chatId, seq: entry.seq } } : {})}
            // spec/04 ## Message queueing § Edit — a tap on a queued message
            // opens it for editing in place.
            {...(entry.queued &&
            entry.localId !== undefined &&
            onQueuedDraft &&
            queuedDraft === undefined
              ? { onPress: () => onQueuedDraft(entry.localId!, entry.content ?? '') }
              : {})}
            testID={isUser ? 'message-body-user' : 'message-body-assistant'}
            style={{
              // Desktop's user bubble: the accent TINT with a soft accent edge
              // and ink text — not a solid green slab — and a flatter corner
              // on the sender's side.
              backgroundColor: isUser ? colors.accentTint : undefined,
              borderWidth: isUser ? 1 : 0,
              borderColor: isUser ? colors.accentSoft : undefined,
              paddingHorizontal: isUser ? space.lg : 0,
              paddingVertical: isUser ? space.md : space.xs,
              borderRadius: isUser ? radii.lg : 0,
              borderBottomRightRadius: isUser ? space.xs : 0,
              flexShrink: 1,
              flexGrow: isUser ? 0 : 1,
              opacity: entry.deliveryPending || entry.upload ? 0.72 : 1,
            }}
          >
            {queuedDraft !== undefined && entry.localId !== undefined ? (
              <View>
                <TextInput
                  testID="queued-edit-input"
                  value={queuedDraft}
                  onChangeText={(t) => onQueuedDraft?.(entry.localId!, t)}
                  multiline
                  autoFocus
                  style={{ color: fg, minWidth: 200, padding: 0 }}
                />
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.md }}>
                  <Pressable
                    testID="queued-edit-cancel"
                    accessibilityRole="button"
                    accessibilityLabel="Cancel edit"
                    onPress={() => onQueuedDraft?.(entry.localId!, null)}
                    hitSlop={8}
                  >
                    <Text style={{ color: colors.ink3, fontSize: textMin }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    testID="queued-edit-save"
                    accessibilityRole="button"
                    accessibilityLabel="Save edit"
                    onPress={() => onEditQueued?.(entry, queuedDraft)}
                    hitSlop={8}
                  >
                    <Text style={{ color: colors.leaf, fontSize: textMin, fontWeight: '600' }}>
                      Save
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            {/* Markdown, not raw asterisks/backticks (spec/15 § Chat detail). */}
            {hasText && queuedDraft === undefined ? (
              // `hasText` (above) is only true when `entry.content` is a
              // non-empty string, so `?? ''` can never actually fire here —
              // it only satisfies TypeScript given `content` is optional.
              /* v8 ignore next */
              <ChatMarkdown content={entry.content ?? ''} color={fg} selectable={false} />
            ) : null}
            {/* Inline attachments (spec/15 § Composer — render inline in the stream). */}
            {/* A turn sent from this phone draws its files from the local
                copies (spec/15 § Composer → Attachments) — they are on screen
                before any upload lands. */}
            {entry.localAttachments && entry.localAttachments.length > 0 ? (
              <MessageAttachments
                chatId={chatId}
                attachments={entry.localAttachments}
                refs={entry.attachments}
                onGreen={false}
              />
            ) : entry.attachments && entry.attachments.length > 0 ? (
              <MessageAttachments chatId={chatId} attachments={entry.attachments} onGreen={false} />
            ) : null}
          </MessageLongPress>
        </View>
        {/* spec/15 § Side threads screen — "IN THE MAIN CHAT": a message with
            side threads carries a marker per thread. Tapping opens the screen
            on that tab. */}
        {entry.localId === undefined ? <SideThreadMarkers chatId={chatId} seq={entry.seq} /> : null}
        {/* spec/04 ## Message queueing — a parked turn says WHEN it goes in
            (Queued / 2nd in queue), with an always-visible promote (↑: stop the
            running turn so the queue drains now — never reorders it) and
            remove (×). Distinct from the delivery line below. */}
        {entry.queued && queuePos !== undefined ? (
          <View
            testID="queued-tools"
            style={{
              alignSelf: 'flex-end',
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              marginTop: 2,
            }}
          >
            <Text
              testID="queued-badge"
              accessibilityLabel={`${queueChipLabel(queuePos)}. ${queueChipTitle(queuePos)}`}
              style={{ color: colors.ink3, fontSize: textMin }}
            >
              {queueChipLabel(queuePos)}
            </Text>
            {entry.localId ? (
              <Pressable
                testID="queued-promote"
                accessibilityRole="button"
                accessibilityLabel="Run this queued message next"
                onPress={() => promoteMessage(chatId, entry.localId!)}
                hitSlop={10}
              >
                <ArrowUp size={16} color={colors.ink3} />
              </Pressable>
            ) : null}
            {entry.localId ? (
              <Pressable
                testID="queued-remove"
                accessibilityRole="button"
                accessibilityLabel="Remove queued message"
                onPress={() => unqueueMessage(chatId, entry.localId!)}
                hitSlop={10}
              >
                <X size={16} color={colors.ink3} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {/* spec/12 § Guaranteed input delivery — a distinct delivery-status line
            for an OUTGOING turn we haven't yet observed take effect. Failed
            delivery offers a tap-to-retry; never a silent forever-spinner.
            Before that, a turn with attachments says how its uploads are going
            (spec/15 § Composer → Attachments): `Uploading 1/3`, or `Not
            uploaded` with Retry and × (discard). */}
        {entry.upload && entry.localId ? (
          entry.upload.failed ? (
            <View
              style={{
                alignSelf: 'flex-end',
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.sm,
                marginTop: 2,
              }}
            >
              <Text testID="upload-status" style={{ color: colors.red, fontSize: textMin }}>
                Not uploaded
              </Text>
              <Pressable
                testID="upload-retry"
                accessibilityRole="button"
                accessibilityLabel="Retry upload"
                onPress={() => retryUpload(chatId, entry.localId!)}
                hitSlop={8}
              >
                <Text style={{ color: colors.red, fontSize: textMin, fontWeight: '600' }}>
                  Retry
                </Text>
              </Pressable>
              <Pressable
                testID="upload-discard"
                accessibilityRole="button"
                accessibilityLabel="Discard message"
                onPress={() => discardUpload(chatId, entry.localId!)}
                hitSlop={8}
              >
                <X size={14} color={colors.red} />
              </Pressable>
            </View>
          ) : (
            <Text
              testID="upload-status"
              style={{ alignSelf: 'flex-end', marginTop: 2, color: colors.ink3, fontSize: textMin }}
            >
              {`Uploading ${entry.upload.done}/${entry.upload.total}`}
            </Text>
          )
        ) : entry.deliveryFailed && entry.localId ? (
          <Pressable
            testID="delivery-retry"
            accessibilityRole="button"
            accessibilityLabel="Not delivered — tap to retry"
            onPress={() => deliveryTracker.retry(chatId, entry.localId!)}
            style={{ alignSelf: 'flex-end', marginTop: 2 }}
          >
            <Text style={{ color: colors.red, fontSize: textMin }}>
              Not delivered — tap to retry
            </Text>
          </Pressable>
        ) : entry.deliveryPending ? (
          <Text
            testID="delivery-pending"
            style={{ alignSelf: 'flex-end', marginTop: 2, color: colors.ink3, fontSize: textMin }}
          >
            {daemonOnline ? 'Sending…' : 'Queued — will send when the agent reconnects'}
          </Text>
        ) : null}
        {/* spec/15 § Chat detail — every <system-reminder> block this turn
            received, one quiet collapsed row each, under its own bubble. */}
        {entry.systemContext && entry.systemContext.length > 0 ? (
          <View testID="system-context-group" style={{ marginTop: space.xs }}>
            {entry.systemContext.map((item, i) => (
              <ContextDisclosure
                key={i}
                testID="system-context"
                summary={item.label}
                text={item.text}
              />
            ))}
          </View>
        ) : null}
      </View>
    );
  }
  if (entry.kind === 'permission_mode') {
    // spec/15 § Chat detail — where the permission mode changed: a rule across
    // the stream with the host's one-line record on it. Nothing to open; the
    // line is the whole fact.
    return (
      <View
        testID="permission-mode-change"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          marginBottom: space.sm,
        }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: colors.lineSoft }} />
        <Text style={{ color: colors.ink3, fontSize: textMin }}>{entry.content}</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.lineSoft }} />
      </View>
    );
  }
  if (entry.kind === 'artifact') {
    return <ArtifactCard entry={entry} />;
  }
  if (entry.kind === 'tool_call') {
    return <ToolCallItem chatId={chatId} entry={entry} result={result} />;
  }
  // (attachments render inline within the message branch above)
  if (entry.kind === 'tool_result') {
    return <ToolResultItem entry={entry} />;
  }
  if (entry.kind === 'error') {
    // A turn that FAILED, in the transcript where the missing reply is
    // (spec/12 § No fallbacks). The code sits under the message because
    // `sdk_error` is the half that makes a report actionable.
    return (
      <View
        accessibilityRole="alert"
        testID="turn-error"
        style={{
          backgroundColor: colors.diffDel,
          padding: space.md,
          borderRadius: radii.lg,
          marginBottom: space.sm,
          borderWidth: 1,
          borderColor: colors.red,
        }}
      >
        <Text style={{ color: colors.red }}>{presentFailure(entry.content ?? '')}</Text>
        {entry.errorCode && entry.errorCode !== 'sdk_error' ? (
          <Text
            style={{ ...typography.meta, color: colors.red, opacity: 0.75, marginTop: space.xs }}
          >
            {entry.errorCode}
          </Text>
        ) : null}
      </View>
    );
  }
  if (entry.kind === 'permission') {
    // spec/15 § Chat detail — the agent asking the user to choose is not an
    // approval, and gets the question card instead of Approve/Deny.
    if (entry.tool === ASK_USER_QUESTION) {
      return (
        <QuestionCard
          entry={entry}
          onAnswer={(requestId, answers) => {
            // Routed through `permissionDeliveryTracker`, not a bare
            // `getWs().send` — a phone answering a question is usually doing
            // it moments after being foregrounded from a push notification,
            // exactly when the socket is most likely to be mid-reconnect. A
            // send lost there used to be silent: the card still resolved
            // optimistically below, but the host never heard it and its own
            // expiry timer denied the request anyway (Tom, Todoist: "questions
            // are timing out after I answer them"). The tracker redelivers
            // until it observes the host's echo.
            permissionDeliveryTracker.send({
              type: 'chat.permission_response',
              chatId,
              requestId,
              approve: true,
              decision: 'approve_with_edits',
              editedNewString: JSON.stringify(answers),
            });
            useChatStore.getState().resolvePermission(chatId, requestId, 'approve', answers);
          }}
          onCancel={(requestId) => {
            permissionDeliveryTracker.send({
              type: 'chat.permission_response',
              chatId,
              requestId,
              approve: false,
            });
            useChatStore.getState().resolvePermission(chatId, requestId, 'deny');
          }}
        />
      );
    }
    // An ANSWERED request is history, not a prompt (spec/15 § Chat detail): it
    // drops the amber waiting treatment for the quiet card the rest of the
    // transcript's furniture uses, and the options go entirely — a second tap
    // would send a duplicate response for a requestId the host has already
    // resolved.
    const resolved = entry.permissionResolved;
    return (
      <View
        testID={resolved ? 'permission-resolved' : 'permission'}
        style={{
          backgroundColor: resolved ? colors.bgSoft : colors.waitingTint,
          padding: space.md,
          borderRadius: radii.lg,
          marginBottom: space.sm,
          borderWidth: 1,
          borderColor: resolved ? colors.lineSoft : colors.amber,
        }}
      >
        <Text style={{ fontFamily: fonts.bodyBold, color: resolved ? colors.ink2 : colors.ink }}>
          Permission needed: {entry.tool}
        </Text>
        {entry.permissionDescription ? (
          <Text style={{ color: resolved ? colors.ink3 : colors.ink2, marginTop: 4 }}>
            {entry.permissionDescription}
          </Text>
        ) : null}
        {resolved ? (
          <Text
            testID="permission-outcome"
            style={{ ...typography.meta, color: colors.ink3, marginTop: space.sm }}
          >
            {resolved === 'approve'
              ? entry.permissionCancelled
                ? 'Approved, cancelled by interrupt'
                : 'Approved'
              : 'Denied'}
          </Text>
        ) : (
          <View style={{ flexDirection: 'column', marginTop: space.sm }}>
            {(
              [
                { key: 'approve', label: '1. Yes', approve: true },
                {
                  key: 'approve_session',
                  // KNOWN-GAP (group 22): wire schema's PermissionDecision
                  // enum doesn't yet include `approve_with_session_allow`.
                  // Until that lands we map to plain `approve`. Text mirrors
                  // Claude Code's exact option 2 wording (spec/15 ## Chat detail).
                  label: `2. Yes, allow all ${entry.tool ?? 'tools'} during this session`,
                  approve: true,
                },
                { key: 'deny', label: '3. No, tell Claude what to do differently', approve: false },
              ] as const
            ).map((opt) => (
              <Pressable
                key={opt.key}
                onPress={() => {
                  if (!entry.requestId) return;
                  permissionDeliveryTracker.send({
                    type: 'chat.permission_response',
                    requestId: entry.requestId,
                    approve: opt.approve,
                    decision: opt.approve ? 'approve' : 'deny',
                  });
                  // Answer the card here rather than waiting for the host's
                  // echo: the round trip is over the network, and until it lands
                  // the options are still tappable.
                  useChatStore
                    .getState()
                    .resolvePermission(chatId, entry.requestId, opt.approve ? 'approve' : 'deny');
                }}
                style={{
                  backgroundColor: opt.approve ? colors.leaf : colors.paperRaised,
                  borderWidth: 1,
                  borderColor: opt.approve ? colors.leaf : colors.divider,
                  paddingVertical: space.md,
                  paddingHorizontal: space.md,
                  borderRadius: radii.md,
                  marginTop: space.sm,
                }}
              >
                <Text
                  style={{ ...typography.label, color: opt.approve ? colors.onAccent : colors.ink }}
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    );
  }
  return null;
});

// Inline attachments carried by a user turn (spec/15 § Composer). Images render
// as pictures that open an IN-APP pinch-zoomable viewer (never a browser tab);
// other files as tappable chips (open the served copy). The URL is built from
// the chatId + ref id, so a persisted message and an optimistic echo render
// identically. A turn sent from this phone passes its LOCAL files instead
// (drawn from their `uri`) plus, once they have uploaded, the matching `refs`
// (index for index): an image keeps showing the local copy, a file chip opens
// the served copy — and does nothing until there is one.
function MessageAttachments({
  chatId,
  attachments,
  refs,
  onGreen,
}: {
  chatId: string;
  attachments: AttachmentRef[] | LocalAttachment[];
  refs?: AttachmentRef[];
  onGreen: boolean;
}): React.ReactElement {
  const colors = useTheme();
  const chipFg = onGreen ? colors.onAccent : colors.ink2;
  const [viewer, setViewer] = React.useState<{ url: string; name: string } | null>(null);
  const served = (ref: AttachmentRef): string =>
    apiUrl(`/api/chats/${encodeURIComponent(chatId)}/attachment/${encodeURIComponent(ref.id)}`);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs }}>
      {attachments.map((att: AttachmentRef | LocalAttachment, i) => {
        const ref = 'uri' in att ? refs?.[i] : att;
        const itemKey = `${i}-${att.name}`;
        if (att.kind === 'image') {
          const url = 'uri' in att ? att.uri : served(att);
          return (
            <Pressable
              key={itemKey}
              onPress={() => setViewer({ url, name: att.name })}
              accessibilityRole="imagebutton"
              accessibilityLabel={`View ${att.name}`}
            >
              <ServedImage
                url={url}
                style={{ width: 180, height: 180, borderRadius: radii.sm }}
                resizeMode="cover"
                accessibilityLabel={att.name}
              />
            </Pressable>
          );
        }
        return (
          <Pressable
            key={itemKey}
            disabled={ref === undefined}
            onPress={() => {
              if (ref !== undefined) openServed(served(ref), att.name);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              paddingHorizontal: space.sm,
              paddingVertical: 6,
              borderRadius: radii.sm,
              borderWidth: 1,
              borderColor: onGreen ? colors.onAccentLine : colors.divider,
            }}
            accessibilityRole="link"
            accessibilityLabel={att.name}
          >
            <FileText size={14} color={chipFg} />
            <Text numberOfLines={1} style={{ color: chipFg, fontSize: 13, maxWidth: 200 }}>
              {att.name}
            </Text>
          </Pressable>
        );
      })}
      {viewer ? (
        <ZoomableImageViewer url={viewer.url} name={viewer.name} onClose={() => setViewer(null)} />
      ) : null}
    </View>
  );
}

// Full-screen, pinch-zoomable image viewer rendered INSIDE the app (spec/15 §
// Composer — "tapping an image opens an in-app zoomable viewer, never a browser
// tab"). A single PanResponder drives a tiny two-finger pinch (scale) + drag
// (pan) gesture on an Animated.Image; a double-tap resets. No native gesture
// dep — react-native's PanResponder + Animated only.
function ZoomableImageViewer({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}): React.ReactElement {
  const { width, height } = Dimensions.get('window');
  const { uri: shown } = useLocalUri(url);
  const scale = React.useRef(new Animated.Value(1)).current;
  const translateX = React.useRef(new Animated.Value(0)).current;
  const translateY = React.useRef(new Animated.Value(0)).current;

  // Gesture bookkeeping kept in refs (PanResponder callbacks close over them).
  const g = React.useRef({
    baseScale: 1,
    curScale: 1,
    baseX: 0,
    baseY: 0,
    curX: 0,
    curY: 0,
    startDist: 0,
    lastTap: 0,
  }).current;

  const reset = React.useCallback(() => {
    g.baseScale = 1;
    g.curScale = 1;
    g.baseX = 0;
    g.baseY = 0;
    g.curX = 0;
    g.curY = 0;
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  }, [g, scale, translateX, translateY]);

  const responder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const touches = e.nativeEvent.touches;
        if (touches.length < 2) {
          // Track double-tap to reset zoom.
          const now = Date.now();
          if (now - g.lastTap < 300) reset();
          g.lastTap = now;
        }
        g.startDist = 0;
      },
      onPanResponderMove: (e, gesture) => {
        const touches = e.nativeEvent.touches;
        const t0 = touches[0];
        const t1 = touches[1];
        if (touches.length >= 2 && t0 && t1) {
          // Pinch: scale by the change in finger distance.
          const dx = t0.pageX - t1.pageX;
          const dy = t0.pageY - t1.pageY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (g.startDist === 0) g.startDist = dist;
          const next = Math.min(6, Math.max(1, (g.baseScale * dist) / g.startDist));
          g.curScale = next;
          scale.setValue(next);
        } else if (g.curScale > 1) {
          // Pan (only meaningful when zoomed in).
          g.curX = g.baseX + gesture.dx;
          g.curY = g.baseY + gesture.dy;
          translateX.setValue(g.curX);
          translateY.setValue(g.curY);
        }
      },
      onPanResponderRelease: () => {
        g.baseScale = g.curScale;
        g.baseX = g.curX;
        g.baseY = g.curY;
        if (g.curScale <= 1) reset();
      },
    }),
  ).current;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: fixed.lightbox }}>
        <View style={{ flex: 1 }} {...responder.panHandlers}>
          {shown ? (
            <Animated.Image
              source={{ uri: shown }}
              resizeMode="contain"
              accessibilityLabel={name}
              style={{
                width,
                height,
                transform: [{ scale }, { translateX }, { translateY }],
              }}
            />
          ) : null}
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close image viewer"
          hitSlop={12}
          style={{
            position: 'absolute',
            top: 48,
            right: 20,
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: fixed.backdrop,
          }}
        >
          <X size={24} color={fixed.onShade} />
        </Pressable>
      </View>
    </Modal>
  );
}
