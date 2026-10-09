# Harness Capability Parity

A side-by-side of what **patch** can do versus **Claude Code** (Anthropic's public CLI/agent harness) and **Pi + its popular packages** (`@earendil-works/pi-coding-agent` core plus the notable community/example extensions).

## What each of these is

- **patch** — this project. A daemon-driven, Claude-Code-native coordination layer with many surfaces (CLI/web/mobile/desktop/voice), jobs/triggers, cross-chat orchestration.
- **Claude Code** — Anthropic's public CLI + agent harness (Task subagents, hooks, skills, MCP, `/goal`, worktrees, checkpoints, Artifacts on cloud tiers).
- **Pi (+ packages)** — an **open-source, provider-agnostic, BYOK** harness (`earendil-works/pi`). The **core is a minimal four tools (Read / Write / Edit / Bash)**, but the whole design is _"tiny core, extend at runtime"_: **TypeScript Extensions, Skills, Prompt Templates, Themes**, installed via `pi install npm:…` / `git:…`, hooking a **lifecycle-event API** (`ExtensionAPI`/`ExtensionContext`). So Pi's real capability = core **+** popular packages. This column reflects **core + these notable extensions**: `subagent` (single/parallel/chain), `sandbox` (`@anthropic-ai/sandbox-runtime` fs/network limits), `ssh` (remote exec), `tool-override` (audit + block `.env`/`~/.ssh`), `plan-mode`, `handoff`/`summarize` + `custom-compaction` (context mgmt), custom LLM-provider registration.

## Source confidence (read this)

- **patch** cells cited to `spec/*.md`. High confidence.
- **Claude Code** cells checked against official docs (2026-07-14); cloud-/version-tier items noted.
- **Pi** cells from public sources: [llmreference](https://www.llmreference.com/agents/pi), [github.com/earendil-works/pi](https://github.com/earendil-works/pi), and the [DeepWiki extension-examples](https://deepwiki.com/earendil-works/pi/6.3-extension-examples-and-patterns) summary. Where a capability comes from an **extension** rather than core I tag it **`[ext]`** and name it; where public docs don't confirm, **`[undoc]`** — not guessed. _(An earlier version of this file fabricated the Pi column by mislabelling the author's own harness — since fully rewritten from real sources; then re-scoped from Pi-core to Pi-core-plus-packages.)_

Legend: ✓ native/first-class · ◑ partial/indirect · ✗ absent · `[ext]` via a Pi extension · `[undoc]` unconfirmed.

---

## 1. Scheduling & automation — _patch's strongest axis; Pi has ~none of this_

| Capability                                  | patch                                                               | Claude Code                                     | Pi (+ packages)                              |
| ------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Recurring wall-clock schedule (cron)        | ✓ `cron` trigger, 5-field UTC, NL-generated (`08-*.md`)             | ✓ `CronCreate` (session-scoped); cloud Routines | ✗ no scheduler; would be a bespoke extension |
| Durable self-wake (survives restart)        | ✓ `patch_wake_me` — durable, adaptive, catch-up-on-boot (`02-*.md`) | ◑ `ScheduleWakeup`/`/loop`, session-scoped      | ✗                                            |
| External event ingress (webhook)            | ✓ signed webhooks `hmac`/`github`/`stripe` (`08-*.md`)              | ◑ event-driven Routines `[uncertain]`           | ✗                                            |
| Todoist triggers                            | ✓ `todoist` (`08-*.md`)                                             | ✗                                               | ✗                                            |
| Server-side event filtering before spawning | ✓ **JSONata**, µs, no LLM (`08-*.md`)                               | ✗                                               | ✗                                            |
| Goal-conditioned looping                    | ✗ — chat self-terminates its `patch_wake_me` loop                   | ✓ `/goal`, re-checked each turn by a judge      | ✗                                            |
| One-time future run                         | ✓ `patch_wake_me({at})` / cron                                      | ✓ `/schedule` one-time                          | ✗                                            |

## 2. Subagents & orchestration — _Pi + `subagent` ext is a real peer here_

| Capability                                       | patch                                                    | Claude Code                          | Pi (+ packages)                                                         |
| ------------------------------------------------ | -------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| In-session subagent                              | ◑ inherited Claude Code `Task`                           | ✓ `Agent` + `.claude/agents/*.md`    | ✓ `[ext]` **`subagent`** — spawns agents as separate processes          |
| Multi-mode orchestration (parallel / chain)      | ◑ `patch_spawn` + `patch_send_to`, hand-wired            | ◑ parallel `Agent` calls             | ✓ `[ext]` **`subagent`** — **Single / Parallel / Chain** modes built in |
| Persistent spawned agent as a durable artifact   | ✓ `patch_spawn` → long-lived chat (`06-*.md`)            | ◑ background sessions                | ✗ subagents are task-scoped processes, not durable chats                |
| Forked subagent (pre-loaded with parent context) | ✗                                                        | ◑ `[uncertain]`                      | ◑ `[ext]` **`handoff`** extracts history into a new session (fork-ish)  |
| Agent-to-agent messaging into an existing chat   | ✓ `patch_send_to` (`06-*.md`)                            | ✗                                    | ✗                                                                       |
| Background / parallel agents                     | ◑ each chat is an independent session                    | ◑ `Monitor` + parallel `Agent`       | ✓ `[ext]` parallel subagents                                            |
| Worktree isolation per agent                     | ✗                                                        | ✓ `--worktree`, `isolation:worktree` | ✗ (no git integration; but see sandbox/SSH isolation, §6)               |
| Remote execution of work                         | ◑ whole host runs remotely                               | ◑ cloud Routines                     | ✓ `[ext]` **`ssh`** — run the core tools over SSH                       |
| Declarative multi-step workflow (DAG)            | ✗ hand-wired                                             | ◑ via skills, no DAG runner          | ◑ `[ext]` `subagent` **chain** mode (linear, not a full DAG)            |
| Cross-chat orchestration / "what's running?"     | ✓ Manager + `patch_list_chats`/`peek`/`stop` (`06-*.md`) | ◑ session list                       | ✗                                                                       |

## 3. Tools & extensibility — _Pi's design centre; it leads here_

| Capability                                      | patch                                                                    | Claude Code                         | Pi (+ packages)                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Custom tools / tool override at runtime         | ◑ ships a fixed MCP tool set                                             | ◑ MCP / skills                      | ✓ **core extension model** — register, wrap, or override tools (`tool-override`, `sandbox`, `ssh` all do this) |
| Lifecycle hooks (pre/post tool, session events) | ✗ **host wires none by design** (`principles.md`)                        | ✓ rich hook events in settings.json | ✓ `[ext]` extensions subscribe to lifecycle events (the whole API is event-driven)                             |
| MCP servers                                     | ✓ own stdio MCP per `query()`; external MCPs work in-session (`02-*.md`) | ✓ user/project/managed scopes       | ✗ **no MCP support** (would need a bespoke extension)                                                          |
| Agent Skills (SKILL.md)                         | ◑ inherited (chats read `.claude/skills/`)                               | ✓ auto-invoke, `/skill-name`        | ✓ Skills are a first-class extension type                                                                      |
| Custom slash commands / prompt presets          | ◑ via skills                                                             | ✓ skills + commands                 | ✓ Prompt Templates + command extensions                                                                        |
| Plan / read-only exploration mode               | ◑ per-chat permission toggle                                             | ✓ plan mode                         | ✓ `[ext]` **`plan-mode`** — read-only, blocks destructive bash                                                 |
| Model / provider flexibility                    | ✗ **Claude-only** (inherits Claude Code OAuth)                           | ✗ Claude-only                       | ✓ **20+ providers, BYOK** + `[ext]` custom-provider registration — Pi's biggest edge                           |
| Voice I/O (STT/TTS)                             | ✓ self-hosted Whisper + Kokoro (`07/16-*.md`)                            | ✗                                   | ✗                                                                                                              |

## 4. Memory & context

| Capability                                      | patch                                                     | Claude Code                   | Pi (+ packages)                                                              |
| ----------------------------------------------- | --------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Project/user memory file                        | ✓ CLAUDE.md inherited unmodified (`principles.md`)        | ✓ managed/user/project scopes | ◑ Prompt Templates; CLAUDE.md-equiv `[undoc]`                                |
| Context compaction / summarization control      | ✗ relies on Claude Code                                   | ◑ `/compact`                  | ✓ `[ext]` **`custom-compaction`** — swap in cheaper-model markdown summaries |
| Handoff to a fresh session with carried context | ◑ `patch_send_to` a new chat                              | ◑                             | ✓ `[ext]` **`handoff`** — extract relevant history → new session             |
| Session history persistence & resume            | ✓ native history + `claudeSessionId` (`02-*.md`)          | ✓ native + resume             | ◑ agent-runtime state; resume specifics `[undoc]`                            |
| Checkpoints / rewind                            | ✗                                                         | ✓ auto-checkpoint + `/rewind` | ✗ (handoff ≠ rewind)                                                         |
| Broadcast context injection                     | ✓ server broadcast log as `<system-reminder>` (`09-*.md`) | ✗                             | ✗                                                                            |

## 5. Surfaces & I/O — _patch's other strong axis_

| Capability                                  | patch                                              | Claude Code                        | Pi (+ packages)                             |
| ------------------------------------------- | -------------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| Terminal / CLI                              | ✓ `patch` TUI + `--json` to remote host            | ✓ the CLI                          | ✓ CLI + custom TUI lib                      |
| Web app                                     | ✓ SPA at `/app`, Monaco, job UI                    | ◑ claude.ai                        | ✓ Web UI / chat components                  |
| Slack / chat automation                     | ◑ generic webhook + normal chat                    | ✗                                  | ✓ Slack bot ("MOM") delegates to the agent  |
| Native mobile                               | ✓ Android/Expo, Expo push, voice                   | ✗                                  | ✗                                           |
| Desktop notifier + tray                     | ✓ Electron + tray, global-hotkey voice             | ✗                                  | ✗                                           |
| Standalone voice hardware                   | ✓ HA Voice PE, local Whisper/Kokoro (`16-*.md`)    | ✗                                  | ✗                                           |
| Notification routing (push/desktop/speaker) | ✓ `patch_notify` presence-aware (`09-*.md`)        | ◑ `PushNotification`               | ✗                                           |
| Phone-call-style escalation                 | ✓ `patch_call` — rings phone + desktop (`09-*.md`) | ✗                                  | ✗                                           |
| Artifact publishing (shareable page)        | ✗ output = files in the folder                     | ✓ `Artifact` (Pro+), versioned URL | ✗                                           |
| GPU / model-deployment tooling              | ✗                                                  | ✗                                  | ✓ vLLM pod management (`earendil-works/pi`) |

## 6. Safety & permissions — _Pi's extensions genuinely lead here_

| Capability                            | patch                                                          | Claude Code                  | Pi (+ packages)                                                               |
| ------------------------------------- | -------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Sandboxed / restricted execution      | ✗ runs `bypassPermissions`                                     | ◑ permission modes           | ✓ `[ext]` **`sandbox`** — `@anthropic-ai/sandbox-runtime` fs + network limits |
| Access-control / audit on tool use    | ◑ concurrency guard only                                       | ✓ allow/deny rules           | ✓ `[ext]` **`tool-override`** — audit log + block sensitive paths             |
| Permission model                      | ◑ single pass-through to Claude Code (`00-*.md`)               | ✓ prompts, allow/deny, modes | ◑ `[ext]` plan-mode + tool-override compose one                               |
| Concurrency guard (avoid two writers) | ✓ refuses human `file.write` while `running` (`principles.md`) | ◑ checkpoint-based           | ✗ `[undoc]`                                                                   |
| Local trust boundary                  | ✓ loopback socket `0600` + local key (`02-*.md`)               | ✓                            | ◑ local/on-prem; specifics `[undoc]`                                          |
| Auth / device linking                 | ✓ Claude Code OAuth (no keys held) + QR (`10-*.md`)            | ✓ `/login`                   | ✓ subscription login **or** API keys                                          |

## 7. Observability

| Capability                            | patch                                         | Claude Code           | Pi (+ packages)                                             |
| ------------------------------------- | --------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| Live agent state without an LLM pass  | ✓ `chat_state` via `patch_peek` (`02-*.md`)   | ◑ session status      | ✗ `[undoc]`                                                 |
| Per-run / per-fire audit log          | ✓ `runs.jsonl` + `webhooks.jsonl` (`08-*.md`) | ◑ Routine history     | ◑ `[ext]` `tool-override` audit log (per-tool, not per-run) |
| Run navigable to the chat it produced | ✓ each fire records the chatId (`08-*.md`)    | ✗                     | ✗                                                           |
| Health / diagnostics                  | ✓ `patch doctor`/`logs`/`surfaces`            | ◑ `/context`,`/debug` | ✗ `[undoc]`                                                 |
| Delivery-failure log                  | ✓ `undelivered.jsonl` (`09-*.md`)             | ✗                     | ✗                                                           |

---

## Reading the comparison

The two live at different layers, so the table isn't a scoreboard:

- **patch owns the coordination + surface + trigger layer** — scheduling, durable self-wake, webhooks/todoist, multi-channel notify + phone-call escalation, voice, mobile/desktop, cross-chat orchestration. Pi has essentially none of this and isn't trying to.
- **Pi (+ packages) owns the agent-loop-mechanics layer** — a lifecycle-event extension API, tool override, multi-mode subagents, sandboxed + SSH execution, plan-mode, custom compaction/handoff, and provider-agnostic BYOK. Several of these are things patch **deliberately doesn't have** (patch wires _no_ hooks and runs `bypassPermissions`).

## Gaps worth adopting (prioritised)

From **Claude Code**:

1. **Goals — harness-enforced completion.** _You asked for this._ A per-chat `goal.json` predicate judged after each turn, auto-nudging via the existing self-wake path until met. Highest value; the host already runs the loop.
2. **Goal-linked scheduled wakeup.** _You asked._ patch already has the durable core (`patch_wake_me`, beats CC's session-scoped one) — the gap is only coupling it to goals (#1).
3. **Worktree-isolated + forked subagents.** A `fork` variant of `patch_spawn` (seed the child with parent context) + per-chat git worktree.
4. **Checkpoints / rewind** and **artifact publishing** (a `patch_publish` to a URL on the web surface patch already hosts).

From **Pi**, genuinely worth considering: 5. **A lifecycle-hook / tool-override extension point.** Pi's whole extension API is event-driven; patch wires _none_ by design. A narrow hook surface (e.g. pre-`file.write` audit, or a per-chat `tool-override`-style access block on `.env`/secrets) would add safety without the second-permission-layer patch avoids. 6. **Sandboxed execution mode.** Pi's `sandbox` extension caps filesystem + network per run. patch runs `bypassPermissions` everywhere; an opt-in sandboxed chat mode (via `@anthropic-ai/sandbox-runtime`) would let risky automated jobs run contained. 7. **Multi-mode subagents (parallel/chain).** Pi's `subagent` extension has Single/Parallel/Chain built in; patch hand-wires this with `patch_send_to`. A first-class `chain`/`parallel` spawn primitive would formalise Manager fan-out. 8. **Provider-agnosticism** — noted as a _philosophical_ choice, not an obvious win: patch is deliberately Claude-Code-native (OAuth, CLAUDE.md, history). Pi shows the BYOK multi-provider alternative.

**Not gaps** (patch meets or beats both): cron/webhook/todoist triggers, JSONata filtering, durable self-wake, cross-chat peek/send/spawn, multi-channel notify + phone-call escalation, self-hosted voice, multi-surface reach, per-run audit + delivery logs.

---

_Sources: patch — `spec/_.md`. Claude Code — official docs (2026-07-14). Pi — [llmreference.com/agents/pi](https://www.llmreference.com/agents/pi), [github.com/earendil-works/pi](https://github.com/earendil-works/pi), [DeepWiki extension examples](https://deepwiki.com/earendil-works/pi/6.3-extension-examples-and-patterns).\*
