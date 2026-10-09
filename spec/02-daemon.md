# Host

One native background process per host machine, running as the user who owns
that machine. It runs agent sessions and owns the filesystem they work in.

## Runtime and installation

The host runs with the access of the user it runs as: the whole filesystem,
every installed tool, services on loopback, the machine's package manager,
`docker`, `systemctl`, `launchctl` and `cron`. A chat on a host can do what that
user can do from their own shell.

It runs under the user's account and `HOME`, so the agent reads that user's own
configuration — their skills, plugins, MCP servers, settings and `CLAUDE.md` —
and a chat behaves the way that agent behaves in their terminal.

The OS service manager owns its lifecycle: launchd on macOS, a systemd user unit
on Linux, with restart-on-failure and start-at-boot. It runs through logout,
surface disconnects, and any app on the same machine closing.

It is a native process rather than a container. A container would have to mount
the host back into itself to reach the files it works on, keeping a private
network namespace that hides services on loopback, a private PID namespace that
hides host processes, a foreign uid that misowns written files, and a duplicate
toolchain. On macOS and Windows the container runs inside a Linux VM that cannot
see the user's machine at all, so there the arrangement cannot work.

The host dials out to the server over WSS and holds that connection, so a host
works from behind NAT with no public address, open port or DNS entry.

### Installation

The host ships as an installable binary artifact per OS/arch, which installs on
a machine that has only an OS on it.

```
patch-daemon-<version>-<os>-<arch>/
  node               pinned Node runtime
  daemon.mjs         the bundled daemon
  native/            platform-native addons (onnxruntime for VAD)
  silero_vad.onnx    the VAD model (~2 MB), the one model weight in the artifact
  install            registers the service, then runs first-run setup
```

`silero_vad.onnx` is in the artifact because it is ~2 MB and everything
end-of-utterance and barge-in depends on it, so it works on every host with
nothing downloaded (`07-voice-app.md`). The large weights stay out
(§ Optional components).

Two install routes:

1. `curl … | sh` on any machine with a shell.
2. From a surface: Settings → Hosts offers the install command for another
   machine, and the desktop app installs the host onto the Mac it runs on
   (§ Desktop app and the local host).

First run is self-contained: the installer registers the service, provisions an
agent backend (§ Agent backends), then asks for the pairing code the user takes
from a linked surface's Add host, and submits it with the host's public key
(`10-auth.md` § Host registration).

The install also writes the `patch-cli` skill that ships in the artifact into the
host user's own agent skills directory, and rewrites it on every self-update, so
every chat on the host can drive the CLI and the skill matches the host it
describes (`17-cli.md` § Skill).

The host self-updates. It checks the server for a newer build on boot and on a
schedule, downloads it, and restarts itself under the service manager. A host
behind the current version shows an update control in Settings → Hosts. A failed
update leaves the running version in place and reports the failure to surfaces.
The restart never lands under a running turn: it would kill the turn and every
command it is running. An update asked for while any chat on the host is mid-turn
is accepted as deferred at once (the asker is often one of those turns), and the
install waits until no chat is running, checked again after the download.

### Desktop app and the local host

The desktop app is a surface. It installs and manages the host on its own
machine — offering "run a host on this Mac", installing the service, showing
its status, restarting it — and the host it installs is an ordinary OS service
with its own lifetime, like any other host's.

Settings → Hosts in the desktop app carries a This Mac group while the Mac has
no host: one Install action, which mints a pairing code and runs the published
installer with it, and on failure shows the installer's own last lines. Once the
host is installed the group goes, and the Mac is a row in the host list.

A macOS service is given the PATH the user's login shell builds, not the
installer's own: launchd and whatever launched the installer both start from a
bare PATH, and a chat needs the user's tools. An installer that cannot read that
PATH stops rather than registering a service with a guessed one.

## Agent backends

A session runs on an agent backend. A backend supplies four things: the models it
can run, the credential those models authenticate with, the permission modes it
accepts, and the transcript store it persists sessions to. A chat's model
selects its backend, and the host reports the backends a host has to surfaces.

Claude Code runs through `@anthropic-ai/claude-agent-sdk` against the host's installation. OpenAI runs through a managed, version-pinned Codex app-server process, with an isolated credential profile per account. A model's provider selects the backend; an existing conversation cannot change provider. OpenAI models use provider-qualified identities in the model catalogue.

Codex supports explicit approval, workspace edits, read-only planning and explicitly unrestricted execution. It does not offer Claude's automatic approval classifier. A new OpenAI chat inherits explicit approval when the host default is Claude's automatic mode.

Codex history persists independently of Claude transcripts, including tool results and pending turn identities. On reconnect the host reconciles an outstanding provider turn before submitting another request. An uncertain outcome is reported and never silently retried. Branches fork at provider-supported turn boundaries; unsupported partial-turn branch points are refused.

The host provisions a backend the host lacks rather than reporting it as
missing. For Claude Code it resolves the `claude` executable and passes it to the
SDK as `pathToClaudeCodeExecutable`, so turns run against the same binary,
version and configuration the user gets in their terminal:

1. Present: use it. The resolved path and version go to surfaces and appear in
   Settings → Hosts.
2. Absent: install it via the backend's own installer, reporting progress to
   surfaces over the same channel as § Optional components.
3. Present and logged out: report `daemon.unauthenticated` naming the backend.
   Settings offers that backend's routes to a credential (`10-auth.md`).

A host takes its last-used model from the first catalogue it reads successfully —
the newest entry of it — so a host can run its first chat before anyone has
chosen a model on it (`04-chats-and-folders.md` § Spawn). That read needs a
working credential, so a host whose backend is provisioned but logged out has no
last-used model until the credential is connected. Every chat spawned after that
sets it.

A failed install is reported to surfaces and the host holds turns for that
backend until it is resolved. Backends are independent: a host with one backend
unprovisioned keeps running chats on the others.

## Permission mode

Turns run under `auto` by default: a model classifier approves or denies each
tool call without involving a human. Surfaces are remote and frequently
asleep, so `auto` is what a host starts on absent an explicit choice — a call
the classifier will not approve is denied outright and the agent is told so in
the transcript, which leaves the triggers, jobs and self-wakes that run
unattended free to carry on or fail visibly rather than stall until somebody
happens to look.

`bypassPermissions` never prompts — every tool call runs immediately.
`default`, `acceptEdits` and `plan` DO block a turn: a tool call needing a
decision under that mode (e.g. `acceptEdits` still prompts for a Bash command,
only file edits are pre-approved) is held until a `chat.permission_request`
sent to surfaces (`03-wire-protocol.md`) is answered with a
`chat.permission_response` — the chat reports activity `awaiting-permission`
meanwhile, resuming the turn once answered, denying the call with the agent
told so in the transcript if declined. Because these modes can stall a turn
on an absent human, none of them is ever reached by default — only by a
deliberate choice, made by someone who intends to be there to answer it.

The modes are `auto`, `acceptEdits`, `bypassPermissions`, `default` and `plan`.
They are the Agent SDK's own mode names and are passed through to it unchanged,
so every surface that offers the choice names them exactly as written here
rather than in words of its own.

Every chat carries its own mode. It is stamped at creation from the host
default in force at that moment (a spawn request naming a mode wins over it),
and from then on only a change made to that chat alters it. Changing the host
default therefore steers the chats created next, and never reaches back into
one already running. The mode is stored with the chat rather than in the
running process, so a host restart does not disturb it.

The default is a shared setting (`01-server.md` § Settings), so every host
stamps new chats from the same one; `auto` until one is chosen. A chat is set from within the chat itself. There
is no clearing a chat back to the host default — a chat with no mode of its own
does not exist. A chat that predates chats carrying their own mode adopts the
host default once, when its host first loads it, and keeps it thereafter.

The host carries the chat's mode on `chat.state`, so a surface shows the mode
the next turn will use. That value is only ever the mode in force now, so a
change made part-way through a conversation is also written into the chat's
transcript, as a `system` `chat.message` naming the mode the chat moved to. It
is recorded where the change was made, which is one turn before it takes
effect. Re-picking the mode a chat is already on changes nothing and records
nothing. The host keeps these records with the chat rather than relying on
the agent's own transcript, which has no notion of them, so they replay in
place after a restart like the rest of the chat.

Claude Code can resolve a turn onto a different mode than the one it was
given — the host's `claude` build too old for the mode, or the chat's model
not supporting it — and does not refuse the combination itself, it silently
substitutes one and carries on. The host compares the mode Claude Code
actually resolved against the one requested and, for every substitution
target except `plan`, refuses the turn: the chat's status becomes `errored`
and the transcript states both modes and why, because the remaining targets
(`default` in practice) block on a human approving every tool call, which for
an unattended chat is a dead end rather than a degraded mode.

A turn Claude Code lands on `plan` is not refused. `plan` blocks a turn the
same way `default` does — a decision per tool call — so it is exactly what a
person choosing `plan` from the mode control gets, not a dead end. The turn
runs on, the chat is moved onto `plan` exactly as a person's own choice would
move it, and it gets the same mode-change record in the transcript — except
this one names Claude Code as what made the change, not the person the chat
belongs to.

### The agent's own Plan Mode entry, mid-conversation

Distinct from the substitution above: the agent can call `EnterPlanMode` /
`ExitPlanMode` itself, mid-turn, on a chat that was never given `plan` at all
— a deliberate "let me think this through with nothing at stake" the model
reaches for, independent of the chat's configured mode. Left unrecorded, the
chat's configured mode (and therefore its mode control everywhere) kept
reading whatever it was configured to — `bypassPermissions`, say — while the
SDK was, in fact, gating every subsequent tool call the way `plan` does, which
is what an otherwise-ordinary `Bash` call needing an unexpected approval looks
like from the outside.

The host watches for these two tool calls in the stream (`EnterPlanMode` a
`tool_use`, `ExitPlanMode` its `tool_result` — gated on the result, not the
call, since `ExitPlanMode` presents the plan and waits on approval before the
SDK actually leaves `plan`; a denied/errored result changes nothing). Entering
stamps the chat onto `plan` and records it exactly as the substitution case
above does (`automatic`, naming Claude Code as what made the change);
exiting restores whatever mode the chat was actually configured to before —
held in memory for the span of the plan, not persisted, since it describes
one turn's tool-call sequence, not a standing preference. A manual mode
change made _while_ plan is active is not specially reconciled against this
in-memory stash; it is expected to be rare enough not to need it.

### Questions are not approvals

The permission gate is also how the agent asks the user a question:
`AskUserQuestion` reaches it under EVERY mode, `auto` and `bypassPermissions`
included, because there is nothing to auto-approve — the tool's whole output is
the answer the human gives. Its arguments carry 1–4 questions, each with a
short `header`, the question text, 2–4 `options` (`label` + `description`) and a
`multiSelect` flag; its `answers` argument is left empty for the permission
layer to fill in, and the tool echoes back whatever it finds there. So an
approval with no answers is not a no-op — it runs the tool and returns an empty
answer to the agent, which then proceeds on a decision the user never made.

The host therefore treats an `AskUserQuestion` permission as a question, not a
yes/no: the surface renders the options (`14-design-web.md` § Main chat panel)
and returns the selections as `approve_with_edits` (`03-wire-protocol.md`
§ Answering with content), and the host merges them into the tool's `answers`
argument as the `updatedInput` it grants permission with. Denying is still a
real deny — the tool does not run and the agent is told so — which is what
"cancel the question" means. NO FALLBACK: answers that do not parse as
`{[questionText]: string}` deny the call and raise a `chat.error`, rather than
approving an empty answer.

Cancelling is not the same act as stopping the turn (`04-chats-and-folders.md`
§ Message queueing), and the deny message the agent is handed says so. Left
generic, a deny reads to the agent as the user refusing the plan behind the
question, not just declining to answer it — so a question the agent could have
carried on past instead ends the turn outright (Tom, Todoist: "patch cancelled
user question generally just stops"). The host's deny message is explicit
that the turn is still live, and tells the agent to keep going on whatever it
can decide for itself, and to come back and ask — or stop — only for what a
question exists for in the first place: an ambiguity it cannot resolve alone,
or a next step that is destructive, irreversible, spends money, or otherwise
reaches outside the chat into the real world.

A question is also superseded by the user simply answering in the composer,
which is the normal thing to do when none of the options is the answer. A new
message on a chat with an outstanding question cancels the question — a real
deny, so the tool does not run — and the message then runs as the next turn.
Without that the message is accepted, queued, and goes nowhere: the turn is
suspended on the question, and the queue only drains once that turn ends. The
agent is told that the question was superseded rather than refused, and that the
next user turn is the answer, so it reads the reply instead of apologising for
having asked. Only questions: an ordinary tool approval is a turn paused on
purpose, and typing must never decide it.

A question also EXPIRES. It is the one permission the user cannot simply leave
pending: the turn cannot proceed without it, so a question asked while the phone
is in a pocket parks the whole chat indefinitely and the agent has no way to
notice. Question expiry is a shared setting (`01-server.md` § Settings): on or off, and the window in seconds, defaulting to on at 10 minutes.
Turned off, a question waits indefinitely and no deadline is shown.

An ordinary tool approval expires too, on a fixed hour rather than the
question window, and is not configurable: an approval raised in a chat nobody
is watching wedges an unattended job exactly as a question does, but a chat
someone is sitting in front of is likelier to want to approve a tool call than
to answer a question, so it is given more of the doubt.

The host owns the deadline, and it is the same deadline everywhere: the
request carries the instant it expires (`03-wire-protocol.md`), so every
surface counts down to the one the host will actually act on rather than to a
clock of its own, including a surface that connects after the question was
asked. A request with no deadline on it is one that will not expire.

A question's deadline is not fixed the instant it is asked. A surface's
`chat.focus_change` (`03-wire-protocol.md`) naming this chat, or naming
something else after previously naming this one, gives the deadline a fresh
full window — the same length the question was originally asked with, not
whatever the setting currently reads, so a mid-flight change to the setting
cannot retroactively shrink a question already in play. Both edges reset it —
Tom looking at the question and Tom looking away are each worth a fresh window
(Tom, Todoist: "the question timer should reset when you view the chat, and
then start again when unfocused"). Every connected surface is told
the new deadline (`chat.permission_expiry_update`, `03-wire-protocol.md`), so
the one-deadline-everywhere rule above still holds after a reset. Only a
question resets this way; an ordinary tool approval's fixed window ignores
focus.

The expiry resolves as a `deny` on the wire, because `deny` is what
`chat.permission_response` can already say and a new decision value would be
dropped by any surface running behind (`03-wire-protocol.md`). The AGENT is told
the truth instead, through the deny message the host hands `canUseTool`: that
nobody answered, that this was NOT a refusal, and that it must not assume any of
the options. Otherwise an expiry reads to the agent exactly like the user
rejecting the question, which is the same class of bug as an empty answer.

## Optional components (large models)

The list is Kokoro TTS (~340 MB) and a local Whisper model (~1.5 GB): the two
weights sets too large for the installer. The host downloads them on demand,
per host, driven from the app. The VAD model stays off this list — it is ~2 MB
and ships in the artifact (§ Installation). Two entry points:

- Settings → Hosts → components lists each optional component with its size and
  state (`not installed`, `downloading`, `installed`, `failed`) and install and
  remove controls.
- Pressing the mic on a host whose voice components are missing asks once —
  "Voice needs a 340 MB download on <host>. Download?" — and on accept starts
  that same download with progress in place. Declining cancels the action.

Download progress streams to every surface (`03-wire-protocol.md` § Host
components), so a download started on a phone is visible on the desktop.

Each host advertises the components it has. A surface disables an affordance
whose component is missing and names what is needed. An interrupted download
resumes, and a component counts as installed once its size and digest verify.

Remote backends install nothing: with `WHISPER_BACKEND=groq`, STT is a cloud
call.

## Browser

A host can run a real browser for its own chats — Chrome/Chromium in a
virtual display, never headless — so an agent can do what a human does in a
browser: fill in a form, sign in, click through a multi-step flow, in the
background. Distinct from the optional "Browser tools" setting that wires the
`playwright` / `chrome-devtools` MCP pair into a chat's tool list (§ Runtime
and installation above, `14-design-web.md` § Agent behavior) — that stays as
it is, an opt-in MCP a chat can turn on. This is a Patch-owned capability with
its own `patch_browser_*` tools (`06-threads-manager-speakers.md` §
Browser tools), distinct names so the model never faces two overlapping ways
to drive a browser.

**Honest by design.** The browser is a normal Chrome/Chromium with a normal
fingerprint: never headless (`headless: false`, under a real display, or on a
headless Linux host one this component opens itself with its own Xvfb),
automation flags off (`--disable-blink-features=AutomationControlled`,
`navigator.webdriver` patched undefined by an init script), real input events
with human timing on every click and keystroke, persistent cookies. It never
pretends to be something it isn't beyond being a normal browser — no stealth
beyond that, and no captcha-solving service of any kind. It obeys
`robots.txt` only where that applies (crawling); a user-directed task working
a page the user asked for open is not a crawl.

**Profiles.** One persistent profile, `<patchHome>/browser/profile` — a real
Chromium `userDataDir` — shared by every chat on the host, so a site logged
into once stays logged in across chats and across a host restart (this is
the `'logged-in'` default `patch_browser_open` takes). A task that must run
signed out instead passes `profile: 'logged-out'`, which opens a throwaway,
in-memory browser context with no `userDataDir` and so no cookies to carry —
closing its tab leaves nothing on disk.

**Installation.** Optional, the same Settings → Hosts pattern as the voice
weight sets (§ Optional components above) — not installed, the
`patch_browser_*` tools fail saying exactly how to install it, with no
fallback to another browser or to `headless: true`. Unlike a weight download
there is no digest to verify: "installed" means Playwright's own Chromium is
present (`npx playwright install chromium`) and, on a headless Linux host
with no `DISPLAY`, that `Xvfb` is on the `PATH` to open one. A host that
already has a real display (a desktop Mac, a Linux box someone is logged
into) uses that one directly and never starts its own Xvfb.

**Tools.** `06-threads-manager-speakers.md` § Browser tools has the
full signatures. In short: `patch_browser_open` returns a `tabId`;
`patch_browser_read` returns an accessible-ish snapshot — every visible
interactive element with a stable `ref` — that `_click` / `_type` /
`_fill_form` / `_select` / `_upload` target by; `_screenshot` sees what the
snapshot can't (layout, an image, a bot check); `_tabs` lists every open tab
on the host; `_close` ends one. A `ref` is only valid until the next `_read` —
call it again after a navigation or anything that changes the page. Before
anything irreversible a click or a submitted form could trigger — a payment,
a sent message, a booking, a deletion — the tool's own guidance is to ask the
user first; this is the tool-ownership convention (`principles.md` § Tool
ownership), not a second permission system alongside `canUseTool`.

A chat driving `patch_browser_*` looks like any other tool call in the
transcript: there is no screencast, no live "Browsing &lt;site&gt;" status row,
and no take-over control (`14-design-web.md` / `15-design-mobile.md`). The
browser is not scoped per chat — every chat on a host shares the one real
browser and its open tabs.

### Route through

Settings → Hosts → &lt;host&gt; → Browser → "Route through" sends that host's
`patch_browser_*` traffic out through another of the user's hosts instead of
its own network: none (the default, direct) or any other registered host. The
IP a routed host ends up browsing from is otherwise the user's own concern —
this is an option, not a default, and nothing else about the host (its other
tools, its shell, its files) is affected.

Traffic goes browsing host → server → routing host → internet, carried over
the existing host↔server WS links each already holds — no open port on
either machine. The browsing host runs a loopback-only SOCKS5 listener that
its own Chromium launches against (`proxy.server`); each CONNECT it accepts
becomes one stream, relayed by the server to the named routing host, which
makes the real outbound connection and pumps the bytes back the same way
(`03-wire-protocol.md` § Browser tunnel). Changing the setting (on, off, or to
a different host) closes that host's open browser tabs and relaunches
Chromium with the new proxy (or none) the next time one opens — a running
browser's proxy cannot be repointed without relaunching it.

The user is always aware routing is on: the host's row and its browser detail
state "via &lt;host&gt;" for as long as the setting is active, read from the
same `browserRouteThrough` the host reports on `daemon.host`.

The routing host being offline fails the open outright, naming it — browsing
never falls back to going direct. Naming the routing host as itself is
refused; the Settings picker never offers it as an option.

### Web Bot Auth

A host can sign every request its agent browser makes so sites that verify
agents (Cloudflare verified bots, Akamai) can recognise Patch. Per host, by
environment: `PATCH_WEB_BOT_AUTH=on|off` (default off). When on, every http(s)
request from either profile (`logged-in`, `logged-out`) is signed per request
(RFC 9421, `tag="web-bot-auth"`, covering `@authority` and `signature-agent`,
Ed25519, `keyid` = the key's RFC 7638 thumbprint) and carries
`Signature-Agent: "<directory URL>"` (`PATCH_WEB_BOT_AUTH_DIRECTORY`, default
`https://patch.tomchambers.me/.well-known/http-message-signatures-directory`).
The key is `PATCH_WEB_BOT_AUTH_KEY`, base64 PKCS#8, from the 1Password Agents
vault (`env-patch`) via `deploy/web-bot-auth.env.tpl`. On with no/invalid key
fails host start loudly; a signing failure aborts that request, never sends it
unsigned.

The server serves the public half: `GET /.well-known/http-message-signatures-directory`
(signed key directory, unauthenticated; 503 naming the variable if no key) and
`GET /agent` (what Patch is, that it obeys robots.txt and browses at human
rates, and who to contact).

## Claude Code settings

The host runs Claude Code against the user's own configuration (§ Runtime and
installation), and two parts of it are visible and editable from Settings:

- `settings.json` in the `~/.claude` the agent backend reads — permissions,
  hooks, model, statusLine, output style, env and the rest. It is a shared
  setting (`01-server.md` § Settings): one text for every host, plus an optional
  override per OS (`darwin`, `linux`) whose top-level keys replace the shared
  ones on hosts of that OS, for values such as hook paths that differ between
  machines. The host writes the file from each snapshot. Shown and edited as
  raw JSON; text that is not valid JSON is refused, naming why, rather than
  stored.
- Memory entries: Claude Code's own persistent-memory files, one per topic,
  under each project's `~/.claude/projects/<project>/memory/` alongside its
  `MEMORY.md` index. These stay on the host that wrote them, since they are
  stored under that machine's project paths. Each entry is listed with its
  name, description and type (parsed from its frontmatter) and can be deleted.
  Deleting one also drops its line from that project's `MEMORY.md` index where
  present.

Claude Code itself can change `settings.json` on the machine, and so can a
person editing the file. The host watches it, and a file that no longer
matches what the snapshot wrote is reported as drift on that host rather than
overwritten or ignored. Settings offers two actions on it: take it into the
shared text (or that OS's override), or discard it, which rewrites the file
from the snapshot. A new snapshot does not overwrite a drifted file either;
the drift stays reported until one of the two is chosen.

The host publishes memory entries and any drift on connect and after every
change (`03-wire-protocol.md` § Host events), and the local CLI socket carries
the same operations (§ Control IPC).

## Provider keys

The paid services the host itself calls each need an API key: Gemini
(`GEMINI_API_KEY`) and OpenAI Realtime (`OPENAI_REALTIME_API_KEY`) for hosted
voice, and Groq (`GROQ_API_KEY`) for Whisper when `WHISPER_BACKEND=groq`
(`07-voice-app.md` § Voice is a config matrix). These are the host's own
keys, not the agent's (the agent's credentials are its backend's, `10-auth.md`),
and not Secrets (which are injected into chats, `15-design-mobile.md` §
Settings tab).

Provider keys are shared settings (`01-server.md` § Settings): set once on
Settings → Keys and used by every host.

- A key comes from Settings → Keys, or from the host's own environment, read
  once at boot. A key set from Settings wins over the environment; revoking it
  lets a host's environment apply again. A key in one host's environment can
  be adopted from Settings as the shared value.
- Everything that uses a key reads it when it opens a session or sends a
  request, so a new snapshot takes effect for the next session with no
  restart. After applying one, each host re-publishes `daemon.host`, whose
  `voiceKeys` and `providerKeys` state each key's source on that host (`ui` /
  `env` / `none`) and whether its environment also has one. They drive
  Settings → Voice's "not configured" line, and re-log any configured voice
  surface now without its key.
- Set takes a value of at least 16 characters with no whitespace (a pasted
  value is trimmed); anything else is refused as `invalid_value`.
- The Groq key cannot be revoked while any host runs `WHISPER_BACKEND=groq`
  with none in its environment (`required`, naming the host): that host
  refuses to start without it, and would not come back up to be given
  another. Replace it instead.
- A missing key never stops a host, except for that Groq one. Voice refuses
  the surface's sessions (`voice_key_missing`), and a transcription on a
  missing Groq key fails naming where to set it.

## Responsibilities

- Session lifecycle. Spawn, stop, resume agent sessions pinned to folders. Each session runs in-process on its chat's backend, without permission prompting by default (§ Permission mode).
- chat_state maintenance. Maintains a live, in-memory struct per chat: last N messages, activity (`idle` / `running` / `awaiting-permission` / `errored`), last-updated timestamp. Updated as events flow. Exposed via `patch_peek` (see `06-threads-*.md`). No LLM summarisation — this is raw materialised state.
- History persistence. Append-only log per chat on local filesystem, independent of the harness's own native history (`principles.md` § History ownership) — the read source for every chat once its one-time import has verified. See `04-chats-and-folders.md`.
- Local log as a cache. The host's log of a chat is what answers replays while the host is online, and the server can rebuild it. Every `chat.state` carries `lastSeq`, the highest seq the log records. On `patch.log_sync.request` the host sends its logged events after a seq, oldest first, in size-bounded `patch.log_sync.batch` frames; on `patch.log_restore` it writes each event it does not already hold into its log and carries its numbering on above them, so a restore may be sent twice. On `chat.committed` it never lets its numbering fall at or below the server's log (`01-server.md` § Message log). The host still allocates seqs itself, so a turn runs with the link down; its events wait in the link's offline buffer and are recovered from the log if that buffer overflows.
- Sequence durability. Per-chat monotonic sequence counter is persisted to `~/.patch/chats/<chatId>/seq` (atomic write) after every emit. On host restart, sequence resumes from the persisted value — replay continues to work across crashes.
- Action execution. Server fires all triggers (cron/webhook/todoist) server-side. The server emits the same event shape a surface would (`chat.spawn_request`, `chat.input`, `notify`, tool_call) — host handles them identically to surface-originated events.
- Notify egress. When a chat calls `patch_notify`, host forwards to the server with routing metadata.
- Cross-chat tool execution. When a chat's agent calls `patch_send_to` / `patch_spawn` / `patch_peek`, the host executes it in-process when the target is on this host, and relays it through the server to the owning host otherwise (`03-wire-protocol.md` § Cross-chat tools).

Public-facing routing and push fanout belong to the server (see `01-server.md`).

## Host identity

Each host has a stable `daemonId` issued at registration and a host name,
editable from any surface. It defaults to the name a person knows the machine
by: on macOS the Computer Name ("Tom's MacBook Pro"), not the numbered network
hostname; elsewhere the hostname without its domain. Surfaces
label the host by that name ("hetzner", "Tom's MacBook"). The host also reports
its platform and arch, its own version, its provisioned backends and their
versions, its installed optional components, its permission-mode default and its
last-used model.

## Stack

- Node (pinned runtime, shipped with the host artifact), TypeScript, single process.
- Drives its agent backend in-process (§ Agent backends), which manages whatever subprocesses the agent needs internally and gives us the agent stream as an async iterator.
- Local storage, all of it resolved from the host user's `HOME` so it is the same on every start — with two deliberate test-only overrides, `PATCH_HOME` and `PATCH_DAEMON_SOCKET`, which exist so several hosts can run on one box for the multi-machine test rig (`18-tech-stack.md` § Testing). An ordinary install sets neither, and nothing in the product writes them: `~/.patch/` (config, credentials, socket) + `~/.patch/chats/<chat-id>/` (per-chat state: `meta.json`, `wake.json`, and its own append-only history log, `events.jsonl` — `04-chats-and-folders.md` § History) + `~/.patch/blobs/` (content-addressed store for large tool results and inline images referenced from that log) + `~/.patch/threads/{manager,speakers}/` on the home host (each special thread's working folder — `06-threads-manager-speakers.md` § Where special threads run). The agent's native history under `~/.claude/projects/...` is a resumption cache the harness reads from, not the record.
- Connects to server via WebSocket. Reconnects with exponential backoff; buffers outbound events during disconnect. See `12-error-and-offline.md`.

## CLI

The CLI surface is defined in `17-cli.md`. The daemon-local subset:

```
patch host start            # start the service (the installer registers it; this is for manual control)
patch host stop             # stop daemon; running chats stay alive as orphans until restart
patch host status           # running / last heartbeat / chat count / version
patch host list             # active chats
patch host clean            # remove stale meta.json entries for chats the backend has lost
```

Modelled on `happy host`.

## Session ID capture

The SDK emits a `result` message containing `session_id` on every query. Host captures it from the message stream and persists to `meta.json`.

If a chat does `/clear` or `/compact` mid-session, the SDK rotates `session_id` in the next `result` message; host updates `meta.json` accordingly.

## Context compression

When a chat's context fills up the SDK compacts the conversation and emits a compaction boundary carrying whether it was triggered automatically or by the user, the token count before, and — where the SDK reports them — the count after and how long it took. The host emits that boundary as a `system` `chat.message` whose content is the one-line record of the compression and whose `compaction` payload carries those figures, and writes it to the transcript so it replays with the rest of the chat instead of vanishing on re-entry.

A boundary missing its trigger or its before-count fails the turn, rather than being drawn with invented numbers that would read as measurements.

## Streaming assistant text

Surfaces render the reply progressively, not as a single final dump. The host drives every `query()` with `includePartialMessages: true`, so the SDK emits `stream_event` partials carrying `text_delta` chunks as the model produces tokens, ahead of the turn's final `assistant` message. The daemon:

- Reserves the seq the finalising `chat.message` will carry on the first text delta of a turn.
- Fans out each chunk as a transient `chat.message_delta { chatId, messageSeq, delta }` live event (no own `seq`, mirroring `audio.transcript_partial`): NOT persisted, NOT replayed.
- Emits the durable `chat.message` at that same reserved seq when the turn's final `assistant` message arrives — this is the record `chat.replay` / `patch_history` reconstruct.

A surface accumulates deltas keyed by `messageSeq` to render the reply chunk-by-chunk, then the matching `chat.message` supersedes the accumulator. An aborted/errored turn drops its unfinalised accumulator (the reserved seq is simply skipped — replay filters by seq, not contiguity).

## Background work

A shell command the agent asks to run in the background belongs to the agent process, which ends with the turn — so it would be killed moments later having produced nothing, and the agent would end its turn believing work was under way. The host refuses the background request and tells the agent why, so the choice is corrected rather than silently lost.

Native subagent dispatch (`Agent`, formerly `Task`, and `Workflow`) is not corrected but removed: the whole subagent runs inside this turn's process tree, so it dies with the turn or a host restart and the resumed turn has no way back to its work. All three tools are in `disallowedTools`; a subagent is a `patch_delegate` call (`06-threads-manager-telegram-speakers.md` § Cross-chat toolset), covered next.

### Native subagent dispatch — `patch_delegate`

`patch_delegate({ prompt, model?, folder?, disallowedTools?, wait? })` gives an agent a real subagent: a durable background worker that runs `prompt` to completion and hands its full final reply back to the chat that called it (the PARENT). It is built on the host's own chat machinery rather than being a second implementation of a chat: a subagent IS an ordinary chat — same `meta.json`, same SDK session, same turn queue, same restart-resume — with one extra field, `meta.subagent: { parentChatId, label, outcome? }`, that is never cleared.

That one field does three things:

- **Lifecycle.** The subagent's turn runs exactly like any other chat's. The moment it settles — idle with nothing queued (success), or `errored` with no retry armed (an SDK error, or a usage limit it cannot get past) — the host stamps `outcome` (`done`/`failed`) once, and delivers a `[from <label>]`-prefixed message into the PARENT as a new turn, queuing behind a running parent turn like any other machine message (`04-chats-and-folders.md` ## Message queueing). A failure delivers the same way, naming what went wrong — never silent. Stopping or archiving the parent stops every one of its subagents that has not already settled (`outcome` stamped `stopped`, nothing delivered — the caller already knows). Several subagents can run under the same parent at once; each is an independent chat.
- **Task/Agent semantics.** By default the call returns at once and the result arrives as the `[from]` turn. With `wait: true` the call blocks until the subagent settles and returns `{ id, label, status, reply }` as its tool result — the host then does NOT also deliver a `[from]` turn (a host restart drops the blocked call, so a waiter that is gone falls back to the delivery). `disallowedTools` is the subagent's capability limit, persisted on `meta.subagent.disallowedTools` and added to the always-disabled set for every turn it runs. A settled subagent stays addressable: `patch_delegate_send({ id, message, wait? })` clears its `outcome`, runs the message as its next turn in the same session, and settles again exactly as before; it errors for an id that is not the caller's own subagent.
- **The parent stays alive for it.** While any of its subagents has not settled, the parent counts as still working, like one with a running `patch_watch`: a hidden parent does not archive itself, an active goal is not evaluated (it re-checks once they have delivered), and the chat cannot be moved to another host.
- **Durability.** Because a subagent is an ordinary chat, a host restart resumes its in-flight turn exactly as it would any other chat's, and the delivery above fires whenever that resumed turn settles — there is no separate subagent-restart path to get wrong.
- **Invisibility.** Every surface that lists, searches, or notifies about chats excludes a chat carrying `meta.subagent` — not in the sidebar, Hidden, Archived, or search, no badges, no notifications, no needs-attention, never marked unread. The ONLY way in is the parent's own transcript: the `patch_delegate` call renders as a tool-call row carrying the subagent's live state (running / awaiting-permission / done / failed / stopped) and a link to open its transcript read-only (`14-design-web.md` § Main chat panel — Delegate tool row).

Permissions follow the parent, not a separate mode: a subagent is stamped with the parent's permission mode at creation, like any spawn. If its turn blocks on a tool approval — including its own `AskUserQuestion`, which arrives through the identical `canUseTool` gate — the request is mirrored onto the PARENT's own transcript, labelled with the subagent's name, because the user is looking at the parent and the subagent has no surface of its own to ask on. The real gate still belongs to the subagent's own chatId; the mirror is resolved by the same `requestId`-keyed answer any permission card uses, so answering the mirrored copy unblocks the real turn. A subagent itself has no way to reach the user directly: `patch_notify`, `patch_report`, `patch_call`, `patch_speak`, `patch_ask_human` and `patch_artifact` are disabled for its turns on top of whatever the user has toggled off — talking to the user is the parent's job.

Work that genuinely outlives a turn belongs to the host. `patch_run` starts a command the host owns: it runs in its own process group, its output is retained, and it survives the turn that started it and the chat going idle. `patch_run_list` reports what is in flight, `patch_run_output` reads what a run has produced so far, and `patch_run_stop` ends one and everything it started. When a run finishes the host delivers the outcome into its chat as a turn, the same way a self-wake is delivered.

A run is persisted per chat, so a host restart re-adopts it; one whose process did not survive the restart is reported as failed rather than left pending for ever. Runs ride on chat state, so a surface shows what a chat has in flight without asking the agent.

## Background task completions

The agent runs sub-agents in the background. When one finishes, the SDK reports it on a user message carrying a `<task-notification>` block whose summary is a readable sentence naming the task and how it ended. The host puts that sentence on the transcript as a system message, so the completion is visible in its own right rather than only as the agent abruptly reacting to it.

The sentence names the task and how it ended — completed, failed, stopped or killed, carrying the process exit code where the task was a process. The wordings are the agent layer's, not ours, and the list is not closed: a sentence naming a task and ANY outcome ends that task, under the outcome it spells out where that is one we read exactly and under `ended` where it is not. Being unable to read a phrase must never leave the task it ended reading as still running, which is what an enumerated list of wordings did (`principles.md`). It is passed through unchanged: it is what surfaces read to render the completion (`14-design-web.md` § Background task completions), and it stands on its own where a surface does not. A block carrying no summary surfaces nothing — there is no sentence to invent.

The lifting is a live-path translation only. Replay reconstructs a transcript from what the agent layer persisted, where the notification is still a user turn carrying the whole raw block, so a replayed chat — and any chat on a host whose host predates the lifting — hands that block to the surface as a user message. Surfaces therefore recognise the raw block themselves and render it as a completion rather than as a turn (`14-design-web.md` § Background task completions, `15-design-mobile.md` ## Chat detail). Replay does not rewrite the persisted turn: the block is what was persisted, and a surface that reads it is enough.

While a background task is still running, the agent layer streams its output to a file on the host, under a per-session `tasks` directory named by the background id the launch reported (`/tmp/claude-<uid>/<project>/<session>/tasks/<id>.output`). A backgrounded command appends to it as it runs; a backgrounded sub-agent's is its transcript, so one lookup covers both kinds. A terminal session (§ Terminal sessions) is started by the same host on the same machine, so following that file is how a surface shows what a running background task is doing (`14-design-web.md` § Main chat panel — Background task bar). The host neither creates nor parses these files.

The host answers a surface's request for what a set of running background tasks are costing the machine, named by those same background ids. Every process in a backgrounded command's tree holds that task's output file open as both its standard output and its standard error, so the processes holding that file open are the task's processes; the task's cost is theirs summed. CPU is each process's share of one core averaged over its own lifetime, as the host's process table reports it — an average rather than an instant, because a number resampled every few seconds jitters without saying anything a reader can use. Memory is resident set size, which is current by nature.

A task with no such process is reported as unmeasured, not as zero: a backgrounded sub-agent runs inside the agent process and only links its transcript into the tasks directory, and a command whose processes have already exited leaves the file behind. Zero is a measurement, and a task that is genuinely working must never be indistinguishable from one that could not be measured (`principles.md`).

The host also counts how many of each chat's background tasks are still running, and reports that count on the chat's state (`03-wire-protocol.md` ## Event categories). It tracks them from its own outgoing stream: a `run_in_background` call starts one, a completion notice ends one, and an explicit kill ends one, paired by the same rules a surface uses (`14-design-web.md` § Main chat panel — Background task bar). A surface holding many chats has the transcript of none, so this count is the only way the list can tell a chat that has finished from one that settled idle with work still in flight. It is in memory only: a background task belongs to the agent session that launched it, and a restart leaves nothing of it running. The count is reported on every state emit, zero included, so a surface can tell a host that counts them and reports none running from a host that does not count them at all.

Nothing else on a user message is chat-visible. Tool results and the turn's own prompt echo arrive the same way and are not transcript entries.

## Output style

Patch injects no system prompt to shape the agent's output (`principles.md` § No system-prompt injection): the host passes no `systemPrompt`/`append` to the SDK `query()`. The model's default style stands. If the user wants to shape it (no emoji, terse voice replies, etc.) they do so in the CLAUDE.md of the chat's folder, which the agent reads itself — nothing in the platform layer invisibly steers the agent.

## Per-turn process / warm sessions

Each turn runs as a fresh agent process: it spawns, runs the turn, and exits. The spawn costs a couple of seconds — unnoticeable in a typed chat, and the dominant cost of a spoken one.

So a chat in a voice call holds one warm agent process instead, opened when the call starts and closed when it ends, paying the spawn once per call rather than once per utterance. Nothing else uses one. A chat outside a call gets a fresh process per turn, and so do the host's own title and status turns, which never join a chat's session.

A warm session takes the chat's settings — folder, model, permission mode, disabled tools, system prompt, skills, and the session it resumes — when the call starts, and keeps them for the call. A change made elsewhere while a call is running applies to the next call, and a surface offering that change says so rather than appearing to take effect. Branching a chat, or switching the track it is on, ends the call's session: those change which session the chat continues, and a warm process cannot follow them.

Barge-in interrupts the running turn and leaves the session warm. An interrupt that does not land promptly ends the session instead, so a stop is always honoured and a wedged agent can never leave a chat unable to start another turn.

The session ends when the call ends, when the chat's folder changes, when the chat is deleted, when a turn fails, and when the host shuts down. Ending it stops the agent process and everything it started.

A message the agent harness generated is not a message the model wrote, and is never rendered as one. Claude Code injects its own turns — stamped `model: "<synthetic>"` with zero input tokens — and on resuming a session whose last turn died it answers its own `Continue from where you left off.` with something like `No response requested.`. Shown as the assistant's reply, that is a turn which produced nothing reading as a turn which answered: the silent success this app has no room for. A synthetic assistant message is shown instead as a muted `system` line flagged `synthetic` (`ChatMessageEvent.synthetic` in `@patch/wire`), attributed to Claude Code: the gap stays visible without the agent's name on it. The resume placeholder never crosses the SDK stream — Claude Code writes it straight into the session — so the daemon also watches what the Claude session store mirrors (`claudeSessionStore.ts` `onAppend`) and shows any non-error synthetic reply written there, once per uuid however it arrives. A surface names the `No response requested.` placeholder `Turn interrupted` and quotes it; any other synthetic reply is quoted as what Claude Code inserted. Because Claude Code inserts it while loading the session for the NEXT message, the line appears just after that message — exactly where the model reads it. A compaction notice, which arrives the same way, keeps its own compaction line. The marker must be PRESENT to fire: a backend that carries no raw SDK message is not synthetic, and relabelling its replies would be the worse bug. Reopening a chat replays its own history log, so the line reads exactly as it did live (`04-chats-and-folders.md` § History); translating a Claude Code transcript directly (an import, a fork point) still drops these entries, because they were never part of what the chat showed.

The model never sees them either. Claude Code writes the placeholder into its transcript and, by default, sends it back as the agent's own past reply on every later resume — a long-lived chat piled up 54 of them and the agent began ending its own quiet turns with the same words. The daemon starts every run with `CLAUDE_CODE_RESUME_TOLERATES_CONTEXT_APPENDS=1`, which makes Claude Code drop a synthetic `No response requested.` when it loads a session — but only one whose immediately preceding entry is a user turn. In practice an attachment (the token-count reminder) almost always sits between the tool result and the placeholder, so the filter does not fire: replaying a real 2026-10-07 session through Claude Code 2.1.291 with the flag set sent all four of its placeholders to the model, one directly after the same tool output the model then answered with `No response requested.` itself. This is Claude Code's behaviour and is left as is; the placeholders are made visible instead (above).

A turn the agent could not complete is recorded as a failed turn, whether or not the agent process exited. A warm agent reports a refused request — a spend or rate limit, a rejected credential, an invalid session — by ending the turn normally and putting the refusal in its reply, so a host that only watches for a process to die reads a failure as a finished turn and prints the refusal as though the agent had said it. The refusal is a failure: it parks and retries where the cause is transient, and surfaces as the chat's error otherwise.

## Self-wake

A self-wake lets a chat ask the host to re-invoke itself after a delay — "in 10 minutes, deliver this message back to me as a new turn". It's the primitive behind self-rescheduling reminder/check loops (e.g. a go-to-bed nag that fires every 10 minutes from 10pm until you acknowledge, then stops), and behind a fixed-cadence loop that never needs re-arming at all (e.g. "check on the build every 5 minutes").

Why the host owns it, not the agent. The agent can't usefully wait inside a turn (it would hold the SDK `query()` open and die on a restart), and the agent's native `CronCreate` does not work here: a turn runs to completion and ends, no agent process outlives the call it belongs to, and the host wires no agent cron/hooks — so an in-session cron has nothing to fire it. Because a visible-but-dead tool is a trap, the host disallows the `Cron*` family (`disallowedTools`, removing them from the model's context — `principles.md` § Tool ownership), so the agent only ever sees `patch_wake_me` and `patch_loop`. Instead: the agent calls one of them and ends its turn (no blocking). The host holds the timer; when it fires, the host delivers the message into the same chat exactly like any input — resuming the agent session via `claudeSessionId`. (If the chat is mid-turn, a plain `patch_wake_me` wake queues behind it — see `04-chats-and-folders.md` § Message queueing. A `patch_loop` tick does not: see "count the interval from the end of the turn", below.)

Durable. The pending wake is persisted per-chat at `~/.patch/chats/<chatId>/wake.json` (atomic write). On host restart, every persisted wake is re-armed; a wake whose time passed during downtime fires once on boot (catch-up — the agent's own clock-check decides if a late wake is still relevant), and one past its optional `notAfter` cutoff is dropped. This is the durability `CronCreate` (in-process, dies with the turn) cannot provide.

One-shot + adaptive loop, or `patch_loop`. A plain wake fires exactly once, then the file is cleared. To loop adaptively, the agent calls `patch_wake_me` again on each fire with whatever next interval it decides — the cadence is the agent's own choice ("in 10 min", "in 20 min", escalating), not a fixed cron. This depends on the agent's behaviour each cycle: if a turn errors, or the agent simply doesn't get around to re-arming before the turn ends, the loop silently stops with nothing saying so. `patch_loop({ message, every, notAfter? })` is for the common case where that dependency isn't wanted — a fixed cadence, decided once — and removes it: the host itself re-arms `fireAt = now + every` every time the record fires, instead of clearing it, so the cadence is mechanically guaranteed rather than agent-remembered. One pending wake per chat either way (a loop and a plain wake share the exact same `wake.json` slot — both are "the host will deliver a message into this chat later", so arming one replaces the other). The agent stops an adaptive loop by doing nothing further; either kind is stopped early with `patch_cancel_wake` — there is no separate tool to stop a `patch_loop`, because a recurring wake is still just a pending wake, one that happens to re-arm itself.

A loop's `every` counts the interval from the END of a turn, not from whenever a tick happened to land. A tick that comes due while the chat's pump is already occupied — an unrelated turn still running, or (the common case when a turn outlasts `every`) the turn the loop's own previous tick started — is absorbed, not queued: the host marks the record `waiting` and arms nothing further, so a turn far longer than `every` is never followed by several identical `[wake]` turns queued up to run back to back once it finally settles. The moment that turn actually ends, the host arms a fresh `fireAt = now + every` from then — "every 3 minutes" means 3 minutes of quiet between checks, not a tick stacked for every 3 minutes the chat happened to stay busy. `waiting` is persisted on `wake.json` alongside the rest of the record, so it survives a host restart: a loop found `waiting` on boot re-arms immediately, since from the fresh process's point of view whatever turn it was waiting on is, one way or another, over. This applies only to `patch_loop` — a plain `patch_wake_me` still queues behind a running turn exactly as before.

Tools (see `06-threads-manager-speakers.md` § Cross-chat tools): `patch_wake_me({ message, in | at, notAfter? })` — exactly one of `in` (relative: `"10m"`, `"1h30m"`, seconds, or `PT10M`) or `at` (absolute ISO 8601, computed by the agent in the user's TZ); `patch_loop({ message, every, notAfter? })` — `every` is the same relative-duration grammar as `in`, and the first fire is one `every` from the call (then that cadence forever, or until `notAfter`/cancellation); `patch_cancel_wake()` stops whichever of the two is pending. Delivered turns carry a `[wake]` prefix, as metadata-as-data like `[voice • …]` (see `principles.md`), for both kinds alike.

A surface can arm or stop a loop too, not just the agent: `/loop <interval> <message>` typed in the composer sends `chat.loop_request` (`03-wire-protocol.md`), which reaches the identical `scheduleWake`/`cancelWake` calls `patch_loop`/`patch_cancel_wake` reach — a bare `/loop` cancels. This is unlike `/goal`/`/remind`, which are pure user-owned banner state with no agent-tool equivalent; a loop needs to land on the real scheduler, since the agent can arm, see, and stop the very same one.

A pending wake is a scheduled future turn in the user's chat, and is visible as such: the host carries it on `chat.state` as `pendingWake` — `{ message, fireAt, notAfter?, every?, waiting? }`, or `null` when nothing is armed — read straight from `wake.json` on every state emit, so it is correct after a restart and after a catch-up fire. `every` (ms) is present only for a `patch_loop` record; its absence is what tells a surface this is the plain one-shot kind. `waiting` is present (and `true`) only while that loop is absorbing a tick, per the above — `fireAt` is stale then, so surfaces read `waiting` instead of trusting a countdown to a time that isn't real yet. State is re-emitted the moment a wake is scheduled, replaced, cancelled, or fires, and the moment a loop's `waiting` tick is absorbed and the moment it's re-armed on turn-end — a firing `patch_loop` record re-emits too, since its `fireAt` just moved (a firing plain wake clears to `null` instead, as the delivered turn lands). Surfaces render it as a bar above the chat showing the countdown to `fireAt` and the wake message, or "waiting for current turn" in place of the countdown while `waiting` is set (`14-design-web.md` § Main chat panel). A plain one-shot wake is a read-only readout there — the agent owns the timer, and there is no cancel control for it — but a loop's bar carries a stop control, since a loop is exactly as likely to have been armed by the user (`/loop`) as by the agent (`patch_loop`), and either can stop it.

Self-wake vs job vs `CronCreate`: a job (`08-triggers-and-jobs.md`) is an externally-defined schedule that fires into a usually-new chat (durable, server-side); a self-wake is a chat re-invoking itself, adaptive or fixed-cadence, and self-terminating or explicitly cancelled (durable, host-side, per-chat); `CronCreate` is the agent's in-session timer — unavailable in the host's session model, so Patch provides self-wake in its place.

## Task list

The agent tracks its work with Claude Code's native TodoWrite tool. The host observes those tool calls and mirrors the list onto chat state as `todos` — `{text, status}` per item, status ∈ pending / in_progress / completed — carried on `chat.state` so every surface can show what the chat is working through (`14-design-web.md` § Main chat panel). The mirror follows the agent's list and is not persisted: a rehydrated chat starts empty until its next TodoWrite.

Keeping the agent on the list. When a turn settles idle with items still incomplete, the host fires the head incomplete item back into the chat as a fresh `[todo]`-prefixed turn, so the agent works one focused item at a time instead of drifting. The fired turn carries a `<system-reminder>` telling the agent the line is one of its own TodoWrite items and to mark it in_progress now and completed once it is done; without that cue the agent does the work and leaves the item reading pending for ever.

An item already fired that comes back still incomplete is not re-fired — the agent stopped for a reason (usually a question for the user), and re-firing would steamroll the user's turn. A whole turn was spent on it, so the host marks it in_progress rather than leaving it reading pending, which would claim it was never started. The host never marks an item completed: only the agent or the user closes one out.

The user owns the list too. A surface rewrites it — edit an item's text, change its status, add or delete items — with `chat.todos_request`, which carries the whole list; the host adopts it wholesale, emits `chat.state`, and the auto-advance above then fires from the edited list. The agent's own TodoWrite state lives inside its session and cannot be written from outside, so the host tells it instead: the next turn on that chat is prefixed with a `<system-reminder>` naming the current list and instructing the agent to call TodoWrite to adopt it (the mechanism broadcast threads already use — `09-notifications.md`). Without it the agent's next TodoWrite would silently overwrite the user's edit. The reminder is one-shot: it is attached to the next turn and then cleared.

## MCP server

Patch ships a stdio MCP server (`patch-tools-server.js`). It is not registered in the agent's user-scope config — instead, every SDK `query()` the host makes passes an inline `mcpServers` option:

```ts
mcpServers: {
  patch: {
    command: 'node',
    args: [patchToolsServerPath],
    env: {
      PATCH_CHAT_ID: chatId,
      PATCH_DAEMON_SOCKET: '~/.patch/daemon.sock'
    }
  }
}
```

The SDK launches that script as a child process for the duration of the query. The MCP child reads `PATCH_CHAT_ID` from env on startup and tags every tool call with it. To execute side effects (look up other chats, fan out a notification, modify a job), it talks back to the host over `PATCH_DAEMON_SOCKET` — a Unix domain socket the host owns. The host holds all state; the MCP child is a thin wire.

Auth is the same for every caller of the socket (§ Control IPC): the MCP child is given `PATCH_DAEMON_LOCAL_KEY` alongside `PATCH_CHAT_ID` and presents it as a `Bearer` on each call. Host, MCP child and the agent's query all run as the same user on the same host, so the key is defence in depth over the `0600` socket rather than a trust boundary in itself. The host still identifies the child by the env it set, not by the key.

Identity is plumbing, not call-time. Each query gets a fresh MCP child with `PATCH_CHAT_ID` baked into env. The chat agent doesn't pass its own ID, the model doesn't echo it, no header parsing — the MCP child knows which chat it is from the moment it boots.

No mutation of `~/.claude.json`. The user's agent config stays untouched. Patch's MCP exists for the lifetime of patch-driven queries.

No tool-surface scoping. Every chat gets every tool. A coding chat can in principle call `patch_spawn` or `patch_job_create`; nothing in its prompt will steer it there.

### What else a chat gets, beside `patch`

By default a fresh host adds nothing beyond `patch` itself — Settings → MCP seeds a host with the `playwright` + `chrome-devtools` pair `disabled`, so nothing but `patch` reaches a chat until a user turns one on (`mcpServers.ts`).

Two more sources feed the same `mcpServers` option, both merged in by the host rather than left to the SDK (which does not merge them itself):

- **The host's own list** (Settings → MCP, `harnessMcpServers` in `host.json`) — servers the USER told Patch to add, editable through Patch's own settings tools, never by hand-editing a file. Only the `enabled` entries reach a chat.
- **Claude Code's own config** (`claudeConfigMcp.ts`, `discoverClaudeMcpServers`) — servers the user already told the `claude` CLI to add, outside Patch entirely: `~/.claude/settings.json` → `mcpServers`, `~/.claude.json`'s global and per-project `mcpServers`, and a project's `.mcp.json`, the last gated on that project already appearing in `~/.claude.json`'s `enabledMcpjsonServers` (i.e. a human has trust-approved it on this machine at some point — an unapproved `.mcp.json` entry is not one Claude's own process would run unattended either, so Patch doesn't run it unattended). Read-only, same as the "no mutation" rule above.

Merge order into a chat's `mcpServers`: `patch`, then Claude Code's own discovered servers, then the host's enabled list — a name in both wins from the host's list, since that is the one the user can see and edit inside Patch.

## Control IPC (local CLI ↔ host)

`patch <subcommand>` invoked on the host itself (e.g. while SSH'd in) talks to the running host over a Unix domain socket at `~/.patch/daemon.sock` (HTTP framing over the socket), not via the public WebSocket. The socket path is fixed under `~/.patch`, so the local CLI finds it without a port-discovery file. The socket is created mode `0600` (owner-only).

| Endpoint                         | Verb | Purpose                                                                     |
| -------------------------------- | ---- | --------------------------------------------------------------------------- |
| `/list`                          | GET  | Active chats                                                                |
| `/spawn-chat`                    | POST | Spawn a new chat in a folder                                                |
| `/stop-chat`                     | POST | SIGTERM a tracked chat                                                      |
| `/stop`                          | POST | Shut the host down                                                          |
| `/host`                          | GET  | This host's self-description — the same content as its `daemon.host` report |
| `/folders`                       | GET  | This host's folder registry                                                 |
| `/folders/add`                   | POST | Designate a project root                                                    |
| `/folders/remove`                | POST | Drop a designated project root                                              |
| `/backends`                      | GET  | Each backend's version and this host's view of its shared accounts          |
| `/models`                        | GET  | This host's model catalogue across its backends                             |
| `/components/install`            | POST | Install an optional component                                               |
| `/components/remove`             | POST | Delete an installed component                                               |
| `/claude-settings`               | GET  | This host's Claude Code memory entries and any settings.json drift          |
| `/claude-settings/memory/delete` | POST | Delete one memory entry                                                     |
| `/claude-settings/discard`       | POST | Rewrite a drifted settings.json from the last snapshot                      |
| `/update`                        | POST | Apply an available host update                                              |
| `/pair-device`                   | POST | Open the five-minute voice-device adoption window (`16-voice-device.md`)    |

Below the chat endpoints, the socket carries every host-scoped control of
`03-wire-protocol.md` § Host events that this host owns, one endpoint per
frame, because the CLI's default host is the machine it runs on (`17-cli.md`
§ Hosts and the CLI) and those commands must work there without a round trip
through the server. A host-scoped control added to the wire gains its endpoint
here in the same change. Shared settings are not host-scoped and have no
endpoint here: the CLI changes them through the server wherever it runs
(`01-server.md` § Settings). Four host controls are reached over HTTP too, even
when the CLI is invoked on that host, because the server owns them rather than
the host: minting a registration code for a new host, renaming a host, marking
one the home host, and revoking one. `/pair-device` runs
the other way round — it exists here and has no wire frame, since the host
adopts the device itself and the command is local-only (`17-cli.md` § Commands).

Requests carry a `Bearer` local key — a defence-in-depth measure over the OS-level same-host/same-user trust the `0600` socket already provides (cheap to add, closes the case where another local process can reach the socket). When the CLI runs on a different host, it goes via the WebSocket server, not this IPC.

The host is the only party that mints that key: it generates one on first start and keeps it at `~/.patch/local.key` (mode `0600`, beside the socket), rotating it on each start. It passes the current value as `PATCH_DAEMON_LOCAL_KEY` in the environment of the children it starts, and every other caller on that machine — the CLI a person runs there — reads the file, which the fixed path under `~/.patch` makes findable without discovery.

## Terminal sessions

The host owns the project filesystem, so it also owns the shell. A surface
can open a terminal session against a folder and drive it over the wire — the
escape hatch for the things the agent is not the right tool for: `git clone`ing
a repo into a project root so a chat can be opened in it, `pnpm install`, a quick
`ls`. Without it a remote host is a closed box: there is no way to put a new
folder on it from a surface.

- A session is a long-lived shell process (`$SHELL`, else `bash`) started
  with `cwd` = the requested folder, stdin/stdout/stderr piped. Long-lived, so
  `cd` and shell state persist across commands, exactly like a real terminal.
- A named folder is validated the same way a chat spawn is — it must exist
  on the host. A missing one is a loud `folder_not_found`, so a shell always starts where the
  caller asked.
- Omitting the folder is a different, explicit request — "a shell anywhere I
  can work" — used by the new-chat terminal, where no folder exists yet (that
  being the reason a shell is wanted). The host starts it in the first
  published project root that exists — where a clone is actually going — and
  falls through to `$HOME` only if it has no usable root. Either way `ready.cwd`
  reports the real directory, so the surface displays the path in use.
- Input is raw: whatever the surface sends is written to the shell's stdin
  verbatim. Output is raw: stdout and stderr are streamed back in chunks as
  they arrive, tagged with which stream they came from. The only bytes the
  host interprets are its own completion sentinel, below.
- Command completion is reported. A pipe shell prints no prompt and echoes
  nothing, so a command that produces no output — `cd`, `export`, `mkdir` —
  would otherwise be indistinguishable from one still running. Each session
  mints a random marker when its shell starts, and every input ending in a
  newline is followed on the same stdin by a command that prints that marker
  with the preceding command's exit status. The host strips the marker line
  out of stdout, so it never reaches the surface as output, and reports the
  status instead. Input that does not end in a newline is a partial line and
  gets no sentinel.
- Stripping the marker means holding back only those trailing stdout bytes that
  could still turn out to be the start of one, since the marker can straddle a
  chunk boundary. Everything else goes out as it arrives: a prompt written with
  no trailing newline must still appear immediately. stderr is never held.
- A command that reads stdin itself, or a multi-line construct typed line by
  line, consumes the sentinel rather than the shell, so it reports no
  completion until it exits. It stays reported as running, which is true.
- Output and completions are reported in the order the shell produced them. One
  chunk routinely carries the tail of one command's output, its sentinel, and
  the start of the next, so reporting the completions separately would file a
  failure above the error that earned it — or, on a chunk that lands mid-line,
  between the two halves of one message.
- Interrupt is a separate signal frame (`SIGINT`) delivered to the shell's
  process group, so a runaway command is killable without killing the session.
- Lifecycle: the session ends when the surface closes it, when the shell
  exits (exit code reported), or when it goes idle for 30 minutes. A host
  restart ends every session — there is no reattach, and the surface is told.
- Limits: there is NO cap on concurrent sessions per host. A count of shells
  bounded nothing worth bounding — an idle session is one piped `bash`, and the
  real cost is what a session runs — while the slots it did withhold were easy
  to exhaust by accident, since closing the drawer keeps the shell alive and a
  reloaded surface strands its old session until the idle timer reaps it. The
  idle timeout is what bounds accumulation. A per-session output rate cap
  remains, so a `yes`-style firehose cannot flood the link.
- This is not a sandbox. A terminal session runs with the host's own
  privileges — the same privileges the agent already has on that host. It adds
  no new authority, and it is reachable only by an authenticated surface.
- Git identity is the user's own: the host runs as them, so `~/.ssh` and
  `~/.gitconfig` are already in place and a private clone authenticates as it
  would in their terminal. `GIT_TERMINAL_PROMPT=0` is set, so a credential prompt
  on a session with no TTY fails immediately.

By default a session is a pipe shell, as above, so full-screen curses programs
(`vim`, `htop`) and password prompts that demand a TTY do not work in it. That
is the web drawer's trade: its use case is clone/install/inspect.

### PTY sessions

An open that carries a window size (`pty: {cols, rows}`) gets a real
pseudo-terminal instead, for a surface that draws with a terminal emulator (the
phone's host terminal, `15-design-mobile.md` § Host files and terminal). The
shell is a login shell (`$SHELL -l`, else `bash -l`), like an ssh session, so
the user's profile puts their own tools on PATH. It echoes, prompts, completes
on Tab and runs full-screen programs.

- The PTY is allocated by a small python3 helper the host runs — no native
  module. python3 is present on every host the host runs on; a host where the
  helper cannot start answers `pty_unavailable`, never a pipe shell instead.
- `ready` carries `pty: true`. A surface that asked for a PTY and gets a ready
  without it is talking to a host that predates the field and opened a pipe
  shell; it refuses the session and closes it.
- `TERM=xterm-256color`. `GIT_TERMINAL_PROMPT` is not set: a terminal can answer
  a credential prompt. When the host's environment names no locale at all, a
  UTF-8 character type is declared so the shell does not fall back to ASCII.
- Output is one stream, raw terminal bytes, decoded as UTF-8 without splitting
  a character across chunks. There is no completion sentinel and no
  `command-exit` — the prompt says when a command is done.
- Ctrl-C (`signal`) is the ETX byte written to the terminal, so the line
  discipline interrupts the foreground job exactly as a keyboard would.
- `resize` sets the window size, which is what sends the foreground program its
  SIGWINCH. A resize for a pipe session is refused with `not_a_pty`.
- Folder validation, the idle timeout, the output rate cap, the lifecycle and
  the privileges are those of every session, above.

## Host files

A surface can list, read and write files on a host by absolute path, with no
chat in between (`03-wire-protocol.md` § Host files). The chat-scoped file
browser resolves every path through a chat's folder; this is how a file outside
every chat — a skill under `~/.claude/skills`, a dotfile — is reached.

- It is not confined to the project roots. A surface that can reach this can
  already open a terminal on the host, which reaches every file the host's
  user can, so a narrower file API would guard nothing.
- A path must be absolute and already normal (no `.` or `..` segments, no
  doubled or trailing slash); anything else is `path_invalid`, never resolved
  against something the surface did not name. A `list` with no path lists the
  host user's home directory and reports its absolute path.
- A listing shows every entry, hidden ones included, directories first. A
  symlink is listed as what it points at; a dangling one as `other`.
- `read` returns UTF-8 text up to 1 MiB, with its `version` — the SHA-256 of
  the bytes on disk. A directory, a binary file or a larger file is refused with
  its own code rather than opened mangled or truncated.
- `write` replaces an existing file's whole content and must name the `version`
  it was edited from. If the file on disk no longer matches, the write is
  refused with `conflict` and nothing is written. It never creates a file. It
  writes through a symlink to its target, keeps the file's mode, and commits
  atomically (temp file, fsync, rename), so a concurrent reader sees the old
  file or the new one.
- A committed write inside a chat's folder is announced to that chat's
  surfaces with `patch.file_changed`, as its own editor's save would be.

## Chat search

The host answers `patch.chat_search.request` for its own chats (`04-chats-and-folders.md` § Search) from an index held in memory and never written anywhere: Patch stores no chat history, so the index is derived from the backends' own transcripts. It holds the user and assistant message text of each chat's current track, read through the same translation replay uses, so a hit's text is what the chat renders. It is built in the background at start-up; a search arriving before the build finishes waits for it rather than answering from a partial index. Every search then brings the index up to date first — it reads only what each transcript has appended since the last look (a line still being written waits for the next search), and re-reads a transcript that changed track or shrank — so a message written a moment ago is findable.

Only the text is indexed, not the tool traffic around it, which is what makes holding it in memory affordable: a host with 1.7 GB of transcripts carries about 14 MB of message text. A search over some 4,500 chats answers in around 100 ms; a cold build takes about 5 s. A per-query scan of the raw transcripts would take seconds, and a persisted full-text index would be a second copy of every message.

A hit's `seq` is looked up in the chat's canonical-seq sidecar, read-only: the n-th occurrence of a message payload in the transcript takes the n-th seq recorded for it, exactly as replay resolves it. A message with no recorded seq returns none — a search never allocates one. A chat whose transcript the backend has pruned from disk is still searched by name and preview, and the response counts such chats. A request with `fullText: false` searches names only and reads no transcript (so counts no missing ones). A quoted run in the query is one exact-phrase term, matched against text with whitespace runs collapsed.

## Model catalogue

The set of models a new chat can spawn on is read from each provisioned backend's
provider, not hard-coded. The catalogue is per host: a chat's host is chosen
before its model, and the models offered are that host's. The host owns it because the host owns the backend
credentials (`10-auth.md`) — no surface holds a model API key (`principles.md`).
On a `patch.models.request` it returns its cached catalogue across its own backends,
re-reading a provider's models endpoint whenever that entry is older than its TTL
(6 h). Entries are `{ id, label, backend }`, newest-first, so a model released
after the last deploy is selectable and a retired one stops being offered. A
chat's chosen model determines which backend runs it.

A missing or expired credential, or a non-2xx from a provider, is returned as an error against that backend, and the surface shows that error in the picker (`14-design-web.md` § Model selector) while models from the backends that answered stay selectable. A cached catalogue is served for its TTL even if a later refresh fails.

## Self-upgrade

See § Runtime and installation: the host checks for, downloads and applies its
own updates under the service manager, and reports its version and update state
per host.

## Host restart behaviour

The SDK runs in-process, so a host restart kills any in-flight query. There is nothing to reattach to — but the work is not abandoned, because a restart is the last thing every deploy does and chats must not silently stop mid-task waiting for a human to retype:

- Every turn the host is running or holding in a chat's queue is written to that chat's `meta.json` as `pendingTurns` (`persistPendingTurns`), so the set of unfinished work outlives the process.
- On restart, the host scans `~/.patch/chats/*/meta.json`, marks every chat as `idle`, and re-sends those pending turns in their original order (`resumeInterruptedTurns`). Turns belonging to a chat deleted while it was running are dropped.
- Each is a fresh `query()` with `options.resume = meta.claudeSessionId`, so the SDK reconstructs context from the agent's native history and the agent can see its own half-finished work AND the original ask. The turn that was actually running is prefixed with a `<system-reminder>` saying it was cut off partway and to carry on from what it had already done rather than start the request again; that reminder is stripped from the persisted transcript AND from the visible bubble, and is captured as `systemContext` on the turn's `chat.message` (§ System-reminder disclosure below) rather than discarded. The human-visible text sent alongside it is just `'Carry on'`, never the turn's own original text — the resumed session already has that in its history, so resending it would only duplicate it, at whatever length it happened to be (a large tool-result-shaped turn used to come back verbatim on every restart that interrupted it). Turns that were only ever queued never began — the agent has never seen them — so they go back verbatim.
- The `pendingTurns` marker is cleared before the re-send, and each resumed turn re-persists itself as it starts running: a second interruption is still caught, while a turn that takes the host down with it is not retried for ever.
- A query that was mid-tool-call when the host died loses that tool call; the agent picks up from the last persisted message.

No PID tracking, no lock file, no orphan reattach.

## System-reminder disclosure

The host prepends a leading `<system-reminder>…</system-reminder>` block onto a
user turn's outgoing prompt from several places — telling the agent context it has
no other way to learn:

- The restart reminder above (`INTERRUPTED_TURN_REMINDER` /
  `interruptedTurnReminderWithPendingDecisions` — the latter also names what
  permission/question was left pending when the restart hit).
- A surface rewrote the chat's task list (§ Task list): the reminder tells the
  agent to adopt the new list before its own next `TodoWrite`.
- A `[todo]` turn auto-fired from the task list: the reminder tells the agent
  which of its own `TodoWrite` items the turn corresponds to.
- A broadcast digest delivered to a special (Manager/Speakers) thread
  since its last turn (`06-threads-manager-speakers.md`).

Every one of these blocks always reaches the agent — that part is unconditional.
What changes is what a HUMAN sees: the block is stripped from both the visible
bubble and the persisted transcript (unchanged — see the duplicate-bubble note in
history.ts), but instead of being discarded it is captured as structured
`systemContext` on the turn's `chat.message` (`03-wire-protocol.md` §
`chat.message`), labelled by which mechanism produced it. A surface renders it as
a small disclosure at that turn — collapsed by default, expanding to the raw
block on click — so a reply that reacted to a restart or a broadcast reads as
reacting to something, instead of as an unprompted aside. This is a verification
aid, not something read on every turn: nothing about it is ever shown open by
default or pushed as a notification.

A re-send that folds into the bubble of the turn it repeats (a restart resume —
`12-error-and-offline.md` § What a recovery leaves behind) brings its captured
blocks with it: they join that one bubble's disclosures after any it already
had, so the turn a restart cut off reads as having been cut off. Folding the
attempt without its blocks would hide the restart notice, which is the block
this disclosure most exists to show.

Capture happens at ONE place turns live and replayed turns share:
`sanitizeCommandTextWithContext` in `history.ts` (the same function that always
stripped these blocks) now returns the stripped text AND the captured blocks
together, and both the live emission (`chatRunner.ts`, building the turn's own
`chat.message` at send time) and history replay (`jsonlLineToWire`, reconstructing
it from the persisted Claude Code transcript) attach the result — so a live turn
and its replayed twin carry identical `systemContext`, the same identity
guarantee `persistedUserContent` already gives their `content`.

Only Patch's own injected blocks exist today (`source: 'patch'` on
`SystemContextItem`). The type still reserves `source: 'sdk'` for a future
one-off block genuinely scoped to a single turn's prompt the way Patch's own
five are — but the block the agent backend DOES inject on its own (below)
turned out not to fit that shape at all, and got its own mechanism instead.

## Provider-level context

Claude Code's own harness injects a SEPARATE kind of context, structurally
unrelated to the `<system-reminder>` blocks above: its own `type: "attachment"`
transcript/stream entries — environment (cwd, platform, shell), model identity,
the day's date, an instruction file that changed since last read, a file the
agent had read that changed on disk outside it (`edited_text_file` /
`edited_image_file`, labelled "File changed externally" — an image's bytes are
never put in the text), the skill/agent/deferred-tool listings, a remaining-token-count reminder, and a
handful of purely internal bookkeeping records the harness never renders as a
reminder to the model itself (`command_permissions`, `prompt_snapshot`,
`deferred_tools_record`). Each is its OWN top-level entry — never embedded in
any turn's own prompt — so it cannot be captured by `sanitizeCommandTextWithContext`
above; it is read and translated separately, before that function ever runs
(`history.ts`'s `translateAttachment`, `jsonlLineToWire`'s `type === 'attachment'`
branch; live, the identical translation runs in `sdkBackend.ts`'s
`translateSdkMessage`, so a live turn and its replayed twin describe it the
same way).

The other structural difference from a `<system-reminder>` block: these recur
constantly within one session — a token-count reminder alone can fire hundreds
of times — so "one row per occurrence" (the `SystemContextItem` model) would
flood a chat with hundreds of disclosure rows, the opposite of what the
disclosure is for. So this is its own wire event, `chat.provider_context`
(`03-wire-protocol.md`), and a surface DEDUPLICATES it: `ChatRow.providerContext`
keeps exactly ONE entry per `providerType` (Claude Code's own stable name for
the kind, e.g. `"environment"` / `"total_tokens_reminder"`), upserted to the
latest `label`/`text` with a running `count`, `firstSeq` (stable sort/position)
and `lastSeq` (the replay-dedup guard — a `chat.replay` re-delivering an
already-applied event must not double-count it). `ProviderContextPanel`
(`ChatRoute.tsx`) renders one collapsed row per category, sitting with the
chat's other standing banners above the transcript rather than inline at a
turn — chat-scoped, not turn-scoped, the same way `GoalBanner`/`ReminderBanner`
are. A `providerType` this repo has no dedicated label for still renders (Title
Case of the raw name), never dropped — Claude Code adding a new attachment kind
some future release must not go silently missing.

The panel's default expand state is an account-wide preference,
`providerContextVerbosity` (`off` / `summary` / `full` — Settings § Transcript),
not a hardcoded "always collapsed": `off` hides the panel entirely, `summary`
is the collapsed-row behaviour above and the default, `full` opens every row.
A per-row click still overrides the default locally either way. This affects
ONLY `ProviderContextPanel` — the `<system-reminder>` disclosures above stay
collapsed-always regardless of this setting, since those are a verification
aid for something that looked wrong, not routine reading.

## Cross-refs

- Session spawn contract: `04-chats-and-folders.md`
- Wire messages host sends/receives: `03-wire-protocol.md`
- Job execution: `08-triggers-and-jobs.md`
- Cross-chat tools: `06-threads-manager-speakers.md`
