// DEV-ONLY visual harness — see dev-harness.html.
//
// Mounts the REAL Sidebar + ChatRoute components against hydrated mock stores
// to verify spec/06 presentational policy in a real browser:
//   - Channels section (Speakers) collapsed by default.
//   - Speakers renders a read-only mirror (no composer) when opened.
//   - Manager keeps its full composer.
// This file is never imported by the production entry (main.tsx); Vite only
// bundles it for dev-harness.html.

import { StrictMode, useEffect } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './components/Sidebar.js';
import { MiniSidebar } from './components/MiniSidebar.js';
import { SidebarWindowRoute } from './routes/SidebarWindowRoute.js';
import { SidebarExpandButton } from './components/SidebarExpandButton.js';
import { useDiscardUnsentNewChats } from './lib/unsentNewChat.js';
import { SidebarBackdrop } from './components/SidebarBackdrop.js';
import { ColumnDivider } from './components/ColumnDivider.js';
import { ChatPaneRoute } from './routes/ChatPaneRoute.js';
import { NewChatRoute } from './routes/NewChatRoute.js';
import { SettingsPaneRoute } from './routes/SettingsPaneRoute.js';
import { JobPaneRoute } from './routes/JobPaneRoute.js';
import { JobsPaneRoute } from './routes/JobsPaneRoute.js';
import { LifecycleRoute } from './routes/LifecycleRoute.js';
import { IndexRedirect } from './routes/IndexRedirect.js';
import { ToolsPanel } from './components/ToolsPanel.js';
import { SideThreadsPanel } from './components/SideThreadsPanel.js';
import { useSideThreadsStore } from './stores/sideThreadsStore.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { PromptModal } from './components/PromptModal.js';
import { DevErrorOverlay } from './components/DevErrorOverlay.js';
import { ErrorToasts } from './components/ErrorToasts.js';
import { TooltipHost } from './components/TooltipHost.js';
import { useBatchWatcher } from './lib/batchNotifier.js';
import { useBatchStore } from './stores/batchStore.js';
import { useDesktopNavigation } from './lib/desktopNavigation.js';
import { VoiceBar } from './components/VoiceBar.js';
import { DesktopUpdateBanner } from './components/DesktopUpdateBanner.js';
import { OfflineBanner } from './components/OfflineBanner.js';
import { DaemonOfflineBanner } from './components/DaemonOfflineBanner.js';
import { useChatStore } from './stores/chatStore.js';
import { useUiStore, SIDEBAR_MINI_WIDTH } from './stores/uiStore.js';
import { usePreferencesStore } from './stores/preferencesStore.js';
import { useVoiceStore } from './stores/voiceStore.js';
import { useMeetingStore } from './stores/meetingStore.js';
import type { MeetingState } from '@patch/wire';
import { useDraftStore } from './stores/draftStore.js';
import { useComposerDraftStore } from './stores/composerDraftStore.js';
import type { ChatEventEntry } from './stores/chatStore.js';
import { usePresenceStore } from './stores/presenceStore.js';
import { useTerminalStore } from './stores/terminalStore.js';
import { resolvePane, useLayoutStore } from './stores/layoutStore.js';
import { setActiveWs, type PatchWs } from './api/ws.js';
import { setModelCatalog } from './lib/models.js';
import type { WireEvent } from '@patch/wire';
import { focusPageSearch } from './lib/searchTarget.js';
import { useShortcuts, isChatViewPath, type ShortcutHandlers } from './lib/shortcuts.js';
import { composerHotkeyDown, composerHotkeyUp } from './lib/composerMic.js';
import { useShiftClickGuard } from './lib/shiftClickGuard.js';
import { useResponsiveShell } from './lib/responsiveShell.js';
import { useSectionCounts } from './lib/sectionCounts.js';
import { useDocumentTitleSync } from './lib/documentTitle.js';
import { installDevErrorQueue } from './lib/devErrorQueue.js';
import { initWindowChrome } from './lib/windowChrome.js';
import './index.css';

// Install the dev error queue collectors at harness boot — before any
// component renders so we capture errors from the very first render.
installDevErrorQueue();

// Mirrors main.tsx's spec/05 § Window chrome boot hook, so e2e can stub
// `window.patch.overlayTitleBar` and measure the REAL traffic-light inset and
// drag regions against the real CSS. Without the mirror the harness would only
// ever be told about a class it never applies.
initWindowChrome();

// Mirrors main.tsx's retry/refetch config — the default `retry: 3` with
// backoff made an e2e stub a real error only after ~30s (a stubbed failure
// never succeeds on retry, so it's pure wasted wall-clock, in the harness or
// in prod).
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// `chat_job_trigger` only carries `jobId` when IT is the chat being opened —
// every dev-harness page load hydrates this fixture, and any `jobId` here
// makes the store's Automations grouping (`Sidebar.tsx`) include it
// regardless of the chat actually on screen, which broke
// `automations-sidebar.spec.ts`'s "empty when no job has spawned a chat"
// case. Scoping it to `?chat=chat_job_trigger` keeps that spec's harness
// load (no `?chat=`) automations-free.
const openingJobTriggerFixture =
  new URLSearchParams(window.location.search).get('chat') === 'chat_job_trigger';

// `?recency=machine` gives the new-chat screen's recently used models
// something to ignore: a job-spawned chat and the Manager thread, both NEWER
// than the one chat a person started (`chat_bus`), each on a model of its own
// (spec/14 § Sidebar §8). Scoped to the param for the same reason as
// `openingJobTriggerFixture` — a `jobId` fills the Automations group.
const machineRecencyFixture =
  new URLSearchParams(window.location.search).get('recency') === 'machine';

// Hydrate the real chat store with the three special threads plus a regular
// chat, exactly as the host would emit them.
useChatStore.getState().hydrate([
  {
    chatId: 'thread_manager',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'manager',
    folder: '/home/tom/.patch/threads/manager',
    activity: 'idle',
    status: 'active',
    pinned: true,
    pinnedAt: 50,
    disabled: false,
    lastUpdated: machineRecencyFixture ? 90 : 3,
    ...(machineRecencyFixture ? { model: 'claude-haiku-4-5' } : {}),
  },
  ...(machineRecencyFixture
    ? [
        {
          chatId: 'jobchat-nightly',
          daemonId: 'd1',
          permissionMode: 'auto' as const,
          name: 'nightly-job-fixture',
          folder: '/home/tom/projects/bus',
          activity: 'idle' as const,
          status: 'active' as const,
          pinned: false,
          pinnedAt: null,
          disabled: false,
          lastUpdated: 99,
          jobId: 'job_nightly',
          model: 'claude-opus-4-1',
        },
      ]
    : []),
  {
    chatId: 'thread_speakers',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'speakers',
    folder: '/home/tom/.patch/threads/speakers',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  },
  {
    chatId: 'chat_bus',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'bus-watch',
    folder: '/home/tom/projects/bus',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 4,
    // The model this chat resolved to at spawn (spec/04 § Spawn) — shown in
    // the header's folder crumb (ChatHeader.tsx).
    model: 'claude-sonnet-4-6',
    // A pending self-wake (spec/02 § Self-wake) — the bus-watch loop's next
    // tick. Drives the wake bar above the transcript (patch/todo.md — "cron
    // should be visible in a bar above the chat").
    pendingWake: {
      message: 'check whether the 36 has left the depot',
      fireAt: Date.now() + 9 * 60_000,
    },
  },
  // spec/02 § Self-wake — "count the interval from the end of the turn": a
  // loop tick came due while this chat's own turn was still running, so it
  // was absorbed rather than queued (`pendingWake.waiting`). The bar reads
  // "waiting for current turn" instead of a countdown to the stale `fireAt`
  // (`wake-bar.spec.ts`).
  {
    chatId: 'chat_loop_waiting',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'deploy-watch',
    folder: '/home/tom/projects/deploy-watch',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 4,
    pendingWake: {
      message: 'check whether the deploy finished',
      fireAt: Date.now() - 60_000,
      every: 5 * 60_000,
      waiting: true,
    },
  },
  {
    chatId: 'chat_md',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'July Seasonal Food',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 5,
  },
  // A reply built around a wide many-column table (spec/14 § Wide tables) —
  // drives the table e2e. On its own fixture so the markdown/typography specs'
  // chat keeps its exact shape.
  {
    chatId: 'chat_table',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'Tea prices',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 5,
  },
  // A chat whose permission mode was changed part-way through (spec/02 §
  // Permission mode) — drives the mode-change line e2e. On its own fixture so
  // the transcript-spacing and markdown specs' chats keep their exact shape.
  {
    chatId: 'chat_perm_mode',
    daemonId: 'd1',
    permissionMode: 'acceptEdits' as const,
    name: 'kettle spares',
    folder: '/home/tom/projects/bus',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 5,
  },
  // A chat Claude Code itself landed on `plan` (spec/02 § Permission mode's
  // plan-mode exception) — drives the AUTOMATIC mode-change line e2e, proving
  // it reads differently from a person's own switch above.
  {
    chatId: 'chat_perm_mode_auto',
    daemonId: 'd1',
    permissionMode: 'plan' as const,
    name: 'overnight refactor',
    folder: '/home/tom/projects/bus',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 5,
  },
  // A goal plus a task list (spec/02 § Task list, spec/14 § Main chat panel) —
  // drives the goal-bar / task-bar e2e. Kept on its own fixture so the wake-bar
  // and transcript-spacing specs' chats keep their existing bar stack.
  {
    chatId: 'chat_tasks',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'index-rebuild',
    folder: '/home/tom/projects/bus',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 6,
    goal: 'Get the search index rebuilding nightly',
    todos: [
      { text: 'read the current indexer', status: 'completed' as const },
      { text: 'rebuild the index', status: 'in_progress' as const },
      { text: 'schedule it nightly', status: 'pending' as const },
    ],
  },
  // Claude Code's own provider-level context (spec/02 § Provider-level
  // context) — drives the ProviderContextPanel e2e. On its own fixture so the
  // goal/task-bar spec's chat keeps its exact bar stack; `providerContext`
  // itself is seeded below via the real `chat.provider_context` reducer, not
  // here (it is event-sourced, never part of the REST hydrate shape).
  {
    chatId: 'chat_provider_context',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'provider context demo',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 6,
  },
  // A turn a host restart cut off and re-sent with its restart reminder
  // (spec/02 § System-reminder disclosure) — drives the system-context e2e.
  // Its transcript is seeded below through the real `chat.message` reducer.
  {
    chatId: 'chat_system_context',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'system context demo',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 6,
  },
  // Two type-ahead turns parked behind a running turn (spec/04 ## Message
  // queueing) — drives the queued-message e2e: the hover-revealed promote (↑)
  // next to the remove (×).
  {
    chatId: 'chat_queued',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'queued-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A turn the user stopped with nothing queued behind it (spec/14 §
  // Running-turn controls) — drives the stopped-message e2e: the status line
  // plus its Continue, on a chat settled back to idle with no reply and no
  // error.
  {
    chatId: 'chat_stopped',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'stopped-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A turn cut off by a newer message getting promoted ahead of it (spec/14 §
  // Running-turn controls) — drives the interrupted-message e2e: the muted
  // status line with no action, on a chat that stayed `running` throughout
  // (the promoted turn's own run).
  {
    chatId: 'chat_interrupted',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'interrupted-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A forked chat (spec/04 § Branching) — drives the edit/track-switch e2e:
  // the hover-revealed pencil on a user turn and the ‹ 2/2 › switcher on the
  // fork point.
  {
    chatId: 'chat_forked',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'forked-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A turn carrying an inline image attachment (spec/14 § Composer) — drives
  // the lightbox e2e: only a real browser can prove the overlay covers the
  // WHOLE window rather than being clipped to the chat panel.
  {
    chatId: 'chat_image',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'image-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A turn that fired a run of tools around one file edit (spec/14 § Main chat
  // panel — "Tool runs collapse to one row") — drives the tool-group e2e.
  {
    chatId: 'chat_tools',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'tools-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A live turn narrating between tool runs — prose, a run, prose, a run, a
  // lone call still in flight — the shape every real agent turn takes. Drives
  // the transcript-rhythm e2e (spec/14 § Breathing room).
  {
    chatId: 'chat_tool_rhythm',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'tool-rhythm-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // Single tool calls, each outside any run, so the collapsed one-line summary
  // is the ONLY thing on screen for them (spec/14 § Main chat panel — Tool
  // calls) — drives the tool-call summary e2e.
  {
    chatId: 'chat_tool_single',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'single-tool-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  {
    chatId: 'chat_scroll',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'scroll-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // No seeded timeline — driven live via `__store.applyEvent` by the spec
  // itself (a re-delivered `chat.replay` doesn't duplicate/reorder tool
  // calls — spec/12 § "No message deduplication beyond seq").
  {
    chatId: 'chat_replay_dupe',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'replay-dupe-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // No seeded timeline — driven live via `__store.applyEvent` by the spec
  // itself (spec/04 § Activity: the server's daemon-link-lost notice must
  // disappear from the transcript once the host comes back).
  {
    chatId: 'chat_daemon_blip',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'daemon-blip-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A patch_notify call carrying a deepLink (spec/09 § `### push`, spec/14 ##
  // Main chat panel) — drives the tappable-link-on-the-collapsed-summary e2e.
  {
    chatId: 'chat_deeplink',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'deeplink-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A `Skill` tool call (spec/14 ## Main chat panel — the Skill tool-call
  // link + tooltip) — drives the "links to the skill's SKILL.md, tooltip
  // shows its description" e2e. Folder matches `?editor=browse`'s stub tree,
  // which already has `.claude/skills/plant/SKILL.md`.
  {
    chatId: 'chat_skill',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'skill-call-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A tool result carrying an Anthropic image content block (spec/14 § Tool
  // calls) — drives the "renders as a picture, not raw base64" e2e.
  {
    chatId: 'chat_tool_image',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'tool-image-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A tool call folded together with its own result (spec/14 § Tool calls) —
  // drives the "one row, not two" e2e.
  {
    chatId: 'chat_tool_paired',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'tool-paired-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A `view_file` call showing a page inline (spec/14 § Viewing files).
  {
    chatId: 'chat_view_file',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'view-file-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A `view_file` call showing an image inline (spec/14 § Viewing files) —
  // drives the click-to-lightbox e2e.
  {
    chatId: 'chat_view_file_image',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'view-file-image-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A `view_file` call showing a PDF inline (spec/14 § Viewing files) — same
  // sandboxed-frame treatment as an HTML page, not the image/lightbox path.
  {
    chatId: 'chat_view_file_pdf',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'view-file-pdf-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // Archived chat — reuses the portfolio folder (no new sidebar folder row) and,
  // being archived, lives in the collapsed Archived section so it doesn't alter
  // the active list. `?chat=chat_archived` opens it in the main panel to verify
  // the Archived banner + Unarchive control (patch/todo.md).
  {
    chatId: 'chat_archived',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'old cleanup',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'archived',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // Hidden chat (spec/04 § Hidden) — running, but out of the active list, so it
  // lives only in the collapsed Hidden section and leaves every other list as
  // it was. `?chat=chat_hidden` opens it to verify the Hidden banner + Show.
  {
    chatId: 'chat_hidden',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'inbox triage run',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    hidden: true,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A long-unbroken-string fixture (todo item: "long text in a message flows
  // over the edge of the message box") — drives the message-overflow e2e.
  {
    chatId: 'chat_long_text',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'long-text-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A user message typed with single newlines — drives the user-newlines e2e.
  {
    chatId: 'chat_user_newlines',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'user-newlines-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // spec/14 § Messages — Long user messages collapse (accordion) — drives
  // the accordion-collapse e2e.
  {
    chatId: 'chat_long_user_message',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'long-user-message-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // spec/14 § Message links — drives the link-preview e2e: an assistant
  // message containing an http(s) link.
  {
    chatId: 'chat_link_preview',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'link-preview-fixture',
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A job-spawned chat (spec/08 § Action) — drives the job-trigger e2e: the
  // first user turn (the job's raw prompt/payload) renders as quiet
  // furniture, not a plain user bubble; a later, normal user reply does not.
  {
    chatId: 'chat_job_trigger',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'job-trigger-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    ...(openingJobTriggerFixture ? { jobId: 'job_bus_watch' } : {}),
  },
  // spec/14 § Job trigger turn — drives the later-fire half of the e2e: a
  // `continue`/`message` action's fire into this chat carries its own
  // `jobTrigger` flag and gets the same quiet treatment, even though it is
  // not the chat's first turn and this chat carries no `jobId` at all — proof
  // the flag is read per-message, not inferred from job-chat membership.
  {
    chatId: 'chat_job_trigger_later_fire',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'job-trigger-later-fire-fixture',
    // A folder of its own, and deliberately NOT sharing any substring with
    // another fixture's folder name (`bus`, `garden`, `portfolio`, …): several
    // sidebar e2e specs locate a folder header by `hasText`, which is a
    // substring match, so e.g. `bus-watch-2` would double-match the existing
    // `.../bus` fixture's header.
    folder: '/home/tom/projects/triggers',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // spec/14 § Background task completions — drives the raw-notification e2e: a
  // replayed chat where a background task's whole `<task-notification>` block
  // arrived as a user turn.
  {
    chatId: 'chat_task_notification',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'task-notification-fixture',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // spec/14 § Main chat panel — Background task bar. An idle chat with two
  // background tasks still running and a third already finished, so the bar has
  // a count to get wrong and a completion to have honoured.
  {
    chatId: 'chat_bgtask',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'background-task-fixture',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    // spec/14 § Status badges — the same two tasks, as the host reports them
    // on `chat.state`. The sidebar never sees this chat's transcript, so this
    // count is all its row has to go on; it matches the bar's deliberately, so
    // the two readouts can be checked against each other in one browser.
    backgroundTasks: 2,
  },
  // job-editor-origin e2e (job-editor-back.spec.ts) — a chat whose transcript
  // carries a `patch_job_create` row with an Open job link, so the spec can
  // click through into the editor and prove Back returns HERE rather than
  // always landing on the jobs list.
  {
    chatId: 'chat_job_open_link',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'job-open-link-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // spec/14 § Status badges — `monitoring`: a self-wake armed and nothing else
  // going on. `activity: 'idle'` (not `running`, which would show `working`
  // first) and no `backgroundTasks`/unread — the ONLY signal is `pendingWake`.
  {
    chatId: 'chat_monitoring',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'monitoring-fixture (self-wake armed)',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    pendingWake: { message: 'check back in 10 minutes', fireAt: Date.now() + 600_000 },
  },
  // spec/14 § Status badges — a declared `question` (`patch_ask_human`) drives
  // the SAME `permission` badge as a native pending request ("same difference
  // as needs you"). `activity: 'idle'` deliberately: a declared question is
  // not a blocking SDK gate, so `awaiting-permission` never applies here — the
  // badge has to come from `statusKind` alone or this fixture proves nothing.
  {
    chatId: 'chat_declared_question',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'declared-question-fixture (patch_ask_human)',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    statusKind: 'question' as const,
    statusSummary: 'Grant Screen Recording permission in System Settings',
  },
  // An unanswered `AskUserQuestion` card mid-transcript — drives the Other-box
  // e2e (spec/14 § Main chat panel — Question prompts): `↵`/`⇧↵` insert a
  // newline in the free-text answer, `⌘↵`/`Ctrl↵` send. `activity: 'idle'`
  // deliberately, even though a real pending question would be
  // `awaiting-permission`: the card is drawn from the TIMELINE entry, not the
  // row's activity, and an `awaiting-permission` row can never be marked read,
  // so it would permanently break `attention-empty-spacing.spec.ts`'s
  // mark-everything-read empty state.
  {
    chatId: 'chat_question',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'question-fixture',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // Two pending questions on the host's clock: one with a whole minute left
  // and one about to run out, so the countdown ring can be watched depleting
  // AND watched reaching zero in a single load (spec/14 § Main chat panel —
  // Question prompts). `activity: 'idle'` for the same reason as
  // `chat_question` above.
  {
    chatId: 'chat_question_timer',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'question-timer-fixture',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // Every state of the question card at once, next to a real approval card, so
  // the styling e2e can compare them in one screenshot and one page load:
  // pending / answered / unreadable question, plus a pending and an answered
  // approval (spec/14 § Main chat panel — Question prompts, § Permission
  // prompts). `activity: 'idle'` for the same reason as `chat_question` above.
  {
    chatId: 'chat_question_styles',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'question-styles-fixture',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A resolved `AskUserQuestion` in every shape its stored answer can take —
  // single-select, multi-select, and free-text `Other` — so the e2e can prove
  // a real browser still paints the SELECTION on an answered card rather than
  // just the "Answered" outcome (Todoist: "patch previous question answers
  // are not being stored"; spec/14 § Main chat panel — Question prompts).
  // `activity: 'idle'` for the same reason as `chat_question` above.
  {
    chatId: 'chat_question_answered',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'question-answered-fixture',
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
  // A chat blocked on a usage limit with NO resume armed — auto-resume off
  // (spec/12). The host publishes the structured block and no
  // `rateLimitResumingAt`, and reports the failure in patch's own words; the
  // provider's sentence about a monthly spend limit is not part of it.
  {
    chatId: 'chat_limit_blocked',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'limit-blocked-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'errored',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    rateLimitResumingAt: null,
    limitBlock: {
      accountId: 'default',
      accountLabel: 'Default',
      scope: 'week' as const,
      utilization: 1,
      resetsAt: Date.now() + 3 * 3_600_000,
      overageBlocked: true,
      overageReason: 'org_level_disabled_until',
      raw: "Claude Code returned an error result: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Sep 15, 4am (UTC)",
    },
  },
  // The same limit, with its stated reset already BEHIND us and the turn still
  // un-run (spec/12). Drives the e2e for what the notice says once the wait is
  // over, and for it withdrawing itself the moment the chat reports a turn in
  // flight.
  {
    chatId: 'chat_limit_past_reset',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'limit-past-reset-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'errored',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    rateLimitResumingAt: null,
    limitBlock: {
      accountId: 'default',
      accountLabel: 'Default',
      scope: 'session' as const,
      utilization: 1,
      resetsAt: Date.now() - 20 * 60_000,
      raw: "Claude Code returned an error result: You've hit your monthly spend limit",
    },
  },
  // The exact reproduction of Todoist "patch error is wrong": a limitBlock
  // whose resetsAt is literally epoch 0 (an upstream header/probe reading
  // gone wrong — see @patch/auth's claude-usage.test.ts and host's
  // limit-block-invented-reset.test.ts). Must render exactly like "no reset
  // stated" — no countdown/elapsed text — never `now - 0`, the ~56-year gap
  // that read "That was 20690 days 23 hours ago".
  {
    chatId: 'chat_limit_epoch_reset',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'limit-epoch-reset-fixture',
    folder: '/home/tom/projects/bus',
    activity: 'errored',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    rateLimitResumingAt: null,
    limitBlock: {
      accountId: 'default',
      accountLabel: 'Default',
      scope: 'session' as const,
      utilization: 1,
      resetsAt: 0,
      raw: "Claude Code returned an error result: You've hit your monthly spend limit",
    },
  },
  // A row naming neither a host nor a folder — the shape chatStore's `emptyRow`
  // seeds optimistically before `chat.spawned` lands. Drives the header-crumb
  // e2e: with nothing known the crumb must draw nothing at all, rather than its
  // separators and a placeholder (spec/14 § Chat panel header).
  {
    chatId: 'chat_no_folder',
    daemonId: '',
    permissionMode: 'auto' as const,
    name: 'no-folder-fixture',
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  },
]);

// `hydrate()` cannot set `lastReadSeq` (spec/14 § Status badges — it is
// local-only read state, never carried on the wire), so every freshly
// hydrated row defaults to `-1`: unread by construction, same as a chat
// nobody has opened yet. Real usage never notices, because opening a chat is
// what marks it read (`sidebar-background-badge.spec.ts` proves `chat_bgtask`
// this way, via `?chat=chat_bgtask`) — but a fixture meant to demonstrate a
// QUIET badge (`background`, `monitoring`) in the sidebar's OWN list, without
// requiring a click into it first, has to be marked read explicitly or it
// shows `done` instead, per "unread beats background/monitoring, always".
for (const id of ['chat_bgtask', 'chat_monitoring']) {
  useChatStore.getState().markRead(id);
}

// A markdown reply with headings, paragraphs, a rule and both list kinds (one
// of them nested), so the transcript e2e can assert headings render in the BODY
// font (not Fraunces serif), the `---` is a quiet low-opacity divider, block
// spacing is tight, and list markers survive the CSS reset (spec/14 § Type,
// § Breathing room → List markers). Seeded on BOTH chat_bus (existing
// composer/transcript spec) and chat_md.
const markdownReply: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'whats in season in july', at: 1 },
  {
    seq: 2,
    kind: 'message',
    role: 'assistant',
    content: [
      '## Endozoochory',
      'Peak sunlight means maximum sugar conversion in the fruit.',
      '',
      '- Blackcurrants',
      '- Gooseberries',
      '  - Hinnonmaki Red',
      '',
      '---',
      '',
      '## Legume Pods',
      'Nitrogen-fixing roots invest the surplus protein into the seed.',
      '',
      '1. Broad beans',
      '2. Mangetout',
      '',
      'Pick them with `harvest()`:',
      '',
      '```js',
      "const pods = harvest('mangetout');",
      'return pods.length;',
      '```',
    ].join('\n'),
    at: 2,
  },
];
// A reply whose substance is a WIDE table — ten narrow columns, the shape an
// agent produces when it compares options, and the shape the 780px reading
// measure cannot hold (spec/14 § Wide tables). Carries a prose paragraph in the
// same message (which must stay at the measure) and a two-column table (which
// must stay at its own natural width rather than being stretched), so one
// fixture covers all three behaviours.
const wideTableReply: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'compare the darjeeling sellers', at: 1 },
  {
    seq: 2,
    kind: 'message',
    role: 'assistant',
    content: [
      'Ten sellers ship a first-flush Darjeeling to the UK, and the delivered',
      'price per 100g is the only figure that ranks them honestly, since the',
      'pack sizes and the postage both move.',
      '',
      '| Product | Size | Goods | Delivery | Delivered | £/100g | Estate named | Harvest date | Milk? | Stock |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| Rare Tea Co | 50g | £21.50 | £3.95 | £25.45 | £50.90 | Jungpana | 1st flush 2026 | no | in stock |',
      '| Postcard Teas | 100g | £18.00 | £4.50 | £22.50 | £22.50 | Gopaldhara | 2nd flush 2026 | both | in stock |',
      '| Canton Tea | 125g | £36.00 | £0.00 | £36.00 | £28.80 | Castleton | 1st flush 2026 | no | backorder |',
      '| Tea Palace | 200g | £29.95 | £5.95 | £35.90 | £17.95 | Margaret Hope | autumnal 2025 | both | in stock |',
      '',
      'The rest are blends sold under a regional name, so the estate column is',
      'the one that actually separates them.',
      '',
      '| Grade | Leaf |',
      '| --- | --- |',
      '| FTGFOP | whole |',
      '| BOP | broken |',
    ].join('\n'),
    at: 2,
  },
];
// A `Monitor` call on the bus-watch chat, predating `Monitor`/`TaskStop` being
// disallowed (spec/14 § Monitors (historical)): the tool call plus the result
// that reports its task id. Proves a pre-existing transcript still replays
// the call as an ordinary tool-call row — it is no longer a background-task-
// bar row.
const monitorEntries: ChatEventEntry[] = [
  {
    seq: 3,
    kind: 'tool_call',
    tool: 'Monitor',
    toolArgs: {
      command: 'tail -f /var/log/bus.log | grep --line-buffered "36 departed"',
      description: 'departures on the 36',
      persistent: true,
    },
    callId: 'call-monitor-1',
    at: 3,
  },
  {
    seq: 4,
    kind: 'tool_result',
    tool: 'Monitor',
    toolResult:
      'Monitor started (task task_bus36, persistent — runs until TaskStop or session end).',
    callId: 'call-monitor-1',
    at: 4,
  },
];
// A context compression part-way through the chat (spec/14 § Context
// compression) — the quiet one-line disclosure that expands to the figures.
const compactionEntry: ChatEventEntry = {
  seq: 3,
  kind: 'compaction',
  content: 'Context compressed · 168k → 42k',
  compaction: { trigger: 'auto', preTokens: 168165, postTokens: 42118, durationMs: 3210 },
  at: 3,
};
// A permission-mode change made part-way through the conversation (spec/02 §
// Permission mode) — the quiet rule the transcript draws where it happened,
// with turns either side of it.
const permissionModeEntries: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'find me a replacement lid', at: 1 },
  { seq: 2, kind: 'message', role: 'assistant', content: 'No UK spares exist for it.', at: 2 },
  {
    seq: 3,
    kind: 'permission_mode',
    content: 'Permission mode \u2192 acceptEdits',
    permissionMode: 'acceptEdits',
    at: 3,
  },
  { seq: 4, kind: 'message', role: 'user', content: 'try the repair caf\u00e9s then', at: 4 },
];
// The plan-mode exception (spec/02 \u00a7 Permission mode): Claude Code itself
// landed the chat on `plan` rather than the mode the turn was given, so the
// same quiet rule is drawn \u2014 with a note that it was Claude Code's doing, not
// the mode control.
const permissionModeAutomaticEntries: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'run the whole refactor overnight', at: 1 },
  {
    seq: 2,
    kind: 'permission_mode',
    content: 'Permission mode \u2192 plan (set by Claude Code)',
    permissionMode: 'plan',
    permissionModeChangeAutomatic: true,
    at: 2,
  },
  { seq: 3, kind: 'message', role: 'assistant', content: 'Starting in plan mode.', at: 3 },
];
// A turn that fired six tools around one file edit: the run before the edit and
// the run after it each collapse to a single row, while the edit keeps its own
// row and inline diff (spec/14 § Main chat panel — "Tool runs collapse to one
// row").
// See `chat_tool_rhythm` above.
const toolRhythmEntries: ChatEventEntry[] = [
  {
    seq: 1,
    kind: 'message',
    role: 'user',
    content: 'tidy the poller',
    at: 1,
    messageAt: 1760000000000 + 1000,
  },
  {
    seq: 2,
    kind: 'message',
    role: 'assistant',
    content: 'Looking at the poller first.',
    at: 2,
    messageAt: 1760000000000 + 2000,
  },
  {
    seq: 3,
    kind: 'tool_call',
    tool: 'Grep',
    toolArgs: { pattern: 'timeout' },
    callId: 'r1',
    at: 3,
  },
  { seq: 4, kind: 'tool_result', tool: 'Grep', toolResult: { files: 2 }, callId: 'r1', at: 4 },
  {
    seq: 5,
    kind: 'tool_call',
    tool: 'Read',
    toolArgs: { file_path: 'src/poll.ts' },
    callId: 'r2',
    at: 5,
  },
  { seq: 6, kind: 'tool_result', tool: 'Read', toolResult: { lines: 120 }, callId: 'r2', at: 6 },
  {
    seq: 7,
    kind: 'message',
    role: 'assistant',
    content: 'Now running the tests.',
    at: 7,
    messageAt: 1760000000000 + 7000,
  },
  {
    seq: 8,
    kind: 'tool_call',
    tool: 'Bash',
    toolArgs: { command: 'pnpm test', description: 'Run the suite' },
    callId: 'r3',
    at: 8,
  },
  { seq: 9, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, callId: 'r3', at: 9 },
  {
    seq: 10,
    kind: 'tool_call',
    tool: 'Bash',
    toolArgs: { command: 'pnpm lint', description: 'Lint' },
    callId: 'r4',
    at: 10,
  },
  { seq: 11, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, callId: 'r4', at: 11 },
  {
    seq: 12,
    kind: 'message',
    role: 'assistant',
    content: 'Building it.',
    at: 12,
    messageAt: 1760000000000 + 12000,
  },
  {
    seq: 13,
    kind: 'tool_call',
    tool: 'Bash',
    toolArgs: { command: 'pnpm build' },
    callId: 'r5',
    at: 13,
  },
];

// A two-command run with call ids, so a test can attach a tool-run summary to it.
const toolRunFailedEntries: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'run the checks', at: 1 },
  { seq: 2, kind: 'tool_call', tool: 'Bash', callId: 'f1', toolArgs: { command: 'ls' }, at: 2 },
  { seq: 3, kind: 'tool_result', tool: 'Bash', callId: 'f1', toolResult: { stdout: '' }, at: 3 },
  { seq: 4, kind: 'tool_call', tool: 'Bash', callId: 'f2', toolArgs: { command: 'pwd' }, at: 4 },
  { seq: 5, kind: 'tool_result', tool: 'Bash', callId: 'f2', toolResult: { stdout: '' }, at: 5 },
];

const toolRunEntries: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'bump the timeout', at: 1 },
  { seq: 2, kind: 'tool_call', tool: 'Grep', toolArgs: { pattern: 'timeout' }, at: 2 },
  { seq: 3, kind: 'tool_result', tool: 'Grep', toolResult: { files: ['src/poll.ts'] }, at: 3 },
  { seq: 4, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'src/poll.ts' }, at: 4 },
  { seq: 5, kind: 'tool_result', tool: 'Read', toolResult: { lines: 120 }, at: 5 },
  { seq: 6, kind: 'tool_call', tool: 'Glob', toolArgs: { pattern: 'src/**/*.ts' }, at: 6 },
  { seq: 7, kind: 'tool_result', tool: 'Glob', toolResult: { matches: 12 }, at: 7 },
  {
    seq: 8,
    kind: 'tool_call',
    tool: 'Edit',
    toolArgs: {
      file_path: 'src/poll.ts',
      old_string: 'const timeout = 5_000;\n',
      new_string: 'const timeout = 30_000;\n',
    },
    at: 8,
  },
  { seq: 9, kind: 'tool_result', tool: 'Edit', toolResult: { ok: true }, at: 9 },
  { seq: 10, kind: 'tool_call', tool: 'Bash', toolArgs: { command: 'pnpm test' }, at: 10 },
  { seq: 11, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, at: 11 },
  { seq: 12, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'src/poll.ts' }, at: 12 },
  { seq: 13, kind: 'tool_result', tool: 'Read', toolResult: { lines: 120 }, at: 13 },
  { seq: 14, kind: 'message', role: 'assistant', content: 'Done — 5s to 30s.', at: 14 },
];
// Three calls that each sit ALONE between turns, so none of them folds into a
// run: one carrying its own description, one named only by the file it read,
// and one with nothing nameable at all (spec/14 § Main chat panel — Tool
// calls).
const singleToolEntries: ChatEventEntry[] = [
  { seq: 0, kind: 'message', role: 'user', content: 'did the deploy go through?', at: 0 },
  {
    seq: 1,
    kind: 'tool_call',
    tool: 'Bash',
    toolArgs: {
      command: 'tail -n 50 /var/log/deploy.log',
      description: 'Check the deploy log for errors',
      timeout: 120000,
    },
    callId: 'call-single-bash',
    at: 1,
  },
  {
    seq: 2,
    kind: 'tool_result',
    tool: 'Bash',
    toolResult: { code: 0 },
    callId: 'call-single-bash',
    at: 2,
  },
  { seq: 3, kind: 'message', role: 'assistant', content: 'Clean — no errors.', at: 3 },
  { seq: 4, kind: 'message', role: 'user', content: 'what does the poller do?', at: 4 },
  {
    seq: 5,
    kind: 'tool_call',
    tool: 'Read',
    toolArgs: { file_path: 'src/poll.ts' },
    callId: 'call-single-read',
    at: 5,
  },
  {
    seq: 6,
    kind: 'tool_result',
    tool: 'Read',
    toolResult: { lines: 120 },
    callId: 'call-single-read',
    at: 6,
  },
  { seq: 7, kind: 'message', role: 'assistant', content: 'It polls every 30s.', at: 7 },
  { seq: 8, kind: 'message', role: 'user', content: 'plan it out', at: 8 },
  {
    seq: 9,
    kind: 'tool_call',
    tool: 'TodoWrite',
    toolArgs: { todos: [{ content: 'rebuild the index', status: 'pending' }] },
    callId: 'call-single-todo',
    at: 9,
  },
];
// Two unresolved `AskUserQuestion` questions in one request, so the e2e can
// exercise BOTH a complete card (⌘↵ sends) and an incomplete one (⌘↵ must not).
const questionEntries: ChatEventEntry[] = [
  { seq: 0, kind: 'message', role: 'user', content: 'sort out the dates', at: 0 },
  {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-harness-question',
    callId: 'call-harness-question',
    toolArgs: {
      questions: [
        {
          header: 'Library',
          question: 'Which date library should we use?',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
            { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
          ],
        },
        {
          header: 'Scope',
          question: 'Where should it be applied?',
          multiSelect: false,
          options: [
            { label: 'Everywhere', description: 'All surfaces at once.' },
            { label: 'Web only', description: 'Leave mobile alone for now.' },
          ],
        },
      ],
    },
    at: 1,
  },
];
// The countdown ring's fixture. Deadlines are relative to LOAD, not absolute:
// an absolute instant baked into the file would be long past by the time any
// spec ran, and every card would render already expired.
//
// `SHORT_WINDOW_MS` is a real three seconds rather than a faked clock. The ring
// is driven by a `setInterval` inside React, and faking the page clock to skip
// the wait puts the test's timing in charge of React's scheduling as well as
// the card's — three seconds of real waiting is cheaper than debugging that.
const LONG_WINDOW_MS = 60_000;
const SHORT_WINDOW_MS = 3_000;
const questionTimerEntries: ChatEventEntry[] = [
  { seq: 0, kind: 'message', role: 'user', content: 'pick a date library', at: 0 },
  {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-timer-long',
    callId: 'call-timer-long',
    permissionExpiry: { at: Date.now() + LONG_WINDOW_MS, windowMs: LONG_WINDOW_MS },
    toolArgs: {
      questions: [
        {
          header: 'Library',
          question: 'Which date library should we use?',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
            { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
          ],
        },
      ],
    },
    at: 1,
  },
  {
    seq: 2,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-timer-short',
    callId: 'call-timer-short',
    permissionExpiry: { at: Date.now() + SHORT_WINDOW_MS, windowMs: SHORT_WINDOW_MS },
    toolArgs: {
      questions: [
        {
          header: 'Deploy',
          question: 'Ship it now?',
          multiSelect: false,
          options: [
            { label: 'Ship', description: 'Deploy to production.' },
            { label: 'Hold', description: 'Wait for review.' },
          ],
        },
      ],
    },
    at: 2,
  },
];
// A resolved `AskUserQuestion` for each shape `permissionAnswers` can take —
// single-select, multi-select, and free-text `Other` — powering
// `question-card-answered.spec.ts`.
const questionAnsweredEntries: ChatEventEntry[] = [
  { seq: 0, kind: 'message', role: 'user', content: 'pick a date library', at: 0 },
  {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-answered-single',
    callId: 'call-answered-single',
    permissionResolved: 'approve',
    permissionAnswers: { 'Which date library should we use?': 'Luxon' },
    toolArgs: {
      questions: [
        {
          header: 'Library',
          question: 'Which date library should we use?',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
            { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
          ],
        },
      ],
    },
    at: 1,
  },
  {
    seq: 2,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-answered-multi',
    callId: 'call-answered-multi',
    permissionResolved: 'approve',
    permissionAnswers: { 'Which features do you want enabled?': 'Search, Sync' },
    toolArgs: {
      questions: [
        {
          header: 'Features',
          question: 'Which features do you want enabled?',
          multiSelect: true,
          options: [
            { label: 'Search', description: 'Full-text search over chats.' },
            { label: 'Export', description: 'Download a transcript.' },
            { label: 'Sync', description: 'Cross-device sync.' },
          ],
        },
      ],
    },
    at: 2,
  },
  {
    seq: 3,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-answered-other',
    callId: 'call-answered-other',
    permissionResolved: 'approve',
    permissionAnswers: { 'Which date library should we use?': 'Temporal, once it ships' },
    toolArgs: {
      questions: [
        {
          header: 'Library',
          question: 'Which date library should we use?',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
            { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
          ],
        },
      ],
    },
    at: 3,
  },
];
// The question card in all three of its states beside the approval card it must
// NOT look like (spec/14 § Main chat panel — Question prompts). The approval is
// a filled block of the waiting tint; the question is an outlined panel. Both
// are on one chat so `question-card-style.spec.ts` measures them against each
// other in a single load, in both themes.
const questionStyleEntries: ChatEventEntry[] = [
  { seq: 0, kind: 'message', role: 'user', content: 'pick a date library', at: 0 },
  {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-style-pending',
    callId: 'call-style-pending',
    toolArgs: {
      questions: [
        {
          header: 'Library',
          question: 'Which date library should we use?',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
            { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
          ],
        },
        // The two modes on ONE card, so `question-card-multiselect.spec.ts`
        // measures the multi-select rows against the single-select rows beside
        // them in a single load rather than trusting two separate screenshots.
        {
          header: 'Features',
          question: 'Which features do you want enabled?',
          multiSelect: true,
          options: [
            { label: 'Search', description: 'Full-text search over chats.' },
            { label: 'Export', description: 'Download a transcript.' },
          ],
        },
      ],
    },
    at: 1,
  },
  {
    seq: 2,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-style-answered',
    callId: 'call-style-answered',
    permissionResolved: 'approve',
    toolArgs: {
      questions: [
        {
          header: 'Scope',
          question: 'Where should it be applied?',
          multiSelect: false,
          options: [
            { label: 'Everywhere', description: 'All surfaces at once.' },
            { label: 'Web only', description: 'Leave mobile alone for now.' },
          ],
        },
      ],
    },
    at: 2,
  },
  {
    // `questions` missing entirely — the shape `parseAskUserQuestion` refuses,
    // which is what draws the unreadable-question card.
    seq: 3,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-style-broken',
    callId: 'call-style-broken',
    toolArgs: { prompt: 'not the documented shape' },
    at: 3,
  },
  {
    seq: 4,
    kind: 'permission',
    tool: 'Bash',
    requestId: 'req-style-approval',
    callId: 'call-style-approval',
    permissionDescription: 'rm -rf node_modules',
    at: 4,
  },
  {
    seq: 5,
    kind: 'permission',
    tool: 'Write',
    requestId: 'req-style-approval-done',
    callId: 'call-style-approval-done',
    permissionDescription: 'packages/web/src/index.css',
    permissionResolved: 'approve',
    at: 5,
  },
];
useChatStore.setState((s) => ({
  timelines: {
    ...s.timelines,
    chat_bus: [...markdownReply, ...monitorEntries],
    chat_md: [...markdownReply, compactionEntry],
    chat_table: wideTableReply,
    chat_perm_mode: permissionModeEntries,
    chat_perm_mode_auto: permissionModeAutomaticEntries,
    chat_tools: toolRunEntries,
    chat_tools_failed: toolRunFailedEntries,
    chat_tool_rhythm: toolRhythmEntries,
    chat_tool_single: singleToolEntries,
    chat_question: questionEntries,
    chat_question_timer: questionTimerEntries,
    chat_question_styles: questionStyleEntries,
    chat_question_answered: questionAnsweredEntries,
    chat_queued: [
      { seq: 0, kind: 'message', role: 'user', content: 'the running turn', at: 0 },
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'first queued turn',
        queued: true,
        localId: 'q-first',
        at: 1,
      },
      {
        seq: 2,
        kind: 'message',
        role: 'user',
        content: 'second queued turn',
        queued: true,
        localId: 'q-second',
        at: 2,
      },
    ],
    // The state a chat is in the instant BEFORE the user hits Stop with nothing
    // queued: a turn running, its reply half-streamed. The `chat.stopped` event
    // is then applied for real below, so the fixture is the reducer's own
    // output rather than a hand-written stopped entry.
    chat_stopped: [
      { seq: 0, kind: 'message', role: 'user', content: 'refactor the scheduler', at: 0 },
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: 'Reading the scheduler',
        streaming: true,
        at: 1,
      },
    ],
    // The state a chat is in the instant BEFORE a queued message gets promoted
    // and interrupts this one: a turn running, its reply half-streamed, same as
    // `chat_stopped` — the only difference is the chat STAYS `running` (the
    // promoted turn's own run), which is what the reducer reads to tell the two
    // apart. `chat.stopped` is applied for real below, as it is for `chat_stopped`.
    chat_interrupted: [
      { seq: 0, kind: 'message', role: 'user', content: 'rename the config module', at: 0 },
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: 'Looking at the config module',
        streaming: true,
        at: 1,
      },
    ],
    chat_limit_blocked: [
      { seq: 0, kind: 'message', role: 'user', content: 'ship the thing', at: 0 },
    ],
    chat_forked: [
      { seq: 0, kind: 'message', role: 'user', content: 'the shared prefix turn', at: 0 },
      { seq: 1, kind: 'message', role: 'assistant', content: 'prefix reply', at: 1 },
      { seq: 2, kind: 'message', role: 'user', content: 'the edited turn', at: 2 },
      { seq: 3, kind: 'message', role: 'assistant', content: 'reply on this track', at: 3 },
    ],
    chat_image: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: '',
        attachments: [
          { id: 'att_shot', name: 'screenshot.png', mimeType: 'image/png', kind: 'image' },
        ],
        at: 0,
      },
    ],
    // A long history so the scroll-behaviour spec has something to scroll.
    chat_scroll: Array.from(
      { length: 40 },
      (_v, i): ChatEventEntry => ({
        seq: i,
        kind: 'message',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `history line ${i} — lorem ipsum dolor sit amet consectetur adipiscing.`,
        at: i,
      }),
    ),
    chat_deeplink: [
      {
        seq: 0,
        kind: 'tool_call',
        tool: 'patch_notify',
        toolArgs: {
          channel: 'push',
          message: 'Route to the venue is ready',
          deepLink: 'citymapper://directions?startcoord=51.4536,-2.5892&endcoord=51.4816,-2.5952',
        },
        callId: 'call-notify-1',
        at: 0,
      },
    ],
    chat_skill: [
      {
        seq: 0,
        kind: 'tool_call',
        tool: 'Skill',
        toolArgs: { skill: 'plant' },
        callId: 'call-skill-1',
        at: 0,
      },
    ],
    chat_tool_image: [
      {
        seq: 0,
        kind: 'tool_result',
        tool: 'Read',
        toolResult: {
          content: [
            { type: 'text', text: 'screenshot.png' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              },
            },
          ],
        },
        callId: 'call-tool-image',
        at: 0,
      },
    ],
    // A call and its own result, correlated by callId — must render as ONE row
    // carrying both halves, never as an invocation row plus a result row.
    chat_tool_paired: [
      {
        seq: 0,
        kind: 'tool_call',
        tool: 'Read',
        toolArgs: { file_path: 'src/poll.ts' },
        callId: 'call-paired-1',
        at: 0,
      },
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'Read',
        toolResult: { content: [{ type: 'text', text: 'export const poll = 1;' }] },
        callId: 'call-paired-1',
        at: 1,
      },
    ],
    // spec/14 § Viewing files — the row IS the file, in a sandboxed frame.
    chat_view_file: [
      {
        seq: 0,
        kind: 'tool_call',
        tool: 'view_file',
        toolArgs: { file_path: 'plants.html' },
        callId: 'call-view-1',
        at: 0,
      },
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'view_file',
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                kind: 'html',
                url: '/api/chats/chat_view_file/artifact/deadbeef',
                name: 'plants.html',
              }),
            },
          ],
        },
        callId: 'call-view-1',
        at: 1,
      },
    ],
    // spec/14 § Viewing files — an image renders as a picture, click-to-open
    // in the same lightbox as any other inline image.
    chat_view_file_image: [
      {
        seq: 0,
        kind: 'tool_call',
        tool: 'view_file',
        toolArgs: { file_path: 'shot.png' },
        callId: 'call-view-img-1',
        at: 0,
      },
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'view_file',
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                kind: 'image',
                url: '/api/chats/chat_view_file_image/artifact/beef01',
                name: 'shot.png',
              }),
            },
          ],
        },
        callId: 'call-view-img-1',
        at: 1,
      },
    ],
    // spec/14 § Viewing files — a PDF renders in the same sandboxed frame as
    // an HTML page (not the image/lightbox path), with its own expand control.
    chat_view_file_pdf: [
      {
        seq: 0,
        kind: 'tool_call',
        tool: 'view_file',
        toolArgs: { file_path: 'invoice.pdf' },
        callId: 'call-view-pdf-1',
        at: 0,
      },
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'view_file',
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                kind: 'pdf',
                url: '/api/chats/chat_view_file_pdf/artifact/pdf001',
                name: 'invoice.pdf',
              }),
            },
          ],
        },
        callId: 'call-view-pdf-1',
        at: 1,
      },
    ],
    // A long unbroken URL with no spaces, on both a user bubble and an
    // assistant bubble — must wrap inside the message box, not overflow it.
    chat_long_text: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content:
          'https://example.com/a/very/long/path/segment/that/keeps/going/and/going/without/any/spaces/to/break/on/query?param1=aaaaaaaaaa&param2=bbbbbbbbbb&param3=cccccccccc',
        at: 0,
      },
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content:
          'Here it is: https://example.com/a/very/long/path/segment/that/keeps/going/and/going/without/any/spaces/to/break/on/query?param1=aaaaaaaaaa&param2=bbbbbbbbbb&param3=cccccccccc',
        at: 1,
      },
    ],
    chat_user_newlines: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'first line\nsecond line\nthird line',
        at: 0,
      },
    ],
    // spec/14 § Messages — Long user messages collapse (accordion). A user
    // turn well over the 8-line / 600-char threshold, plus a short user turn
    // and a long assistant reply as controls — neither of the latter two
    // should ever collapse.
    chat_long_user_message: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: Array.from(
          { length: 20 },
          (_, i) =>
            `Step ${i + 1}: a fairly detailed line describing one part of a long pasted plan.`,
        ).join('\n'),
        at: 0,
      },
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: Array.from(
          { length: 20 },
          (_, i) => `Reply line ${i + 1} of a long assistant answer.`,
        ).join('\n'),
        at: 1,
      },
      {
        seq: 2,
        kind: 'message',
        role: 'user',
        content: 'a short follow-up',
        at: 2,
      },
    ],
    // spec/14 § Message links — one link in an assistant reply.
    chat_link_preview: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'find me an article about foraging',
        at: 0,
      },
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: 'Here you go: https://example.com/foraging-guide',
        at: 1,
      },
    ],
    // spec/08 § Action — the job's raw trigger payload as the first turn,
    // then a normal assistant reply and a genuine Tom-authored follow-up
    // (which must NOT get the furniture treatment — only the first turn is
    // unambiguously the job's, not Tom's).
    chat_job_trigger: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: JSON.stringify({ event: 'departure', route: '36', etaMinutes: 4 }, null, 2),
        at: 0,
      },
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: 'The 36 is 4 minutes out.',
        at: 1,
      },
      {
        seq: 2,
        kind: 'message',
        role: 'user',
        content: 'thanks, keep watching',
        at: 2,
      },
    ],
    // spec/14 § Job trigger turn — the first turn is a genuine Tom-authored
    // message (no `jobId` on this chat at all), then a `continue` action's
    // LATER fire into it carries its own `jobTrigger` flag and still gets the
    // quiet furniture treatment.
    chat_job_trigger_later_fire: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'watch this bus route for me',
        at: 0,
      },
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: 'Watching the 36.',
        at: 1,
      },
      {
        seq: 2,
        kind: 'message',
        role: 'user',
        content: JSON.stringify({ event: 'departure', route: '36', etaMinutes: 4 }, null, 2),
        jobTrigger: true,
        at: 2,
      },
    ],
    // job-editor-origin e2e (job-editor-back.spec.ts) — an "Open job" row for
    // chat_job_open_link (spec/14 ## Main chat panel), the click-through
    // target the spec follows into the editor before checking Back.
    chat_job_open_link: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'watch the 36 bus and tell me when it leaves',
        at: 0,
      },
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'patch_job_create',
        toolArgs: { jobId: 'job_bus_watch', name: 'Bus watch' },
        callId: 'call-job-open-link',
        at: 1,
      },
    ],
    // spec/14 § Background task completions — a real captured notification
    // block, delivered as a user turn the way replay delivers it, plus a
    // one-summary-less block and a genuine Tom-authored turn either side.
    chat_task_notification: [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'run the build in the background',
        at: 0,
      },
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: [
          '<task-notification>',
          '<task-id>baiw888mq</task-id>',
          '<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>',
          '<output-file>/tmp/claude-1000/9a1710c0/tasks/baiw888mq.output</output-file>',
          '<status>completed</status>',
          '<summary>Background command "Build web package to compile CSS" completed (exit code 0)</summary>',
          '</task-notification>',
        ].join('\n'),
        at: 1,
      },
      {
        seq: 2,
        kind: 'message',
        role: 'assistant',
        content: 'The build finished cleanly.',
        at: 2,
      },
    ],
    // spec/14 § Main chat panel — Background task bar. Two launches still
    // running (a command and a sub-agent) and one already closed by its lifted
    // completion sentence, on a chat that is otherwise idle.
    chat_bgtask: [
      { seq: 0, kind: 'message', role: 'user', content: 'kick the build off', at: 0 },
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: {
          command: 'pnpm --filter @patch/web build',
          description: 'Build web package to compile CSS',
          run_in_background: true,
        },
        callId: 'call-bgtask-1',
        at: 1,
      },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'Bash',
        toolResult: 'Command running in background with ID: baiw888mq.',
        callId: 'call-bgtask-1',
        at: 2,
      },
      {
        seq: 3,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: {
          command: 'pnpm --filter @patch/server test',
          description: 'Run the server suite',
          run_in_background: true,
        },
        callId: 'call-bgtask-2',
        at: 3,
      },
      {
        seq: 4,
        kind: 'message',
        role: 'system',
        content: 'Background command "Run the server suite" completed (exit code 0)',
        at: 4,
      },
      {
        seq: 5,
        kind: 'tool_call',
        tool: 'Task',
        toolArgs: {
          subagent_type: 'general-purpose',
          description: 'Diagnose 25045 test failures',
          run_in_background: true,
        },
        callId: 'call-bgtask-3',
        at: 5,
      },
      {
        seq: 6,
        kind: 'message',
        role: 'assistant',
        content: 'Both are running in the background.',
        at: 6,
      },
      // Two more that have ENDED, and not by completing: one the agent killed
      // outright and one that failed. Hidden unless Show all is checked, which
      // is the whole point of them being here (spec/14 § Main chat panel —
      // Background task bar).
      {
        seq: 7,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: {
          command: 'pnpm run deploy',
          description: 'Ship the web bundle',
          run_in_background: true,
        },
        callId: 'call-bgtask-4',
        at: 7,
      },
      {
        seq: 8,
        kind: 'tool_result',
        tool: 'Bash',
        toolResult: 'Command running in background with ID: bkill01xy.',
        callId: 'call-bgtask-4',
        at: 8,
      },
      {
        seq: 9,
        kind: 'tool_call',
        tool: 'KillShell',
        toolArgs: { shell_id: 'bkill01xy' },
        callId: 'call-bgtask-kill',
        at: 9,
      },
      {
        seq: 10,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: {
          command: 'pnpm typecheck',
          description: 'Typecheck the monorepo',
          run_in_background: true,
        },
        callId: 'call-bgtask-5',
        at: 10,
      },
      // The sentence a real failed command produces. It spells the exit code
      // out in words rather than parenthesising it, and a task whose end
      // cannot be read stays in the bar spinning for the life of the chat.
      {
        seq: 11,
        kind: 'message',
        role: 'system',
        content: 'Background command "Typecheck the monorepo" failed with exit code 1',
        at: 11,
      },
    ],
  },
}));
// Exposed so the scroll-behaviour spec can append an optimistic turn the way a
// real send does.
(window as unknown as { __store?: typeof useChatStore }).__store = useChatStore;
// Exposed so specs can push a fresh `daemon.account` report (e.g. usage
// windows) the way the real WS greeting/report would, without a live host.
(window as unknown as { __presenceStore?: typeof usePresenceStore }).__presenceStore =
  usePresenceStore;
// Exposed so specs can play a `settings.changed` (spec/03 § Settings) the way
// the server pushes one, without a live server.
(window as unknown as { __preferencesStore?: typeof usePreferencesStore }).__preferencesStore =
  usePreferencesStore;

// Exposed so the voice specs can drive a call's live transcript and chat.
(window as unknown as { __voiceStore?: typeof useVoiceStore }).__voiceStore = useVoiceStore;
// Exposed so the narrow-layout spec can simulate a MANUAL sidebar
// collapse/expand (the same call the real ⌘/ toggle makes) to prove the
// auto-collapse effect doesn't fight it.
(window as unknown as { __uiStore?: typeof useUiStore }).__uiStore = useUiStore;
// Exposed so the scroll-band spec can save a draft the way the composer does
// (`create` then `update`), which is the case where new sidebar content appears
// without the user expanding anything.
(window as unknown as { __draftStore?: typeof useDraftStore }).__draftStore = useDraftStore;
// Exposed so specs can simulate a server-owned composer-draft frame
// (`composer_draft.updated`/`.cleared`) the way the real WS would — the
// harness has no live socket, so this is the only way to prove the
// focused-composer-not-clobbered rule (spec/14 § Composer) in a real browser.
(
  window as unknown as { __composerDraftStore?: typeof useComposerDraftStore }
).__composerDraftStore = useComposerDraftStore;
// Exposed so the terminal specs can push host→surface frames the way a real
// shell does. The completion frame is the whole point: the fake socket below
// answers `open` with a `ready`, but nothing in the harness runs a command, so
// a spec has to say for itself when one finished and with what status.
(window as unknown as { __terminalStore?: typeof useTerminalStore }).__terminalStore =
  useTerminalStore;
// Exposed so batch specs can force a re-poll (spec/14 § Batch mode is server-
// owned and polled; the harness has no live socket to push a change over).
(window as unknown as { __batchStore?: typeof useBatchStore }).__batchStore = useBatchStore;
// A fake active WS that only records what a host-scoped control sends, so e2e
// can click Save/remove in Settings → Hosts → Claude Code settings and assert
// on the real frame — the harness otherwise runs with no live socket (`ws={null}`
// throughout), which is why nothing captured outbound sends before.
const wsSent: WireEvent[] = [];
(window as unknown as { __wsSent: WireEvent[] }).__wsSent = wsSent;
setActiveWs({ send: (event: WireEvent) => wsSent.push(event) } as unknown as PatchWs);
// The model catalogue (spec/14 § Model selector). Seeded, not fetched: the
// harness has no backend, and the chat header's model crumb is a live control —
// it opens this list and sends a `chat.model_request` for the chosen row
// (spec/04 § Model). Without a seed the pop-up could only show its error state.
setModelCatalog({
  status: 'ready',
  models: [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-opus-4-1', label: 'Opus 4.1' },
  ],
});
// The forked chat's track graph (spec/04 § Branching): the root track plus one
// fork at seq 2, with the FORK active — so the switcher reads 2/2 and ‹ goes
// back to the original.
useChatStore.getState().applyEvent({
  type: 'chat.branches',
  chatId: 'chat_forked',
  activeBranchId: 'chat_forked-b1',
  branches: [
    {
      branchId: 'chat_forked-b0',
      parentBranchId: null,
      forkFromSeq: null,
      label: 'main',
      createdAt: 0,
    },
    {
      branchId: 'chat_forked-b1',
      parentBranchId: 'chat_forked-b0',
      forkFromSeq: 2,
      label: 'edit 1',
      createdAt: 1,
    },
  ],
});
// `?sideThreads=1` — two side threads off chat_forked and the Threads panel open
// on the first (spec/14 § Side threads panel). Their transcripts are pull-based:
// a spec stubs `GET /api/chats/:id/history`.
if (new URLSearchParams(window.location.search).get('sideThreads') === '1') {
  const side = (n: number, name: string): Record<string, unknown> => ({
    branchId: `chat_forked-b${n + 1}`,
    parentBranchId: 'chat_forked-b1',
    forkFromSeq: 2,
    label: `side ${n}`,
    name,
    createdAt: n + 2,
    sideThread: true,
  });
  useChatStore.getState().applyEvent({
    type: 'chat.branches',
    chatId: 'chat_forked',
    activeBranchId: 'chat_forked-b1',
    branches: [
      {
        branchId: 'chat_forked-b0',
        parentBranchId: null,
        forkFromSeq: null,
        label: 'main',
        createdAt: 0,
      },
      {
        branchId: 'chat_forked-b1',
        parentBranchId: 'chat_forked-b0',
        forkFromSeq: 2,
        label: 'edit 1',
        createdAt: 1,
      },
      side(1, 'Why this approach'),
      side(2, 'Alternatives'),
    ],
  } as never);
  useSideThreadsStore.getState().openThread('chat_forked', 'chat_forked-b2');
}
// The failure `chat_limit_blocked` died on, as the host reports it: patch's
// own account of the limit it stated, attached to the turn that failed. Run
// through the real reducer so the fixture is what the surface would actually
// build from the wire event.
useChatStore.getState().applyEvent({
  type: 'chat.error',
  chatId: 'chat_limit_blocked',
  error: {
    code: 'sdk_error',
    message:
      'Usage limit reached on Default \u2014 the weekly window. It resets at 2026-09-15T04:00:00Z.',
  },
  seq: 1,
  causeSeq: 0,
});
// The Stop the user pressed on `chat_stopped`, with nothing queued behind it
// (spec/14 § Running-turn controls) — the host's own event, run through the
// real reducer. `chat_stopped`'s row is already `idle` (see chatsSeed above),
// matching the real sequence (the aborted run settles idle before this
// arrives), so the reducer reads it as a bare stop.
useChatStore.getState().applyEvent({
  type: 'chat.stopped',
  chatId: 'chat_stopped',
  reason: 'user-stop',
});
// The same stop, but on `chat_interrupted` — a newer message got promoted
// ahead of it, so its row is still `running` (see chatsSeed above), matching
// the real sequence (a promote never goes idle in between), and the reducer
// reads it as an interruption rather than a stop.
useChatStore.getState().applyEvent({
  type: 'chat.stopped',
  chatId: 'chat_interrupted',
  reason: 'user-stop',
});
// `chat_provider_context`'s ProviderContextPanel rows (spec/02 § Provider-
// level context) — run through the real reducer, exactly as the host's live
// stream / replay would deliver them. `total_tokens_reminder` fires twice to
// drive the "one row per providerType, not per occurrence" e2e: the panel
// must show ONE row naming both the latest count and how many times it fired.
useChatStore.getState().applyEvent({
  type: 'chat.provider_context',
  chatId: 'chat_provider_context',
  seq: 1,
  providerType: 'model',
  label: 'Model',
  text: 'You are powered by the model named Sonnet 5. The exact model ID is claude-sonnet-5.',
});
useChatStore.getState().applyEvent({
  type: 'chat.provider_context',
  chatId: 'chat_provider_context',
  seq: 2,
  providerType: 'total_tokens_reminder',
  label: 'Tokens remaining',
  text: '14,961,549 tokens left',
});
useChatStore.getState().applyEvent({
  type: 'chat.provider_context',
  chatId: 'chat_provider_context',
  seq: 3,
  providerType: 'total_tokens_reminder',
  label: 'Tokens remaining',
  text: '14,900,112 tokens left',
});
// `chat_system_context` (spec/02 § System-reminder disclosure): a turn carrying
// a todo-edit reminder, re-sent after a restart with the restart reminder, then
// answered — all through the real reducer, so the fold is the store's own.
useChatStore.getState().applyEvent({
  type: 'chat.message',
  chatId: 'chat_system_context',
  role: 'user',
  content: 'tidy the garden notes',
  seq: 0,
  systemContext: [
    {
      source: 'patch',
      label: 'Todo list updated',
      text: 'The user edited this chat’s task list. Adopt it before your next TodoWrite.',
    },
  ],
});
useChatStore.getState().applyEvent({
  type: 'chat.message',
  chatId: 'chat_system_context',
  role: 'user',
  content: 'Carry on',
  seq: 1,
  retryOfSeq: 0,
  systemContext: [
    {
      source: 'patch',
      label: 'Turn interrupted by restart',
      text: 'This turn was already running when the host restarted, and was cut off partway.',
    },
  ],
});
useChatStore.getState().applyEvent({
  type: 'chat.message',
  chatId: 'chat_system_context',
  role: 'assistant',
  content: 'Picking up where I left off with the garden notes.',
  seq: 2,
});
// `?providerContextVerbosity=off|summary|full` seeds the account preference
// the panel above reads (spec/02 § Provider-level context) — otherwise it is
// left at the store's own default (`summary`), exercised by every other e2e
// spec in this harness.
const verbosityParam = new URLSearchParams(window.location.search).get('providerContextVerbosity');
if (verbosityParam === 'off' || verbosityParam === 'summary' || verbosityParam === 'full') {
  usePreferencesStore.setState({
    preferences: {
      ...usePreferencesStore.getState().preferences,
      providerContextVerbosity: verbosityParam,
    },
    loaded: true,
  });
}
usePresenceStore.getState().setConnection('connected');
// The `auth.ok` greeting, as the server replays it: one registered host, online,
// with its own credential and its own last-used model. The last-used model lives
// on the MACHINE (spec/04 § Spawn), so without a host here the new-chat picker
// has nothing to preselect and no host to spawn on — exactly as in the real app.
usePresenceStore.getState().setHosts([
  {
    daemonId: 'd1',
    online: true,
    lastSeenAt: Date.now(),
    host: {
      daemonId: 'd1',
      hostName: 'dev-host',
      platform: 'darwin',
      arch: 'arm64',
      daemonVersion: '0.0.0-dev',
      updateAvailable: false,
      permissionModeDefault: 'auto',
      permissionOverrides: 0,
      defaultModel: 'claude-opus-5',
      isHomeHost: true,
      audioRelayHost: '127.0.0.1:3003',
      backends: [],
      components: [],
      // Both halves, so Settings draws the Questions controls at all: their
      // absence is how a surface tells "this host predates the setting"
      // apart from "the setting is off" (spec/14 § `/settings` details).
      questionExpiry: true,
      questionExpirySeconds: 60,
      // spec/02 § Provider keys — one of each state, so Settings → Hosts →
      // Keys can be seen and exercised without a host.
      voiceKeys: { gemini: false, openai: false },
      providerKeys: [
        { id: 'gemini', source: 'none', envSet: false },
        { id: 'openai', source: 'none', envSet: false },
        { id: 'groq', source: 'env', last4: 'q9Zk', envSet: true },
      ],
    },
    accounts: [
      {
        daemonId: 'd1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: 'dev@example.com',
      },
    ],
  },
]);

// `?hosts=two` adds a second machine, so the new-chat screen has a choice of
// where to run (spec/14 §8). It publishes its own folder registry, as a real
// host does, so choosing it offers that machine's folders and nobody else's.
if (new URLSearchParams(window.location.search).get('hosts') === 'two') {
  const home = usePresenceStore.getState().hosts['d1'];
  usePresenceStore.getState().setHosts([
    ...(home
      ? [
          {
            daemonId: 'd1',
            online: true,
            lastSeenAt: Date.now(),
            host: home.host,
            accounts: [
              {
                daemonId: 'd1',
                backendId: 'claude-code',
                connected: true,
                accountEmail: 'dev@example.com',
              },
            ],
          },
        ]
      : []),
    {
      daemonId: 'd2',
      online: true,
      lastSeenAt: Date.now(),
      host: home?.host
        ? { ...home.host, daemonId: 'd2', hostName: 'mac', isHomeHost: false }
        : null,
      accounts: [
        {
          daemonId: 'd2',
          backendId: 'claude-code',
          connected: true,
          accountEmail: 'dev@example.com',
        },
      ],
    },
  ]);
  usePresenceStore.getState().setHostFolders('d2', ['/Users/dev/code'], []);
}

// Which thread to show in the main panel. `?chat=thread_speakers` (default)
// demonstrates the read-only mirror; `?chat=thread_manager` shows the full
// composer.
const params = new URLSearchParams(window.location.search);
const chatId = params.get('chat') ?? 'thread_speakers';

// A fixture's own tab-opening call has to run AFTER `ChatPaneRoute`'s mount
// effect, which ALSO opens a tab (the plain chat named by `?chat=`) the
// moment the tree mounts — the default ('active') placement means whichever
// runs SECOND is the one left focused. `setTimeout`/`queueMicrotask` both
// run before React's own passive-effect flush, so neither reliably comes
// after it; `EditorFixtureBridge` instead runs as a REAL effect, placed as a
// later sibling of `<Routes>` in the tree below — later siblings' effects
// commit after earlier ones', so this always loses the race the right way.
let pendingEditorFixtureTab: (() => void) | null = null;
function registerEditorFixtureTab(open: () => void): void {
  pendingEditorFixtureTab = open;
}
// `sessionStorage`, not a module-level flag: a spec proving reload-persistence
// (editor-persist-state.spec.ts) does a REAL `page.reload()`, which re-runs
// this whole script from scratch — a plain in-memory flag would be gone, and
// the fixture would re-assert its OWN opening over whatever the reload just
// restored from `localStorage`, masking the very thing being tested.
// `sessionStorage` survives a reload in the same tab (only a closed tab
// clears it), so "seed this once per test session" is exactly what it means.
const EDITOR_FIXTURE_APPLIED_KEY = 'patch-dev-harness-editor-fixture-applied';
function EditorFixtureBridge(): null {
  useEffect(() => {
    if (sessionStorage.getItem(EDITOR_FIXTURE_APPLIED_KEY) === '1') return;
    sessionStorage.setItem(EDITOR_FIXTURE_APPLIED_KEY, '1');
    pendingEditorFixtureTab?.();
  }, []);
  return null;
}

// `?editor=browse` mounts the real EditorRail in file-browser mode alongside the
// chat, backed by a tiny in-memory file API stub, so the file-browser layout
// (editor filling the pane) can be verified in a real browser without a host.
const editorParam = params.get('editor');
// `&fileStub=skill` wants the SAME in-memory file API (real `SKILL.md`
// content at a real path) without opening the Files tab over whatever the
// test actually came to look at (the composer, a transcript link) — the
// skill-autocomplete specs need the file real, not the tab open.
const fileStubParam = params.get('fileStub');
if (editorParam === 'browse' || fileStubParam === 'skill') {
  // A small NESTED, deliberately UNSORTED, FLAT list — this is the shape
  // `listFilesRecursive` really returns (full relative paths, dirs AND files),
  // and is now the tree's ONLY data source (editor overhaul: hierarchical
  // tree). `buildFileTree` turns it into the nested tree client-side, the
  // same as the real app. Root keeps `foo.ts` for the layout specs.
  let entries: Array<{ name: string; type: 'file' | 'dir'; dirty?: boolean }> = [
    { name: 'zeta.ts', type: 'file' },
    { name: 'src', type: 'dir' },
    { name: 'src/index.ts', type: 'file' },
    { name: 'src/components', type: 'dir' },
    { name: 'src/components/Panel.tsx', type: 'file' },
    { name: 'foo.ts', type: 'file' },
    { name: 'assets', type: 'dir' },
    // Editor overhaul (binary preview) — a real extension for
    // `isPreviewableBinary` to key off; the harness's `/files/raw` stub below
    // answers every path with the same tiny PNG regardless of name.
    { name: 'assets/logo.png', type: 'file' },
    // Document editor (spec/14 § Document editor, step 1 of 3) — a real
    // extension for `isMarkdownPath` to key off, with one of every FORMAT
    // element so document-editor.spec.ts can prove rich rendering + round
    // trip in a real browser. Nested under `assets/`, not the root — the
    // root entry count is pinned exactly by browse-redesign.spec.ts.
    { name: 'assets/notes.md', type: 'file' },
    // Word import/export (spec/14 § Document editor, step 3 of 3) — a real
    // `.docx` for document-editor-word.spec.ts to open and convert in a real
    // browser.
    { name: 'assets/update.docx', type: 'file' },
  ];
  // job-skill-edit-link.spec.ts opens `.claude/skills/plant/SKILL.md` by path
  // (via the job editor's Edit link, not the tree), and `contentFor` below
  // answers any path regardless of `entries` — so that fixture file does not
  // need an `entries` row. It used to have one at the root, which silently
  // became a 5th row the browse-tree specs' root-count assertions didn't
  // expect.
  const fileBody = Array.from({ length: 60 }, (_v, i) => `const line${i} = ${i};`).join('\n');
  const skillBody = '# plant\n\nSow what is in season.\n';
  const notesBody =
    '# Garden notes\n\n' +
    'A paragraph with **bold**, *italic* and a [link](https://example.com).\n\n' +
    '- [ ] water the tomatoes\n' +
    '- [x] weed the bed\n\n' +
    '| plant | bed |\n' +
    '| --- | --- |\n' +
    '| tomato | 2 |\n';
  // Word import (spec/14 § Document editor, step 3 of 3): the markdown a
  // `/doc/convert` call produces, keyed by the `.md` path it lands at — so a
  // subsequent `/files?path=` read of the just-converted file sees real
  // content rather than the generic `fileBody` fixture.
  const convertedDocxContent = new Map<string, string>();
  const contentFor = (path: string): string =>
    convertedDocxContent.get(path) ??
    (path.endsWith('SKILL.md') ? skillBody : path.endsWith('notes.md') ? notesBody : fileBody);
  // `&filesDelay=<ms>` holds every /files response open for that long, so the
  // browser's LOADING states are observable in a real browser. Without it the
  // stub answers in the same microtask and no spec can ever see the tree
  // skeleton, the editor cover or the ⌘P picker's placeholder — which is how
  // "the file viewer just looks empty while it loads" went unnoticed.
  const filesDelay = Number(params.get('filesDelay') ?? '0');
  // Document editor (spec/14 § Document editor, step 2 of 3) — modes,
  // suggestions, comments, history. One in-memory sidecar per path, same
  // shape the host's `DocView` carries, mutated by the same `action.op`s
  // the real `/doc/action` route accepts — so document-editor-modes.spec.ts
  // can prove the real UI against this stub in a real browser.
  interface StubDocView {
    mode: 'change' | 'propose' | 'comment';
    suggestions: Array<{
      id: string;
      find: string;
      replace: string;
      status: 'pending' | 'accepted' | 'rejected';
      createdAt: number;
    }>;
    threads: Array<{
      id: string;
      anchor: string;
      resolved: boolean;
      comments: Array<{ id: string; author: 'user' | 'agent'; text: string; createdAt: number }>;
    }>;
    versions: Array<{
      id: string;
      content: string;
      savedBy: 'user' | 'agent';
      createdAt: number;
      restoredFrom?: string;
    }>;
    importWarnings?: string[];
  }
  const docViews = new Map<string, StubDocView>();
  // Seeded so document-editor-modes.spec.ts can exercise accept/reject
  // without a real agent turn — the same shape `patch_doc_suggest` lands.
  docViews.set('assets/notes.md', {
    mode: 'propose',
    suggestions: [
      { id: 'seed-1', find: 'bold', replace: 'BOLD', status: 'pending', createdAt: Date.now() },
    ],
    threads: [],
    // Seeded rather than pushed by the `file.write` WS path on save — this
    // harness mocks only `fetch`, not the host's own version-recording
    // (covered end-to-end instead by doc-actions.test.ts / doc-routes.e2e.test.ts).
    versions: [
      {
        id: 'seed-v1',
        content: 'A paragraph with **bold**.\n',
        savedBy: 'user',
        createdAt: Date.now(),
      },
    ],
  });
  let docIdSeq = 0;
  const nextDocId = (): string => `stub-${++docIdSeq}`;
  const docViewFor = (path: string): StubDocView => {
    let v = docViews.get(path);
    if (!v) {
      v = { mode: 'change', suggestions: [], threads: [], versions: [] };
      docViews.set(path, v);
    }
    return v;
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/doc/action') && (init?.method ?? 'GET') === 'POST') {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const path = body['path'] as string;
      const action = body['action'] as Record<string, unknown>;
      const v = docViewFor(path);
      const op = action['op'] as string;
      if (op === 'set_mode') v.mode = action['mode'] as StubDocView['mode'];
      else if (op === 'add_comment') {
        v.threads.push({
          id: nextDocId(),
          anchor: (action['anchor'] as string) ?? '',
          resolved: false,
          comments: [
            {
              id: nextDocId(),
              author: 'user',
              text: action['text'] as string,
              createdAt: Date.now(),
            },
          ],
        });
      } else if (op === 'reply_comment') {
        const t = v.threads.find((t) => t.id === action['threadId']);
        t?.comments.push({
          id: nextDocId(),
          author: 'user',
          text: action['text'] as string,
          createdAt: Date.now(),
        });
      } else if (op === 'resolve_comment') {
        const t = v.threads.find((t) => t.id === action['threadId']);
        if (t) t.resolved = action['resolved'] as boolean;
      } else if (op === 'accept_suggestion' || op === 'reject_suggestion') {
        const s = v.suggestions.find((s) => s.id === action['id']);
        if (s) s.status = op === 'accept_suggestion' ? 'accepted' : 'rejected';
      } else if (op === 'accept_all') {
        for (const s of v.suggestions) if (s.status === 'pending') s.status = 'accepted';
      } else if (op === 'reject_all') {
        for (const s of v.suggestions) if (s.status === 'pending') s.status = 'rejected';
      } else if (op === 'restore_version') {
        const ver = v.versions.find((ver) => ver.id === action['versionId']);
        if (ver) {
          v.versions.push({
            id: nextDocId(),
            content: ver.content,
            savedBy: 'user',
            createdAt: Date.now(),
            restoredFrom: ver.id,
          });
        }
      }
      return Promise.resolve(
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.includes('/doc/convert')) {
      // Word import (spec/14 § Document editor, step 3 of 3): a deliberately
      // fake conversion (no real mammoth in a browser-side stub) that still
      // exercises the real round trip — opening the `.md` it names, and
      // naming a warning rather than dropping it, exactly as the real host
      // conversion would for a document with something it couldn't carry
      // over.
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const docxPath = body['path'] as string;
      const mdPath = docxPath.replace(/\.docx$/i, '.md');
      const warnings = ['A multi-column layout was flattened to a single column.'];
      convertedDocxContent.set(mdPath, '# Converted From Word\n\nThis came from update.docx.\n');
      if (!entries.some((e) => e.name === mdPath)) {
        entries = [...entries, { name: mdPath, type: 'file' }];
      }
      docViews.set(mdPath, {
        mode: 'change',
        suggestions: [],
        threads: [],
        versions: [],
        importWarnings: warnings,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ mdPath, warnings, reused: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.includes('/doc/export')) {
      // Download/Save as (spec/14 § Document editor, step 3 of 3) — real
      // bytes shaped enough to prove the browser-side download path (object
      // URL + anchor click), not a real conversion.
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const path = body['path'] as string;
      const format = body['format'] as 'docx' | 'pdf' | 'md';
      const stem = path.replace(/\.md$/i, '');
      const outPath = `${stem}.${format}`;
      const bytes =
        format === 'pdf'
          ? '%PDF-1.4 fake pdf bytes'
          : format === 'docx'
            ? 'PK fake docx bytes'
            : contentFor(path);
      const mimeType =
        format === 'pdf'
          ? 'application/pdf'
          : format === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'text/markdown';
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': mimeType,
            'content-disposition': `attachment; filename="${outPath.split('/').pop()}"`,
            'x-patch-doc-path': outPath,
            'x-patch-doc-warnings': '[]',
          },
        }),
      );
    }
    if (url.includes('/doc?') || url.endsWith('/doc')) {
      const reqPath = new URL(url, window.location.origin).searchParams.get('path') ?? '';
      return Promise.resolve(
        new Response(JSON.stringify(docViewFor(reqPath)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.includes('/files/raw')) {
      // Editor overhaul (binary preview): served as real bytes, not JSON — a
      // 1x1 transparent PNG is enough to prove the `<img>` path renders.
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        ),
        (c) => c.charCodeAt(0),
      );
      return Promise.resolve(
        new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    }
    if (url.includes('/files') && (init?.method ?? 'GET') === 'POST') {
      // Editor overhaul (inline create + rename): the file browser's
      // create/rename/delete. Mutates the in-memory `entries` list the same
      // way the real host would, so a create-then-rename round trip in a
      // real browser reflects what actually landed.
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const op = body['op'] as string;
      const opPath = body['path'] as string;
      const to = body['to'] as string | undefined;
      let landed = opPath;
      if (op === 'create' || op === 'create_dir') {
        entries = [...entries, { name: opPath, type: op === 'create' ? 'file' : 'dir' }];
      } else if (op === 'rename' && to) {
        entries = entries.map((e) =>
          e.name === opPath || e.name.startsWith(`${opPath}/`)
            ? { ...e, name: to + e.name.slice(opPath.length) }
            : e,
        );
        landed = to;
      } else if (op === 'delete') {
        entries = entries.filter((e) => e.name !== opPath && !e.name.startsWith(`${opPath}/`));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ path: landed }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.includes('/files')) {
      const reqPath = new URL(url, window.location.origin).searchParams.get('path') ?? '';
      // `ref=head` on `foo.ts` deliberately diverges from the working tree
      // (one changed line) so the "Git diff" meta-strip toggle has something
      // real to open against in a real browser (e2e: diff-buttons-explained).
      // Every other file's HEAD matches its working tree — e.g. the ⌘P index
      // walk never sends `ref=head`, so it is unaffected.
      const isHeadRef = url.includes('ref=head');
      const content =
        isHeadRef && reqPath === 'foo.ts'
          ? contentFor(reqPath).replace('const line0 = 0;', 'const line0 = -1;')
          : contentFor(reqPath);
      const body = url.includes('recursive=1')
        ? { entries }
        : { path: reqPath, content, size: content.length };
      const res = new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      if (filesDelay > 0) {
        return new Promise<Response>((resolve) => {
          window.setTimeout(() => resolve(res), filesDelay);
        });
      }
      return Promise.resolve(res);
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
  if (editorParam === 'browse') {
    registerEditorFixtureTab(() => {
      useLayoutStore.getState().openTab({ kind: 'page', page: 'files', chatId });
    });
  }
}

// `?editor=diff` opens the Monaco DIFF editor as a file tab over a seeded
// change set (one file, one line removed and one added), so its theming and
// add/remove contrast can be measured in a real browser at a real colour
// scheme (Todoist: "diff not visible on dark mode").
if (editorParam === 'diff') {
  registerEditorFixtureTab(() => {
    useUiStore.getState().openFileDiff({
      chatId,
      changeSet: [
        {
          path: 'src/foo.ts',
          original: ['const kept = 1;', 'const removedLine = 2;', 'const tail = 3;'].join('\n'),
          modified: ['const kept = 1;', 'const addedLine = 4;', 'const tail = 3;'].join('\n'),
        },
      ],
      activeIndex: 0,
    });
  });
}
// `?editor=write` opens a file tab exactly as a `Write` permission request
// leaves it (api/ws.ts): a pending diff whose original side is empty,
// because the request's args ARE the whole new file and there is no baseline.
// spec/14 § Diff editor says that opens as the plain single-pane editor.
if (editorParam === 'write') {
  useUiStore.getState().setPendingDiff({
    requestId: 'req-write-1',
    chatId,
    tool: 'Write',
    filePath: '/home/tom/projects/bus/src/brandNew.ts',
    original: '',
    modified: ['const wholeFileWrite = 1;', 'const secondLine = 2;', ''].join('\n'),
  });
  registerEditorFixtureTab(() => {
    useLayoutStore.getState().openTab({ kind: 'file', chatId, path: 'src/brandNew.ts' });
  });
}
// `?editor=write-changeset` is the OTHER entry point to the same rule: a
// change-set entry (from clicking a tool call, or ⌘') for a file with no
// committed baseline, so lib/openDiff.ts built it with an empty original side.
if (editorParam === 'write-changeset') {
  registerEditorFixtureTab(() => {
    useUiStore.getState().openFileDiff({
      chatId,
      changeSet: [
        {
          path: 'src/brandNew.ts',
          original: '',
          modified: ['const wholeFileWrite = 1;', 'const secondLine = 2;', ''].join('\n'),
        },
      ],
      activeIndex: 0,
    });
  });
}
// `?voice=call|hands-free` opens a sustained voice session, so the top voice
// bar (spec/07 § Session modes) can be measured in a real browser: it is IN
// FLOW above the columns, which is the one thing jsdom cannot show. `?voiceLine`
// seeds what the line last heard-and-dropped, for the heard-not-sent state.
const voiceParam = params.get('voice');
if (voiceParam === 'call' || voiceParam === 'hands-free') {
  useVoiceStore.getState().startCall(chatId, voiceParam);
  useVoiceStore.getState().setCallPhase('listening');
  const dropped = params.get('voiceLine');
  if (dropped !== null) useVoiceStore.getState().setCallUnaddressed(dropped);
}

// `?meeting=live|paused|ended` seeds the chat with a meeting (meeting mode), and
// `window.__meetingStore` lets a spec play the host's `meeting.state` replies.
(window as unknown as { __meetingStore?: typeof useMeetingStore }).__meetingStore = useMeetingStore;
const meetingParam = params.get('meeting');
if (meetingParam === 'live' || meetingParam === 'paused' || meetingParam === 'ended') {
  const t0 = Date.now();
  const seeded: MeetingState = {
    status: meetingParam,
    startedAt: t0 - 34 * 60_000,
    ...(meetingParam === 'ended' ? { endedAt: t0 } : {}),
    elapsedBaseMs: meetingParam === 'live' ? 0 : 52 * 60_000,
    ...(meetingParam === 'live' ? { resumedAt: t0 - 34 * 60_000 - 12_000 } : {}),
    now:
      meetingParam === 'ended'
        ? null
        : {
            headline: 'Dev is arguing the ledger split should wait until after Black Friday',
            bullets: [
              'Risk: migrating during peak traffic',
              'Priya wants it before the statement run',
            ],
            who: 'Dev, Priya',
          },
    summary:
      meetingParam === 'ended'
        ? {
            headline: 'Ledger split goes ahead in November behind a flag',
            bullets: ['3 decisions · 5 actions'],
          }
        : null,
    topics: [
      {
        id: 't1',
        at: 22 * 60_000 + 5000,
        title: 'Points ledger split',
        points: ['Own service'],
        decided: true,
      },
      {
        id: 't2',
        at: 31 * 60_000 + 40_000,
        title: "Sam's failing tests",
        points: ['Sandbox out of credit'],
        decided: false,
      },
      { id: 't3', at: 30_000, title: 'Release 4.2', points: ['Ships Monday'], decided: true },
    ],
    actions: [
      {
        id: 'a1',
        title: "Top up Sam's sandbox credit by £50",
        why: 'Sam: tests keep failing',
        at: 31 * 60_000 + 40_000,
        status: 'pending',
      },
      {
        id: 'a2',
        title: 'Create ticket: move points ledger',
        why: 'Agreed by Dev and Priya',
        at: 22 * 60_000 + 5000,
        status: 'pending',
      },
      {
        id: 'a3',
        title: 'Sent Priya the Q3 retention deck',
        why: '',
        at: 9 * 60_000,
        status: 'done',
        resolvedAt: t0,
      },
    ],
    transcript: [
      {
        at: 33 * 60_000 + 58_000,
        speaker: 'them',
        text: "If we do it in November we're migrating in the busiest week of the year.",
      },
      {
        at: 34 * 60_000 + 3000,
        speaker: 'you',
        text: 'But the statement run on the first will lock it again.',
      },
    ],
    error: null,
  };
  useMeetingStore.getState().apply(chatId, seeded);
}

// `?route=/settings` drives an arbitrary initial route (else a chat).
const initialRoute = params.get('route') ?? `/chats/${chatId}`;

// The real global shortcut hook, wired to handlers that only record which
// action fired on `window.__shortcutCalls`. It lets e2e prove in a REAL browser
// that a chord does (or does NOT) reach an app action — e.g. ⌘A must fall
// through to the OS so it selects the transcript (spec/14 § Reserved OS chords).
function recordingHandlers(): ShortcutHandlers {
  const calls: string[] = ((window as unknown as { __shortcutCalls?: string[] }).__shortcutCalls =
    []);
  const record = (name: string) => (): void => {
    calls.push(name);
  };
  return {
    // The one handler whose behaviour is pure DOM and route-independent:
    // ⌘K/⌘F focus resolution (`lib/searchTarget.ts`). Record it AND run the
    // real thing, so an e2e can assert where focus actually landed and whether
    // the chord was taken — recording alone could not tell them apart.
    onSearch: (chord) => {
      calls.push('search');
      return focusPageSearch(chord);
    },
    onNewChat: record('newChat'),
    onNewChatPicker: record('newChatPicker'),
    onJumpOldestUnread: record('jumpOldestUnread'),
    onPrevFolder: record('prevFolder'),
    onNextFolder: record('nextFolder'),
    onJumpManager: record('jumpManager'),
    onArchiveCurrent: record('archiveCurrent'),
    onFilePicker: record('filePicker'),
    onDiffViewer: record('diffViewer'),
    // ⌘⇧' (spec/14 § Panes and tabs): same real-wiring reasoning as
    // `onToggleEditor`/`onToggleTerminal` above.
    onFileBrowser: () => {
      record('fileBrowser')();
      const chatId = useChatStore.getState().activeChatId;
      if (!chatId) return;
      useLayoutStore.getState().openTab({ kind: 'page', page: 'files', chatId });
    },
    // Recorded, and routed to the open composer exactly as AppShell does.
    onVoiceHoldStart: () => {
      record('voiceHoldStart')();
      const open = useChatStore.getState().activeChatId;
      if (open) composerHotkeyDown(open);
    },
    onVoiceHoldEnd: () => {
      record('voiceHoldEnd')();
      composerHotkeyUp();
    },
    onGlobalVoiceStart: record('globalVoiceStart'),
    onGlobalVoiceEnd: record('globalVoiceEnd'),
    onToggleSidebar: record('toggleSidebar'),
    onToggleChannels: record('toggleChannels'),
    onToggleArchived: record('toggleArchived'),
    onPrevChat: record('prevChat'),
    onNextChat: record('nextChat'),
    onCheatSheet: record('cheatSheet'),
    // ⌥E / ⌃` (spec/14 § Panes and tabs): recorded AND wired to the real
    // layoutStore action, same reasoning as `onCloseTab`/`onSplitPane` below —
    // a spec needs the tab to actually open/focus/close, not just confirm the
    // chord was recognised. Mirrors `AppShell.tsx`'s own wiring exactly.
    onToggleEditor: () => {
      record('toggleEditor')();
      const chatId = useChatStore.getState().activeChatId;
      if (!chatId) return;
      useLayoutStore.getState().toggleTab({ kind: 'page', page: 'files', chatId });
    },
    onToggleTerminal: () => {
      record('toggleTerminal')();
      const chatId = useChatStore.getState().activeChatId;
      if (!chatId) return;
      useLayoutStore.getState().toggleTab({ kind: 'terminal', chatId });
    },
    // Panes and tabs (spec/14 § Panes and tabs): recorded AND wired to the
    // real layoutStore actions, like `onVoiceHoldStart` below — an e2e spec
    // needs the chord to actually close/switch/split, not just confirm it
    // was recognised. Mirrors `AppShell.tsx`'s own wiring exactly.
    onCloseTab: () => {
      record('closeTab')();
      const layout = useLayoutStore.getState();
      const pane = resolvePane(layout.root, layout.activePaneId);
      if (pane.activeTabId) layout.closeTab(pane.id, pane.activeTabId);
    },
    onPrevTab: () => {
      record('prevTab')();
      useLayoutStore.getState().cycleActiveTab(-1);
    },
    onNextTab: () => {
      record('nextTab')();
      useLayoutStore.getState().cycleActiveTab(1);
    },
    onSplitPane: () => {
      record('splitPane')();
      const layout = useLayoutStore.getState();
      layout.splitActivePane(layout.activePaneId, 'right');
    },
  };
}

const harnessShortcutHandlers = recordingHandlers();

// `?ws=fake` hands ChatRoute a stand-in socket. Everything else in the harness
// deliberately runs with `ws={null}` — most specs want the not-connected path —
// but the terminal cannot be exercised at all without one: its session only
// reaches `live` once the host answers `patch.terminal.open` with a
// `patch.terminal.ready`, and nothing that depends on a live shell (running a
// command, echoing it) can happen before that. So this records every frame on
// the same `__wsSent` array the rest of the harness asserts against, and
// answers an open with a ready.
const harnessWs: PatchWs | null =
  params.get('ws') === 'fake'
    ? ({
        send: (event: WireEvent) => {
          wsSent.push(event);
          if (event.type === 'patch.terminal.open') {
            useTerminalStore.getState().ingest({
              type: 'patch.terminal.ready',
              sessionId: event.sessionId,
              cwd: event.folder ?? '/home/tom/projects/patch',
            });
          }
        },
        requestReplay: () => {},
      } as unknown as PatchWs)
    : null;

// Mirrors AppShell's desktop-shell navigate subscription (spec/09 § `### desktop`
// — a clicked native toast opens the chat it came from). It must live INSIDE the
// router, since it routes; AppShell is itself inside one, the harness's Harness
// is not. Stub `window.patch.onNavigate` in an init script and an e2e can fire
// the shell's IPC at the real hook.
function DesktopNavigationBridge(): null {
  useDesktopNavigation();
  return null;
}

// Same reason as DesktopNavigationBridge above: `chat-view` scope (spec/14
// § Discoverability) reads `useLocation()`, so this has to live INSIDE the
// router too.
function GlobalShortcuts(): null {
  const location = useLocation();
  useShortcuts(harnessShortcutHandlers, { isChatView: isChatViewPath(location.pathname) });
  return null;
}

function DiscardUnsentNewChats(): null {
  useDiscardUnsentNewChats();
  return null;
}

function Harness(): JSX.Element {
  // Mirrors AppShell's global wiring so e2e can exercise the real thing.
  useShiftClickGuard();
  // Mirrors AppShell's batch watcher, so the batch notification (and the click
  // through to the batch view it now offers) is exercisable against the real
  // toast rather than a stand-in. Seed `patch.batch.members` in an init script
  // and the all-ready notice fires on mount off the harness's own chats.
  useBatchWatcher();
  // Mirrors AppShell's cold-start folder-roster fetch (spec/04 § Folders →
  // Folder roster). The store hydration above cannot stand in for it: the whole
  // point of the roster is to carry folders whose chats are ALL archived, and
  // after a real reload those chats are ABSENT from the hydrated roster. Specs
  // stub `/api/chats/folders` with `page.route`; unstubbed it 404s in the
  // harness and the roster simply stays empty, which is the pre-fix behaviour.
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/chats/folders');
      if (!res.ok) return;
      const body = (await res.json()) as {
        folders: Array<{ folder: string; daemonId: string; lastUpdated: number }>;
      };
      useChatStore.getState().setFolderRoster(body.folders);
    })();
  }, []);
  // Mirrors AppShell's section counts (spec/04 § Section counts) by calling the
  // very same hook, so the collapsed sidebar badges — and their refresh when a
  // chat is archived — are exercised here rather than re-implemented. Specs stub
  // `/api/chats/counts` with `page.route`; unstubbed it 404s and the counts stay
  // null, which draws no badge (the pre-fix appearance).
  useSectionCounts();
  // Mirrors AppShell's boot load of account preferences (spec/04 § History —
  // the provider-switch confirmation reads `suppressProviderSwitchWarning`
  // from here on every route, not just /settings). Unstubbed `/api/settings`
  // 404s in the harness and preferences just stay at their default, matching
  // the folder-roster fetch above rather than surfacing a toast no spec here
  // asserts on.
  useEffect(() => {
    void usePreferencesStore
      .getState()
      .load()
      .catch(() => {});
  }, []);
  // spec/14 ## Layout → Narrow widths: same auto-collapse/auto-close hook
  // AppShell uses, so the narrow-layout e2e specs exercise the real thing
  // against the real `.three-col`/`.sb`/`.editor-rail` CSS.
  useResponsiveShell();
  // Mirrors AppShell's document-title sync (App Updates: "should show which
  // workspace I am in somewhere"), so an e2e spec can assert on `document.title`
  // against the real hook rather than a stand-in.
  useDocumentTitleSync();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const sidebarMini = useUiStore((s) => s.sidebarMini);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  // `?route=/sidebar-window` — AppShell serves this as a BARE route (no docked
  // sidebar, no chat panel, no editor rail), so the harness mirrors that shape
  // instead of nesting it in the three-column shell. Rendering it inside the
  // shell would draw a second, docked Sidebar beside it and measure nothing
  // real.
  if (initialRoute === '/sidebar-window') {
    return (
      <div className="app-shell bare" data-testid="app-shell-bare" style={{ height: '100vh' }}>
        <MemoryRouter initialEntries={[initialRoute]}>
          <GlobalShortcuts />
          <SidebarWindowRoute />
        </MemoryRouter>
      </div>
    );
  }
  const columns = (
    <div
      className={`three-col ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      style={voiceParam === null ? { height: '100vh' } : { flex: '1 1 auto', minHeight: 0 }}
    >
      <MemoryRouter initialEntries={[initialRoute]}>
        <GlobalShortcuts />
        <DesktopNavigationBridge />
        {/* Mirrors AppShell: a new chat left empty is deleted on leaving it. */}
        <DiscardUnsentNewChats />
        {sidebarCollapsed ? null : sidebarMini ? <MiniSidebar /> : <Sidebar />}
        <SidebarBackdrop />
        {/* AppShell's sidebar divider. Mirrored here so the narrow-width specs
            can see that the drawer drops it — without it in the harness, an
            "is not drawn" assertion passes against an element that never
            existed. */}
        {sidebarCollapsed ? null : (
          <ColumnDivider
            side="left"
            width={sidebarMini ? SIDEBAR_MINI_WIDTH : sidebarWidth}
            onResize={setSidebarWidth}
            testId="sidebar-divider"
          />
        )}
        <Routes>
          {/* Mirrors AppShell: `/` is where anything "take me back" points, and
              it resolves to the Manager thread. */}
          <Route path="/" element={<IndexRedirect />} />
          <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          <Route path="/chats/:chatId" element={<ChatPaneRoute ws={harnessWs} />} />
          <Route path="/settings/*" element={<SettingsPaneRoute ws={harnessWs} />} />
          <Route path="/jobs/new" element={<JobPaneRoute ws={harnessWs} />} />
          <Route path="/jobs/:id" element={<JobPaneRoute ws={harnessWs} />} />
          <Route path="/jobs" element={<JobsPaneRoute ws={harnessWs} />} />
          <Route path="/lifecycle/:kind" element={<LifecycleRoute />} />
        </Routes>
        {/* A LATER sibling of `<Routes>` — see `EditorFixtureBridge`'s own
            note on why its effect has to commit after `ChatPaneRoute`'s. */}
        <EditorFixtureBridge />
        {/* Mirrors AppShell: after the routes, so its no-drag hole is folded
            in after `.chat-head`'s drag region (spec/05 § Window chrome). */}
        <SidebarExpandButton />
        <ToolsPanel />
        <SideThreadsPanel />
        <ConfirmModal />
        <PromptModal />
        {/* Mirrors AppShell: the toast queue is the app's ONE error surface
            (spec/12 § Principles), so e2e can see what a failure actually
            looks like instead of asserting against a stand-in. */}
        <ErrorToasts />
        <TooltipHost />
        <DevErrorOverlay />
      </MemoryRouter>
    </div>
  );
  // Mirrors AppShell's pending-update and offline banners. A FRAGMENT, and
  // above the columns: both render null in their resting state (no staged
  // update; harness boots `connection: 'connected'` above), so for every
  // layout spec — none of which stub a desktop shell or force a disconnect —
  // the DOM is byte-for-byte what it was, and no column measurement moves.
  const withChrome = (
    <>
      <OfflineBanner />
      <DaemonOfflineBanner />
      <DesktopUpdateBanner />
      {columns}
    </>
  );
  // Without `?voice` the harness is the columns alone, exactly as every layout
  // spec already measures them. With it, they sit under the real app-shell
  // column so the bar is laid out against them for real.
  if (voiceParam === null) return withChrome;
  return (
    <div className="app-shell" data-testid="app-shell" style={{ height: '100vh' }}>
      <VoiceBar />
      {withChrome}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  </StrictMode>,
);
