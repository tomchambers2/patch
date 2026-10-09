import { accountConnectedForModel } from '@patch/wire';
// NewChatRoute — `/chats/new`. Per spec/14 ## Sidebar §8 (`+ New chat`):
// "Opens a fresh chat directly in the main panel. No modal, no wizard. Folder
// defaults to the most-recently-used. Composer auto-focused."
//
// So this is NOT a form/wizard: it's the chat panel shape (header + composer).
// Per spec/14 §8 § New-chat setup row the project (folder) + model pickers live
// INSIDE the chat window, in a row under the "New chat" empty state — the header
// is title + Editor only (spec/14 § Chat panel header); Call lives in the
// composer, same as a live chat. Sending the first message spawns the chat in
// that folder and delivers the message into it; from then on the folder "moves
// up" into the live chat's header crumb and the model is fixed.

import type { JSX, KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadLastNewChat, saveLastNewChat } from '../lib/lastNewChat';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  folderName,
  folderLabels,
  isJunkFolder,
  isReservedSpecialThread,
  CLAUDE_BACKEND_ID,
} from '@patch/wire';
import { api } from '../api/rest.js';
import { ApiError } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useDraftStore } from '../stores/draftStore.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { markUnsentNewChat } from '../lib/unsentNewChat.js';
import {
  defaultDaemonId,
  hostAccount,
  hostDefaultModel,
  usePresenceStore,
} from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { startVoiceCall, startVoiceNote } from '../lib/voiceController.js';
import { sendMessage, type OutgoingFile } from '../lib/sendQueue.js';
import { usePopupPlacement } from '../lib/popupPlacement.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { summariseUsage } from '../lib/usage.js';
import { Composer } from '../components/Composer.js';
import { ClaudeDisconnectedBanner } from '../components/ClaudeDisconnectedBanner.js';
import { EmptyChat } from '../components/EmptyChat.js';
import { NavHistoryControls } from '../components/NavHistoryControls.js';
import { UsageCrumb } from '../components/UsageCrumb.js';
import { Edit3 } from 'lucide-react';
import { loadModels, useModelCatalog } from '../lib/models.js';
import { humaniseError } from '../lib/errorCopy.js';
import { HostPicker } from '../components/HostPicker.js';
import { ModelPicker } from '../components/ModelPicker.js';
import type { PatchWs } from '../api/ws.js';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { useLayoutStore } from '../stores/layoutStore.js';

const HEAD_ICON = 18;
// How many projects the setup row offers as one-click toggles (spec/14 §8).
const QUICK_FOLDER_COUNT = 3;
// How many models the setup row offers as one-click toggles on its own line
// (spec/14 §8). Same count as the projects — the two rows read as one idea.
const QUICK_MODEL_COUNT = 3;

// Error codes that indicate the host rejected a spawn before a real chat was
// created. These can arrive over WS after a 202 HTTP response when the host
// was too slow to respond within the server's 5-second synchronous-error window.
const SPAWN_REJECTION_CODES = new Set([
  'no_model_catalogue',
  'chat_not_found',
  'account_not_found',
]);

/** A host's refusal to spawn, as it arrived — code and its own wording. */
interface SpawnRejection {
  code: string;
  message: string;
}

/**
 * A spawn rejection for `chatId` that has ALREADY landed in the store, checked
 * synchronously (no waiting). Used right before the optimistic send so a spawn
 * already known to be doomed — e.g. the host's chat.error raced ahead of, or
 * alongside, the 202 while we were awaiting the create request — never
 * flashes the message or the navigation into view even for a frame.
 */
function findSpawnRejection(chatId: string): SpawnRejection | null {
  const timeline = useChatStore.getState().timelines[chatId];
  if (!timeline) return null;
  const err = timeline.find(
    (e) => e.kind === 'error' && SPAWN_REJECTION_CODES.has(e.errorCode ?? ''),
  );
  return err ? { code: err.errorCode ?? '', message: err.content ?? '' } : null;
}

/**
 * Watch for a LATE spawn rejection — one that lands only AFTER we have already
 * shown the chat (optimistic message + navigation), because the host took
 * longer than the server's synchronous-error window to refuse it. Waits up to
 * `timeoutMs` for either a spawn-rejection chat.error or confirmation
 * (chat.spawned sets daemonId); resolves null once the spawn is confirmed or
 * the window expires with no error, in which case there is nothing to unwind.
 *
 * The code and the message are kept APART rather than collapsed into one
 * string: the host's message is written for whoever wrote the host
 * ("…so it has no last-used model; name a model on the spawn or connect the
 * backend credential on that machine"), so the surface humanises off the code
 * and keeps that wording as the detail (`lib/errorCopy.ts`).
 *
 * This used to run BEFORE the optimistic render and navigation, blocking both
 * on it — which meant every send waited out this whole window (chat.spawned
 * confirmation, or the full timeout) before the user's own message appeared
 * anywhere, and the composer had already cleared on send (spec/15 §
 * Composer's optimistic clear), so that wait was a blank frame with nothing on
 * screen (Todoist: "the new message should immediately appear in chat for a
 * new chat ... currently it goes blank for a moment, then loads it in"). Now
 * it only ever runs AFTER the chat is already showing, to unwind the rare case
 * where the spawn turns out to have been refused after all.
 */
function waitForSpawnRejection(chatId: string, timeoutMs = 800): Promise<SpawnRejection | null> {
  return new Promise((resolve) => {
    function checkState(): boolean {
      const { chats, timelines } = useChatStore.getState();
      const timeline = timelines[chatId];
      if (timeline) {
        const err = timeline.find(
          (e) => e.kind === 'error' && SPAWN_REJECTION_CODES.has(e.errorCode ?? ''),
        );
        if (err) {
          resolve({ code: err.errorCode ?? '', message: err.content ?? '' });
          return true;
        }
      }
      // chat.spawned sets daemonId from '' to a real value.
      if (chats[chatId]?.daemonId) {
        resolve(null);
        return true;
      }
      return false;
    }

    // Check immediately — the event may have already been processed.
    if (checkState()) return;

    const t = setTimeout(() => {
      unsub();
      resolve(null);
    }, timeoutMs);
    const unsub = useChatStore.subscribe(() => {
      if (checkState()) {
        clearTimeout(t);
        unsub();
      }
    });
  });
}

/**
 * `/chats/new` — resolves WHICH draft this new-chat session is (spec/14 § New
 * chat drafts) and mounts the panel on it.
 *
 * The resolution has to happen HERE, above the panel, because the panel is
 * keyed by the draft: keying it by the URL's `?draft=` instead meant a visit
 * with no param mounted the panel under the key `new`, and the effect that
 * pinned the freshly-minted id into the URL then changed that key — so the
 * panel was unmounted and rebuilt a frame or two after it first appeared,
 * throwing away anything done in between (an open folder/model pop-up simply
 * vanished). Keyed by the RESOLVED id, pinning the URL is invisible, and
 * switching drafts still remounts because the id itself changed.
 */
export function NewChatRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const draftIdParam = searchParams.get('draft');
  const folderParam = searchParams.get('folder');

  const [draftId, setDraftId] = useState<string>(() => {
    const st = useDraftStore.getState();
    if (draftIdParam && st.drafts[draftIdParam]) return draftIdParam;
    return st.create(folderParam ?? undefined);
  });
  // The URL naming a DIFFERENT existing draft is the sidebar switching drafts —
  // adopt it (which re-keys, and so remounts, the panel).
  if (draftIdParam && draftIdParam !== draftId && useDraftStore.getState().drafts[draftIdParam]) {
    setDraftId(draftIdParam);
  }

  // Pin the resolved draft to the URL so a reload/back lands on the SAME draft.
  useEffect(() => {
    if (draftIdParam !== draftId) {
      navigate(`/chats/new?draft=${encodeURIComponent(draftId)}`, { replace: true });
    }
  }, [draftIdParam, draftId, navigate]);

  // A new chat with no message is not a thing the user kept (spec/14 § New chat
  // drafts). One that was never typed in, and one that was typed in and then
  // emptied again, are the same thing — neither is listed, and neither is
  // carried around. Collect them whenever a new-chat session resolves, sparing
  // only the draft this screen is currently sitting on (it still owns the
  // chosen folder/model until the user leaves it). Idempotent, so React's
  // StrictMode double-invoke is harmless.
  useEffect(() => {
    useDraftStore.getState().pruneBlank(draftId);
  }, [draftId]);

  return <NewChatPanel key={draftId} draftId={draftId} ws={ws} />;
}

function NewChatPanel({ draftId, ws }: { draftId: string; ws: PatchWs | null }): JSX.Element {
  const navigate = useNavigate();
  // E6: the sidebar's Recent folders rows start a new chat in a specific folder
  // via `/chats/new?folder=<path>`. When present it preselects that folder
  // (overriding the most-recently-used default).
  const [searchParams] = useSearchParams();
  const folderParam = searchParams.get('folder');
  const updateDraft = useDraftStore((s) => s.update);
  const removeDraft = useDraftStore((s) => s.remove);

  // Select the draft's fields one by one, never the whole map or its `text`:
  // every keystroke rewrites the draft, and subscribing to it here re-rendered
  // this whole route per key press (typing went slow). The composer owns the
  // text; it is seeded once per draft below.
  const draftFolder = useDraftStore((s) => s.drafts[draftId]?.folder) ?? '';
  const draftDaemonId = useDraftStore((s) => s.drafts[draftId]?.daemonId);
  const draftModel = useDraftStore((s) => s.drafts[draftId]?.model);
  const seedRef = useRef<{ id: string; text: string } | null>(null);
  if (seedRef.current?.id !== draftId) {
    seedRef.current = { id: draftId, text: useDraftStore.getState().drafts[draftId]?.text ?? '' };
  }

  const chats = useChatStore((s) => s.chats);
  const [lastNewChat] = useState(loadLastNewChat);
  const ensureChat = useChatStore((s) => s.ensureChat);
  const pushError = useUiStore((s) => s.pushError);
  // spec/14 § Terminal — a local toggle, not `layoutStore`: this screen isn't
  // a pane tab itself (it's the pre-chat draft screen), so the shell fills
  // the panel in place of the setup screen and composer the same way it
  // always has, just driven by this component's own state now instead of a
  // store shared with a pane system that doesn't reach this far.
  const [terminalTakesPanel, setTerminalTakesPanel] = useState(false);

  // Whether a chat creation is in flight (send, voice-note-starts-a-chat, or a
  // header action). Declared up here, ahead of `quickFolders`/`quickModels`
  // below, because their order-freeze reads it — moved out of its old spot
  // next to `createChatInFolder` so that read isn't a temporal-dead-zone bug.
  const [submitting, setSubmitting] = useState(false);

  // The chats this screen is allowed to infer a PROJECT from — every folder it
  // offers (the MRU default, the pop-up's recents, the quick toggles) is
  // derived from exactly this list, so the three can't disagree about what
  // counts as a project. Same two exclusions the host's registry applies
  // (spec/04 § Folders): reserved special threads by chatId, then `isJunkFolder`
  // on the path. Patch's own `.patch/threads/*` working dirs are bookkeeping,
  // not somewhere the user ever meant to start a chat. Configured project roots
  // are NOT filtered here — they are user designations and join the list later.
  const projectChats = useMemo(
    () =>
      Object.values(chats).filter(
        (c) =>
          c.folder && c.daemonId && !isReservedSpecialThread(c.chatId) && !isJunkFolder(c.folder),
      ),
    [chats],
  );

  // Folder defaults to the most-recently-used (host, folder) PAIR (spec/14 §8).
  // Paths are scoped to their host (spec/04 § Spawn: "the same string on two
  // hosts means two different directories"), so the folder and the daemonId
  // must move together — pairing one host's path with another host's id is how
  // a spawn ends up running somewhere the user never chose.
  // The last NEW chat's pair wins outright and never moves. Only before any
  // new chat has been made from this browser (nothing recorded yet) does the
  // newest project chat seed it.
  const newestProjectPair = useMemo(() => {
    let best: { folder: string; daemonId: string; at: number } | null = null;
    for (const c of projectChats) {
      if (!best || c.lastUpdated > best.at)
        best = { folder: c.folder, daemonId: c.daemonId, at: c.lastUpdated };
    }
    return best;
  }, [projectChats]);
  const mruPair = lastNewChat ?? newestProjectPair;
  const mruFolder = mruPair?.folder ?? '';

  // Recent folders seen across existing chats, each carrying the host it lives
  // on (used as secondary picker options).
  //
  // Seeded from the server's folder roster first, because the store's chats
  // exclude archived ones on cold start: without this a folder whose chats are
  // all archived resolved to NO host, so clicking its Recent projects row
  // landed here with a folder it could not spawn in. Live rows are applied
  // after and win, since they carry any host change made this session.
  const folderRoster = useChatStore((s) => s.folderRoster);
  const recentFolderHosts = useMemo(() => {
    const byFolder = new Map<string, string>();
    for (const entry of folderRoster) {
      if (
        entry.folder &&
        entry.daemonId &&
        !isJunkFolder(entry.folder) &&
        !byFolder.has(entry.folder)
      )
        byFolder.set(entry.folder, entry.daemonId);
    }
    for (const c of projectChats) {
      byFolder.set(c.folder, c.daemonId);
    }
    return byFolder;
  }, [projectChats, folderRoster]);
  // The same recents, per machine. A path means one directory on one host, so
  // the picker only ever offers the chosen machine's own folders.
  const recentFoldersByHost = useMemo(() => {
    const byHost = new Map<string, Set<string>>();
    const add = (daemonId: string, f: string): void => {
      const set = byHost.get(daemonId) ?? new Set<string>();
      set.add(f);
      byHost.set(daemonId, set);
    };
    for (const entry of folderRoster) {
      if (entry.folder && entry.daemonId && !isJunkFolder(entry.folder))
        add(entry.daemonId, entry.folder);
    }
    for (const c of projectChats) add(c.daemonId, c.folder);
    return byHost;
  }, [projectChats, folderRoster]);

  // The machines a chat can start on, the default one first (spec/14 §8).
  const presenceHosts = usePresenceStore((s) => s.hosts);
  const accountDefaultDaemonId = defaultDaemonId(presenceHosts);
  const machines = useMemo(
    () =>
      Object.values(presenceHosts).sort((a, b) => {
        if (a.daemonId === accountDefaultDaemonId) return -1;
        if (b.daemonId === accountDefaultDaemonId) return 1;
        return (a.host?.hostName ?? a.daemonId).localeCompare(b.host?.hostName ?? b.daemonId);
      }),
    [presenceHosts, accountDefaultDaemonId],
  );

  // The host whose filesystem the picker browses and whose folder the chat is
  // spawned into. It is never this surface's own machine (spec/04 § Browsing).
  //
  // Choosing a machine is its own decision, taken before the folder: a folder
  // picked afterwards is one of THAT machine's, and the pair is what the spawn
  // sends as `daemonId` + `folder` (spec/14 §8). A restored draft comes back on
  // the machine it was typed against; otherwise the most recent chat's machine.
  const [chosenDaemonId, setChosenDaemonId] = useState<string | null>(
    draftDaemonId ??
      (folderParam ? recentFolderHosts.get(folderParam) : undefined) ??
      mruPair?.daemonId ??
      null,
  );
  const pickerDaemonId = chosenDaemonId ?? accountDefaultDaemonId;
  useEffect(() => {
    updateDraft(draftId, { daemonId: pickerDaemonId ?? undefined });
  }, [pickerDaemonId, draftId, updateDraft]);

  // Configured project folders (Settings → Project folders) — offered first in
  // the picker (spec/04 § Folders). Cached with the same settings query key.
  // They predate per-machine folders and name the default machine's paths.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings() });
  const configuredFolders = settings?.projectFolders ?? [];
  const pickerHostFolders = pickerDaemonId ? presenceHosts[pickerDaemonId]?.folders : null;

  // Picker option list for the chosen machine: configured first, then that
  // machine's own registered roots, then its recents (de-duped).
  const folderOptions = useMemo(() => {
    if (pickerDaemonId === null) return [];
    const recent = Array.from(recentFoldersByHost.get(pickerDaemonId) ?? []).sort();
    const out: string[] = [];
    for (const f of [
      ...(pickerDaemonId === accountDefaultDaemonId ? configuredFolders : []),
      ...(pickerHostFolders?.roots ?? []),
      ...recent,
    ]) {
      if (f && !out.includes(f)) out.push(f);
    }
    return out;
  }, [
    configuredFolders,
    recentFoldersByHost,
    pickerDaemonId,
    accountDefaultDaemonId,
    pickerHostFolders,
  ]);

  // Disambiguating labels for the option rows: just the folder NAME, growing a
  // parent segment ONLY when two options share a basename (todo "recent should
  // just show folder name, extra only if needed for disambiguation"). The full
  // path stays on each row's `title` tooltip. Positionally aligned to
  // `folderOptions`.
  const folderOptionLabels = useMemo(() => folderLabels(folderOptions), [folderOptions]);

  // The projects offered as one-click toggles in the setup row (spec/14 §8):
  // most-recently-used first, topped up from the picker's own list. Reaching a
  // project through the pop-up costs an open-then-choose round trip, and the
  // project you were last in is the one this screen is nearly always headed
  // for. They are drawn from the SAME options the pop-up lists — a shortcut
  // into it, never a second source — so a project can't be offered here that
  // the pop-up disowns.
  const foldersByRecency = useMemo(() => {
    const newest = new Map<string, number>();
    for (const c of projectChats) {
      if (c.daemonId !== pickerDaemonId) continue;
      const at = newest.get(c.folder);
      if (at === undefined || c.lastUpdated > at) newest.set(c.folder, c.lastUpdated);
    }
    return Array.from(newest.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);
  }, [projectChats, pickerDaemonId]);
  const quickFoldersLive = useMemo(() => {
    const out: string[] = [];
    for (const f of [...foldersByRecency, ...folderOptions]) {
      if (out.length === QUICK_FOLDER_COUNT) break;
      if (f && !out.includes(f)) out.push(f);
    }
    return out;
  }, [foldersByRecency, folderOptions]);

  // A `?folder=` param (from the sidebar Recent folders shortcut) wins over the
  // most-recently-used default and counts as a user-chosen folder.
  // A restored draft's folder wins; then a `?folder=` shortcut; then MRU.
  const [folder, setFolder] = useState(draftFolder || folderParam || mruFolder);

  // The field at the top of the pop-up doubles as a search box: while its text
  // is not itself one of the options, only the recents containing it are listed.
  // Indexes into `folderOptions`, so labels stay positionally aligned.
  const shownFolderIdx = useMemo(() => {
    const q = folder.trim().toLowerCase();
    const idx = folderOptions.map((_, i) => i);
    if (!q || folderOptions.includes(folder)) return idx;
    return idx.filter((i) => (folderOptions[i] as string).toLowerCase().includes(q));
  }, [folder, folderOptions]);
  // Per-chat model, applied at spawn via POST /api/chats { model }.
  //
  // `null` is the default and means "don't name one": the spawn omits `model`
  // entirely and the HOST resolves it from its own last-used value (spec/03 §
  // `chat.spawn_request` — "omitted, the chat takes the host's last-used
  // model"). There is no synthetic "Default" row (spec/14 § Model selector) —
  // the picker simply preselects the draft's model, else the chosen host's
  // last-used one, which is exactly what an omitted model resolves to.
  //
  // The surface holds NO default model id and NO browser-local last-used: that
  // pair is what made a fresh browser send `claude-opus-5` on every spawn and
  // overwrite the machine's real last-used model.
  const [model, setModel] = useState<string | null>(draftModel ?? lastNewChat?.model ?? null);
  // The shared account the chat starts on, or null to leave it to the strategy.
  const [preferredAccountId, setPreferredAccountId] = useState<string | null>(null);
  useEffect(() => {
    updateDraft(draftId, model === null ? { model: undefined } : { model });
  }, [model, draftId, updateDraft]);
  // The two setup-row pop-ups (folder + model) are mutually exclusive — one
  // open list at a time (spec/14 § Model selector), so they never overlap.
  const [openPicker, setOpenPicker] = useState<'folder' | 'model' | 'host' | null>(null);
  const pickerOpen = openPicker === 'folder';
  const modelOpen = openPicker === 'model';
  const hostOpen = openPicker === 'host';
  function setPickerOpen(next: boolean | ((v: boolean) => boolean)): void {
    const value = typeof next === 'function' ? next(pickerOpen) : next;
    setOpenPicker(value ? 'folder' : null);
  }
  // The setup row sits low in the chat window, so a pop-up that always dropped
  // downward was clipped by the composer (todo — "folder picker gets cut off by
  // the composer"). Each pop-up opens toward whichever side has room and is
  // capped to it, so it scrolls internally instead of hiding rows underneath
  // the composer.
  const folderAnchorRef = useRef<HTMLDivElement | null>(null);
  const modelAnchorRef = useRef<HTMLDivElement | null>(null);
  const hostAnchorRef = useRef<HTMLDivElement | null>(null);
  const folderPlacement = usePopupPlacement(folderAnchorRef, pickerOpen);
  const modelPlacement = usePopupPlacement(modelAnchorRef, modelOpen);
  const hostPlacement = usePopupPlacement(hostAnchorRef, hostOpen);
  // spec/14 § Dismissing pop-ups (click-off): a press anywhere outside the open
  // picker closes it and selects nothing. All anchors wrap their pill AND
  // their pop-up, so a press on either is "inside" — the pill keeps its own
  // toggle, and interacting with the pop-up (browse tree, path field) never
  // closes it.
  useDismissOnClickOff(openPicker !== null, [folderAnchorRef, modelAnchorRef, hostAnchorRef], () =>
    setOpenPicker(null),
  );
  // Folder BROWSER (spec/04 § Browsing, spec/14/15 § folder picker): the user
  // drills into the host's directory tree instead of typing a path. `null`
  // is the ROOTS view (entries = the host's browsable roots). Only fetched
  // while the picker is open. NO FALLBACK — a browse error (e.g. a dir that
  // escaped the project roots) is surfaced, never swallowed into an empty tree.
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  // Can this machine actually run a chat? Everything on this screen depends on
  // it, so it is answered ONCE here rather than discovered control by control.
  // `null` = not reported yet; only a definite `connected: false` blocks, so a
  // slow first report does not flash a wall of red on every load.
  const hostHasCreditSource = usePresenceStore((s) =>
    pickerDaemonId
      ? Object.values(s.hosts[pickerDaemonId]?.accounts ?? {}).some((account) => account.connected)
      : false,
  );
  const chosenAccount = usePresenceStore((s) =>
    hostAccount(
      s.hosts,
      pickerDaemonId,
      (model ?? hostDefaultModel(s.hosts, pickerDaemonId))?.startsWith('openai/')
        ? 'codex'
        : CLAUDE_BACKEND_ID,
    ),
  );
  const signedOut = !accountConnectedForModel(
    chosenAccount,
    model ?? hostDefaultModel(usePresenceStore.getState().hosts, pickerDaemonId),
  );
  const chosenMachine = usePresenceStore((s) =>
    pickerDaemonId ? (s.hosts[pickerDaemonId]?.host?.hostName ?? pickerDaemonId) : null,
  );
  // The catalogue is per MACHINE, so it loads once the machine is known and
  // RELOADS when it changes — showing one machine's models while a chat is
  // about to be pinned to another is how the wrong model gets sent.
  useEffect(() => {
    void loadModels(pickerDaemonId);
  }, [pickerDaemonId]);
  // What an omitted `model` resolves to on that host — the ACCOUNT's default
  // model, which the host reports as `daemon.host.defaultModel` and the server
  // mirrors down. `null` until it has reached that host, in which case a spawn
  // there naming no model is an error the host raises.
  const hostModel = usePresenceStore((s) => hostDefaultModel(s.hosts, pickerDaemonId));
  // The model this chat will actually run on: the explicit choice if there is
  // one, else the account default (which is what omitting `model` selects).
  const effectiveModel = model ?? hostModel;
  // The accounts a chat on this model could start on: the shared Claude or
  // ChatGPT list, whichever backend the model runs on.
  const sharedSecrets = usePreferencesStore((st) => st.shared?.secrets);
  const preferableAccounts = useMemo(
    () =>
      (
        (effectiveModel?.startsWith('openai/') ? sharedSecrets?.codex : sharedSecrets?.claude) ?? []
      ).filter((a) => a.connected),
    [sharedSecrets, effectiveModel],
  );
  // A preference for the other backend's account means nothing; drop it.
  useEffect(() => {
    if (
      preferredAccountId !== null &&
      !preferableAccounts.some((a) => a.id === preferredAccountId)
    ) {
      setPreferredAccountId(null);
    }
  }, [preferableAccounts, preferredAccountId]);
  // Usage crumb (spec/14 §8 New-chat setup row) — account-level, not
  // chat-level, so it reads exactly as it will once the chat exists: the SAME
  // account `chosenAccount` already resolved above for the sign-in check, on
  // the backend the chosen model actually runs against. An OpenAI API key has
  // no rate limits to draw (matches the exclusion the context ring uses
  // elsewhere). It is the one usage readout left on this header: a live
  // chat's header carries none at all now (its composer's context ring covers
  // it instead), but there is no chat yet here for a ring to measure.
  const usageSummary = summariseUsage(
    effectiveModel?.startsWith('openai/api/') ? undefined : chosenAccount?.usage,
  );
  // The models offered as one-click toggles on their own line in the setup row
  // (spec/14 §8) — the exact shape the projects already have, for the same
  // reason: the model you last worked in is the one this screen is nearly
  // always headed for, and reaching it through the pop-up costs an
  // open-then-choose round trip.
  //
  // Recency comes from EXISTING CHATS, not from a browser-local last-used:
  // each chat carries the model it resolved to at spawn, so the history is
  // already on the wire. Keeping it there is what stops this row becoming the
  // surface-local default that used to overwrite a machine's own last-used
  // model — a toggle only ever sets `model` when the user presses it.
  //
  // Job-spawned chats (`jobId !== null`) are excluded from this recency scan
  // (Todoist: "patch last used should default to last used in a user
  // initiated chat, not a job"). A job's model is a persistent, deliberate
  // setting on the job itself (JobEditorRoute), most often left at the
  // account default rather than hand-picked — so a run of unattended jobs
  // pushed this row toward whatever they happened to run on, burying the
  // model the user actually last chose by hand.
  const modelCatalog = useModelCatalog();
  const catalogModels = modelCatalog.models;
  const modelsByRecency = useMemo(() => {
    const newest = new Map<string, number>();
    for (const c of projectChats) {
      if (!c.model || c.jobId !== null) continue;
      const at = newest.get(c.model);
      if (at === undefined || c.lastUpdated > at) newest.set(c.model, c.lastUpdated);
    }
    return Array.from(newest.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([m]) => m);
  }, [projectChats]);
  const quickModelsLive = useMemo(() => {
    // Drawn from the SAME catalogue the pop-up lists — a shortcut into it,
    // never a second source. A model retired since the chat that used it
    // spawned is no longer offered anywhere, so it is not offered here either.
    const offered = new Set(catalogModels.map((m) => m.id));
    const out: string[] = [];
    for (const id of [...modelsByRecency, ...catalogModels.map((m) => m.id)]) {
      if (out.length === QUICK_MODEL_COUNT) break;
      if (offered.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  }, [modelsByRecency, catalogModels]);
  // Freeze the quick-toggle order the instant a send/create starts (Todoist:
  // "the order of the last used workflow/model should not change when you
  // send the message ... that screen should stay as is"). `foldersByRecency`/
  // `modelsByRecency` are LIVE off `projectChats`, and the moment the new chat
  // this send is creating lands in the store with its own `lastUpdated`, it
  // reorders both rows out from under the user mid-send — before, or instead
  // of, the navigation away that was supposed to be the next thing they saw.
  // `submitting` (set at the top of `createChatInFolder`, the one entry point
  // every send/call/voice-note path funnels through) marks exactly that
  // window: snapshot the live list once on the first submitting render, keep
  // returning that snapshot for as long as submitting stays true, and drop it
  // the moment submitting goes back to false (a failed create, which leaves
  // this screen showing and should resume tracking live recency again).
  const frozenQuickFoldersRef = useRef<string[] | null>(null);
  const frozenQuickModelsRef = useRef<string[] | null>(null);
  if (submitting) {
    if (frozenQuickFoldersRef.current === null) frozenQuickFoldersRef.current = quickFoldersLive;
    if (frozenQuickModelsRef.current === null) frozenQuickModelsRef.current = quickModelsLive;
  } else {
    frozenQuickFoldersRef.current = null;
    frozenQuickModelsRef.current = null;
  }
  const quickFolders = frozenQuickFoldersRef.current ?? quickFoldersLive;
  const quickModels = frozenQuickModelsRef.current ?? quickModelsLive;
  const {
    data: browse,
    isLoading: browseLoading,
    error: browseErr,
  } = useQuery({
    queryKey: ['folders-browse', pickerDaemonId, browseDir],
    queryFn: () => api.browseFolders(pickerDaemonId as string, browseDir ?? undefined),
    // Browsing is addressed to ONE host; with none resolved there is nothing to
    // ask, so the query stays idle rather than browsing a guessed machine.
    enabled: pickerOpen && pickerDaemonId !== null,
  });
  // A failed chat creation is reported by `pushError` alone — one surface per
  // failure (spec/12 § Principles). It used to ALSO render the identical text
  // as a paragraph at the top of the panel; two copies of one message read as
  // two faults, and only the toast is styled.
  // A folder supplied via `?folder=` is an explicit choice — mark it so the MRU
  // seeding effect below never overwrites it.
  const userEditedFolder = useRef(
    (folderParam !== null && folderParam !== '') || draftFolder !== '',
  );
  // A SECOND `?folder=` navigation on this same mount (the sidebar's Recent
  // folders rows `navigate()` to `/chats/new?folder=<path>` with no `?draft=`,
  // so clicking a different row re-renders this screen rather than remounting
  // it — the `folder`/`chosenDaemonId` state above is seeded from the param
  // only once, at mount, via `useState`'s initializer). Without this, the
  // picker keeps showing the FIRST click's folder (and its host) after the
  // user has pointed it at a different one — stale, and on another host
  // possibly not even a directory that exists there (Todoist: "the folder
  // picker for new chat should change immediately for new host, so it
  // doesn't show inaccessible stuff"). Tracks the param already applied so
  // the initial mount value (already consumed above) isn't re-applied here.
  const appliedFolderParam = useRef(folderParam);
  useEffect(() => {
    if (folderParam === appliedFolderParam.current) return;
    appliedFolderParam.current = folderParam;
    if (!folderParam) return;
    userEditedFolder.current = true;
    setFolder(folderParam);
    const daemonId = recentFolderHosts.get(folderParam);
    if (daemonId) setChosenDaemonId(daemonId);
  }, [folderParam, recentFolderHosts]);
  // The chatId once the chat has been created for THIS new-chat session. Caches
  // so a retry (e.g. after an attachment upload failed) reuses the same chat
  // instead of spawning a second one. Cleared implicitly by navigating away.
  const createdChatId = useRef<string | null>(null);

  // The roster may hydrate after first render (WS replay), so the MRU folder
  // can resolve a tick late. Seed it once, until the user types their own.
  useEffect(() => {
    if (!userEditedFolder.current && !folder && mruPair) {
      setFolder(mruPair.folder);
      setChosenDaemonId(mruPair.daemonId);
    }
  }, [mruPair, folder]);

  // Persist the chosen folder into the active draft (survives navigation +
  // reload).
  useEffect(() => {
    updateDraft(draftId, { folder });
  }, [folder, draftId, updateDraft]);

  // Create the chat in the chosen folder, shared by the text-send and the
  // voice-note-starts-a-chat paths. Returns the new chatId, or null on a
  // validation/daemon error (with the error already surfaced to the user).
  async function createChatInFolder(): Promise<string | null> {
    const trimmed = folder.trim();
    if (!trimmed) {
      pushError('Folder is required before starting a chat.');
      return null;
    }
    if (submitting) return null;
    setSubmitting(true);
    try {
      if (pickerDaemonId === null) {
        pushError('Choose which host to start the chat on.');
        setSubmitting(false);
        return null;
      }
      // `model` rides ONLY when the user named one. Omitted, the host resolves
      // it from its own last-used value and records this chat's model as the
      // new one (spec/04 § Spawn). Sending the surface's idea of a default
      // instead is what overwrote a machine's last-used model on every spawn.
      const res = (await api.createChat({
        daemonId: pickerDaemonId,
        folder: trimmed,
        ...(model === null ? {} : { model }),
        ...(preferredAccountId !== null ? { preferredAccountId } : {}),
      })) as { chatId: string };
      // Created before anything is sent into it: if the user leaves it
      // empty, it goes (spec/14 § New chat drafts).
      markUnsentNewChat(res.chatId);
      saveLastNewChat({ daemonId: pickerDaemonId, folder: trimmed, model });
      return res.chatId;
    } catch (err) {
      let code: string;
      let msg: string;
      if (err instanceof ApiError) {
        const body = err.body as {
          message?: string;
          error?: string;
          retractChatId?: string;
        } | null;
        code = body?.error ?? err.message;
        msg = body?.message ?? '';
        // The refusal names the chatId the host's `chat.error` was fanned out
        // under (server: POST /api/chats). That frame reached this surface over
        // the WS a moment ago and seeded a row for a chat that does not exist —
        // the ghost "New chat" rows a run of failed spawns used to leave in the
        // sidebar. Retract it, which also tombstones the id so the same frame
        // arriving late (the two race — different connections) can't re-seed it.
        if (body?.retractChatId) useChatStore.getState().retractChat(body.retractChatId);
      } else {
        code = '';
        msg = (err as Error).message;
      }
      // Surfaced as one error toast (spec/12 — the 400 folder_not_found must
      // not fail silently, and must not be said twice either), humanised down
      // to one sentence with the code kept in the toast's Details.
      const human = humaniseError({ code, message: msg }, 'spawn');
      pushError(human.sentence, undefined, human.detail);
      setSubmitting(false);
      return null;
    }
  }

  // Resolve the real chatId for the composer's attachment upload path: create
  // the chat (or reuse the one already created this session) BEFORE any upload,
  // so a first message WITH attachments no longer hits "chat not found: new"
  // (spec/14 § New chat). Returns null on a creation error (surfaced already).
  async function resolveNewChatId(): Promise<string | null> {
    if (createdChatId.current) return createdChatId.current;
    const id = await createChatInFolder();
    if (id) createdChatId.current = id;
    return id;
  }

  async function handleSend(
    message: string,
    files?: OutgoingFile[],
    presetChatId?: string,
  ): Promise<boolean> {
    // `presetChatId` is set when the composer already created the chat (the
    // attachment path — its uploads need a real chat). Otherwise create it now
    // (text-only first message), reusing any chat already spun up this session.
    const chatId = presetChatId ?? createdChatId.current ?? (await createChatInFolder());
    if (!chatId) return false; // composer restores the typed first message
    createdChatId.current = chatId;

    // A spawn rejection that has ALREADY landed (e.g. the host's chat.error
    // raced ahead of, or alongside, the 202 while we awaited the create request
    // above) — checked synchronously so a doomed spawn is caught before it is
    // ever rendered, not after an optimistic message has already appeared.
    const immediateRejection = findSpawnRejection(chatId);
    if (immediateRejection !== null) {
      // Clean up any partial chatStore state seeded by applyEvent for this id.
      useChatStore.getState().removeChat(chatId);
      createdChatId.current = null;
      const human = humaniseError(immediateRejection, 'spawn');
      pushError(human.sentence, undefined, human.detail);
      setSubmitting(false);
      return false; // composer restores the typed first message
    }

    // Optimistically render the user's OWN first message, and switch to the new
    // chat, IMMEDIATELY — before waiting on any WS-level spawn confirmation
    // (see waitForSpawnRejection's comment for why that used to sit here and
    // caused a blank frame). The host streams back only the assistant reply
    // (never a live echo of the seq-0 user turn), so without this the
    // freshly-created transcript would open showing only the ASSISTANT bubble
    // (spec/14). Reconciled to its persisted seq-0 echo on the next replay via
    // the matching localId. Starts delivery-pending — or, with attachments,
    // uploading: the chat opens with the message pending while they upload
    // (spec/14 § Attachments, spec/15 § Composer → Attachments), and it is sent
    // once they have landed. Tracked to completion (spec/12): held pending,
    // redelivered on a flap/restart, surfaced as "tap to retry" if it stays
    // unacked. A missing socket (null in some tests) simply keeps it pending
    // for reconnect.
    sendMessage(chatId, message, files ?? [], {
      folder: folder.trim(),
      ...(ws ? { send: (e) => ws.send(e) } : {}),
    });
    removeDraft(draftId); // the draft is now a real chat — consume it
    navigate(`/chats/${chatId}`);

    // Guard against a LATE spawn rejection that slips past the server's
    // synchronous-error window: the host can still refuse the chat (e.g.
    // no_model_catalogue) after we've already shown it. Unwind rather than
    // leaving a dead chat behind. Fire-and-forget: the user is already looking
    // at their message and must not be blocked on this.
    void waitForSpawnRejection(chatId).then((spawnErr) => {
      if (spawnErr === null) return;
      useChatStore.getState().removeChat(chatId);
      if (createdChatId.current === chatId) createdChatId.current = null;
      const human = humaniseError(spawnErr, 'spawn');
      pushError(human.sentence, undefined, human.detail);
    });

    return true;
  }

  // Voice can START a chat (spec/14 § Sidebar §8, spec/07 ## Voice-input modes):
  // create the chat, open it, and bind the voice note to its real chatId so the
  // host routes the typed text + transcript in as the first turn. The first note always
  // runs as a TOGGLE session (commit ⏎, cancel esc — handled globally in
  // AppShell): a press-and-hold release can't survive the route change off the
  // new-chat composer, so PTT-release would never commit.
  async function handleStartVoiceNote(typed: string): Promise<void> {
    const chatId = await createChatInFolder();
    if (!chatId) return;
    // Guard against WS-level spawn rejections (same as handleSend above).
    const spawnErr = await waitForSpawnRejection(chatId);
    if (spawnErr !== null) {
      useChatStore.getState().removeChat(chatId);
      const human = humaniseError(spawnErr, 'spawn');
      pushError(human.sentence, undefined, human.detail);
      setSubmitting(false);
      return;
    }
    ensureChat(chatId, folder.trim()); // render the transcript at once, no "not found yet"
    removeDraft(draftId); // the draft is now a real chat — consume it
    navigate(`/chats/${chatId}`);
    // The typed first message rides along with the note: this composer unmounts
    // on the navigation, so anything already written here would otherwise be
    // thrown away by the act of starting the note. It leads the turn, with the
    // transcript appended (spec/07 § 1. Voice note).
    void startVoiceNote(chatId, 'toggle', typed);
  }

  // Call on a NOT-YET-SPAWNED chat: same shape as a voice note starting a chat —
  // create it, wait until its host has it, open it, then bind the call to the
  // real chatId. Starting the call without opening the chat left an off-screen
  // chat for the empty-chat sweep to delete and the audio session to hit
  // "chat not found".
  async function handleStartCall(): Promise<void> {
    if (!folder.trim()) {
      setPickerOpen(true);
      return;
    }
    const chatId = await resolveNewChatId();
    if (!chatId) return; // creation error already surfaced
    const spawnErr = await waitForSpawnRejection(chatId);
    if (spawnErr !== null) {
      useChatStore.getState().removeChat(chatId);
      const human = humaniseError(spawnErr, 'spawn');
      pushError(human.sentence, undefined, human.detail);
      setSubmitting(false);
      return;
    }
    ensureChat(chatId, folder.trim());
    const typed = useDraftStore.getState().drafts[draftId]?.text ?? '';
    useComposerDraftStore.getState().setDraft(chatId, typed);
    removeDraft(draftId);
    navigate(`/chats/${chatId}`);
    void startVoiceCall(chatId);
  }

  // Header actions on a NOT-YET-SPAWNED chat (Call / Files / Open editor):
  // there's no chatId or host session until the chat exists, so each button
  // CREATES the chat in the chosen folder first, navigates into it, then runs
  // its action against the real chatId. No folder chosen yet → open the picker
  // instead of failing (spec/14 § Sidebar §8 — folder is required to spawn).
  async function createThenRun(run: (chatId: string) => void): Promise<void> {
    if (!folder.trim()) {
      setPickerOpen(true);
      return;
    }
    const chatId = await resolveNewChatId();
    if (!chatId) return; // creation error already surfaced
    // Same guard as handleStartVoiceNote/handleStartCall: without it, `run`
    // can open a host session (e.g. the Editor tab's audio/dictation path)
    // against a chatId the host hasn't registered yet, which 404s as
    // "chat not found" (session_not_found) even though the chat looks open.
    const spawnErr = await waitForSpawnRejection(chatId);
    if (spawnErr !== null) {
      useChatStore.getState().removeChat(chatId);
      const human = humaniseError(spawnErr, 'spawn');
      pushError(human.sentence, undefined, human.detail);
      setSubmitting(false);
      return;
    }
    ensureChat(chatId, folder.trim());
    // Whatever was typed here carries into the new chat's composer rather than
    // going with the draft.
    const typed = useDraftStore.getState().drafts[draftId]?.text ?? '';
    useComposerDraftStore.getState().setDraft(chatId, typed);
    removeDraft(draftId); // the draft is now a real chat — consume it
    navigate(`/chats/${chatId}`);
    run(chatId);
  }

  // Choosing a project, shared by the pop-up's recents rows and the setup row's
  // quick toggles so the two cannot drift apart. It is a TOGGLE (spec/14 §8):
  // choosing the one already chosen DESELECTS it — the only way to clear the
  // most-recently-used default. Selecting also picks the project's HOST, and
  // that pair is what the spawn sends. A deselect leaves the pop-up open
  // (nothing was picked, so there is nothing to close on); a pick closes it.
  function chooseFolder(f: string): void {
    userEditedFolder.current = true;
    if (f === folder) {
      setFolder('');
      return;
    }
    setFolder(f);
    setChosenDaemonId(pickerDaemonId);
    setPickerOpen(false);
  }

  // Choosing the machine. Its folders are not the last machine's, so a folder
  // chosen there is kept only if this machine has one at the same path, and the
  // browser goes back to this machine's roots.
  function chooseMachine(daemonId: string): void {
    if (daemonId === pickerDaemonId) return;
    userEditedFolder.current = true;
    setChosenDaemonId(daemonId);
    setBrowseDir(null);
    const theirs = recentFoldersByHost.get(daemonId);
    const roots = presenceHosts[daemonId]?.folders?.roots ?? [];
    if (folder && !theirs?.has(folder) && !roots.includes(folder)) setFolder('');
  }

  // Quick-folder toggle row: Left/Right cycle the row like a segmented
  // control (Todoist: "on a new chat page arrow keys left and right should
  // allow user to choose the folder to work in"). Scoped to firing only while
  // one of the row's own buttons has focus (the handler sits on the row and
  // reads the bubbled keydown), so it never steals Left/Right from the
  // composer's text cursor. Unlike a click, this always SELECTS — never
  // toggles off — and moves focus to the newly-selected button so repeated
  // presses keep walking the row without re-tabbing in.
  const quickFolderRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  function handleQuickFolderKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (quickFolders.length === 0) return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const currentIndex = quickFolders.indexOf(folder);
    const nextIndex =
      currentIndex === -1
        ? e.key === 'ArrowRight'
          ? 0
          : quickFolders.length - 1
        : (currentIndex + delta + quickFolders.length) % quickFolders.length;
    const next = quickFolders[nextIndex];
    if (next === undefined) return;
    userEditedFolder.current = true;
    setFolder(next);
    setChosenDaemonId(pickerDaemonId);
    quickFolderRefs.current.get(next)?.focus();
  }

  // Choosing a model, shared by the quick toggles and the pop-up's rows so the
  // two cannot drift apart. Unlike a project this is NOT a toggle: a chat
  // always spawns on some model, so re-pressing the chosen one leaves it
  // chosen (spec/14 § Model selector).
  function chooseModel(id: string): void {
    setModel(id);
    setOpenPicker(null);
  }

  // Quick-model toggle row: same roving Left/Right as the project row above,
  // scoped the same way (the handler sits on the row and reads the bubbled
  // keydown) so it never steals Left/Right from the composer's text cursor.
  // Cycling starts from the model in force, which before any choice is the
  // host's own last-used one.
  const quickModelRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  function handleQuickModelKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (quickModels.length === 0) return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const currentIndex = effectiveModel === null ? -1 : quickModels.indexOf(effectiveModel);
    const nextIndex =
      currentIndex === -1
        ? e.key === 'ArrowRight'
          ? 0
          : quickModels.length - 1
        : (currentIndex + delta + quickModels.length) % quickModels.length;
    const next = quickModels[nextIndex];
    if (next === undefined) return;
    chooseModel(next);
    quickModelRefs.current.get(next)?.focus();
  }

  // spec/14 §8 § New-chat setup row — the project (folder) + model pickers.
  // They live INSIDE the chat window, under the "New chat" empty state, because
  // before the first message there's nothing in the transcript to read and
  // these are the two decisions the screen exists to take. Once the first
  // message spawns the chat, the setup "moves up": the folder reads as the live
  // chat's header crumb and the model is fixed at spawn.
  const setupRow = (
    <div className="new-chat-setup" data-testid="new-chat-setup">
      {/* Where the chat runs (spec/14 §8), only once there is a choice to make.
          An offline machine is listed so its absence is visible, and cannot be
          chosen. */}
      {machines.length > 1 ? (
        <div className="new-chat-quick new-chat-machines" data-testid="new-chat-machines">
          <HostPicker
            hosts={machines.map((m) => ({
              daemonId: m.daemonId,
              label: m.host?.hostName ?? m.daemonId,
              online: m.online,
            }))}
            selected={pickerDaemonId}
            onSelect={(id) => {
              chooseMachine(id);
              setOpenPicker(null);
            }}
            open={hostOpen}
            onToggle={() => setOpenPicker((v) => (v === 'host' ? null : 'host'))}
            anchorRef={hostAnchorRef}
            placement={hostPlacement}
            testId="new-chat-host"
          />
        </div>
      ) : null}
      {/* One-click project toggles (spec/14 §8) — the recent projects, in the
          row itself, so the commonest choice doesn't cost a trip through the
          pop-up. Same toggle and same host pairing as the pop-up's rows. */}
      {quickFolders.length > 0 ? (
        <div
          className="new-chat-quick"
          data-testid="new-chat-quick"
          onKeyDown={handleQuickFolderKeyDown}
        >
          {quickFolders.map((f) => (
            <button
              key={f}
              ref={(el) => {
                if (el) quickFolderRefs.current.set(f, el);
                else quickFolderRefs.current.delete(f);
              }}
              type="button"
              className={`folder-quick ${f === folder ? 'selected' : ''}`}
              data-testid={`folder-quick-${f}`}
              aria-pressed={f === folder}
              title={f}
              disabled={signedOut}
              onClick={() => chooseFolder(f)}
            >
              {folderOptionLabels[folderOptions.indexOf(f)]}
            </button>
          ))}
        </div>
      ) : null}
      {/* Folder picker pop-up (spec/14 § Sidebar §8): tap the pill to choose
          from configured folders, recent folders, or type an ad-hoc path. */}
      <div className="folder-picker" ref={folderAnchorRef}>
        <button
          type="button"
          className="folder-pill"
          data-testid="new-chat-folder-pill"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          // Nothing here can be acted on until the machine can run a turn.
          disabled={signedOut}
          onClick={() => setPickerOpen((v) => !v)}
        >
          {/* H2 (desktop review): show the folder's BASENAME as the label;
                  the full absolute path is available on hover via `title`, so
                  the pill never spells out a long path inline. */}
          <span className="folder-pill-label mono" title={folder || undefined}>
            {folder ? folderName(folder) : 'Choose a folder…'}
          </span>
          <span className="folder-pill-caret" aria-hidden>
            ▾
          </span>
        </button>
        {pickerOpen ? (
          <div
            className={`folder-popup place-${folderPlacement.direction}`}
            style={{ maxHeight: folderPlacement.maxHeight }}
            data-testid="folder-popup"
            role="listbox"
          >
            {/* One field for both jobs: type to narrow the recents below, or
                type any absolute path the daemon can reach and press Enter. */}
            <input
              type="text"
              className="folder-input"
              data-testid="new-chat-folder"
              placeholder="Search projects or type a path"
              aria-label="folder"
              value={folder}
              onChange={(e) => {
                userEditedFolder.current = true;
                setFolder(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setPickerOpen(false);
                }
              }}
            />
            {/* RECENT — configured + recently-used folders. These are
                    shortcuts: one tap SELECTS the folder and closes the picker
                    ("start here"). Each row shows the folder NAME (bold) as the
                    primary label; the full path is muted secondary text, never
                    the primary (spec/14 § Sidebar §8). No chevron — a recent row
                    is a destination, not a drill target. */}
            <section className="folder-section">
              <p className="folder-section-head">Recent projects</p>
              {folderOptions.length === 0 ? (
                /* H3 (desktop review): a proper empty state when there are no
                       recent folders — a short prompt pointing at Browse. */
                <div className="folder-recent-empty" data-testid="folder-recent-empty">
                  <p className="folder-recent-empty-title">No recent projects</p>
                  <p className="folder-recent-empty-hint">
                    Browse for a project to start a chat in.
                  </p>
                </div>
              ) : shownFolderIdx.length === 0 ? (
                <p className="folder-popup-empty muted" data-testid="folder-recent-nomatch">
                  No match. Press Enter to use this path.
                </p>
              ) : (
                <ul className="folder-popup-list">
                  {shownFolderIdx.map((i) => {
                    const f = folderOptions[i] as string;
                    return (
                      <li key={f}>
                        <button
                          type="button"
                          className={`folder-option ${f === folder ? 'selected' : ''}`}
                          data-testid={`folder-option-${f}`}
                          role="option"
                          aria-selected={f === folder}
                          title={f}
                          onClick={() => chooseFolder(f)}
                        >
                          <span className="folder-option-text">
                            <span className="folder-option-name">{folderName(f)}</span>
                            {/* The extra path line shows ONLY when this option's
                                  basename collides with another's — then the
                                  disambiguating label (…/parent/name) is the extra
                                  the user needs. Unique names stand alone. */}
                            {folderOptionLabels[i] !== folderName(f) ? (
                              <span className="folder-option-path mono">
                                {folderOptionLabels[i]}
                              </span>
                            ) : null}
                          </span>
                          {f === folder ? (
                            <span className="folder-option-check" aria-hidden>
                              ✓
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            {/* BROWSE (spec/04 § Browsing): drill into the daemon's directory
                        tree. Entry rows carry a chevron — clicking DRILLS IN (opens
                        subfolders), it does NOT select. Selecting the folder you're
                        currently looking at is a separate, clearly-labelled accent
                        action ("Use this folder") below the list. Distinct
                        affordances so drill vs select never read the same. */}
            <section className="folder-section folder-browser" data-testid="folder-browser">
              <div className="folder-browser-bar">
                <p className="folder-section-head">Browse</p>
                {browse?.dir ? (
                  <button
                    type="button"
                    className="folder-browser-up"
                    data-testid="folder-browser-up"
                    onClick={() => setBrowseDir(browse.parent)}
                  >
                    ↑ Up
                  </button>
                ) : null}
              </div>
              {/* Breadcrumb — current folder NAME as the primary label; the
                          full absolute path is muted secondary text (spec/14 §8).
                          ONLY once drilled in: at the roots view there is no current
                          directory, and a synthetic "Projects" crumb under the
                          "Browse" heading is a stray line of text — not clickable
                          like the rows beneath it, not a heading, and saying nothing
                          the heading doesn't already say. */}
              {browse?.dir ? (
                <span
                  className="folder-browser-crumb"
                  data-testid="folder-browser-crumb"
                  title={browse.dir}
                >
                  <span className="folder-browser-crumb-name">{folderName(browse.dir)}</span>
                  <span className="folder-browser-crumb-path mono">{browse.dir}</span>
                </span>
              ) : null}
              {browseLoading ? (
                <p className="folder-popup-empty muted">Loading…</p>
              ) : browseErr ? (
                <p className="error" data-testid="folder-browser-error">
                  {(browseErr as Error).message}
                </p>
              ) : (browse?.entries?.length ?? 0) === 0 ? (
                // Two different emptinesses, and conflating them stalls people:
                // AT THE ROOTS VIEW (no `dir`), nothing to browse means this
                // machine has no project folders registered at all — "No
                // subfolders here" blames the wrong thing and offers no way
                // out. Drilled INTO a folder, it really is an empty folder.
                browse?.dir ? (
                  <p className="folder-popup-empty muted">No subfolders here.</p>
                ) : (
                  <p className="folder-popup-empty muted" data-testid="folder-browser-no-roots">
                    Nothing here. Type a path below to open any folder on this machine.
                  </p>
                )
              ) : (
                <ul className="folder-browser-list">
                  {browse?.entries.map((e) => (
                    <li key={e.path}>
                      <button
                        type="button"
                        className="folder-browser-entry"
                        data-testid={`folder-browser-entry-${e.name}`}
                        title={`Open ${e.name}`}
                        onClick={() => setBrowseDir(e.path)}
                      >
                        <span className="folder-browser-entry-name">{e.name}</span>
                        <span className="folder-browser-entry-chevron" aria-hidden>
                          ›
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {/* SELECT the currently-browsed directory (distinct from the
                          drill rows above). Absent at the roots view — you can't open
                          a chat in the synthetic "Projects" root. */}
              {browse?.dir ? (
                <button
                  type="button"
                  className="folder-browser-use"
                  data-testid="folder-browser-use"
                  onClick={() => {
                    userEditedFolder.current = true;
                    setFolder(browse.dir as string);
                    // The tree just browsed belongs to `pickerDaemonId`; keep
                    // the chosen path bound to the host it came from.
                    setChosenDaemonId(pickerDaemonId);
                    setPickerOpen(false);
                  }}
                >
                  Use “{folderName(browse.dir)}”
                </button>
              ) : null}
            </section>
          </div>
        ) : null}
      </div>
      {/* Per-chat model (spec/13) — the model this chat will START on. Persists
          to the draft. The SAME control the chat header uses to change a live
          chat's model (spec/14 § Model selector), so the app has one model
          control rather than two. */}
      <ModelPicker
        selected={effectiveModel}
        onSelect={chooseModel}
        open={modelOpen}
        onToggle={() => setOpenPicker((v) => (v === 'model' ? null : 'model'))}
        anchorRef={modelAnchorRef}
        placement={modelPlacement}
        testId="new-chat-model"
        disabled={signedOut && !hostHasCreditSource}
      />
      {/* The account this chat's turns START on (spec/10 § Backend credentials —
          preferred account). A preference, not a pin: a spent account is walked
          past. "Strategy" leaves the choice to the account strategy. */}
      {preferableAccounts.length > 1 ? (
        <select
          className="new-chat-account"
          aria-label="Start on account"
          data-testid="new-chat-account"
          value={preferredAccountId ?? ''}
          onChange={(e) => setPreferredAccountId(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Account: by strategy</option>
          {preferableAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              Start on {a.label}
            </option>
          ))}
        </select>
      ) : null}
      {/* One-click model toggles (spec/14 §8) — the recently used models, on a
          line of their own beneath the pills, so the commonest choice doesn't
          cost a trip through the pop-up. Same chip as the project toggles
          above; unlike them there is no deselect, since a chat always spawns on
          some model. Nothing offered while the catalogue is unreadable — the
          pop-up says why, and a guessed row here would contradict it. */}
      {quickModels.length > 0 ? (
        <div
          className="new-chat-quick new-chat-quick-models"
          data-testid="new-chat-quick-models"
          onKeyDown={handleQuickModelKeyDown}
        >
          {quickModels.map((id) => (
            <button
              key={id}
              ref={(el) => {
                if (el) quickModelRefs.current.set(id, el);
                else quickModelRefs.current.delete(id);
              }}
              type="button"
              className={`model-quick ${id === effectiveModel ? 'selected' : ''}`}
              data-testid={`model-quick-${id}`}
              aria-pressed={id === effectiveModel}
              title={id}
              disabled={signedOut && !hostHasCreditSource}
              onClick={() => chooseModel(id)}
            >
              {catalogModels.find((m) => m.id === id)?.label ?? id}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <main className="chat-main new-chat-main" data-testid="new-chat-main">
      <header className="chat-head" data-testid="chat-head">
        {/* Far left: the same zone a live chat's header has (spec/14 § Chat
            panel header) — Back / Forward, then the usage crumb (there is no
            folder/host crumb yet on a new chat — the folder isn't chosen
            until the setup row below). The zone is what carries the flex
            share holding the title on centre, so it is drawn whatever is in
            it. */}
        <div className="chat-head-left">
          <NavHistoryControls />
          {usageSummary ? <UsageCrumb summary={usageSummary} context={null} /> : null}
        </div>
        {/* Centre: the "New chat" title, on the same centred zone as a live
            chat's header. No folder/host crumb yet — the folder isn't chosen
            until the setup row below. */}
        <div className="chat-head-title">
          <div className="chat-head-title-row">
            <h1 className="chat-title display">New chat</h1>
          </div>
        </div>
        {/* Far right: Editor. A new chat has no session yet, so the button
            spawns the chat first, then opens the file browser (see
            createThenRun). Same control as a live chat's header, so the
            new-chat header reads identically; Call lives in the composer
            below, same as a live chat. */}
        <div className="chat-head-actions" data-testid="chat-head-actions">
          <button
            type="button"
            className="head-action"
            data-testid="new-chat-action-editor"
            aria-label="Editor"
            title="Editor"
            onClick={() =>
              void createThenRun((chatId) => {
                // `navigate` above lands on `ChatPaneRoute`, whose own effect
                // opens the plain chat tab and focuses it — deferred past
                // that commit so THIS open (the files page) is the one left
                // focused, not raced and immediately replaced by it.
                queueMicrotask(() =>
                  useLayoutStore.getState().openTab({ kind: 'page', page: 'files', chatId }),
                );
              })
            }
          >
            <Edit3 size={HEAD_ICON} aria-hidden />
          </button>
        </div>
      </header>
      {/* spec/14 § Terminal — the Chat / Terminal strip. This screen has no
          pane/tab system of its own (it is the pre-chat draft screen), so the
          switch is local state, not a `layoutStore` tab. */}
      <div className="terminal-tabs" role="tablist" aria-label="Panel" data-testid="terminal-tabs">
        <button
          type="button"
          role="tab"
          className={`terminal-tab ${terminalTakesPanel ? '' : 'active'}`}
          data-testid="terminal-tab-chat"
          aria-selected={!terminalTakesPanel}
          onClick={() => setTerminalTakesPanel(false)}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          className={`terminal-tab ${terminalTakesPanel ? 'active' : ''}`}
          data-testid="terminal-tab-terminal"
          aria-selected={terminalTakesPanel}
          onClick={() => setTerminalTakesPanel(true)}
        >
          Terminal
        </button>
      </div>
      {terminalTakesPanel ? null : (
        <section className="chat-stream" data-testid="chat-stream">
          {/* The empty state and the setup row centre TOGETHER as one block, so
            the pickers sit directly under the "New chat" title rather than
            drifting to the foot of the panel. */}
          <div className="new-chat-intro">
            <EmptyChat title="New chat" />
            {signedOut ? (
              <div className="new-chat-blocked" data-testid="new-chat-blocked" role="alert">
                <p className="new-chat-blocked-title">
                  {chosenMachine ?? 'This machine'} isn’t signed in to{' '}
                  {effectiveModel?.startsWith('openai/') ? 'OpenAI' : 'Claude'}
                </p>
                <p className="muted">Chats can’t run until it is.</p>
                <Link className="ctrl" to="/settings/usage">
                  Sign in
                </Link>
              </div>
            ) : null}
            {setupRow}
          </div>
        </section>
      )}
      {/* A new chat cannot run without a credential, so say so here too — this is
          the screen where someone would otherwise type into a dead composer. */}
      <ClaudeDisconnectedBanner daemonId={pickerDaemonId} />
      {/* spec/14 § Terminal — available HERE above all: you are on this screen
          because the folder you want does not exist on the host yet, and a
          shell is how you clone it there. Rooted by the daemon (no folder
          claimed), so it opens even with nothing selected. */}
      {terminalTakesPanel ? <TerminalPanel chatId="new" ws={ws} /> : null}
      {terminalTakesPanel ? null : (
        <Composer
          // Keyed by draftId so switching drafts remounts the composer and
          // re-seeds its text from the newly-active draft.
          key={draftId}
          chatId="new"
          selectedModel={effectiveModel ?? undefined}
          daemonId={pickerDaemonId}
          folder={folder.trim()}
          resolveChatId={resolveNewChatId}
          onStartCall={() => void handleStartCall()}
          autoFocus
          // Restore + persist the draft's unsent text (spec/14 § New chat drafts).
          // Keyed by draftId above, so switching drafts remounts + re-seeds.
          initialValue={seedRef.current.text}
          onValueChange={(t) => updateDraft(draftId, { text: t })}
          onSend={handleSend}
          // Voice can START a chat: create it, open it, then bind the note to the
          // real chatId (see handleStartVoiceNote). The gesture is ignored here —
          // the first note always runs as a toggle session.
          onStartVoiceNote={(_chatId, _gesture, typed) => void handleStartVoiceNote(typed)}
        />
      )}
    </main>
  );
}
