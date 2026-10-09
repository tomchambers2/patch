# OpenAI backend and credit sources

Status: proposed implementation plan. No runtime changes made.

## User experience

Settings → host → Add account opens an account-type picker: Claude, ChatGPT, OpenAI API key. Accounts remain attached to the machine running the work and appear in the existing credit-source controls.

For ChatGPT, offer three explicit connection methods:

1. Sign in: browser login when the browser and daemon share a machine; device-code login for remote hosts and mobile. Show the link, copyable code, pending state, cancellation and expiry/retry. Device-code login may require enabling it in ChatGPT security settings; show the actionable provider failure when unavailable.
2. Find existing login: ask the selected host to detect its existing Codex credential, then show the account identity before adopting it. Never search arbitrary files or browser cookies. No secret is returned to the UI. This searches the selected host, not the phone viewing Settings.
3. Connect on another machine: where device login is unavailable, use a local Patch daemon's browser sign-in and an explicit authenticated credential transfer to the selected host. Implement only after verifying secure storage and refresh ownership; do not offer a button that depends on manual token extraction.

OpenAI API key is a separate, clearly billed account type. Accept a secret reference/secure submission and validate without generating a paid response. Adding it must not implicitly enable paid overflow from a subscription; expose API models separately as “OpenAI API (paid)” and only use a paid key when that model is explicitly selected. Development verification must not generate paid API responses without an agreed budget.

Finish connection only after reading the account identity and verifying runtime readiness. Show missing runtime, sign-in required, pending login, connected, exhausted, usage unavailable and host offline distinctly. Preserve the existing Claude flow.

## Architecture

Run a managed Codex app-server child process beside the Claude backend on each Patch daemon. Use its supported protocol for authentication, models, threads, streaming turns, approval requests, cancellation and account limits. Do not build a raw ChatGPT web-endpoint client.

Use an isolated credential/config context per OpenAI account; never change process-wide credentials while concurrent turns are running. Pin and verify a supported Codex version and generate protocol types from that binary. Provision it through Patch's existing installer/update system, reporting its actual version and health.

The existing abstractions need extending:

- `packages/wire/src/events.ts`: provider/auth-kind account metadata; correlated login start/progress/cancel/results; backend-qualified model identities; generic usage windows. Retain compatibility with existing Claude account events.
- `packages/auth/src`: OpenAI credential discovery, secure references and account identity. Existing implementation is Claude-specific (`claude-oauth.ts`, `claude-usage.ts`). Keep credentials out of server snapshots, logs and client stores. Use 1Password references/native secure storage rather than introducing plaintext secret files; verify Codex storage support on both macOS and Linux before choosing the bridge.
- `packages/daemon/src/host.ts`, registration and `index.ts`: advertise and dispatch both backends, manage per-account runtimes and login lifecycles, publish account state.
- `sdkBackend.ts` / new Codex adapter: extract a provider-neutral execution contract. Its current options include Claude OAuth and permission types; do not force Codex through fabricated Claude SDK messages.
- `chatRunner.ts`, `meta.ts` and history readers: persist backend and provider session identity; route start/resume/fork/cancel/history through the correct adapter. Migrate existing chats to Claude explicitly. Store enough durable Patch event history for reconnect and replay without depending on Claude JSONL for Codex chats.
- `modelCatalog.ts`, `accountUsage.ts`, `accountFailover.ts`: backend-aware catalogues, usage and source selection. Model capabilities drive reasoning settings, tool availability and permission controls.
- Settings, composer, CLI and shared account stores across web/desktop/mobile: account-type picker, login ceremony, credit-source rows and provider-qualified model selection. Long-running interactive login cannot use the existing five-second credential-operation timeout as its completion deadline.

## Credit-source semantics

Keep the existing first-eligible-account ordering, scoped to accounts compatible with the selected backend/model. Record the actual account on each turn, not as a pinned preference on the chat. Adding ChatGPT makes it eligible for OpenAI work immediately after successful connection.

Claude credits cannot run OpenAI models or vice versa. Initial scope therefore uses one credit-source UI with provider-aware eligibility. A Claude chat exhausting its accounts must not silently change model or backend. A future explicit cross-provider continuation would need a separate context-transfer design; it cannot resume a Claude session inside Codex.

Deduplicate using provider-verified account/workspace identity. An email alone is insufficient to establish a shared credit pool. Mark known shared pools exhausted together. Handle revoked credentials separately from limits and transient network failures. Never repeatedly replay tool side effects after an uncertain turn result; reconcile the provider turn before retrying.

Read ChatGPT limits through `account/rateLimits/read` and account notifications, without generation probes. Preserve provider window IDs/durations and normalize timestamps; unknown readings remain unknown. Display last successful reading and last refresh failure separately. API keys must not display invented ChatGPT subscription balances. Bound retries and publish why each blocked turn is waiting and when it can resume.

## Implementation order

1. Compatibility spike: installed/version-pinned app-server protocol, local/browser and remote/device auth, account isolation, secure persistence/refresh, model list, limits and real thread lifecycle. Resolve secure Linux storage and credential-adoption ownership here before building the picker.
2. Update specs 02/03/04/10/11/17 and add backward-compatible wire/account/session contracts. Unit-test eligibility, identity grouping, rate-window conversion and login state transitions.
3. Build Codex process manager, account lifecycle and installer integration. Validate concurrent account isolation and restart behavior.
4. Integrate runner, durable history, tools/MCP, approvals/questions, attachments, fork/resume, cancellation and backend-specific permission capabilities. Unsupported modes fail explicitly rather than weakening permissions.
5. Build all account and model controls; connect usage, source ordering and exhaustion behavior to chats and scheduled jobs.
6. Verify built artifacts under real failures, then deploy server, daemon and surfaces using Patch's deployment instructions. Install the mobile artifact through `bin/phone install` if native changes require it.

## Release checks

Run the real packaged daemon with the actual Codex runtime on local macOS and remote Linux. Exercise browser/device login, cancellation, expiry, unavailable device auth, reconnect and duplicate accounts. Authenticate only through user-controlled sign-in; no credential extraction in chat.

Run unattended turns with streaming, file tools, Patch MCP, questions/approvals, queued messages and scheduled jobs. Kill the child process, restart the daemon, drop the network below the process and delay replies. Assert durable accepted prompts, no duplicate tool execution, bounded recovery or visible failure, correct account attribution, and eventual resolution of pending operations. Test reconnect/replay and resume after restart, plus two simultaneous accounts without credential crossover.

Test the built web/desktop/mobile surfaces against the same live daemon, including offline account actions and login completed from another surface. Obtain permission before tests that interrupt Tom's screen. Paid API execution requires an agreed budget; until then its real generation check remains explicitly outstanding. Recheck Claude through the shipped adapter after the shared-contract changes.

## Official references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): browser/device/API-key login, cancellation, account reads and rate limits; execution and thread protocol.
- [Codex authentication](https://learn.chatgpt.com/docs/auth): device-code prerequisites, credential storage and local-to-headless authentication.
