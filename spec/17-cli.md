# CLI

The `patch` command-line tool is the canonical primitive surface to patch. This
file owns the whole command-line surface: every `patch` invocation the product
has is listed here, and other files reference it rather than restating it.
Everything a host reports is readable through it, and every host setting a
graphical surface can change is settable through it (§ Completeness). Three
properties:

1. One API per resource owner. Chats, hosts and threads are the host's; jobs, webhooks, message hooks, runs, surfaces and activity are the server's. Web UI, MCP tools and CLI are all clients of those same APIs — the CLI adds no surface of its own.
2. Primitives only for agents. Agent-facing commands are direct CRUD on resources. The agent composes investigations using the primitives. `patch doctor` and the TUI (`13-design-terminal.md`) are user-facing; agents drive the CLI via `--json` subcommands.
3. Driven by agents. Most CLI usage comes from inside chats — a `patch-cli` skill on the host teaches the agent how to drive the CLI (§ Skill). The skill is the contract; humans use the same surface sparingly.

## Commands

Resource-grouped. `<id>` accepts the full ULID or a unique prefix.

Every `hosts` subcommand that acts on one host takes `--host H`, which defaults
to the machine the command is invoked on (§ Hosts and the CLI). Two are
exceptions. `hosts remove` requires `--host`, so an irreversible revocation is
never aimed at a host by default. `hosts pair-device` takes no `--host` and runs
on the machine it is invoked on, because the host adopts the device itself and
nothing about that exchange crosses the server (`16-voice-device.md`
§ Connection model).

```
patch                                     # interactive picker: recent folders grouped by host, this host first
patch --folder <path> [--host H] [--model M] [--no-status]   # start a chat there and render it inline (13-design-terminal.md)

patch hosts list                          # every registered host: name, status, version, components
patch hosts get [--host H]                # one host (platform, backends and their versions, components, permission mode, home marker)
patch hosts add                           # server-minted registration nonce as a QR + short code, for the new machine's installer to redeem, plus the server's install command for the target OS
patch hosts rename <name> [--host H]
patch hosts set-home [--host H]           # make this the account's home host, where the special threads run
patch hosts folders [--host H]            # that host's project-folder registry
patch hosts folders add <path> [--host H]
patch hosts folders remove <path> [--host H]
patch hosts backends [--host H]           # each backend's version and that host's view of the shared accounts
patch hosts models [--host H]             # that host's model catalogue across its backends
patch hosts install <component> [--host H]  # install an optional component (e.g. kokoro)
patch hosts uninstall <component> [--host H]
patch hosts update [--host H]             # apply an available daemon update
patch hosts claude-settings [--host H]                    # that host's Claude Code memory entries and any settings.json drift
patch hosts claude-settings discard [--host H]            # rewrite a drifted settings.json from the shared settings
patch hosts memory remove <project> <file> [--host H]     # delete one Claude Code memory entry
patch hosts pair-device                   # on this machine only: open a five-minute window for a voice device to announce itself (16-voice-device.md)
patch hosts remove --host H               # revoke a host (confirmed; names its chat count)

patch settings                            # every shared setting, and each host's applied version (01-server.md § Settings)
patch settings set <key> <value>          # change a shared setting, e.g. permission-mode, question-expiry, default-model
patch settings claude <file>              # replace the shared Claude Code settings.json; --os darwin|linux for that OS's override
patch accounts [<backend>]                # the shared backend accounts, in order
patch accounts add <backend> --token T [--label L]
patch accounts connect <backend> <accountId> --token T
patch accounts disconnect <backend> <accountId>        # confirmed; takes it out of every host's sequence
patch accounts order <backend> <accountId>...
patch accounts strategy <backend> <strategy>          # priority, round-robin, soonest-reset or least-used
patch accounts adopt <backend> [--host H]              # store that machine's own login as a shared account
patch keys                                # provider keys: source and last four
patch keys set <keyId> [--host H to adopt from its environment]
patch keys revoke <keyId>                 # confirmed

patch chats list                          # list active chats
patch chats get <id>                      # show one chat (state, last activity)
patch chats spawn <folder> [--host H] [--model M] [--prompt P]  # start a chat there and print its id; --model defaults to the host's last-used
patch chats send-to <id> <message>        # deliver a user-turn into chat
patch chats permission-mode <id> <mode>   # set the chat's permission mode
patch chats history <id> [--limit N]      # print the chat's transcript
patch chats attach <id>                   # reattach to a live chat's TUI
patch chats resume [<id>]                 # reopen the most recent chat's TUI, or the one named
patch chats stop <id>                     # stop a chat
patch chats archive <id>                  # archive a chat (UI hides; its history and metadata stay on its host)
patch chats rename <id> [<name>]          # rename a chat; no name clears it back to the derived label
patch chats move <id> --host H --folder F   # move a chat to another machine, to run in folder F there (spec/04 § Moving a chat to another host)

patch activity [--since S] [--until U] [--messages-cursor C] [--limit N]
                                           # the user's own messages, read through every host's chat logs by the server (06-threads-manager-telegram-speakers.md § Cross-chat toolset); always REST — there is no per-host local view. --since/--until take ISO-8601 or ms-epoch; default is the last 24h.

patch jobs list                           # list all jobs
patch jobs get <id>
patch jobs create <file.json>             # job definition from JSON
patch jobs create --cron <expr> --action script \
  --daemon-id <id> --folder <path> --command <cmd>   # a tick with no chat
patch jobs update <id> <file.json>
patch jobs delete <id>
patch jobs enable <id> | disable <id>
patch jobs runs <id>                      # tail runs.jsonl for a job
patch jobs hooks <id>                     # tail webhooks.jsonl (webhook jobs only)

patch hooks list                          # list webhook URLs by trigger
patch hooks tail [--id <id>]              # follow inbound webhooks live

patch message-hooks list                  # list user-message hooks (20-hooks.md)
patch message-hooks get <id>
patch message-hooks create <file.json>    # hook definition from JSON
patch message-hooks update <id> <file.json>
patch message-hooks delete <id>
patch message-hooks enable <id> | disable <id>

patch threads list                        # the three special threads
patch threads send-to <name> <message>    # = chats send-to but by thread name

patch surfaces list                       # connected devices/sessions
patch surfaces ping <id>                  # heartbeat probe
patch surfaces revoke <id>                # revoke a linked surface (confirmed)

patch auth bootstrap                      # get this CLI's credential from the server, for an account with no linked surface yet
patch auth pair                           # server-minted pairing nonce as a QR + short code, for another surface to redeem

patch host start | stop | status | list | clean   # the local daemon service, on this machine

patch logs [--host H]                     # tail a host's daemon log

patch doctor                              # server reachability, per-host status, pending
                                          # webhook/cron backlog, errored-chat count
```

All commands accept `--json` to emit machine-readable output (default is human-readable). Agents always pass `--json`.

## Scope

The CLI exposes single-resource CRUD only. Bulk and aggregate operations are done by scripting over the primitives. User-facing alerts go through `patch_notify` (an agent tool); the CLI handles host state ops.

Transcript- and editor-shaped gestures — forking a message, starting a side
thread, switching tracks, snoozing, pinning, reordering a queued turn, answering
a permission prompt, saving a file from the editor pane — belong to the surfaces
that render them (`03-wire-protocol.md` § Surface events). The CLI reads a
transcript (`chats history`) and attaches to one (`chats attach`), where a
permission prompt appears and is answered inline.

## Completeness

The `hosts` family covers the host-scoped controls of `03-wire-protocol.md` §
Host events one for one — rename, permission-mode default, component install
and remove, host update, home-host marker, folder registry add and remove,
backend connect and disconnect (`10-auth.md` § Backend credentials), model
catalogue — together with registration (`10-auth.md` § Host registration) and
removal (`10-auth.md` § Revocation), which are server routes rather than wire
frames. A host-scoped control added to the wire arrives with its command here in
the same change, so no machine setting is reachable from one surface and not
another. The pairing holds both ways: each command here has a frame or a server
route behind it, and each frame has a command. `hosts pair-device` is the one
host command with no wire frame, and it is local-only for that reason
(§ Commands).

The `chats` family carries a chat's own permission mode, the counterpart to the
default `settings set permission-mode` sets (`02-daemon.md` § Permission mode).

Beyond the transcript- and editor-shaped gestures § Scope leaves to the surfaces
that render them, the single control the CLI does not carry is registering an
Android push token, which only the device holding that token can perform
(`09-notifications.md`).

## Skill

The `patch-cli` skill ships inside the host artifact and the host writes it into
the host user's own agent skills directory — `~/.claude/skills/patch-cli/` — on install
and on every self-update, so the skill on a host always matches the host on it.
It contains `SKILL.md` describing each command, common patterns, and how to interpret
the JSON output. Same skill any human would read in `patch --help`.

Every chat on that host has it, whatever folder the chat runs in, because a user-level
skill is available to the agent everywhere (`02-daemon.md` § Runtime and installation).
That covers the three special threads, which run in the host's own state directory
rather than in a project (`06-threads-manager-speakers.md` § Where special
threads run). It's how an agent learns patch's surface area.

## Hosts and the CLI

The CLI's default host is the machine it is invoked on, so `patch chats spawn
./x` runs there. Addressing another host is explicit via `--host`, and routes
through the server rather than the local socket.

A command aimed at this machine reaches its host over that machine's local
socket, which carries one endpoint per host-scoped control for that reason
(`02-daemon.md` § Control IPC). Four commands go to the server even when they
name this machine, because the server owns what they change rather than the
daemon: `hosts add`, `hosts rename`, `hosts set-home` and `hosts remove`.

`--host` accepts a host name or a `daemonId` prefix. An ambiguous or unknown
value is an error listing the candidates.

## Auth

Local — the CLI talks to the local host over a Unix socket at `~/.patch/daemon.sock`, presenting the host's local key as a `Bearer` like every other caller of that socket. It reads that key from `~/.patch/local.key`, where the host that minted it keeps it (`02-daemon.md` § Control IPC). The `0600` socket carries the same-user boundary; the key is defence in depth over it.

Remote use goes through the same HTTP API the web app uses, with the same QR-paired token (see `10-auth.md`). The `patch --server <url>` flag flips to HTTP mode. `--server` names the server; `--host` names a host (§ Hosts and the CLI).

## Cross-refs

- Job CRUD details: `08-triggers-and-jobs.md`
- MCP tool surface (subset of CLI): `06-threads-manager-speakers.md`
- Host API: `02-daemon.md`
- Auth for remote use: `10-auth.md`
