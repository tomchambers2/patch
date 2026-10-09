# @patch/web

Patch's human-facing web SPA. Vite + React 19 + React Router v7 + Zustand +
TanStack Query + Tailwind v4 + @monaco-editor/react. Mounted at `/app/` in
production behind Caddy + the patch server.

## Routes

| Path             | View                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `/`              | Redirects to `/chats/<manager>` if a Manager chat exists, otherwise renders an empty state. |
| `/chats/:chatId` | Main chat view — header, live event stream, composer.                                       |
| `/jobs`          | Job list (cron / webhook / todoist) with enable toggle.                                     |
| `/jobs/new`      | New job form.                                                                               |
| `/jobs/:id`      | Edit existing job.                                                                          |
| `/settings`      | Account, push registration, logout.                                                         |

## Stores (Zustand)

- `chatStore` — chats list, active selection, kebab menu, per-chat timelines.
  `applyEvent(WireEvent)` ingests every `chat.spawned` / `chat.state` /
  `chat.message` / `chat.tool_call` / `chat.permission_request` event.
- `presenceStore` — server-WS connection (`connecting` | `connected` |
  `reconnecting` | `offline`) and host online/offline.
- `voiceStore` — incoming-call banner state (`chat.call_request`), active
  voice session, voice-note PTT overlay target.
- `uiStore` — sidebar collapse, search query, column widths, error toasts.

## Data flow

1. On boot, look for a credential in localStorage (or the DEV-only
   `?credential=<jwt>` query param). No credential → render `PairingScreen`.
2. With a credential, mount `AppShell`:
   - TanStack Query cold-starts the chats list (`GET /api/chats`).
   - `PatchWs` opens `/ws`, sends `hello` with the bearer, dispatches every
     subsequent event into the right store.
   - On reconnect: capped exponential backoff (1s → 30s) and per-chat
     `chat.replay { fromSeq }` for the chats whose transcript we already hold
     (the open chat + any with a rendered timeline). A cold start replays
     nothing — the roster is the single `GET /api/chats` metadata call and each
     transcript loads on open (spec/12 § Cold start loads metadata only).
3. UI mutations issue REST POSTs (pin / archive / job CRUD) and optimistic
   store updates; failures push a red toast via `uiStore.pushError`.

NO FALLBACK: every failure surfaces as a banner; we never silently render
stub data.

## Dev workflow

```bash
# 1. Bring up the test stack (server + daemon + Caddy on :13000):
docker compose -f docker-compose.test.yml up -d --build

# 2. Run the SPA dev server (proxies /api and /ws to localhost:3000):
pnpm --filter @patch/web dev

# 3. Pair this surface — paste a JWT into the pairing screen, OR open
#    http://localhost:5173/app/?credential=<jwt> in DEV.

# 4. Lint / typecheck / test:
pnpm --filter @patch/web lint
pnpm --filter @patch/web typecheck
pnpm --filter @patch/web test

# 5. Production build:
pnpm --filter @patch/web build         # → dist/
```

## Audio WSS

Voice sessions hit the host's audio WSS via the URL returned by
`POST /api/voice/token` (group 13). The server proxies `/api/voice/audio/*`
through to the host at `:3003`, so the SPA composes the URL using the
same origin and only needs to swap `http(s):` for `ws(s):`.

## Keyboard shortcuts (global)

| Chord         | Action                                |
| ------------- | ------------------------------------- |
| ⌘K            | Focus chat search                     |
| ⌘N            | New chat                              |
| ⌘1            | Jump to Manager                       |
| ⌘A            | Archive current chat                  |
| ⌘P            | File picker — project-wide (group 20) |
| ⌘'            | Diff viewer (group 19)                |
| ⌘↵            | Send composer                         |
| ⌘; (hold)     | Voice note to current chat            |
| ⌃Space (hold) | Voice note to Manager (window-level)  |

## Smoke test

```bash
node packages/web/test-smoke/smoke.mjs
# screenshot saved to /tmp/patch-group17-smoke.png
```

## What's not in this group

- Mobile — group 21. Voice device — group 23.

See `spec/14-design-web.md` for the full visual spec and `spec/18-tech-stack.md`
for the chosen stack.

## Editor right-rail (Monaco) — group 19

The right-rail is a Monaco editor with two modes:

- **Diff mode** (`@monaco-editor/react` `DiffEditor`, unified view) — opens
  automatically when a `chat.permission_request` for a file-edit tool
  (`Edit` / `Write` / `NotebookEdit`) arrives. The modified side is
  editable; if the user tweaks it before clicking Approve, the surface
  emits `chat.permission_response { decision: 'approve_with_edits',
editedDiff }` so the host applies the user's edits in place of the
  agent's original tool args.
- **Browse mode** — a tree on the left + Monaco viewer on the right,
  rooted at the chat's pinned folder. The tree fetches lazily via
  `GET /api/chats/:id/files?path=<rel>` (cached by TanStack Query). `⌘P`
  opens a fuzzy file-search modal.

Shortcuts:

| Shortcut | Action                              |
| -------- | ----------------------------------- |
| `⌘ '`    | Open the most recent diff           |
| `⌘ P`    | File picker (in browse mode)        |
| `⌘ ⇧ '`  | Open the file browser               |
| `⌘ ⇧ E`  | Toggle fullscreen overlay           |
| `Esc`    | Exit fullscreen / close file search |

NO FALLBACK: if Monaco fails to mount (missing CDN, OOM) the user gets a
banner toast — we do not silently render a textarea.
