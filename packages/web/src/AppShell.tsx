// AppShell — three-column layout (sidebar / main fills / editor right rail)
// per spec/14 ## Layout, plus the Tools sidebar (spec/14 § Tools panel) as its
// own column between the main column and the editor rail while it is open —
// App Updates: "tools should show in its own sidebar on right hand side."
// Editor right-rail starts collapsed (group 19 mounts the
// Monaco editor + diff viewer + file browser). Hosts the global
// keyboard-shortcut wiring, the offline banner, the incoming-call banner,
// and the routed main panel.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { Sidebar } from './components/Sidebar.js';
import { MiniSidebar } from './components/MiniSidebar.js';
import { SidebarExpandButton } from './components/SidebarExpandButton.js';
import { SidebarBackdrop } from './components/SidebarBackdrop.js';
import { ToolsPanel } from './components/ToolsPanel.js';
import { SideThreadsPanel } from './components/SideThreadsPanel.js';
import { ColumnDivider } from './components/ColumnDivider.js';
import { OfflineBanner } from './components/OfflineBanner.js';
import { DaemonOfflineBanner } from './components/DaemonOfflineBanner.js';
import { DesktopUpdateBanner } from './components/DesktopUpdateBanner.js';
import { WebUpdateBanner } from './components/WebUpdateBanner.js';
import { ConnectionDiagnosticsGate } from './components/ConnectionDiagnostics.js';
import { IncomingCallBanner } from './components/IncomingCallBanner.js';
import { VoiceBar } from './components/VoiceBar.js';
import { VoiceNoteOverlay } from './components/VoiceNoteOverlay.js';
import { VoicePermissionBanner } from './components/VoicePermissionBanner.js';
import { ShortcutCheatSheet } from './components/ShortcutCheatSheet.js';
import { ErrorToasts } from './components/ErrorToasts.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { PromptModal } from './components/PromptModal.js';
import { TooltipHost } from './components/TooltipHost.js';
import { ChatPaneRoute } from './routes/ChatPaneRoute.js';
import { openMostRecentEditDiff, relativeToChatFolder } from './lib/openDiff.js';
import { permissionDeliveryTracker } from './lib/permissionDeliveryTracker.js';
import { navigateAfterArchive } from './lib/archiveNav.js';
import { PageNotFound } from './components/PageNotFound.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { NewChatRoute } from './routes/NewChatRoute.js';
import { JobsPaneRoute } from './routes/JobsPaneRoute.js';
import { PadsPaneRoute } from './routes/PadsPaneRoute.js';
import { LifecycleRoute } from './routes/LifecycleRoute.js';
import { JobPaneRoute } from './routes/JobPaneRoute.js';
import { SettingsPaneRoute } from './routes/SettingsPaneRoute.js';
import { IndexRedirect } from './routes/IndexRedirect.js';
import { MenubarRoute, AUTO_CALL_KEY } from './routes/MenubarRoute.js';
import { VoiceOverlayRoute } from './routes/VoiceOverlayRoute.js';
import { SidebarWindowRoute } from './routes/SidebarWindowRoute.js';
import { TabWindowRoute } from './routes/TabWindowRoute.js';
import { focusPageSearch } from './lib/searchTarget.js';
import { useShortcuts, isChatViewPath } from './lib/shortcuts.js';
import { useShiftClickGuard } from './lib/shiftClickGuard.js';
import { useResponsiveShell } from './lib/responsiveShell.js';
import { useSectionCounts } from './lib/sectionCounts.js';
import { useDocumentTitleSync } from './lib/documentTitle.js';
import { useChatStore, deriveBadge } from './stores/chatStore.js';
import { useUiStore, SIDEBAR_MINI_WIDTH } from './stores/uiStore.js';
import { isMeetingOpen, useMeetingStore } from './stores/meetingStore.js';
import { endMeeting, startMeeting } from './lib/meetingControl.js';
import { usePreferencesStore } from './stores/preferencesStore.js';
import { resolvePane, useLayoutStore } from './stores/layoutStore.js';
import { useVoiceStore } from './stores/voiceStore.js';
import { composerHotkeyDown, composerHotkeyUp } from './lib/composerMic.js';
import { api } from './api/rest.js';
import { useDiscardUnsentNewChats } from './lib/unsentNewChat.js';
import { PatchWs, defaultWsUrl, setActiveWs } from './api/ws.js';
import {
  startVoiceNote,
  sendVoiceNote,
  cancelVoiceNote,
  releaseVoiceNoteHold,
  startVoiceCall,
} from './lib/voiceController.js';
import { getDesktopBridge } from './lib/desktopBridge.js';
import { initNotificationActionBridge } from './lib/notificationActionBridge.js';
import { useBatchWatcher } from './lib/batchNotifier.js';
import { useDesktopNavigation } from './lib/desktopNavigation.js';
import { failed } from './lib/errorCopy.js';
export function AppShell(): JSX.Element {
  // Batch mode (patch/todo.md § Features to add): watch the batch and notify
  // when all member chats are ready for review, or on the reminder interval.
  useBatchWatcher();
  // Manager per project/batch (patch/todo.md § Features to add): wake on the
  // interval or when an agent stops, and surface the decisions that need you.
  // spec/14 § Links and the web panel: a shift-click on an in-app link would
  // otherwise fall through to the browser and reload the single window.
  useShiftClickGuard();
  // spec/09 § `### desktop` — clicking a native toast opens the chat it came
  // from, and the tray's "Version & updates…" opens Settings. Main can only
  // raise the window; the routing has to happen here.
  useDesktopNavigation();
  // spec/14 ## Layout → Narrow widths: auto-collapse the sidebar / close the
  // editor rail below their breakpoints so the shell never grows a
  // page-level horizontal scrollbar.
  useResponsiveShell();
  const wsRef = useRef<PatchWs | null>(null);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const sidebarMini = useUiStore((s) => s.sidebarMini);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const setChannelsOpen = useUiStore((s) => s.setChannelsOpen);
  const setArchivedOpen = useUiStore((s) => s.setArchivedOpen);
  const setCheatSheetOpen = useUiStore((s) => s.setCheatSheetOpen);
  const navigate = useNavigate();
  const location = useLocation();
  // A chat the new-chat screen created and the user left empty is deleted
  // (spec/14 § New chat drafts).
  useDiscardUnsentNewChats();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const hydrate = useChatStore((s) => s.hydrate);
  const pushError = useUiStore((s) => s.pushError);

  // Cold-start: GET /api/chats → hydrate sidebar BEFORE the WS arrives.
  const { error: chatsError } = useQuery({
    queryKey: ['chats'],
    queryFn: async () => {
      const r = await api.listChats();
      hydrate(
        r.chats.map((c) => ({
          chatId: c.chatId,
          name: c.name,
          daemonId: c.daemonId,
          permissionMode: c.permissionMode,
          // G2-d4: the daemon-captured first-message snippet — lets the sidebar
          // label unnamed/archived rows distinctly even when several share a
          // folder basename.
          preview: c.preview,
          // patch/todo.md — `/goal`: the chat's goal, shown at the top of the
          // chat. Carried on cold-start so it's visible before the live WS.
          goal: c.goal,
          // patch/todo.md — Reminders: the chat's reminder, shown at the top of
          // the chat. Carried on cold-start so it's visible before the live WS.
          reminder: c.reminder,
          // spec/02 § Self-wake: the chat's pending wake, so the wake bar (with
          // its countdown) is up on cold-start rather than only after the next
          // live chat.state.
          pendingWake: c.pendingWake,
          folder: c.folder,
          activity: c.activity,
          status: c.status,
          pinned: c.pinned,
          pinnedAt: c.pinnedAt,
          disabled: c.disabled,
          lastUpdated: c.lastUpdated,
          jobId: c.jobId,
          // spec/02 § Background task completions — a chat can cold-start idle
          // with a background command still running, and the next live
          // `chat.state` only comes when something changes. `null` here is the
          // server saying it does not know, and stays unknown.
          backgroundTasks: c.backgroundTasks,
          // spec/04 § Hidden. Nothing in this snapshot is hidden, and saying so
          // clears a stale `true` on a chat that was shown from another surface.
          hidden: c.hidden,
        })),
      );
      return r;
    },
  });

  useEffect(() => {
    if (chatsError) {
      pushError(`failed to load chats: ${(chatsError as Error).message}`);
    }
  }, [chatsError, pushError]);

  // Cold-start: GET /api/chats/folders → the folder roster (spec/04 § Folders →
  // Folder roster). Separate from the chats query above because that one
  // excludes archived chats, so it cannot see a folder whose chats are ALL
  // archived — which is exactly the folder Recent projects has to keep offering
  // (Todoist: "archiving the last chat in a project makes the project disappear
  // from the sidebar"). One row per folder, so it stays cheap.
  const { error: folderRosterError } = useQuery({
    queryKey: ['chat-folders'],
    queryFn: async () => {
      const r = await api.listChatFolders();
      // NO FALLBACK: a response without a `folders` array is a broken server,
      // not an empty roster. Throwing routes it to the toast below; coercing it
      // to `[]` would silently render the very bug this roster exists to fix.
      if (!Array.isArray(r.folders)) {
        throw new Error(`malformed folder roster: ${JSON.stringify(r)}`);
      }
      useChatStore.getState().setFolderRoster(r.folders);
      return r;
    },
  });

  useEffect(() => {
    // NO FALLBACK — a roster that failed to load is a visibly short Recent
    // projects list, so say so rather than quietly rendering the stale one.
    if (folderRosterError) {
      pushError(`failed to load projects: ${(folderRosterError as Error).message}`);
    }
  }, [folderRosterError, pushError]);

  // Cold-start + live refresh of the sidebar's section counts (spec/04
  // § Section counts). Shared with the dev harness so the e2e suite drives the
  // same code path.
  useSectionCounts();
  // App Updates: "should show which workspace I am in somewhere" — the window
  // title carries the active chat's folder so Cmd+` / Mission Control / the
  // Dock / browser tabs can tell Patch windows apart without clicking into
  // each one (see lib/documentTitle.ts).
  useDocumentTitleSync();

  // The account preferences the voice layer reads without an await — the
  // address word a quiet call gates utterances on (spec/07 § Session modes).
  // Settings re-reads them on its own poll; this is the boot load, so a call
  // opened before Settings was ever visited still carries the right word.
  useEffect(() => {
    void usePreferencesStore
      .getState()
      .load()
      .catch((e: Error) => pushError(`failed to load settings: ${e.message}`));
  }, [pushError]);

  // Clear transient toasts on route change so a stale error (e.g. a failed
  // "Pair Telegram" submit) does not persist across navigations until manually
  // dismissed. Toasts also auto-expire on a timer (uiStore) as a backstop.
  useEffect(() => {
    useUiStore.getState().clearToasts();
  }, [location.pathname]);

  // Open the WS once.
  useEffect(() => {
    const ws = new PatchWs(defaultWsUrl());
    wsRef.current = ws;
    setActiveWs(ws);
    ws.connect();
    return () => {
      ws.close();
      wsRef.current = null;
      setActiveWs(null);
    };
  }, []);

  // spec/09 § Chat completion — tell the server which chat THIS surface has
  // open, independent of voice: the chat-completion / awaiting-permission
  // doorbell withholds its desktop toast from a surface already looking at
  // the chat that just settled. `null` clears it (sidebar-only view, or no
  // chat open at all). Best-effort — the socket may not be OPEN yet on first
  // mount, and a fresh connect resends the current focus itself once
  // authenticated (`ws.ts`'s `auth.ok` handler), so nothing is lost.
  useEffect(() => {
    try {
      wsRef.current?.send({ type: 'chat.focus_change', chatId: activeChatId });
    } catch {
      /* not connected yet; auth.ok resend catches up */
    }
  }, [activeChatId]);

  // Auto-open a voice call requested from the browser menu-bar surface. The
  // `/app/menubar` bare route has no overlay, so its phone control navigates
  // the full app to the target chat and stashes the intent in sessionStorage
  // (spec/07 ## Overlay surfaces: menu-bar phone → voice-call overlay).
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(AUTO_CALL_KEY);
      if (pending) sessionStorage.removeItem(AUTO_CALL_KEY);
    } catch {
      /* storage unavailable */
    }
    if (pending && !useVoiceStore.getState().call) {
      void startVoiceCall(pending);
    }
  }, []);

  // Electron bridge: the desktop shell's ⌃Space global hotkey and menu-bar
  // phone control fire IPC into the renderer (preload exposes onStartVoiceNote
  // / onStartVoiceCall). Wire them to the same controller the in-app gestures
  // use. No-ops in the browser where window.patch is undefined.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const offs: Array<() => void> = [];
    const resolveThread = (thread: string): string | undefined => {
      if (thread === 'manager') return SPECIAL_THREAD_IDS.manager;
      return useChatStore.getState().chats[thread] ? thread : undefined;
    };
    if (bridge.onStartVoiceNote) {
      offs.push(
        bridge.onStartVoiceNote(({ thread }) => {
          const id = resolveThread(thread);
          if (id) void startVoiceNote(id, 'toggle');
        }),
      );
    }
    if (bridge.onStartVoiceCall) {
      offs.push(
        bridge.onStartVoiceCall(({ thread }) => {
          const id = resolveThread(thread);
          if (id) void startVoiceCall(id);
        }),
      );
    }
    // Meeting mode: the shell saw a call app open the mic (offer to start) or
    // let go of it (offer to end). The click on its toast is the consent.
    if (bridge.onMeetingSignal) {
      offs.push(
        bridge.onMeetingSignal(({ phase }) => {
          if (phase === 'ended') {
            const capturing = useMeetingStore.getState().capturingChatId;
            if (capturing) endMeeting(capturing);
            return;
          }
          const chatId = useChatStore.getState().activeChatId;
          if (!chatId) {
            useUiStore.getState().pushError('Open a chat first, then start the meeting from it');
            return;
          }
          if (isMeetingOpen(useMeetingStore.getState().byChat[chatId])) return;
          void startMeeting(chatId);
        }),
      );
    }
    return () => offs.forEach((off) => off());
  }, []);

  // spec/09 § Notification actions — wires the desktop shell's
  // `onNotificationSend` once: a Reply/Approve-Deny/question answer tapped on
  // a native toast is sent through the same guaranteed-delivery path the
  // composer and QuestionCard use. No-op in the browser.
  useEffect(() => {
    initNotificationActionBridge();
  }, []);

  // Electron bridge: the embedded web panel is a SIDE panel (spec/14 § Links
  // and the web panel). Main docks it to the right edge and tells the renderer
  // how wide it is; the app pads itself by exactly that width so the chat and
  // composer stay visible and usable beside it instead of being covered. 0 =
  // closed → the padding is removed entirely, restoring the full-width app.
  // The same width drives the floating divider below, so it tracks main's
  // pushes (a drag it started, a window resize keeping the same share) as well
  // as a resize this renderer itself just asked for.
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onPanelInset) return;
    const off = bridge.onPanelInset(({ width }) => {
      document.body.style.paddingRight = width > 0 ? `${width}px` : '';
      setPanelWidth(width);
    });
    return () => {
      off();
      document.body.style.paddingRight = '';
      setPanelWidth(0);
    };
  }, []);

  // Global voice-overlay keys (spec/07 ## Voice-input modes):
  //   - Esc cancels an in-flight voice note (no send) or ends a call.
  //   - ⏎ commits a TOGGLE-mode voice note (PTT commits on key/mouse release).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const note = useVoiceStore.getState().note;
      // A note in flight owns these two keys wherever focus is — a text field
      // included (spec/07 ## Voice-input modes). The overlay carries no controls,
      // so bailing out on INPUT/TEXTAREA left it unendable and uncancellable
      // whenever a field had focus. The composer handles (and stops) the keys
      // itself when the caret is in it; this catches every other field.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (!note && (tag === 'INPUT' || tag === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        if (note) {
          e.preventDefault();
          cancelVoiceNote();
        }
        return;
      }
      if (e.key === 'Enter' && note && note.gesture === 'toggle') {
        e.preventDefault();
        sendVoiceNote();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Global keyboard shortcuts. spec/14 § Discoverability — the chat-list
  // chords (prev/next chat, folders, jump-unread, archive, …) are scoped to
  // a chat view; this is the one place that fact is computed, off the same
  // `location` every route switch already re-renders on.
  const isChatView = isChatViewPath(location.pathname);
  useShortcuts(
    {
      onSearch: (chord) => focusPageSearch(chord),
      onNewChat: () => navigate('/chats/new'),
      onNewChatPicker: () => {
        // ⌘⇧N — same new-chat panel, but focus the editable folder pill so the
        // user picks the folder first (spec/14: "New chat with folder picker").
        navigate('/chats/new');
        // The route mounts async; focus the folder input once it is in the DOM.
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLInputElement>('[data-testid="new-chat-folder"]');
          el?.focus();
          el?.select();
        });
      },
      onJumpOldestUnread: () => {
        // ⌘J — jump to the OLDEST unread chat (a `done` or `permission` badge),
        // i.e. the one waiting longest. Skips archived rows.
        const chats = Object.values(useChatStore.getState().chats).filter(
          (c) => c.status !== 'archived',
        );
        const unread = chats
          .filter((c) => {
            const b = deriveBadge(c);
            return b === 'done' || b === 'permission';
          })
          .sort((a, b) => a.lastUpdated - b.lastUpdated);
        const target = unread[0];
        if (target) navigate(`/chats/${target.chatId}`);
        else pushError('no unread chats');
      },
      onPrevFolder: () => navigateFolder(-1, location, navigate),
      onNextFolder: () => navigateFolder(1, location, navigate),
      onJumpManager: () => {
        // Manager is the stable special thread — match by chatId, not the
        // host's lowercase folder/name (spec/06 ## Sidebar placement).
        const manager = useChatStore.getState().chats[SPECIAL_THREAD_IDS.manager];
        if (manager) navigate(`/chats/${manager.chatId}`);
      },
      onArchiveCurrent: () => {
        if (!activeChatId) return;
        const row = useChatStore.getState().chats[activeChatId];
        if (!row) return;
        const archived = row.status !== 'archived';
        // Archiving the chat you're on moves you to the next one (spec/04
        // § Lifecycle) — resolved before the flip, while it is still in the list.
        if (archived) navigateAfterArchive(navigate, [activeChatId]);
        useChatStore.getState().setArchived(activeChatId, archived);
        void api.archiveChat(activeChatId, archived).catch((e) => {
          useChatStore.getState().setArchived(activeChatId, !archived);
          pushError(failed('archive'), undefined, (e as Error).message);
        });
      },
      onFilePicker: () => {
        // Group 20 fix DX-8: single-press ⌘P opens the picker directly — it
        // reads whichever chat's `files-recursive` index is cached, which
        // needs a Files tab open for this chat at least once; open it now,
        // not just the picker, same as before.
        if (!activeChatId) {
          pushError('no chat focused');
          return;
        }
        useLayoutStore.getState().openTab({ kind: 'page', page: 'files', chatId: activeChatId });
        useUiStore.getState().setFilePickerOpen(true);
      },
      onDiffViewer: () => {
        // ⌘' — G3-1: open the diff editor on the chat's MOST RECENT agent edit.
        if (!activeChatId) {
          pushError('no chat focused');
          return;
        }
        void openMostRecentEditDiff(activeChatId)
          .then((opened) => {
            if (opened) return;
            const diff = useUiStore.getState().pendingDiffByChat[activeChatId];
            if (diff) {
              const folder = useChatStore.getState().chats[activeChatId]?.folder ?? '';
              useLayoutStore.getState().openTab({
                kind: 'file',
                chatId: activeChatId,
                path: relativeToChatFolder(folder, diff.filePath),
              });
              return;
            }
            pushError('no recent diff to open');
          })
          .catch((err) => pushError(`editor: ${(err as Error).message}`));
      },
      onVoiceHoldStart: () => {
        if (!activeChatId) return;
        // The dictate chord dictates into the open chat's composer, exactly like
        // its mic button (lib/composerMic.ts). Only with no such composer on
        // screen is it a press-and-hold voice note (mode 1, PTT gesture: release sends).
        if (!composerHotkeyDown(activeChatId)) void startVoiceNote(activeChatId, 'ptt');
      },
      onVoiceHoldEnd: (heldMs) => {
        if (composerHotkeyUp()) return;
        // A real press-and-hold commits on release; a chord tap opens a sustained
        // session instead (spec/07 ## Voice-input modes — mode 1).
        releaseVoiceNoteHold(heldMs);
      },
      onGlobalVoiceStart: () => {
        // ⌃Space held — global hotkey, target = Manager (spec/07 ## Overlay
        // surfaces — placement summary).
        const manager = useChatStore.getState().chats[SPECIAL_THREAD_IDS.manager];
        if (manager) void startVoiceNote(manager.chatId, 'ptt');
      },
      onGlobalVoiceEnd: (heldMs) => {
        releaseVoiceNoteHold(heldMs);
      },
      onToggleSidebar: () => setSidebarCollapsed(!sidebarCollapsed),
      onToggleChannels: () => {
        const cur = useUiStore.getState().channelsOpen;
        setChannelsOpen(!cur);
      },
      onToggleArchived: () => {
        const cur = useUiStore.getState().archivedOpen;
        setArchivedOpen(!cur);
      },
      onPrevChat: () => navigateChat(-1, location, navigate),
      onNextChat: () => navigateChat(1, location, navigate),
      onCheatSheet: () => {
        const cur = useUiStore.getState().cheatSheetOpen;
        setCheatSheetOpen(!cur);
      },
      onToggleEditor: () => {
        // ⌥E — spec/14 § Panes and tabs: the editor rail is gone, so this
        // toggles the active chat's Files tab (open/focus, or close if it's
        // already the focused tab) rather than a docked rail.
        if (!activeChatId) return;
        useLayoutStore.getState().toggleTab({ kind: 'page', page: 'files', chatId: activeChatId });
      },
      onToggleTerminal: () => {
        // ⌃` — spec/14 § Terminal. Only meaningful on a live chat: a terminal
        // tab is rooted at that chat's folder, so there is nothing to toggle
        // elsewhere.
        const chatId = location.pathname.match(/\/chats\/([^/]+)/)?.[1];
        if (chatId === undefined || chatId === 'new') return;
        useLayoutStore.getState().toggleTab({ kind: 'terminal', chatId });
      },
      onFileBrowser: () => {
        // ⌘⇧' — G3-8: open the per-chat file browser.
        if (!activeChatId) return;
        useLayoutStore.getState().openTab({ kind: 'page', page: 'files', chatId: activeChatId });
      },
      onCloseTab: () => {
        const layout = useLayoutStore.getState();
        const pane = resolvePane(layout.root, layout.activePaneId);
        if (pane.activeTabId) layout.closeTab(pane.id, pane.activeTabId);
        // Nothing left to close: the chord is already claimed from the OS, so
        // close the window ourselves (the desktop shell hides it).
        else window.close();
      },
      onPrevTab: () => useLayoutStore.getState().cycleActiveTab(-1),
      onNextTab: () => useLayoutStore.getState().cycleActiveTab(1),
      onSplitPane: () => {
        const layout = useLayoutStore.getState();
        layout.splitActivePane(layout.activePaneId, 'right');
      },
    },
    { isChatView },
  );

  // Group 20 fix-2: /menubar and /voice-overlay are bare routes — no
  // sidebar, no panes. The Electron tray-popover and voice-overlay windows
  // load these paths directly. /sidebar-window (spec/14 § New windows) joins
  // them: the sidebar detached into its own window has no pane area either.
  // /tab-window (spec/14 § Panes and tabs — "detach into its own window")
  // joins them too: one tab popped out into its own window has no sidebar —
  // just `PaneArea` filling the window with that single tab.
  const path = location.pathname;
  const isBareRoute =
    path === '/menubar' ||
    path === '/voice-overlay' ||
    path === '/sidebar-window' ||
    path === '/tab-window';

  if (isBareRoute) {
    return (
      <div className="app-shell bare" data-testid="app-shell-bare">
        <Routes>
          <Route path="/menubar" element={<MenubarRoute />} />
          <Route path="/voice-overlay" element={<VoiceOverlayRoute />} />
          <Route path="/sidebar-window" element={<SidebarWindowRoute />} />
          <Route path="/tab-window" element={<TabWindowRoute ws={wsRef.current} />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="app-shell" data-testid="app-shell">
      <OfflineBanner />
      {/* App-level, not per-chat: the WS can be connected while every daemon
          is offline, and that is just as true on Jobs/Settings/New chat as it
          is inside an open chat (Patch Updates: "a bar when something not
          connected on main screen"). Rendering it once here, instead of inside
          ChatRoute, means it is never missing on the screens that aren't a
          chat, and never doubled on the ones that are. */}
      <DaemonOfflineBanner />
      {/* Standing chrome, not an interruption: the shell has a newer build
          staged and is waiting to be asked. Renders nothing in a browser. */}
      <DesktopUpdateBanner />
      {/* Same contract, for the SPA bundle itself — a deploy landed while this
          tab was open. Renders nothing until one has (lib/liveUpdate.ts). */}
      <WebUpdateBanner />
      {/* A sustained voice session takes a strip IN FLOW at the top of the
          shell — it pushes the app down rather than floating over it, and says
          what the open line is doing in either mode (spec/07 § Session
          modes). */}
      <VoiceBar />
      <div className={`three-col ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        {sidebarCollapsed ? null : sidebarMini ? <MiniSidebar /> : <Sidebar />}
        <SidebarBackdrop />
        {sidebarCollapsed ? null : (
          <ColumnDivider
            side="left"
            width={sidebarMini ? SIDEBAR_MINI_WIDTH : sidebarWidth}
            onResize={setSidebarWidth}
            testId="sidebar-divider"
          />
        )}
        <AppErrorBoundary resetKey={location.pathname}>
          <Routes>
            <Route path="/" element={<IndexRedirect />} />
            <Route path="/chats/new" element={<NewChatRoute ws={wsRef.current} />} />
            <Route path="/chats/:chatId" element={<ChatPaneRoute ws={wsRef.current} />} />
            <Route path="/pads" element={<PadsPaneRoute ws={wsRef.current} mode="list" />} />
            <Route path="/pads/new" element={<PadsPaneRoute ws={wsRef.current} mode="new" />} />
            <Route path="/pads/:id" element={<PadsPaneRoute ws={wsRef.current} mode="open" />} />
            <Route path="/jobs" element={<JobsPaneRoute ws={wsRef.current} />} />
            <Route path="/jobs/new" element={<JobPaneRoute ws={wsRef.current} />} />
            <Route path="/jobs/:id" element={<JobPaneRoute ws={wsRef.current} />} />
            <Route path="/lifecycle/:kind" element={<LifecycleRoute />} />
            <Route path="/settings/*" element={<SettingsPaneRoute ws={wsRef.current} />} />
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        </AppErrorBoundary>
        {/* AFTER the routes, not beside the sidebar: on an overlay title bar
            the chevron is a `no-drag` hole inside `.chat-head`'s drag region,
            and Electron folds app regions in DOCUMENT order — a hole that
            comes before the drag rect it sits in is painted over by it, and
            the click starts a window move instead (spec/05 § Window chrome;
            desktop scripts/smoke-drag-regions.cjs). */}
        <SidebarExpandButton />
        {/* The Tools sidebar's own column. It renders null unless a chat has
            it open, so it costs nothing the rest of the time. */}
        <ToolsPanel />
        {/* spec/14 § Side threads panel — its own resizable column, right of
            the chat like the Tools/editor columns. Renders null unless the
            chat on screen has a side thread open. */}
        <SideThreadsPanel />
      </div>
      {/* The web panel is a native Electron view outside this DOM (spec/14 §
          Links and the web panel), so its divider can't be a flex sibling like
          the sidebar's or the editor rail's — it floats at the boundary of the
          `paddingRight` inset above, fixed to the window. Dragging it tells
          main to resize the real views; the resulting `patch:panel-inset`
          echo (onPanelInset above) is what moves it and the padding together. */}
      {panelWidth > 0 ? (
        <ColumnDivider
          side="right"
          width={panelWidth}
          onResize={(next) => getDesktopBridge()?.resizePanel?.(next)}
          onReset={() => getDesktopBridge()?.resetPanelWidth?.()}
          testId="panel-divider"
          className="panel-divider"
          style={{ right: panelWidth }}
        />
      ) : null}
      <IncomingCallBanner
        onAccept={(callId, chatId) => acceptCall(wsRef.current, callId, chatId, navigate)}
        onDismiss={(callId) => dismissCall(wsRef.current, callId)}
      />
      <VoiceNoteOverlay />
      <VoicePermissionBanner
        onRespond={(requestId, approve) => {
          try {
            const perm = useVoiceStore.getState().permission;
            if (!perm || perm.requestId !== requestId) {
              throw new Error(`no voice permission for request ${requestId}`);
            }
            permissionDeliveryTracker.send(
              {
                type: 'chat.permission_response',
                chatId: perm.chatId,
                requestId,
                approve,
                decision: approve ? 'approve' : 'deny',
              },
              (event) => wsRef.current?.send(event),
            );
            // Tapping Approve/Deny on the in-voice banner must resolve the
            // SAME pending request the inline message-list card shows — not
            // just dismiss the banner. Optimistically flip the inline card
            // (the host's `chat.permission_response` echo settles it too,
            // and resolvePermission is idempotent), mirroring the inline and
            // right-rail tap paths. The voiceStore permission carries the
            // chatId since the banner only forwards requestId/approve.
            useChatStore
              .getState()
              .resolvePermission(perm.chatId, requestId, approve ? 'approve' : 'deny');
          } catch (e) {
            pushError(failed('permission send'), undefined, (e as Error).message);
          }
        }}
      />
      <ShortcutCheatSheet />
      <ConnectionDiagnosticsGate />
      <ErrorToasts />
      <ConfirmModal />
      <PromptModal />
      <TooltipHost />
    </div>
  );
}

function navigateChat(
  delta: number,
  location: { pathname: string },
  navigate: (to: string) => void,
): void {
  const chats = useChatStore.getState().chats;
  const ordered = Object.values(chats)
    .filter((c) => c.status !== 'archived')
    .sort((a, b) => b.lastUpdated - a.lastUpdated);
  if (ordered.length === 0) return;
  const match = location.pathname.match(/\/chats\/([^/]+)/);
  const currentId = match ? match[1] : null;
  const idx = currentId ? ordered.findIndex((c) => c.chatId === currentId) : -1;
  let nextIdx: number;
  if (idx < 0) {
    nextIdx = delta > 0 ? 0 : ordered.length - 1;
  } else {
    nextIdx = (idx + delta + ordered.length) % ordered.length;
  }
  const next = ordered[nextIdx];
  if (next) navigate(`/chats/${next.chatId}`);
}

/**
 * ⌘⇧↑ / ⌘⇧↓ — jump to the first chat row of the previous / next folder
 * section. Folder order mirrors the sidebar: folders ranked by most-recent
 * activity. Archived and special threads are not part of the folder list.
 */
function navigateFolder(
  delta: number,
  location: { pathname: string },
  navigate: (to: string) => void,
): void {
  const chats = Object.values(useChatStore.getState().chats).filter(
    (c) =>
      c.status !== 'archived' &&
      !c.pinned &&
      c.chatId !== SPECIAL_THREAD_IDS.manager &&
      c.chatId !== SPECIAL_THREAD_IDS.speakers &&
      c.folder,
  );
  if (chats.length === 0) return;
  const byFolder = new Map<string, typeof chats>();
  for (const c of chats) {
    const list = byFolder.get(c.folder) ?? [];
    list.push(c);
    byFolder.set(c.folder, list);
  }
  // Folders ordered by most-recent activity (matches Sidebar.groupChats).
  const folders = Array.from(byFolder.entries())
    .map(([folder, rows]) => ({
      folder,
      rows: [...rows].sort((a, b) => b.lastUpdated - a.lastUpdated),
      maxAt: Math.max(...rows.map((r) => r.lastUpdated), 0),
    }))
    .sort((a, b) => b.maxAt - a.maxAt);
  /* v8 ignore next -- defensive only: `chats` (filtered above, `chats.length === 0` already returned) only keeps rows with a truthy `c.folder`, so `byFolder` always gains at least one entry and `folders` can never be empty here. */
  if (folders.length === 0) return;
  const match = location.pathname.match(/\/chats\/([^/]+)/);
  const currentId = match ? match[1] : null;
  const current = currentId ? useChatStore.getState().chats[currentId] : undefined;
  const curIdx = current ? folders.findIndex((f) => f.folder === current.folder) : -1;
  let nextIdx: number;
  if (curIdx < 0) nextIdx = delta > 0 ? 0 : folders.length - 1;
  else nextIdx = (curIdx + delta + folders.length) % folders.length;
  const target = folders[nextIdx]?.rows[0];
  if (target) navigate(`/chats/${target.chatId}`);
}

function acceptCall(
  ws: PatchWs | null,
  callId: string,
  chatId: string,
  navigate: (to: string) => void,
): void {
  ws?.send({ type: 'chat.call_response', callId, response: 'accept' });
  useVoiceStore.getState().setIncoming(null);
  navigate(`/chats/${chatId}`);
  // Accept → open the voice-call overlay (spec/14 ## Manager incoming-call UX:
  // "Accept → opens Manager voice session"). The controller mints a voice-call
  // token and opens the audio WSS for the agent-initiated call.
  void startVoiceCall(chatId);
}

function dismissCall(ws: PatchWs | null, callId: string): void {
  ws?.send({ type: 'chat.call_response', callId, response: 'decline' });
  useVoiceStore.getState().setIncoming(null);
}
