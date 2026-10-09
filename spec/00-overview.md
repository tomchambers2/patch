# Patch — Overview

Patch is a thin coordination layer over LLMs. It adds multi-surface access (terminal, web, phone, standalone voice device), external triggers (cron, webhooks, Todoist), voice (daemon-hosted Whisper + Kokoro across all surfaces), and cross-chat management — without altering the agent's native UX.

One server, and one host per host machine. A host is any machine whose files
and commands the agent works with: an always-on box, a laptop, a work machine.
The server is deployed once and is publicly reachable; a host is installed on
each host and runs as an OS-managed service, starting at boot and running
independently of any surface. See `02-daemon.md`.

The two are separate because a host is usually unreachable. Hosts dial out to
the server and hold that connection, which is what lets a laptop behind NAT be a
host at all, and gives webhooks and push a fixed address to arrive at
while every host is asleep. Folding the server into a host would tie the whole
system to one always-on machine with a public address — the arrangement this
exists to avoid.

## Principles

- Preserve the agent's interface. No second permission system, no wrapped prompts. Pass-through by default.
- Thin layer. Add only what's missing: remote surfaces, triggers, voice routing, cross-chat tools, notifications. Everything else is the agent as-is.
- Copy from Happy where it works. Wire protocol, voice architecture, QR-code auth linking, host model.
- Server routes, hosts execute. Surfaces are dumb clients.
- No fallbacks. Failures surface immediately; we don't paper over them (portfolio repo convention).

## Component map

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Terminal │  │ Web app  │  │ Phone    │  │ Desktop  │
│  (TUI)   │  │          │  │ (native) │  │  (Mac)   │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │             │
     └─────────────┴──────┬──────┴─────────────┘
                          │  WebSocket
                          ▼
                  ┌───────────────┐
                  │  Patch Server │  ◀── Todoist
                  │  (deployed)   │  ◀── Webhook URLs
                  └───┬───────┬───┘
             WebSocket│       │WebSocket
                      ▼       ▼
        ┌───────────────┐   ┌───────────────┐
        │ Daemon        │   │ Daemon        │   one per host machine
        │ "hetzner"     │   │ "Tom's Mac"   │
        │  agent        │   │  agent        │
        │  host access  │   │  host access  │
        └───────────────┘   └───────────────┘
```

- Server — one Node/Fastify process, deployed. Relay, registry, presence, push fanout, webhook ingress, voice token mint. See `01-server.md`.
- Host — one native process per host machine. Runs agent sessions with that host's access, tracks chat_state, runs jobs. See `02-daemon.md`.
- Surfaces — terminal CLI, web, phone, desktop notifier. See `05-surfaces.md`.
- Special threads — Manager, Speakers. Long-running chats with cross-chat tools. See `06-threads-manager-speakers.md`.

## Glossary

| Term       | Meaning                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Host       | A machine running a host. Identified by `daemonId`, labelled by a user-editable host name.                   |
| Chat       | One agent session, pinned to a host and a folder on it. Lives forever.                                       |
| Project    | Emergent. Any folder with ≥1 chat. No registration step. Scoped to its host.                                 |
| Surface    | A client UI (CLI, web, phone, desktop).                                                                      |
| Thread     | A long-lived chat. May be a project chat or one of the two special threads.                                  |
| Job        | A trigger + action, stored as JSON on the server.                                                            |
| Patch tool | A tool exposed to the agent inside a chat, prefixed `patch_*` to avoid colliding with the agent's built-ins. |

## Spec files

| File                             | Scope                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `principles.md`                  | What patch is and isn't. Project scope. Read this first.                                                                                    |
| `day-in-the-life.md`             | The product test. End-to-end scenario the spec must serve.                                                                                  |
| `00-overview.md`                 | This file. Principles, component map, glossary.                                                                                             |
| `01-server.md`                   | Relay: auth, registry, presence, push, webhooks.                                                                                            |
| `02-daemon.md`                   | Host: session lifecycle, chat_state, job runner.                                                                                            |
| `03-wire-protocol.md`            | Event protocol between server and clients (Happy-Wire-based).                                                                               |
| `04-chats-and-folders.md`        | Session model, folder pinning, history, resume.                                                                                             |
| `05-surfaces.md`                 | Terminal, web, phone, desktop. Editor. Presence.                                                                                            |
| `06-threads-manager-speakers.md` | The two special threads and their cross-chat tools.                                                                                         |
| `07-voice-app.md`                | Phone + web app voice. Audio streams to host's Whisper + Kokoro stack. Focus-follow, Manager-call mechanics.                                |
| `08-triggers-and-jobs.md`        | Cron, webhook, Todoist. JSONata filtering.                                                                                                  |
| `09-notifications.md`            | `patch_notify` tool. Push routing. Desktop native.                                                                                          |
| `10-auth.md`                     | Backend credentials. Host key. Trust model.                                                                                                 |
| `11-deployment.md`               | Deployment requirements, topology, env vars.                                                                                                |
| `12-error-and-offline.md`        | Disconnect handling. Replay. Presence collapse.                                                                                             |
| `13-design-terminal.md`          | `patch` CLI UX — minimal wrapper over the agent.                                                                                            |
| `14-design-web.md`               | Web SPA layout, navigation, routes.                                                                                                         |
| `15-design-mobile.md`            | Android-native (Expo), tabs, voice, push.                                                                                                   |
| `16-voice-device.md`             | Standalone voice surface — HA Voice Preview Edition with custom firmware. ESP32-S3 streams PCM to host, host runs Whisper + Kokoro locally. |
| `17-cli.md`                      | `patch` CLI subcommands and agent-facing primitives.                                                                                        |
| `18-tech-stack.md`               | Languages, frameworks, libraries, build tools. Decisions made upfront.                                                                      |
| `19-testing.md`                  | The five test layers, which layers a change requires, and the verification gate.                                                            |
| `20-hooks.md`                    | User-defined checks Patch runs on a message before it reaches the agent (or, later, on the agent's reply) — pass/advise/block.              |

## Permission model

The agent's own permission layer is the only one.

Turns run under `auto` by default, where a model classifier approves or denies
each tool call. Every chat carries its own mode, stamped from the host default
when the chat is created and changed only from within that chat; the host
default is set in Settings and steers the chats created after it. A change takes
effect on the next turn. See `02-daemon.md` § Permission mode.
