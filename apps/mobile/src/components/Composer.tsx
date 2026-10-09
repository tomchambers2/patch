// Chat-detail composer: multi-line text input + attach + mic + send.
//
// The mic DICTATES into this composer's own text input (spec/07 § "Dictation
// into the composer"): tap toggles recording, press-and-hold is hold-to-talk.
// Either way, the recognised text lands in the draft, editable, and is NEVER
// auto-sent — there is no overlay, matching web/desktop's composer mic. This
// is distinct from a voice NOTE (chat-row long-press, Voice tab, Manager row),
// which auto-sends as a new chat turn via the VoiceNoteOverlay (lib/voiceNote.ts)
// — the composer mic does not use that path at all. Starting a sustained voice
// CALL is a separate control (the phone icon in the chat-detail header).
//
// LIVE DICTATION (Todoist 6hHGqGVpJqfcXPmm — "voice message on mobile should
// show live transcription inside the text input"): while recording, the
// interim transcript (`lib/dictation.ts`, fed by the host's
// `audio.transcript_partial`) renders inside the input in grey, updating live
// as the user talks. Send while dictating ends it and sends typed + heard.
// On gesture-end it is replaced by the committed draft text — editable and
// sendable like anything else typed. Starting a dictation puts the keyboard
// away (there is nothing to type while talking) and a listening strip above
// the input names the state and counts the time. A Clear (✕) button appears AFTER the mic (never
// before it — the mic keeps its fixed slot, Todoist 6hf6qmQc4RPxX25c) while a
// dictation is in flight to discard it without transcribing (`lib/dictation.ts`
// `finish(false)`) — read that file's header before touching this: the whole
// point of its design is that a fast tap/hold-release NEVER silently drops the
// note, unlike the reverted streaming attempt it replaces.
//
// A hold session ends on a genuine finger LIFT, and the commit therefore hangs
// off `onTouchEnd`/`onTouchCancel` — the raw View touch events, which
// Pressability does not claim — NOT off `onPressOut`. React Native fires
// `onPressOut` on LEAVE_PRESS_RECT as well as on release
// (`Pressability.js`: RESPONDER_ACTIVE_LONG_PRESS_IN + LEAVE_PRESS_RECT ->
// ..._OUT -> `_deactivate` -> onPressOut), so a few px of finger drift on a
// 44px button — or this composer growing under the finger the moment the
// dictation preview appears — used to commit the clip half a second in, mid
// word, with no feedback whatsoever. Do not put the commit back on
// `onPressOut`.
//
// And a dictation that yields no text always SAYS so, naming which of the
// three things happened (nothing captured / too short / no speech heard). An
// empty result used to be a silent no-op, which is why the only bug report it
// ever produced was the word "broken".
//
// Attachments (spec/15 § Composer — "Attachments (images + files)"): three
// clear buttons — a camera icon takes a photo now, an image icon opens the
// photo library, the paperclip opens the OS file picker (any type). There is
// NO dedicated paste button. Paste is the input's own: long-press → Paste puts
// text in as plain text, and an image on the clipboard — or one a keyboard
// inserts (Gboard GIFs, stickers) — is attached like a picked one, through the
// PatchPaste native module's image listener on the input (lib/nativePaste.ts).
// Attached images are DOWNSCALED/compressed before upload (longest
// edge ~1568px, JPEG) so they're within Claude's vision limits. Attachments add
// removable thumbnails above the input that upload with the message on send and
// render inline in the stream (tapping an image opens an in-app zoomable
// viewer). Sending with attachments reacts at once, exactly like a text send:
// the composer clears and the message appears in the stream straight away,
// drawn from the local files and marked `Uploading 1/3` until every upload has
// landed, and only then is the turn sent. The upload pipeline — ordering,
// failure (`Not uploaded`, Retry / ×) and all — lives in lib/sendQueue.ts, not
// here, so it survives this composer unmounting.
//
// The action row, left to right (spec/15 § Composer — Tom's layout):
//   [camera][image][file][mic] … [model pill][padlock][Send | Stop]
// The model pill names the model the NEXT message runs on and changes it with
// the same `chat.model_request` web's header crumb sends. The padlock is the
// chat's permission mode — its icon says which mode, bypass is an open lock in
// the danger colour — and opens the mode list, greying out modes the chat's
// model cannot run (web's `permissionModesFor` rule). While a turn is running
// an EMPTY composer's Send becomes Stop (`chat.stop_request`, as web's stop
// button); typing brings Send back, and that send is QUEUED by the host behind
// the running turn exactly as a web send mid-turn is. On a 360dp phone the
// pill is the one control that shrinks, so Send/Stop is never pushed off.
//
// Send + mic are daemon-dependent controls (spec/12 § Daemon-offline UX): when
// the WS is down or the host is offline they render visibly disabled with a
// reason that names the cause — never a dead button, never a silent no-op.

import React from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Mic,
  ArrowUp,
  Paperclip,
  Image as ImageIcon,
  Camera,
  X,
  FileText,
  Square,
  Lock,
  LockOpen,
  FilePen,
  ClipboardList,
  Sparkles,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { harnessForModel, type PermissionMode } from '@patch/wire';
import { AnchoredMenu } from './AnchoredMenu';
import { ModelPicker } from './ModelPicker';
import { ProviderSwitchModal } from './ProviderSwitchModal';
import { suppressProviderSwitchWarningOrFalse } from '../lib/preferences';
import { useSettingsStore } from '../stores/settingsStore';
import {
  PERMISSION_MODE_ORDER,
  offeredPermissionModes,
  permissionModeLabel,
} from '../lib/permissionModes';
import { receiveImagePaste } from '../lib/nativePaste';
import * as FileSystem from 'expo-file-system';
import { extractLongPaste, pastedTextName } from '../lib/longPaste';
import {
  filterSkills,
  activeSlashToken,
  findChipTokens,
  chipEndingAt,
  spliceCompletion,
  type ChipToken,
} from '../lib/skillAutocomplete';
import { SkillPreviewSheet } from './SkillPreviewSheet';
import { getLastUsedSkill, setLastUsedSkill, orderSkillsByLastUsed } from '../lib/lastUsedSkill';
import { getComposerDraft, setComposerDraft, useComposerDraftStore } from '../lib/composerDraft';
import { radii, space, typography, useTheme } from '../lib/theme';
import { getWs } from '../api/ws';
import { api } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT } from '../lib/composerHeight';
import { startDictation, warmDictation, type DictationHandle } from '../lib/dictation';
import { voiceKeyRefusal } from '../lib/voiceKeys';
import { usePresenceStore } from '../stores/presenceStore';
import { daemonControlsDisabled, daemonControlDisabledReason } from '../lib/connection';
import { sendMessage } from '../lib/sendQueue';
import { formatElapsed } from '../lib/callStatus';
import { StatusDot, useNow } from './CallParts';
import {
  NO_ATTACHMENTS,
  attachmentKindForMime,
  newAttachmentKey,
  useComposerAttachmentStore,
  type PendingAttachment,
} from '../stores/composerAttachmentStore';

interface Props {
  chatId: string;
  /** Put the cursor in the input on mount (spec/15 § Composer — opening a chat). */
  autoFocus?: boolean;
  /** The chat's folder — sources the skill autocomplete (`/` menu). */
  folder?: string;
  /** Test seam: inject a dictation-session factory in place of `lib/dictation`. */
  dictationFactory?: typeof startDictation;
  /**
   * The new-chat screen's composer (spec/15 § New chat flow): `chatId` is then
   * only the draft key, and the chat to send into is resolved on send — the
   * screen creates it (or hands back the one it already created). `null` means
   * it could not, and the screen has already said why: the text and the
   * attachments stay put for a retry.
   */
  sendTarget?(): Promise<string | null>;
  /** A send into `chatId` went out (echoed; delivery follows its uploads). */
  onSent?(chatId: string): void;
}

// One glyph size across the action buttons so they read as a matched set and
// the mic is optically centred against its sibling (spec item 1). 36, not 40:
// the row carries seven controls now, and on a 360dp phone every 4px of each
// is width the model pill needs; the hit slop below keeps the touch target
// bigger than the drawn button.
const ICON_SIZE = 20;
const ACTION_SIZE = 36;
/** Extra touchable margin around the mic/attach targets. */
const MIC_HIT_SLOP = 12;
// Send/Stop are the only action-row controls that paint a filled circle
// rather than an outline glyph, so at the shared 36px token they read heavier
// than their neighbours (Todoist 6hf2JM6695c7rhJ6 — "looks big even if it
// isn't"). Paint the circle smaller and make up the difference in hit slop,
// so the touch target still matches every other 36px control in the row.
const SEND_STOP_VISUAL_SIZE = 30;
const SEND_STOP_HIT_SLOP = (ACTION_SIZE - SEND_STOP_VISUAL_SIZE) / 2;
const SEND_ICON_SIZE = 18;
const STOP_ICON_SIZE = 14;
/** How long a send holds the busy styling waiting for the host to confirm
 * the turn as running, before it gives up and settles (see `pendingSend`). */
export const PENDING_SEND_TIMEOUT_MS = 5000;
/**
 * How far the finger may wander during a press before React Native calls the
 * press rect left. Deliberately far wider than the button: a hold-to-talk
 * gesture lasts as long as a sentence, and the finger WILL move over that
 * time. Keeping the press rect generous means Pressability never declares a
 * LEAVE_PRESS_RECT mid-hold, so the pressed styling doesn't flicker either.
 */
const MIC_PRESS_RETENTION = 80;

/**
 * How long the pill waits for the host to confirm a model change before it
 * says the switch did not happen — web's `MODEL_CONFIRM_TIMEOUT_MS`, for the
 * same reason: a host too old to know `chat.model_request` never answers, and
 * a pill left naming a model the chat is not on is a silent failure.
 */
export const MODEL_CONFIRM_TIMEOUT_MS = 8000;

/** The padlock's glyph for each mode: what the next turn is allowed to do. */
export function permissionModeIcon(mode: PermissionMode | string): typeof Lock {
  switch (mode) {
    case 'acceptEdits':
      return FilePen;
    case 'plan':
      return ClipboardList;
    case 'auto':
      return Sparkles;
    case 'bypassPermissions':
      return LockOpen;
    default:
      return Lock;
  }
}

const kindForMime = attachmentKindForMime;
const newKey = newAttachmentKey;

export function Composer({
  chatId,
  folder,
  dictationFactory,
  sendTarget,
  onSent,
  autoFocus,
}: Props): React.ReactElement {
  const colors = useTheme();
  // spec/15 § Composer — unsent text belongs to the chat it was typed in, so it
  // is seeded from that chat's stored draft and written back as it is typed.
  const [draft, setDraft] = React.useState(() => getComposerDraft(chatId));
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  // Persist SYNCHRONOUSLY with the state update rather than from an effect: an
  // effect keyed on [chatId, draft] fires once with the new chatId and the
  // previous chat's text still in state, writing chat A's draft onto chat B.
  const updateDraft = React.useCallback(
    (next: string | ((cur: string) => string)): void => {
      const value = typeof next === 'function' ? next(draftRef.current) : next;
      draftRef.current = value;
      setDraft(value);
      setComposerDraft(chatId, value);
    },
    [chatId],
  );
  // Re-seed if this composer is reused for a different chat (the screen is not
  // guaranteed to remount). Never writes, so it cannot cross-contaminate.
  React.useEffect(() => {
    const stored = getComposerDraft(chatId);
    draftRef.current = stored;
    setDraft(stored);
  }, [chatId]);
  // Text put into this chat's draft from OUTSIDE the composer (a queued-message
  // edit that lost the race, spec/04 § Edit) shows up here unless the user is
  // typing — a focused composer is never overwritten under the cursor.
  // Subscribed imperatively: a hook selector re-rendered the composer on the
  // echo of every keystroke's own write to this store.
  React.useEffect(() => {
    const apply = (): void => {
      const stored = useComposerDraftStore.getState().drafts[chatId] ?? '';
      if (stored === draftRef.current) return;
      if (useComposerDraftStore.getState().focused[chatId]) return;
      draftRef.current = stored;
      setDraft(stored);
    };
    apply();
    return useComposerDraftStore.subscribe(apply);
  }, [chatId]);
  // Held per draft key in a store rather than here, so the share sheet can
  // drop a shared file into this composer (spec/15 § Share into Patch).
  const attachments = useComposerAttachmentStore((s) => s.byKey[chatId] ?? NO_ATTACHMENTS);
  // This chat's row — the mode, model, host and activity the controls on the
  // right of the action row read, and the host the skill list below is fetched
  // from. Undefined until the roster or the stream has named the chat; the
  // pill and padlock are on screen regardless (the options under the input are
  // always available) but read empty until then rather than inventing a model
  // or a mode nobody set. Only the new-chat screen (`sendTarget`) omits them —
  // its setup rows above own the choice.
  const row = useChatStore((s) => s.chats[chatId]);
  // A new-chat send waiting on the chat to be created (`sendTarget`). Holds the
  // send button busy — a spinner in the active colour, so the tap visibly did
  // something. Attachment uploads never hold the composer: the message is in
  // the stream, counting them, the moment Send is pressed (lib/sendQueue.ts).
  const [resolving, setResolving] = React.useState(false);
  // A send into an existing chat clears the draft synchronously, but the host
  // confirming the turn as `running` — what lets Stop take over — arrives a
  // moment later over the socket. Without this, that gap reads as the send
  // button going dead (Todoist 6hf2JM6695c7rhJ6): empty draft + not yet
  // running looks identical to nothing-to-send. Holds the busy styling across
  // that gap, bounded so a send that never gets a `running` back (an offline
  // queue) still settles instead of spinning forever.
  const [pendingSend, setPendingSend] = React.useState(false);
  const pendingSendTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingSendTimeout = (): void => {
    if (pendingSendTimeoutRef.current !== null) {
      clearTimeout(pendingSendTimeoutRef.current);
      pendingSendTimeoutRef.current = null;
    }
  };
  React.useEffect(() => () => clearPendingSendTimeout(), []);

  // Skill autocomplete (spec/15 § Composer): typing `/` opens a list of the
  // folder's skills, filtered as you type, anywhere in the draft it begins a
  // word — not only when the draft is nothing else. Active only while the
  // token AT THE CURSOR is still open (no closing space yet); tap a row to
  // complete. Skills come from `api.skills(folder)`.
  const [skills, setSkills] = React.useState<string[]>([]);
  const [skillDescriptions, setSkillDescriptions] = React.useState<Record<string, string>>({});
  const [skillFrontmatter, setSkillFrontmatter] = React.useState<
    Record<string, Record<string, string>>
  >({});
  const [skillPaths, setSkillPaths] = React.useState<Record<string, string>>({});
  // Where the cursor sits, kept in sync via the TextInput's own
  // `onSelectionChange` — needed to tell which token (if any) the cursor is
  // currently in, wherever in the draft that is.
  // Paired with the text it was measured against: `updateDraft` and
  // `setCursorState` are two separate `setState` calls from the same
  // handler, and this test renderer (unlike a real device) does not always
  // commit them in the same pass — a render can briefly see the NEW draft
  // with the OLD cursor position. Deriving `cursorPos` with a fallback to
  // "end of the current draft" whenever the pairing is stale makes that
  // window harmless instead of transiently misreading `slashActive` (which
  // used to let the chip-priming background fetch fire a beat early, on a
  // stale false, stealing the call a mocked test's `mockImplementationOnce`
  // meant for the real one).
  const [cursorState, setCursorState] = React.useState({ text: '', pos: 0 });
  const cursorPos = cursorState.text === draft ? cursorState.pos : draft.length;
  // Only `cursorPos` (the selection START) drives rendering/menu state; the
  // END is only needed to tell a collapsed cursor from a real selection for
  // the Backspace-removes-a-chip gesture, so it's a plain ref.
  const selectionEndRef = React.useRef(0);
  const activeToken = activeSlashToken(draft, cursorPos);
  const slashQuery = activeToken?.query ?? null;
  const slashActive = activeToken !== null;
  const trimmedFolder = (folder ?? '').trim();
  React.useEffect(() => {
    // Re-read on EVERY open, not once per folder: the list lives on the host's
    // filesystem and changes there must show up on the next `/`. Typing more of
    // the query does not refetch (`slashQuery` is not a dependency), and the
    // last loaded list stays on screen while the new one is in flight. NO
    // FALLBACK: a failed fetch surfaces an error rather than a silently empty
    // list.
    if (!slashActive || trimmedFolder === '' || !row?.daemonId) return;
    let live = true;
    void api
      .skills(trimmedFolder, row.daemonId)
      .then((r) => {
        if (!live) return;
        setSkills(r.skills ?? []);
        setSkillDescriptions(r.descriptions ?? {});
        setSkillFrontmatter(r.frontmatter ?? {});
        setSkillPaths(r.paths ?? {});
      })
      .catch((e) => {
        if (live) useUiStore.getState().pushError(`skills unavailable: ${(e as Error).message}`);
      });
    return () => {
      live = false;
    };
  }, [slashActive, trimmedFolder, row?.daemonId]);
  // spec/15 § Skill autocomplete — chips: a completed `/<skill>` must be
  // recognised (and rendered as a chip, with its preview reachable) even
  // before `/` has ever been opened this session — e.g. reopening a chat
  // whose draft already holds one. Primed in the background the first time
  // the draft contains a `/` at all, once per folder; skipped whenever
  // `slashActive` (the interactive fetch above already covers that open —
  // firing both on the very first `/` typed would double-fetch). Marked
  // "primed" only on SUCCESS: an attempt that gets superseded before it
  // resolves must not block a later, real one from ever trying (see
  // packages/web/src/components/Composer.tsx's identical guard for why).
  const chipFetchPrimedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (trimmedFolder === '' || slashActive || !row?.daemonId) return;
    if (chipFetchPrimedRef.current === trimmedFolder) return;
    if (!draft.includes('/')) return;
    let live = true;
    void api
      .skills(trimmedFolder, row.daemonId)
      .then((r) => {
        if (!live) return;
        chipFetchPrimedRef.current = trimmedFolder;
        setSkills(r.skills ?? []);
        setSkillDescriptions(r.descriptions ?? {});
        setSkillFrontmatter(r.frontmatter ?? {});
        setSkillPaths(r.paths ?? {});
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [trimmedFolder, draft, slashActive, row?.daemonId]);
  // The skill last completed in this folder sorts to the top (spec/15 § Skill
  // autocomplete) — ordering only, applied AFTER the typed prefix filter.
  const filteredSkills =
    slashQuery !== null
      ? orderSkillsByLastUsed(filterSkills(skills, slashQuery), getLastUsedSkill(trimmedFolder))
      : [];
  const showSkillMenu = slashActive && filteredSkills.length > 0;
  // Every name a chip can legitimately be. Mobile has no built-in slash
  // commands yet (spec/15 § Skill autocomplete lists none), so this is just
  // the folder's skills.
  const knownChipNames = React.useMemo(() => new Set(skills), [skills]);
  const chipTokens = React.useMemo(
    () => findChipTokens(draft, knownChipNames),
    [draft, knownChipNames],
  );
  const [previewSkill, setPreviewSkill] = React.useState<{
    name: string;
    description: string | undefined;
  } | null>(null);
  /** The draft text with every completed `/<skill>` swapped for a boxed,
   *  tappable chip (spec/15 § Skill autocomplete — tapping shows the same
   *  preview the `/` list would). */
  function renderChipMirror(): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    chipTokens.forEach((chip: ChipToken, i: number) => {
      if (chip.start > cursor) {
        nodes.push(<Text key={`t${i}`}>{draft.slice(cursor, chip.start)}</Text>);
      }
      nodes.push(
        <Text
          key={`c${i}`}
          testID="composer-chip"
          onPress={() =>
            setPreviewSkill({ name: chip.name, description: skillDescriptions[chip.name] })
          }
          style={{
            backgroundColor: colors.divider,
            color: colors.leaf,
            borderRadius: 4,
          }}
        >
          {`/${chip.name}`}
        </Text>,
      );
      cursor = chip.end;
    });
    if (cursor < draft.length) nodes.push(<Text key="tail">{draft.slice(cursor)}</Text>);
    return nodes;
  }
  const completeSkill = (name: string): void => {
    if (activeToken === null) return;
    const { text, cursor } = spliceCompletion(draft, activeToken.start, cursorPos, name);
    updateDraft(text);
    pendingCursorRef.current = cursor;
    // Remembered per folder so the next `/` defaults to it.
    setLastUsedSkill(trimmedFolder, name);
  };
  const conn = usePresenceStore((s) => s.connection);
  const daemon = usePresenceStore((s) => s.daemon);
  // Two distinct gates (spec/12 § Daemon-offline UX): text + send stay usable
  // whenever the WS link is up — a message sent while the host is offline is
  // QUEUED (buffered + tracked) and delivered on reconnect, never blocked.
  // Attach + voice DO require the host (an attachment must be stored on the
  // box; audio is real-time and can't be queued), so they gate on the host.
  const linkDown = conn !== 'connected';
  const disabled = daemonControlsDisabled(conn, daemon); // attach + voice
  const disabledReason = daemonControlDisabledReason(conn, daemon);
  const linkReason = linkDown ? daemonControlDisabledReason(conn, daemon) : null;

  const running = row?.activity === 'running';
  React.useEffect(() => {
    if (running) {
      clearPendingSendTimeout();
      setPendingSend(false);
    }
  }, [running]);
  const permissionMode = row?.permissionMode;
  const chatModel = row?.model ?? null;

  // Model pill (spec/15 § Composer — Model pill; parity with web's header
  // crumb, spec/14 § Model selector). A pick sends `chat.model_request` on the
  // socket; the host's answer is the `chat.state` that lands on `row.model`.
  // Until it lands the pill reads the pending pick, dimmed; if it never lands
  // the pill goes back and says so (NO FALLBACK).
  const [pendingModel, setPendingModel] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (pendingModel !== null && chatModel === pendingModel) setPendingModel(null);
  }, [pendingModel, chatModel]);
  React.useEffect(() => {
    if (pendingModel === null) return;
    const t = setTimeout(() => {
      setPendingModel(null);
      useUiStore
        .getState()
        .pushError(
          `the host did not switch the model — this chat is still on ${chatModel ?? 'its previous model'}`,
        );
    }, MODEL_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pendingModel, chatModel]);
  // spec/04 § History — a cross-provider switch may cost more (no cache to
  // resume from), so the picker confirms it first unless the account has
  // turned that off (Settings has a toggle to bring it back).
  const [providerSwitchTarget, setProviderSwitchTarget] = React.useState<string | null>(null);

  const sendModelChange = (modelId: string): void => {
    setPendingModel(modelId);
    getWs().send({ type: 'chat.model_request', chatId, model: modelId });
  };

  const chooseModel = (modelId: string): void => {
    if (modelId === (pendingModel ?? chatModel)) return;
    const crossProvider =
      chatModel !== null && harnessForModel(modelId) !== harnessForModel(chatModel);
    if (crossProvider && !suppressProviderSwitchWarningOrFalse()) {
      setProviderSwitchTarget(modelId);
      return;
    }
    sendModelChange(modelId);
  };

  // Padlock (spec/15 § Composer — Permission mode padlock): the mode list,
  // friendly names, modes the model cannot run greyed but still listed so the
  // user can see why they are not on offer. The mode in force is ticked.
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
  const offeredModes = offeredPermissionModes(chatModel);
  const modeItems = PERMISSION_MODE_ORDER.map((m) => ({
    id: m,
    label: permissionModeLabel(m),
    testID: `permission-mode-option-${m}`,
    disabled: !offeredModes.includes(m),
    selected: m === permissionMode,
    destructive: m === 'bypassPermissions',
  }));
  const onModeSelect = (id: string): void => {
    if (id === permissionMode) return;
    getWs().send({ type: 'chat.settings', chatId, permissionMode: id as PermissionMode });
  };
  const ModeIcon = permissionModeIcon(permissionMode ?? 'default');
  const bypass = permissionMode === 'bypassPermissions';

  // Stop (parity with web's stop button + Claude Code's interrupt): the host
  // closes the in-flight query and settles the chat to idle; anything queued
  // then drains as normal.
  const stopTurn = (): void => {
    clearPendingSendTimeout();
    setPendingSend(false);
    getWs().send({ type: 'chat.stop_request', chatId });
  };

  const inputRef = React.useRef<TextInput>(null);
  // A completion/backspace-chip-removal computes the new cursor position
  // itself, but can only apply it once the input actually holds the new text
  // — set here and consumed once `draft` next changes (see the effect below).
  const pendingCursorRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const pos = pendingCursorRef.current;
    if (pos === null) return;
    pendingCursorRef.current = null;
    // `setNativeProps` isn't implemented on the fake host instance the unit
    // tests render against — only imperative, so its absence is otherwise
    // harmless there (no real cursor to move).
    inputRef.current?.setNativeProps?.({ selection: { start: pos, end: pos } });
    setCursorState({ text: draft, pos });
    selectionEndRef.current = pos;
  }, [draft]);

  // Dictation (spec/07 § "Dictation into the composer"): the mic streams live
  // to the composer — the interim transcript renders inside the input
  // while recording (`livePartial` below), then lands in `draft`, editable, on
  // gesture-end. NO overlay screen — the input itself is the feedback, and
  // nothing here touches voiceStore (that store backs the OTHER voice-note
  // triggers, which DO auto-send + overlay). See `lib/dictation.ts` for the
  // capture/transport design and, critically, how it avoids the race that
  // sank the earlier streaming attempt.
  const [micState, setMicState] = React.useState<'idle' | 'recording' | 'transcribing'>('idle');
  // The live/interim transcript, shown inside the input while recording. Cleared the instant a dictation ends (commit or cancel) — the
  // committed text takes over `draft` instead.
  const [livePartial, setLivePartial] = React.useState('');
  // spec/15 § Skill autocomplete — chips: the mirror only needs to exist
  // while there's a chip to draw, and only when dictation isn't already using
  // the transparent-input trick for its own mirror — the two never overlap.
  const showChipMirror = !(micState !== 'idle' && livePartial.length > 0) && chipTokens.length > 0;
  // Send pressed while dictating: the dictation ends and, once its transcript
  // lands in the draft, the whole draft goes out as one message.
  const sendAfterDictationRef = React.useRef(false);
  // When the in-flight dictation started — the listening strip's timer.
  const [dictationStartedAt, setDictationStartedAt] = React.useState<number | null>(null);
  const dictationNow = useNow(micState === 'recording');
  const dictationRef = React.useRef<DictationHandle | null>(null);
  // Set the instant Clear is pressed so a partial/result already in flight (an
  // onPartial call, or `finish()` resolving) is dropped instead of reviving
  // the just-discarded dictation.
  const discardedRef = React.useRef(false);
  // Which gesture started the in-flight recording: only a `hold` commits on
  // release; a `tap` session needs a second tap (mirrors lib/voiceNote's
  // VoiceNoteMode split). A second gesture can only land once `micState` has
  // left `idle` (the mic Pressable's onPress/onLongPress read that state, see
  // below), so exactly one dictation is ever in flight — no generation
  // counter needed here (contrast lib/dictation.ts's OWN internal setup, which
  // guards its async continuations against a `finish()` that arrives first).
  const micModeRef = React.useRef<'hold' | 'tap'>('tap');
  // True from the moment a hold session starts until the finger genuinely
  // leaves the glass. Only a touch-end/touch-cancel clears it — see the
  // onPressOut note in this file's header.
  const holdTouchRef = React.useRef(false);

  // Resolve mic permission + the recording audio mode BEFORE the user ever
  // presses, so `startDictation` has nothing to await before the microphone
  // opens (lib/dictation.ts § TIMING). Rejections are not surfaced from here:
  // this is speculative work on a screen the user may never dictate from, and
  // the authoritative permission failure is reported by the press path.
  React.useEffect(() => {
    void warmDictation().catch(() => undefined);
  }, []);

  // Leaving the chat mid-dictation must release the microphone: a session
  // whose gesture never ends would otherwise hold it open for the app's life.
  React.useEffect(
    () => () => {
      const handle = dictationRef.current;
      dictationRef.current = null;
      if (handle) void handle.finish(false);
    },
    [],
  );

  function beginDictation(mode: 'hold' | 'tap'): void {
    // Dictation on a backend this chat's host has no key for is refused at the
    // press, not after the user has spoken (the host refuses it too).
    const refusal = voiceKeyRefusal(chatId, 'dictation');
    if (refusal !== null) {
      useUiStore.getState().pushError(`voice: ${refusal}`);
      return;
    }
    micModeRef.current = mode;
    discardedRef.current = false;
    // Dictating is talking, not typing: put the keyboard away so the listening
    // strip and the live words have the room (spec/07 § Dictation into the
    // composer). The input is not locked — tapping it brings the keyboard back.
    Keyboard.dismiss();
    inputRef.current?.blur();
    setLivePartial('');
    setDictationStartedAt(Date.now());
    setMicState('recording');
    const factory = dictationFactory ?? startDictation;
    dictationRef.current = factory(
      chatId,
      (text: string): void => {
        if (discardedRef.current) return;
        setLivePartial(text);
      },
      (message: string): void => {
        if (discardedRef.current) return;
        dictationRef.current = null;
        setMicState('idle');
        setLivePartial('');
        useUiStore.getState().pushError(`voice: ${message}`);
      },
    );
  }

  async function commitDictation(): Promise<void> {
    const handle = dictationRef.current;
    dictationRef.current = null;
    if (!handle) {
      setMicState('idle');
      setLivePartial('');
      return;
    }
    setMicState('transcribing');
    try {
      const outcome = await handle.finish(true);
      if (discardedRef.current) return; // Clear was pressed while the upload was in flight.
      // Every no-text outcome names its own cause. NO FALLBACK: none of them
      // is allowed to be a silent no-op, because a dictation that appears to
      // do nothing is indistinguishable from a broken microphone.
      switch (outcome.kind) {
        case 'text': {
          // Append into the composer's own draft, editable before send —
          // never auto-sent (spec/07 § "Dictation into the composer").
          // The keyboard stays down: the words are ready to send as they
          // are, and a tap on the input brings it back to edit them.
          const t = outcome.text;
          updateDraft((cur) => (cur.trim().length > 0 ? `${cur.trimEnd()} ${t}` : t));
          break;
        }
        case 'no-audio':
          useUiStore.getState().pushError('voice: nothing recorded — the mic never started');
          break;
        case 'too-short':
          useUiStore
            .getState()
            .pushError(`voice: too short to transcribe (${(outcome.ms / 1000).toFixed(1)}s)`);
          break;
        case 'no-speech':
          useUiStore.getState().pushError('voice: no speech recognised');
          break;
        // Only reachable if the session had already been finished elsewhere:
        // nothing to land and nothing to report.
        case 'discarded':
          break;
      }
      if (sendAfterDictationRef.current) {
        sendAfterDictationRef.current = false;
        // Whatever is in the box now — typed text plus anything just heard.
        // A no-text outcome has already said why above.
        submitRef.current();
      }
    } catch (e) {
      sendAfterDictationRef.current = false;
      useUiStore.getState().pushError(`voice transcription failed: ${(e as Error).message}`);
    } finally {
      if (!discardedRef.current) {
        setMicState('idle');
        setLivePartial('');
      }
    }
  }

  /**
   * End a hold-to-talk dictation. Called from the mic's `onTouchEnd` /
   * `onTouchCancel` — a real ACTION_UP or ACTION_CANCEL — never from
   * `onPressOut`, which also fires on a drift-out (see this file's header).
   * A cancel commits rather than discards: the words are already captured and
   * dictation only ever lands editable text in the draft, so throwing them
   * away would lose real speech for nothing.
   */
  function endHoldGesture(): void {
    if (!holdTouchRef.current) return;
    holdTouchRef.current = false;
    if (micModeRef.current !== 'hold') return;
    if (dictationRef.current === null) return;
    void commitDictation();
  }

  /** Discard the in-flight dictation (Clear button) — never lands any text. */
  function cancelDictation(): void {
    sendAfterDictationRef.current = false;
    discardedRef.current = true;
    holdTouchRef.current = false;
    const handle = dictationRef.current;
    dictationRef.current = null;
    setMicState('idle');
    setLivePartial('');
    if (handle) void handle.finish(false);
  }

  const addAttachment = (a: PendingAttachment): void => {
    useComposerAttachmentStore.getState().add(chatId, [a]);
  };
  const removeAttachment = (key: string): void => {
    useComposerAttachmentStore.getState().remove(chatId, key);
  };

  // Image button → photo library. NO FALLBACK: a denied permission surfaces an
  // error rather than silently doing nothing.
  const pickImage = async (): Promise<void> => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) throw new Error('photo library permission denied');
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        // Multi-select (spec/15 § Composer): a phone pick is a whole trip
        // through the OS picker, so one trip must be able to bring back every
        // image the user wants — never one-per-tap.
        allowsMultipleSelection: true,
      });
      if (res.canceled) return;
      for (const asset of res.assets) {
        const mimeType = asset.mimeType ?? 'image/jpeg';
        addAttachment({
          key: newKey(),
          uri: asset.uri,
          name: asset.fileName ?? `image-${Date.now()}.jpg`,
          mimeType,
          kind: 'image',
          width: asset.width,
          height: asset.height,
        });
      }
    } catch (e) {
      useUiStore.getState().pushError(`attach image failed: ${(e as Error).message}`);
    }
  };

  // Camera button → take a photo NOW (spec/15 § Composer). One tap, not a
  // hidden long-press: on a phone the thing you want to send often doesn't
  // exist yet. The capture is an ordinary image attachment from here on — same
  // chip, same downscale, same upload. NO FALLBACK: a denied camera permission
  // surfaces an error rather than silently doing nothing.
  const takePhoto = async (): Promise<void> => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) throw new Error('camera permission denied');
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
      });
      if (res.canceled) return;
      for (const asset of res.assets) {
        addAttachment({
          key: newKey(),
          uri: asset.uri,
          name: asset.fileName ?? `photo-${Date.now()}.jpg`,
          mimeType: asset.mimeType ?? 'image/jpeg',
          kind: 'image',
          width: asset.width,
          height: asset.height,
        });
      }
    } catch (e) {
      useUiStore.getState().pushError(`take photo failed: ${(e as Error).message}`);
    }
  };

  // A long text paste is saved to a cache file and attached like a picked file.
  // NO FALLBACK: a failed write surfaces an error and the pasted text is lost
  // from the input only because the write was refused — never silently.
  const attachPastedText = async (inserted: string): Promise<void> => {
    try {
      const uri = `${FileSystem.cacheDirectory}pasted-text-${Date.now()}.md`;
      await FileSystem.writeAsStringAsync(uri, inserted, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      addAttachment({
        key: newKey(),
        uri,
        name: pastedTextName(inserted),
        mimeType: 'text/markdown',
        kind: 'file',
      });
    } catch (e) {
      useUiStore.getState().pushError(`attach pasted text failed: ${(e as Error).message}`);
    }
  };

  // Paperclip button → OS file picker (any type).
  const pickDocument = async (): Promise<void> => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        // ANY type, stated explicitly (spec/15 § Composer — "Attaching is never
        // limited to photos"), and multi-select for the same reason as the
        // image picker. `copyToCacheDirectory` gives the upload a readable
        // local file even when the pick came from a cloud provider (Drive).
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      for (const asset of res.assets) {
        const mimeType = asset.mimeType ?? 'application/octet-stream';
        addAttachment({
          key: newKey(),
          uri: asset.uri,
          name: asset.name,
          mimeType,
          kind: kindForMime(mimeType),
        });
      }
    } catch (e) {
      useUiStore.getState().pushError(`attach file failed: ${(e as Error).message}`);
    }
  };

  // Image paste (spec/15 § Composer — "Paste"): long-press → Paste of an image,
  // or a keyboard's image insertion, lands here through the PatchPaste native
  // listener on the input and is attached like a picked image. Text paste
  // never reaches this — the input pastes it as plain text itself.
  React.useEffect(
    () =>
      receiveImagePaste(inputRef.current, {
        onImages: (files) => {
          for (const f of files) {
            addAttachment({
              key: newKey(),
              uri: f.uri,
              name: f.name,
              mimeType: f.mimeType,
              kind: 'image',
              width: f.width,
              height: f.height,
            });
          }
        },
        onError: (message) => useUiStore.getState().pushError(message),
      }),
    // addAttachment closes over chatId only.
    [chatId],
  );

  // Echo + send (spec/15 § Composer → Attachments): the message is in the
  // stream at once — attachments from their local copies, uploading — and the
  // composer clears. lib/sendQueue.ts uploads and delivers it, in send order.
  const sendNow = (target: string, text: string, pending: PendingAttachment[]): void => {
    sendMessage(target, text, pending);
    if (pending.length > 0) useComposerAttachmentStore.getState().clear(chatId);
    updateDraft('');
  };

  const submit = (): void => {
    // Send while dictating ends the dictation and sends it with anything
    // typed; mid-transcription it waits for the words to land.
    if (micState !== 'idle') {
      sendAfterDictationRef.current = true;
      holdTouchRef.current = false;
      if (micState === 'recording') void commitDictation();
      return;
    }
    sendDraft();
  };

  const sendDraft = (): void => {
    if (resolving) return;
    // No `linkDown` guard: sending into an existing chat while the link is
    // down queues + flushes on reconnect (Todoist 6hWrcpCQFqXGJpF6; spec/12 §
    // Surface → server disconnect — deliveryTracker already retries
    // regardless of why a send failed).
    // The ref, not state: a dictated send lands its words in the same tick.
    const text = draftRef.current.trim();
    if (!text && attachments.length === 0) return;
    const pending = attachments;

    // New chat (spec/15 § New chat flow): the chat is created by this first
    // send, so resolve it before anything is uploaded or echoed — an upload
    // needs a real chatId, never the draft key. Once it exists the send is
    // the ordinary one, and the screen moves on without waiting for uploads.
    if (sendTarget !== undefined) {
      setResolving(true);
      void (async () => {
        let target: string | null = null;
        try {
          target = await sendTarget();
        } catch (e) {
          useUiStore.getState().pushError(`failed to create chat: ${(e as Error).message}`);
        } finally {
          setResolving(false);
        }
        if (target === null) return;
        sendNow(target, text, pending);
        onSent?.(target);
      })();
      return;
    }

    // Hold the busy styling until the host confirms the turn as running —
    // bounded, so a send that never gets that back (e.g. queued while
    // offline) still settles rather than spinning forever. Only for a plain
    // send: one with an attachment already gets its own "did this land"
    // feedback from the message's `Uploading` status in the stream.
    if (!running && pending.length === 0) {
      clearPendingSendTimeout();
      setPendingSend(true);
      pendingSendTimeoutRef.current = setTimeout(
        () => setPendingSend(false),
        PENDING_SEND_TIMEOUT_MS,
      );
    }
    sendNow(chatId, text, pending);
  };

  // Send stays enabled whether it's the host or the LINK itself that's
  // down — either way the message queues and delivers on reconnect (spec/12
  // § Host-offline UX + Surface → server disconnect; Todoist
  // 6hWrcpCQFqXGJpF6). Attach/voice gate on the host (`disabled`) and, via
  // `linkReason`, on the link too — they have nothing to queue into.
  // The dictation commit submits after an await; it must use this render's
  // attachments and chat state, not the ones from when it began.
  const submitRef = React.useRef(sendDraft);
  submitRef.current = sendDraft;

  const sendDisabled =
    resolving || (draft.trim().length === 0 && attachments.length === 0 && micState === 'idle');

  // Un-pressable and DEAD are different things. A send held open while the
  // new chat is created — or by `pendingSend` waiting on the host to confirm
  // the turn — keeps the active leaf colour and swaps its arrow for a
  // spinner, so the tap visibly did something; only a genuinely unavailable
  // send greys out.
  const sendBusy = resolving || pendingSend;
  const sendLooksInactive = sendDisabled && !sendBusy;

  // Stop REPLACES Send while a turn runs and there is nothing to send. The
  // moment there is text or an attachment, Send is back — and a send now is
  // queued by the host behind the running turn (spec/04 ## Message queueing),
  // the same thing a web send mid-turn does. A chat being created keeps its
  // spinner on Send: that send is already under way.
  // A send still waiting on the host's `running` (`pendingSend`) offers Stop
  // too — otherwise there is no way to cancel it while it is in flight.
  // A chat parked only on the agent's own question is waiting for the user, not
  // working: nothing to stop.
  const pendingTools = row?.pendingPermissions ?? [];
  const onlyQuestionsPending =
    pendingTools.length > 0 && pendingTools.every((p) => p.tool === 'AskUserQuestion');
  const showStop =
    (running ||
      (row?.activity === 'awaiting-permission' && !onlyQuestionsPending) ||
      pendingSend) &&
    !resolving &&
    draft.trim().length === 0 &&
    attachments.length === 0 &&
    micState === 'idle';

  return (
    <View
      style={{
        padding: space.md,
        gap: space.xs,
        backgroundColor: colors.paperRaised,
        borderTopWidth: 1,
        borderColor: colors.lineSoft,
      }}
    >
      {/* Removable thumbnails/chips above the input (spec/15 § Composer). */}
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.xs, paddingBottom: space.xs }}
          style={{ opacity: resolving ? 0.6 : 1 }}
        >
          {attachments.map((a) => (
            <View
              key={a.key}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.xs,
                paddingHorizontal: space.xs,
                paddingVertical: 4,
                borderRadius: radii.sm,
                borderWidth: 1,
                borderColor: colors.divider,
                backgroundColor: colors.paper,
                maxWidth: 200,
              }}
            >
              {a.kind === 'image' ? (
                <Image source={{ uri: a.uri }} style={{ width: 36, height: 36, borderRadius: 4 }} />
              ) : (
                <FileText size={18} color={colors.ink2} />
              )}
              <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, flexShrink: 1 }}>
                {a.name}
              </Text>
              <Pressable
                onPress={() => removeAttachment(a.key)}
                disabled={resolving}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${a.name}`}
                hitSlop={8}
              >
                <X size={16} color={colors.ink3} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* Skill autocomplete list (spec/15 § Composer). Tap a row to complete. */}
      {showSkillMenu ? (
        <View
          testID="skill-menu"
          style={{
            marginBottom: space.xs,
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: radii.md,
            backgroundColor: colors.paper,
            overflow: 'hidden',
            maxHeight: 200,
          }}
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            {filteredSkills.map((s) => (
              <Pressable
                key={s}
                testID={`skill-option-${s}`}
                onPress={() => completeSkill(s)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.xs,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  backgroundColor: pressed ? colors.divider : 'transparent',
                })}
              >
                <Text style={{ ...typography.secondary, color: colors.leaf }}>/</Text>
                <Text style={{ ...typography.secondary, color: colors.ink }}>{s}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Listening strip (spec/15 § Composer): with the keyboard away, this is
          what says the mic is live — a pulsing dot, the state named, and how
          long it has been listening. */}
      {micState !== 'idle' ? (
        <View
          testID="dictation-status"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.xs,
          }}
        >
          <StatusDot
            color={micState === 'recording' ? colors.red : colors.ink3}
            pulsing={micState === 'recording'}
          />
          <Text style={{ ...typography.label, flex: 1, color: colors.ink }}>
            {micState === 'recording' ? 'Listening' : 'Transcribing…'}
          </Text>
          {micState === 'recording' && dictationStartedAt !== null ? (
            <Text
              testID="dictation-timer"
              style={{ color: colors.ink2, fontSize: 14, fontVariant: ['tabular-nums'] }}
            >
              {formatElapsed(dictationNow - dictationStartedAt)}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Two stacked rows (spec/15 § Composer): the text input owns the FULL
          width on its own row, and the action buttons sit on a second row
          beneath it. The input is the thing that runs out of room first — a
          five-button trio beside it left barely half the width for the text.
          `position: 'relative'` is explicit because the live-dictation mirror
          below is absolutely positioned against this box. */}
      <View testID="composer-input-row" style={{ position: 'relative' }}>
        {/* Live-dictation preview (Todoist 6hHGqGVpJqfcXPmm): a mirror of the
              input showing the committed draft in normal ink plus the
              in-progress transcript on a tint, sitting
              behind a text-transparent TextInput so the real input still owns
              the cursor/selection/editing throughout the recording (spec/07 §
              "Dictation into the composer" — "the input stays
              focusable/editable throughout"). Only mounted while there's
              something to preview, so idle typing is unaffected. */}
        {micState !== 'idle' && livePartial.length > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              // Mirrors the input's own bounds exactly — a preview that clipped
              // at a different line from the field under it shows the user text
              // the field is still holding.
              minHeight: COMPOSER_MIN_HEIGHT,
              maxHeight: COMPOSER_MAX_HEIGHT,
            }}
          >
            <Text
              testID="dictation-preview"
              style={{
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                fontSize: 16,
              }}
            >
              <Text style={{ color: colors.ink }}>{draft}</Text>
              {draft.trim().length > 0 ? ' ' : ''}
              {/* Grey: in progress — rewritten as the user talks and replaced
                  outright by the committed transcript. */}
              <Text testID="dictation-live-words" style={{ color: colors.ink3 }}>
                {livePartial}
              </Text>
            </Text>
          </View>
        ) : showChipMirror ? (
          // spec/15 § Skill autocomplete — chips: the same text-transparent-
          // TextInput trick as the dictation preview above, generalised: the
          // real input keeps the cursor and every editing gesture, and this
          // mirror draws the draft back over it with each completed
          // `/<skill>` boxed and tappable instead of plain.
          <View
            pointerEvents="box-none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              minHeight: COMPOSER_MIN_HEIGHT,
              maxHeight: COMPOSER_MAX_HEIGHT,
            }}
          >
            <Text
              testID="chip-mirror"
              style={{
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                fontSize: 16,
                color: colors.ink,
              }}
            >
              {renderChipMirror()}
            </Text>
          </View>
        ) : null}
        <TextInput
          ref={inputRef}
          autoFocus={autoFocus}
          value={draft}
          onChangeText={(text) => {
            // spec/15 § Composer — a long paste becomes a document attachment.
            const pasted = extractLongPaste(draft, text);
            if (pasted !== null) {
              void attachPastedText(pasted.inserted);
              text = pasted.remaining;
            }
            updateDraft(text);
            // Typing always lands the cursor at the end of what was just
            // typed — the same default a real browser textarea applies on a
            // programmatic value change. `onSelectionChange` (below) is the
            // authoritative source for anywhere the cursor moves WITHOUT
            // typing (arrow keys, tapping elsewhere) and overrides this.
            setCursorState({ text, pos: text.length });
            selectionEndRef.current = text.length;
          }}
          onSelectionChange={(e) => {
            setCursorState({ text: draft, pos: e.nativeEvent.selection.start });
            selectionEndRef.current = e.nativeEvent.selection.end;
          }}
          onKeyPress={(e) => {
            // spec/15 § Skill autocomplete — Backspace right after a chip
            // removes the whole `/<skill> ` in one press. Only for a
            // collapsed cursor — a real selection deletes normally.
            if (e.nativeEvent.key !== 'Backspace') return;
            if (selectionEndRef.current !== cursorPos) return;
            const chip = chipEndingAt(draft, cursorPos, knownChipNames);
            if (!chip) return;
            updateDraft(draft.slice(0, chip.start) + draft.slice(cursorPos));
            pendingCursorRef.current = chip.start;
          }}
          onFocus={() => useComposerDraftStore.getState().setFocused(chatId, true)}
          onBlur={() => {
            // spec/14 § Composer — a draft that arrived from another surface
            // while this composer had focus is held back rather than
            // overwriting text under the cursor; losing focus is what
            // resolves it, taking the newer text if there is one.
            const applied = useComposerDraftStore.getState().setFocused(chatId, false);
            if (applied !== undefined) updateDraft(applied);
          }}
          // Typing stays possible while the link is down — only SENDING
          // gates on `linkDown` (Todoist 6hWrcpCQFqXGJpF6).
          editable={!resolving}
          multiline
          // While a dictation is running the input is painted over by the
          // mirror above, and the placeholder — drawn by the TextInput, in the
          // same box — renders THROUGH it on an empty draft, so the two
          // strings sit on top of each other (Tom, Todoist 6hVPGMcWfgcW6256:
          // "when voice note is recording, placeholder should disappear, its
          // writing on top"). Nothing about an empty input needs naming while
          // the user is talking into it.
          placeholder={
            micState !== 'idle' ? undefined : linkDown ? (linkReason ?? 'Disconnected…') : 'Message'
          }
          placeholderTextColor={colors.ink3}
          style={{
            // Grows upward with the content between these two bounds — the
            // list above is `flex: 1`, so the height the field takes is height
            // the transcript gives up and the composer's bottom edge stays put
            // (spec/15 § Composer). Past the cap it scrolls internally.
            minHeight: COMPOSER_MIN_HEIGHT,
            maxHeight: COMPOSER_MAX_HEIGHT,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            backgroundColor: colors.paper,
            borderWidth: 1,
            borderColor: colors.lineSoft,
            borderRadius: radii.lg,
            color:
              (micState !== 'idle' && livePartial.length > 0) || showChipMirror
                ? 'transparent'
                : colors.ink,
            fontSize: 16,
          }}
        />
      </View>
      {/* Action row. Everything that acts on the message is here, left to
          right; the send button is pushed to the RIGHT edge by the flexible
          spacer, keeping it where the thumb already expects it. */}
      <View
        testID="composer-actions-row"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 0 }}
      >
        {/* Three clear attach controls (spec/15 § Composer): a camera, a
            photo/image picker and an any-type file picker. */}
        <Pressable
          onPress={() => {
            if (disabled || resolving) return;
            void takePhoto();
          }}
          disabled={disabled || resolving}
          style={({ pressed }) => ({
            width: ACTION_SIZE,
            height: ACTION_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radii.md,
            backgroundColor: pressed ? colors.divider : 'transparent',
          })}
          accessibilityRole="button"
          accessibilityLabel={
            disabled ? `Take photo unavailable — ${disabledReason ?? 'disconnected'}` : 'Take photo'
          }
        >
          <Camera size={ICON_SIZE} color={disabled ? colors.inkFaint : colors.ink2} />
        </Pressable>
        <Pressable
          onPress={() => {
            if (disabled || resolving) return;
            void pickImage();
          }}
          disabled={disabled || resolving}
          style={({ pressed }) => ({
            width: ACTION_SIZE,
            height: ACTION_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radii.md,
            backgroundColor: pressed ? colors.divider : 'transparent',
          })}
          accessibilityRole="button"
          accessibilityLabel={
            disabled
              ? `Attach unavailable — ${disabledReason ?? 'disconnected'}`
              : 'Attach photo or image'
          }
        >
          <ImageIcon size={ICON_SIZE} color={disabled ? colors.inkFaint : colors.ink2} />
        </Pressable>
        <Pressable
          onPress={() => {
            if (disabled || resolving) return;
            void pickDocument();
          }}
          disabled={disabled || resolving}
          style={({ pressed }) => ({
            width: ACTION_SIZE,
            height: ACTION_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radii.md,
            backgroundColor: pressed ? colors.divider : 'transparent',
          })}
          accessibilityRole="button"
          accessibilityLabel={
            disabled
              ? `Attach unavailable — ${disabledReason ?? 'disconnected'}`
              : 'Attach any file'
          }
        >
          <Paperclip size={ICON_SIZE} color={disabled ? colors.inkFaint : colors.ink2} />
        </Pressable>
        <Pressable
          onPressIn={() => {
            if (disabled) return;
            // A press-in lands ~350ms before onLongPress, so this is a free
            // second chance to warm the audio plane if the mount-time attempt
            // ran before the permission existed.
            void warmDictation().catch(() => undefined);
          }}
          onPress={() => {
            if (disabled) return;
            if (micState !== 'idle') void commitDictation();
            else void beginDictation('tap');
          }}
          onLongPress={() => {
            if (disabled) return;
            holdTouchRef.current = true;
            void beginDictation('hold');
          }}
          // The genuine end of a hold gesture. Reads only refs, so it can
          // never act on a stale render's `micState`.
          onTouchEnd={endHoldGesture}
          onTouchCancel={endHoldGesture}
          disabled={disabled || micState === 'transcribing'}
          delayLongPress={350}
          hitSlop={MIC_HIT_SLOP}
          pressRetentionOffset={MIC_PRESS_RETENTION}
          style={({ pressed }) => ({
            width: ACTION_SIZE,
            height: ACTION_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radii.md,
            backgroundColor: pressed ? colors.divider : 'transparent',
          })}
          accessibilityRole="button"
          accessibilityLabel={
            disabled
              ? `Dictate unavailable — ${disabledReason ?? 'disconnected'}`
              : micState === 'transcribing'
                ? 'Transcribing…'
                : 'Dictate into message'
          }
        >
          <Mic size={ICON_SIZE} color={disabled ? colors.inkFaint : colors.ink2} />
        </Pressable>
        {/* Clear (discard) button — only while a dictation is in flight
            (spec ask: "a clear button to discard the current dictation if it
            came out wrong"). Sits AFTER the mic (spec/15 § Composer —
            "beside the mic"), never before it, so the mic keeps the fixed
            slot it holds at rest (Todoist 6hf6qmQc4RPxX25c: putting it in
            front used to shove the mic itself sideways the instant a
            dictation started — the button under the user's thumb jumping
            out from under them mid-gesture). Cancels via `lib/dictation.ts`'s
            `finish(false)` — the mic capture stops, the preview session ends,
            nothing is transcribed or appended to the draft. */}
        {micState !== 'idle' ? (
          <Pressable
            onPress={cancelDictation}
            style={({ pressed }) => ({
              width: ACTION_SIZE,
              height: ACTION_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radii.md,
              backgroundColor: pressed ? colors.divider : 'transparent',
            })}
            accessibilityRole="button"
            accessibilityLabel="Clear dictation"
          >
            <X size={ICON_SIZE} color={colors.ink2} />
          </Pressable>
        ) : null}
        <View testID="composer-actions-spacer" style={{ flex: 1, minWidth: space.xs }} />
        {sendTarget === undefined ? (
          <ModelPicker
            daemonId={row?.daemonId ? row.daemonId : null}
            selected={pendingModel ?? chatModel}
            pending={pendingModel !== null}
            onSelect={chooseModel}
            disabled={linkDown}
            variant="compact"
            testID="composer-model-pill"
            note={
              running
                ? 'Applies to your next message — this turn keeps its model'
                : 'Applies to your next message'
            }
          />
        ) : null}
        {/* Which account the latest turn ran on (spec/10 § Backend credentials). */}
        {row?.account ? (
          <Text
            testID="chat-account"
            numberOfLines={1}
            accessibilityLabel={`The latest turn ran on the ${row.account.label} account`}
            style={{ ...typography.meta, color: colors.ink3, maxWidth: 96 }}
          >
            {row.account.label}
          </Text>
        ) : null}
        {sendTarget === undefined ? (
          <Pressable
            testID="permission-mode-padlock"
            onPress={() => setModeMenuOpen(true)}
            // A mode change is a socket frame with nothing to queue it into —
            // disabled, visibly, rather than dropped (spec/12).
            disabled={linkDown}
            style={({ pressed }) => ({
              width: ACTION_SIZE,
              height: ACTION_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radii.md,
              backgroundColor: pressed ? colors.divider : 'transparent',
            })}
            accessibilityRole="button"
            accessibilityLabel={`Permission mode: ${
              permissionMode === undefined
                ? 'not reported yet'
                : permissionModeLabel(permissionMode)
            }`}
          >
            <ModeIcon
              size={ICON_SIZE}
              color={linkDown ? colors.inkFaint : bypass ? colors.red : colors.ink2}
            />
          </Pressable>
        ) : null}
        {showStop ? (
          <Pressable
            testID="composer-stop"
            onPress={stopTurn}
            disabled={linkDown}
            hitSlop={SEND_STOP_HIT_SLOP}
            style={({ pressed }) => ({
              width: SEND_STOP_VISUAL_SIZE,
              height: SEND_STOP_VISUAL_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radii.pill,
              backgroundColor: linkDown ? colors.divider : pressed ? colors.inkFaint : colors.ink2,
            })}
            accessibilityRole="button"
            accessibilityLabel={
              linkDown ? `Stop unavailable — ${linkReason ?? 'disconnected'}` : 'Stop turn'
            }
          >
            <Square size={STOP_ICON_SIZE} color={colors.paperRaised} fill={colors.paperRaised} />
          </Pressable>
        ) : (
          <Pressable
            onPress={submit}
            disabled={sendDisabled}
            hitSlop={SEND_STOP_HIT_SLOP}
            style={({ pressed }) => ({
              width: SEND_STOP_VISUAL_SIZE,
              height: SEND_STOP_VISUAL_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radii.pill,
              backgroundColor: sendLooksInactive
                ? colors.divider
                : pressed
                  ? colors.leafSoft
                  : colors.leaf,
            })}
            accessibilityRole="button"
            accessibilityLabel={
              resolving
                ? 'Sending — creating the chat'
                : pendingSend
                  ? 'Sending…'
                  : linkDown || daemon !== 'online'
                    ? 'Send message (queued until the agent reconnects)'
                    : running
                      ? 'Send message (queued after the current turn)'
                      : 'Send message'
            }
          >
            {sendBusy ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <ArrowUp size={SEND_ICON_SIZE} color={colors.onAccent} />
            )}
          </Pressable>
        )}
      </View>
      <AnchoredMenu
        visible={modeMenuOpen}
        items={modeItems}
        onSelect={onModeSelect}
        onDismiss={() => setModeMenuOpen(false)}
        placement="bottom"
        // Modal's Android focus-steal would close the keyboard mid-type
        // (Todoist 6hfvvHWp6QqVjjQ6) — see AnchoredMenu's `nonModal` doc.
        nonModal
      />
      <ProviderSwitchModal
        visible={providerSwitchTarget !== null}
        onCancel={() => setProviderSwitchTarget(null)}
        onSwitch={(dontShowAgain) => {
          const target = providerSwitchTarget;
          setProviderSwitchTarget(null);
          if (dontShowAgain) {
            void useSettingsStore
              .getState()
              .updatePreferences({ suppressProviderSwitchWarning: true })
              .catch((e: Error) =>
                useUiStore.getState().pushError(`settings failed: ${e.message}`),
              );
          }
          if (target !== null) sendModelChange(target);
        }}
      />
      <SkillPreviewSheet
        skill={previewSkill}
        frontmatter={skillFrontmatter}
        paths={skillPaths}
        daemonId={row?.daemonId ?? ''}
        onClose={() => setPreviewSkill(null)}
      />
    </View>
  );
}
