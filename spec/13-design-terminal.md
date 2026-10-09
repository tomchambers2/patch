# Terminal Design

Principle: the smallest possible wrapper around the agent. Same aesthetic, same keystrokes, same rendering. Patch adds connection to a remote host and a handful of management subcommands — nothing else.

Modelled directly on Happy's CLI UX.

## Invocation

`patch` is a remote control. It operates on a folder on a host: by default the host it is running on, otherwise the one named by `--host` (`17-cli.md`). Folders are selected from the target host's filesystem, which is the filesystem the chat sees.

```
$ patch
```

No args: interactive picker. Lists recent folders grouped by host, this host first, plus a path input. Pick, optional initial prompt, start.

```
$ patch --folder /home/tom/projects/bed-planner
```

Non-interactive. `--folder` is mandatory in this form — no implicit cwd inference. Folder must exist on the target host (`--host`, defaulting to the machine the CLI runs on); that host validates and errors loudly if not. Tab-completion for `--folder` is host-mediated (the CLI asks the host what's there) so it works regardless of which host the CLI itself is on.

## Rendering

Patch renders the wire event stream identically to the agent's native output, piping the agent's own JSON stream through the host. Messages, tool calls, diffs, permission prompts appear exactly as they would running that agent locally.

One concession: a single-line status strip at the top of the terminal, showing context that matters for a remote session:

```
┌ ~/projects/bed-planner · c_01HXY · 🟢 connected ───────────────────────────
│
│ > can you fix the layout bug?
│
│ I'll start by reading the current layout file.
│ [read_file  src/layout.ts]
│ ...
│
```

- Folder, chat-id prefix, connection state.
- `🟢 connected` → `🟠 reconnecting` → `🔴 offline`.
- Hideable with `--no-status`.

## Flag pass-through

The CLI accepts flags that map to SDK `query()` options on the host side. Common ones:

```
$ patch --folder ~/code/x --model opus
$ patch --folder ~/code/x --dangerously-skip-permissions
```

The CLI translates these into the host's spawn-chat RPC. Unknown flags are forwarded as SDK options where they map cleanly; otherwise the CLI errors clearly. Reopening an existing chat is `patch chats resume` (`17-cli.md` § Commands), not a flag.

## Subcommands

The command set is `17-cli.md` § Commands, which owns it in full. This file
covers what the TUI does with the two that open one: `patch` and
`patch chats attach`/`resume` render the chat inline as above; every other
subcommand prints and exits.

## Keystrokes

Inherited from the agent:

- Enter to send, Shift+Enter for newline.
- Ctrl+C to stop the current generation; Ctrl+C twice to exit.
- Up/Down to navigate message history (where the agent supports it).

Added by patch:

- Any key during a phone-active session → reclaim control to the terminal (Happy's handoff pattern).
- Ctrl+B → overlay a compact chat browser (fuzzy-search, Enter to switch); Esc to close. Intentionally lightweight — no persistent sidebar.

## Device handoff

When a phone surface takes over a chat that was focused in the terminal, the terminal dims its status strip (`🟡 phone active`) and suspends input. Press any key to reclaim — host emits `surface.foregrounded` from the terminal, phone surface observes and cedes.

## Config

`~/.patch/config.json`:

```json
{
  "serverUrl": "https://patch.<domain>",
  "defaultFlags": ["--dangerously-skip-permissions"]
}
```

Per-invocation flags override config defaults.

## Cross-refs

- Wire events consumed: `03-wire-protocol.md`
- Shared surface concerns (presence, linking): `05-surfaces.md`
- Host commands: `02-daemon.md`
