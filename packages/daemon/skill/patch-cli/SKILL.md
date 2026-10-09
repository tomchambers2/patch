---
name: patch-cli
description: Drive the `patch` command line from inside a chat — chats, hosts, jobs, hooks, threads, surfaces, logs. Use whenever the task involves patch itself: listing or spawning chats, inspecting or changing this machine's settings, creating or reading jobs and webhooks, or checking why something is offline. Always pass --json.
---

# patch CLI

`patch` is the command line of the patch coordination layer. It is installed
alongside the daemon on this machine and this skill is rewritten by the daemon
on every install and self-update, so it always describes the daemon it sits next
to (`spec/17-cli.md` § Skill).

## Rules

1. **Always pass `--json`.** Human-readable output is for humans; it is not a
   stable contract. Every command accepts `--json` and emits one JSON document.
2. **The default host is this machine.** A command with no `--host` acts on the
   daemon running here, over its local Unix socket at `~/.patch/daemon.sock`.
   Naming another machine with `--host` routes through the server instead.
3. **`<id>` takes a unique prefix.** Chat and job ids are ULIDs; any unambiguous
   prefix works.
4. **Errors are loud.** A non-zero exit with a JSON `{ "error": ... }` body means
   the thing did not happen. Do not retry blindly — read the error.

## Chats

```
patch chats list --json                          # active chats
patch chats get <id> --json                      # one chat: state, last activity
patch chats spawn <folder> [--host H] [--model M] [--prompt P] --json
patch chats send-to <id> <message> --json        # deliver a user turn into a chat
patch history <id> [--limit N] --json            # transcript
patch chats stop <id> --json
patch chats archive <id> --json
patch chats move <id> --host H --folder F --json  # to another machine, running in F there
```

`spawn` needs a folder that exists on the target machine. `--model` defaults to
that host's last-used model, so it can be omitted.

## Activity (the user's own timeline)

```
patch activity [--since S] [--until U] [--limit N] --json   # chat dwell sessions + sent messages
```

Not agent output — that's `patch_peek`/`patch_history`'s job inside a chat.
`--since`/`--until` take ISO-8601 or ms-epoch; default is the last 24h, and the
window is capped server-side regardless of what is asked for. If either list
in the response is `*Truncated`, resume it with `--sessions-cursor`/
`--messages-cursor` set to its `nextCursor`.

## Hosts (machines)

```
patch hosts list --json                          # every registered machine
patch hosts get [--host H] --json                # platform, backends, components, permission mode
patch hosts rename <name> [--host H] --json
patch hosts set-home [--host H] --json           # the machine the special threads run on
patch settings set permission-mode <mode> --json   # shared by every host
patch hosts folders [--host H] --json
patch hosts folders add <path> [--host H] --json
patch hosts folders remove <path> [--host H] --json
patch hosts backends [--host H] --json           # each backend's version + account state
patch accounts list [backend] --json             # shared accounts, in order
patch accounts connect <backend> <accountId> --json     # replace an account's token
patch accounts disconnect <backend> <accountId> --json  # take it out of every host's sequence
patch hosts models [--host H] --json             # this machine's model catalogue
patch hosts install <component> [--host H] --json    # e.g. kokoro (~340 MB), whisper (~1.5 GB)
patch hosts uninstall <component> [--host H] --json
patch hosts update [--host H] --json             # apply an available daemon update
patch hosts add --json                           # a registration code for a NEW machine
patch hosts remove --host H --json               # revoke a machine (confirmed)
```

`hosts add` mints the pairing code a new machine's installer redeems. The
installer never mints one.

## Jobs, hooks, threads, surfaces

```
patch jobs list|get <id>|create <file.json>|update <id> <file.json>|delete <id> --json
patch jobs enable <id> --json | patch jobs disable <id> --json
patch jobs runs <id> --json                      # run log
patch jobs hooks <id> --json                     # inbound webhook log

patch hooks list --json                          # webhook URLs by trigger
patch hooks tail [--id <id>] --json

patch threads list --json                        # the three special threads

patch surfaces list --json                       # linked devices/sessions
patch surfaces revoke <id> --json
```

## Diagnostics

```
patch doctor --json      # server reachability, per-host status, backlog, errored chats
patch logs [--host H]    # tail a machine's daemon log
patch host status --json                         # is this machine's daemon reachable
```

Start with `patch doctor --json` whenever something is unreachable: it answers
"is the server up, is this machine linked, is anything queued" in one call.

## Patterns

- **Find a chat then act on it**: `patch chats list --json`, pick the id, then
  `patch chats send-to <prefix> "..." --json`.
- **Work on another machine**: `patch hosts list --json` to see what is online,
  then pass `--host <name>` to the command. A chat spawned with `--host` runs
  there, with that machine's files and tools.
- **Before spawning on a machine you have not used**: `patch hosts folders
--host H --json` to see the folders it publishes.
- **Never** poll in a tight loop. These commands hit a live daemon.
