# Principles

Patch is a thin coordination layer. Its only purpose is to add surfaces that make an LLM usable from anywhere — terminal, web, phone, voice, on a schedule, from a webhook.

## No system-prompt injection

Patch does not inject _invisible_ system prompts into agent sessions to shape behaviour ("you are the Manager", "be concise on voice", etc.). Prompting belongs to the agent and to the user's `CLAUDE.md` files in the relevant folder. Patch ships some `CLAUDE.md` files for the special threads (Manager / Speakers) as starting content the user can edit, but these are files in the user's filesystem, not patch-injected directives at runtime. The user can read them, edit them, delete them.

Patch does ship one piece of prompt content itself: the patch-tools guidance, appended to the system prompt so the agent knows what patch's own tools are for. It is subject to the same test — Settings shows its full text, edits replace it, emptying it removes it, and a reset restores the default. It earns its place because patch's tools are deferred: the agent is handed their names and no schemas, so a tool it has never loaded loses to a built-in that merely looks like it would do. `view_file` lost to `Read` that way, and the user saw a collapsed row where a picture should have been, with nothing in the transcript saying why.

The only exception is the `[voice • <surface>]` prefix patch attaches to user-turn messages so the agent knows the input came in via voice (see `07-voice-app.md`). That's metadata-as-data — like an email From: header — not system prompt directives. The user's CLAUDE.md decides what to do with it.

Reason for the rule: invisible prompt injection from the platform layer is the single biggest source of hard-to-debug agent behaviour. If something is shaping the agent's responses, the user must be able to see it and edit it. Visibility is the whole of the test, so prompt content that meets it is allowed and prompt content that hides is not, whoever wrote it.

## Non-interference

We don't interfere with what the agent already handles well. Patch is glue and triggers — the layer between the agent and the outside world. If the agent can do a thing in-session (sub-agent dispatch via `Task`, file editing, tool use, sub-process spawning) we let it. We don't reinvent it, don't proxy it, don't wrap it.

Patch jobs (and `patch_wake_me`) are reserved for things the agent genuinely cannot do alone: durable cross-session schedules (weekly newsletter, daily HA update at 2am), external event ingress (webhooks, Todoist), cross-chat orchestration (Manager spawning fresh chats), and any timer that must outlive a single turn — see Tool ownership below for why the obvious native answer (`CronCreate`) does not work here.

Default test: if the agent could do this without patch, don't add a patch tool for it.

## Tool ownership

The host drives the agent through its backend, not the interactive TUI, and that breaks an assumption some native tools make. A turn runs to completion and exits, no agent process outlives the call it belongs to, and patch wires no agent cron/hooks. So Claude Code's `CronCreate` / `CronList` / `CronDelete` are inert here: an in-session cron has nothing to fire it after the turn ends. Bus-watching ("check on this in five minutes") is therefore not a native task in patch — it's a `patch_wake_me` self-wake (see `02-daemon.md` § Self-wake).

The rule:

- The agent owns the in-session coding loop — editing, search, bash, web. Subagents are not part of it: Claude Code's `Agent` (formerly `Task`) and `Workflow` run inside the turn's process, so a restart kills them and the resumed turn cannot get their work back. They are disallowed; a subagent is a `patch_delegate` call — durable, invisible to the user, delivering its full result back to the chat that made it (`02-daemon.md` § Native subagent dispatch) — not `patch_edit`/`patch_task`, which would be pure duplication of the native shape rather than the distinct capability patch actually adds.
- Patch owns platform capabilities — durable scheduling/self-wake, work that outlives the turn that started it, cross-chat orchestration, notification routing, external triggers, voice. These get distinct `patch_`-prefixed names with distinct words (`patch_wake_me`, not `patch_cron`; `patch_job_*`, not `patch_schedule`) so the model faces no two tools with overlapping meaning. We're free to evolve them; the SDK's native tools are a moving target we don't control.
- Never leave an inert native tool visible. A tool that's dead in the host is a trap — the model is trained to reach for it, "succeeds," and nothing happens. The host passes `disallowedTools` to every `query()` to remove them from the model's context (the `Cron*` family, and the native subagent tools `Agent`/`Task`/`Workflow`). If we supersede another native tool with a patch capability, it joins that list.
- A native tool that is only partly inert is corrected, not removed. Running a shell command in the background is dead here — the task belongs to the agent process and ends with the turn — but the tool itself is not, so the host refuses that one request, runs the command in the foreground, and says why (`02-daemon.md` § Background work). Removing the tool over one dead option would cost the agent its shell, and hand us a permission surface coarser than the one it replaced.

## Configuration

Behaviour is declared in code. An optional environment variable with a default in the source is not allowed, even where a missing value cannot break anything: what is declared and what is running drift apart in silence — the deployment sets the variable, the process never receives it, the fallback runs, and nothing reports the difference. A limit, a timeout, a mode, a fixture, a mock — each is declared in one place in code, and a behaviour worth having is worth having on.

Values that genuinely come from outside — a bot token, an OAuth client, a service account — are configured in patch and stored with the rest of its state, not read from the environment. A host missing one says which value is missing and where to set it, rather than starting up degraded or failing at the moment the credential is first used. Configuring an integration is something the user does in patch, on any surface, like everything else.

The environment supplies only what the process cannot know about itself: the account and host it is running as, and the paths and ports the machine hands it. Those are listed in one place, each with the reason it qualifies, and reading one that is not on the list fails the build — so adding the next one is a decision rather than an accident.

## History ownership

We don't let a backend's storage decide what a chat remembers. Patch keeps each chat's record itself — every message, tool call, result, artifact and decision, in the order it was shown — independent of any agent harness. A harness's own session files are a cache it resumes from, never the record, so a harness pruning, rotating or losing them costs context, not history, and a chat can move between harnesses. See `04-chats-and-folders.md` § History: the record is read and written from the log, a chat moves between harnesses by reconstructing its own track as a native session there, and a return to a harness it used before resumes ITS OWN prior session rather than rebuilding from scratch. Search (FTS5 over the log) is still in progress. The server also mirrors message text so an offline host's chats stay searchable (`04-chats-and-folders.md` § History — server mirror).

## What we don't do

- We don't wrap or transform the agent's prompts.
- We don't layer a second permission system on top of the agent's. A human editor save is never refused on the grounds that the agent is mid-turn either — the two writers are kept apart by writing atomically, not by locking one of them out.
- We don't summarise, abridge, or rewrite chat content. `patch_peek` returns raw messages.
- We don't hold the agent's model API keys. The backend holds its own credentials; we inherit. (The keys the host itself calls providers with — hosted voice, Groq Whisper — are patch's own configuration, set once in Settings and shared by every host: `02-daemon.md` § Provider keys.)
- We don't compete with the agent on UX. Same prompt, same rendering, same flags. Wire-level pass-through.

If the agent adopts a feature, the corresponding patch feature is removed.

## What we do add

- Remote surfaces: terminal CLI to a remote host, web SPA, native phone app, voice (self-hosted Whisper + Kokoro across all voice surfaces), desktop notifier.
- External triggers: cron, generic webhook, Todoist.
- Cross-chat tools available in every chat: peek, send-to, spawn, job CRUD, notify.
- Notification routing across channels (push / desktop / speakers) with presence-aware suppression.
- QR-code device linking modelled on Happy.

## How we add it

- Server is a dumb relay + registry + ingress endpoint. It makes no LLM calls.
- Host owns agent-session lifecycle on its host. One host per host machine.
- Surfaces are dumb clients. They render the wire event stream verbatim.
- Copy from Happy where it works (wire protocol, voice architecture, QR linking, host model). Don't reinvent.
- Fail loudly. No silent fallbacks (portfolio convention).
