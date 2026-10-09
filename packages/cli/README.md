# @patch/cli

Two-in-one terminal binary:

1. **TUI** — `patch`, `patch resume`, `patch attach` (per `spec/13-design-terminal.md`).
2. **Agent-facing primitives** — `patch chats *`, `patch jobs *`, `patch hooks *`,
   `patch threads *`, `patch surfaces *`, `patch logs`, `patch auth *`,
   `patch host *`, `patch doctor` (per `spec/17-cli.md`).

All resource-grouped subcommands accept `--json`. Agents always pass `--json`.

## Install / build

```sh
pnpm --filter @patch/cli build           # dist/index.js
pnpm --filter @patch/cli build:bin       # dist/patch (single binary via pkg)
node packages/cli/dist/index.js --help
```

## Configuration

`~/.patch/config.json`:

```json
{
  "serverUrl": "https://patch.example",
  "defaultFlags": ["--dangerously-skip-permissions"],
  "defaultFolder": "/home/tom/projects/foo"
}
```

Env overrides:

| Variable                 | Effect                                          |
| ------------------------ | ----------------------------------------------- |
| `PATCH_HOME`             | Override `~/.patch` (alias: `PATCH_CONFIG_DIR`) |
| `PATCH_SERVER_URL`       | Server base URL (overrides `config.serverUrl`)  |
| `PATCH_DAEMON_SOCKET`    | Force a UDS path (else `~/.patch/daemon.sock`)  |
| `PATCH_DAEMON_LOCAL_KEY` | Bearer key for host UDS endpoints               |
| `PATCH_DAEMON_START_CMD` | Command for `patch host start`                  |
| `PATCH_DAEMON_STOP_CMD`  | Command for `patch host stop`                   |

## First-run

```sh
# 1. Bootstrap the account from a fresh keypair (only the FIRST surface ever does this).
patch auth bootstrap --server https://patch.example.com --json

# 2. Spawn a chat in a folder that exists on the daemon host.
patch chats spawn /tmp/work --json

# 3. Send a message into that chat (works over UDS or REST).
patch chats send-to <chatId> --message 'hello' --json
```

The CLI prefers the local UDS on Hetzner (faster), and REST elsewhere.

## Auth

`patch auth bootstrap` mints a fresh keypair, registers the account, and
issues a CLI surface JWT — only the FIRST surface ever does this (one
Ed25519 = one account per spec/10).

`patch auth login` runs the QR-pair bootstrap for additional surfaces. For
CI / tests, pass `--credential <jwt>`; the CLI verifies the JWT signs
against the local identity and that `sub` matches the account public key
before persisting (NO FALLBACK).

## Architecture

```
src/
  index.ts            commander entry, registers every subcommand.
  config.ts           Reads ~/.patch/config.json + env overrides.
  auth.ts             Identity / credential persistence.
  healthz.ts          Cold-start /api/healthz client.
  transport/
    rest.ts           REST client (Bearer JWT).
    uds.ts            HTTP-over-Unix-socket client (Bearer local key).
    index.ts          Unified facade — auto-picks UDS or REST.
    ws.ts             WireTestClient wrapper with state + replay-on-reconnect.
  commands/           One file per resource group.
  tui/                Ink components (App, Picker, ChatView, ChatBrowser, StatusStrip).
```

NO FALLBACKS — bad auth, missing identity, or unreachable transports surface
loudly and exit non-zero.

## Tests

```sh
pnpm --filter @patch/cli test
```

Covers config + identity persistence, every subcommand's REST dispatch
(`--json` exits 0 + valid JSON, bad-auth exits 1 with `{error}`), and the TUI
status strip / chat browser via `ink-testing-library`.
