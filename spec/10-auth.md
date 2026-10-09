# Auth and Trust

## Identity layers

Patch has three overlapping identity concerns:

1. User identity — who owns this account.
2. Agent-backend auth — the credential each provisioned backend does LLM work with, against your own plan or account.
3. Surface / host trust — which clients can connect to the server and what they're allowed to do.

## User identity

The account is identified by an Ed25519 public key. The first surface to enrol generates the account keypair and registers its public key with the server, creating the account.

The server is the credential authority. It holds a signing key and issues every surface a per-surface bearer credential — an EdDSA-JWT (RFC 8037) bound to the account, the surface id, and the surface kind. A surface presents its credential to connect; the server verifies it with its signing key. The `jose` library handles JWTs across Node and browser (WebCrypto).

Every surface is equal: each holds its own revocable credential, and any linked surface can link another.

## OpenAI accounts

Add account offers Claude, ChatGPT and OpenAI API key. ChatGPT connects through a browser sign-in, a device code usable from another device, or an existing Codex login on the selected host. Each operation reports progress, cancellation and failure. A login is complete only when the host verifies the account. Device-code prerequisites and missing secure credential storage are actionable errors. Credentials stay on the execution host in secure storage; disconnecting an adopted login removes Patch's access without signing the owner out of Codex.

Signing in to a disconnected ChatGPT credit source repairs that account, preserving its ID, label and priority. A connected credit source cannot be added twice.

Each OpenAI account has an isolated Codex runtime profile. Existing credentials are explicitly adopted, never silently inherited. API keys are separately billed sources and cannot be used for subscription overflow without spending authorization. Account metadata and login progress synchronize across surfaces without exposing tokens.

Credit selection takes the first connected, eligible account for the chosen provider and model. Each turn records the account it uses. Exhausted accounts wait for their reported reset, authentication failures require reconnecting, and unknown usage is distinct from available credit. ChatGPT usage is read without generating a response. Credit-source changes do not change a chat's provider or model.

OpenAI API keys use the same native secure store. API models have IDs `openai/api/<model>` and are labelled “OpenAI API (paid)”. They are selected explicitly; ChatGPT subscription exhaustion never rotates into an API account. No billed generation runs during credential validation.

## Backend credentials

Each agent backend authenticates with its own credential. Credentials are shared settings, held by the server and sent to every host (`01-server.md` § Settings); the host that runs a turn uses its copy (`02-daemon.md` § Agent backends). A backend authenticates against your own subscription or account rather than a patch-held key.

For Claude Code, patch piggybacks on that backend's own credential and uses your Pro / Max / Team plan over OAuth. A host can hold several named Claude credentials at once — several `claude setup-token` logins, each kept as its own account — rather than one. They are a SEQUENCE, and every host holds the same one. Every turn puts the keys in an order and runs on the first in that order that is connected and not known to be out of credit; the question is asked again for the next turn, so a key coming back needs nothing moved back onto it.

The ORDER is the backend's account strategy, a shared setting (`01-server.md` § Settings), one for Claude and one for Codex:

- `priority` — the stored order, first to last: the first key is always used while it has credit.
- `round-robin` — each turn starts on the key after the one the host's last turn started on, so the keys are spent together. Asking where a turn would start (a failover deciding where its re-run lands, a one-shot, a report) does not move it on; only a turn starting does.
- `soonest-reset` — the key whose weekly window resets first, so allowance about to expire is used rather than lost. A key with no reading goes after every key that has one.
- `least-used` — the key using the least of its limits, read as the higher of its session and weekly utilisation, so a key close to either is avoided. A key with no reading goes last.

Whatever the strategy, a spent key is skipped: a strategy decides which credit to spend, never whether a turn runs.

A chat — and the chat a job creates — can name a PREFERRED ACCOUNT, chosen when it is created and fixed for its life. Its turns start on that key, and the rest follow in the strategy's order. It is a preference, not a pin: a spent preferred key is walked past exactly like any other, and a failure is attributed to the key the turn actually ran on. A chat with a preference does not move a round-robin on. A preference naming a key the host does not hold for the chat's backend is refused when the chat is created; one the accounts later lose is ignored, so the chat runs on the host's keys rather than on nothing.

This is what makes a key running out cost one turn rather than every chat on it. The first turn to hit `You've hit your monthly spend limit` records that key as spent, with the reset time the provider's own message states; every turn after that resolves straight past it to the next key, with no failure of its own. When that reset passes the key is simply first in the order again, so everything goes back to it without anything having to remember to move it. Nothing rewrites a chat, because there is nothing on a chat to rewrite.

The turn that discovers it still has to be re-run, and is — once per key, not once per attempt. When no key has credit left the turn stops and waits for the earliest reset rather than trying again: a host whose keys are all spent must go quiet, not spin. (On 2026-09-07 it spun, for hours, because a failure was attributed to a chat's pinned preference rather than the key that actually spent, so the second key never got marked.)

**The same sequence answers every AI call, not only turns.** Patch makes one-shot calls that are not turns — a chat's title, its current-status summary, the model catalogue — and each of them walks the accounts too. A turn can afford to learn by failing, because the next turn is routed past the spent key; a one-shot has no next turn, so it walks the remaining sequence within the single call and marks what it learns for the calls behind it. Resolving once and giving up is not a smaller version of the rule, it is the absence of it: on 2026-09-12 title and status generation were pinned to the host's _active_ account while turns rotated away from it, so a night of 76 chats came out with no status at all — every one of them looking equally finished — while the chats themselves ran normally on the second key.

A one-shot that no account can answer resolves to nothing, and the caller leaves what it was going to set unchanged. A one-shot that fails for any OTHER reason fails loudly with the provider's own words rather than resolving to nothing: "the model had nothing to say" and "this call did not happen" must not be the same answer, because reading the second as the first is what made a spend limit look like an empty summary.

Work that stopped for want of credit starts again the moment ANY account has some — whichever account, and however it got it. Three things can reveal that, and all three do the same whole thing: a limit reaching the reset it stated; a person adding a key or reconnecting one with a fresh token; and a usage reading finding an account spendable that had been recorded as spent. The third is not a duplicate of the first: a refusal that names no reset time arms no timer, because there is no instant to wait for, so without it such an account stays sidelined until somebody touches a credential.

"Every chat waiting on credit" means both kinds at once, and this is the part that has drifted twice. A chat whose turn was held back sits idle with a stated resume time; a chat that failed on a spent account before it stopped and shows as errored with its turn still owed. They are the same situation seen at two moments of this system's life, and an event that restarts one and not the other leaves a host with credit and turns waiting for it. So a credit event resumes both lists, and a chat does not wait out its own timer once credit has arrived somewhere else — a chat parked against a 7-day weekly window runs when the other key's 5-hour window resets an hour later, not six days later. A resumed chat may try every key again, including ones it already failed on: what it tried is a record of the situation that has just ended.

The one thing deliberately left behind is the ancient turn. A turn that failed days ago is about a world that has moved on — a deploy since superseded, a task already done by hand — so past a cutoff it stays errored and visible for a person to re-send deliberately, and the count left behind is logged rather than passed over in silence.

Which key a turn ran on is a property of THAT TURN: it is what the failure names, and what a `rate_limit_event` usage reading is attributed to. It is never stored on the chat. It is shown, though: the chat's state names the account its latest turn ran on, and a surface draws it beside the model. When a turn runs on a different account from the chat's previous turn BECAUSE that one ran out of credit, the chat gets a system line saying so — which account it moved from and to, and when the spent one comes back if the limit said, in the reader's own time. A move that is the strategy working (round-robin moving on, a reset key taking over again) is not news and writes no line.

- The credential is the OAuth token Claude Code persists after `claude login`. Claude Code stores it under the key `claudeAiOauth` (`{ accessToken, refreshToken, expiresAt, … }`) in a platform-native store — `~/.claude/.credentials.json` on a Linux host and the macOS Keychain (service `Claude Code-credentials`) on a Mac host. It is not in `~/.claude.json`; that file holds account metadata under `oauthAccount` (email, plan, uuids) but no access token. The Claude Agent SDK reads its own credential from that native store directly. Patch passes no `ANTHROPIC_API_KEY` in env and leaves the credential to the backend. Those three locations (env `CLAUDE_CODE_OAUTH_TOKEN` → `~/.claude/.credentials.json` → Keychain, in that order) are that machine's own login, which Settings can adopt as a shared account (below). A host that already held accounts before settings were shared — including the one its first boot seeded from that login — sends them to the server once, the first time it connects (`01-server.md` § Settings), so a single-machine install works without touching Settings. From then on the shared accounts are what patch reads to gate queries and to pass the SDK as `CLAUDE_CODE_OAUTH_TOKEN`.
- First run: host checks for a valid `claudeAiOauth.accessToken` on the account a chat resolves to (via the resolution order above, for the first account; from the store thereafter). If absent/expired, the host refuses to start any `query()` against that account and emits `daemon.unauthenticated` naming the backend; the host's other backends, and its other Claude accounts, keep running (`02-daemon.md` § Agent backends). Settings surfaces this as "not connected" on that account's row under that host, with the connect controls below.
- A credential the check accepts can still be refused by Claude when the turn runs, because a token can be revoked while its stored expiry says otherwise. That refusal means the same thing as an absent one and is reported the same way: `daemon.unauthenticated` for that backend, the chat told in words that the host's sign-in is no longer valid and where to renew it, and the chat left idle so it runs as soon as the credential is replaced. It is not reported as a fault of that chat, and the backend's own error text is not what the chat shows.
- The server renews shared credentials and distributes updated access tokens. Hosts do not receive refresh tokens or renew these credentials independently.
- `ANTHROPIC_API_KEY` is stripped from the env passed to `query()`, so the SDK uses OAuth even when the user has the key set globally. Authentication for this backend is OAuth only.

Surface in Settings (`design/web-lo-fi-settings.html` § Claude subscription), once per backend for the whole account — the accounts are shared settings, held by the server and sent to every host (`01-server.md` § Settings):

- Each stored account gets its own row: connected state shows the account's label and account email (from `~/.claude.json` `oauthAccount.emailAddress` at the time it connected) plus a `disconnect` action; not-connected shows a `connect` action.
- An `add another account` action alongside the existing rows starts the same paste-a-token flow as connect, but always creates a new row rather than replacing one. There is no control to mark an account "active" or "default"; the sequence's order is the only ranking.
- An `adopt` action, per host, takes the backend's own login on that machine (below) and adds it as an account. A host whose login is already stored has none to offer.
- A strategy control per backend, over the rows (§ above).
- ONE ROW IS ONE CLAUDE ACCOUNT. Every stored credential records the Anthropic organisation it authenticates as, read from the `anthropic-organization-id` header on the call that validates it. (`GET /api/oauth/profile` answers 403 `oauth_scope_insufficient` for a `claude setup-token` token; the header is stamped on every response, including the free `/v1/models` 200.) A token whose organisation matches an account already stored is REFUSED, naming the row it clashes with — a second credential for the same account is not somewhere to fail over to, it is the same pool of credit under a second label. A re-connect of a row is exempt: replacing a row's own token with a fresh one for the same organisation is a rotation. An organisation that could not be established is "not known", never "different", so an unidentified token is still stored.
- Two accounts sharing an organisation are sidelined TOGETHER when either runs out, and the chat says so. Failing over between them would spend a turn re-discovering the same empty pool.

Every surface with a Settings screen — web, desktop and mobile (`15-design-mobile.md` § Settings tab) — shows the same state and offers the same controls, read from `GET /api/accounts/:backendId` and kept live by the `settings.changed` push (`03-wire-protocol.md` § Settings).

- Connect, add, disconnect, relabel, reorder and adopt are REST calls to the server (`01-server.md` § Endpoints). The server validates a pasted token itself, against the provider, before storing anything, so a token that does not work is refused in the reply naming why, and nothing is written.
- Disconnect is confirmed first: it takes that key out of the sequence every chat on every host draws from.
- A change is settled when the server has committed it; the reply carries the new list, and the row shows it. Whether each host has picked it up is the host's applied settings version, shown on its Settings → Hosts row (`01-server.md` § Settings) — an offline host does not block a change, it receives it on reconnect.
- The CLI drives the same calls through `patch accounts` (`17-cli.md` § Commands), and needs the server: with no server link it refuses, naming the server.

Surface in Settings — Usage: an easy way to see how close an account is to
Claude's own rate limits, and when they reset.

THE READING IS TAKEN, NOT OVERHEARD. It used to come only from the SDK's
in-turn `rate_limit_event`, which has a hole the shape of the whole feature: the
event rides on a query, so an account with no credit cannot produce one, and its
last reading — the one that blocked it — stood for ever. The host now asks
Anthropic directly, per stored account, every ten minutes, on demand
(`host.backend_usage_refresh`), and immediately after any turn runs one out. The
figures come from the `anthropic-ratelimit-unified-*` response headers, which
arrive on the 429 as well as the 200, so a spent account reports perfectly well.
The probe costs one `max_tokens: 1` Haiku call; the 429 costs nothing. In-turn
`rate_limit_event`s are still folded in when they arrive — they are free — but
nothing depends on one.

THREE WINDOWS, NOT TWO. `five_hour` (the session), `seven_day` (the week) and
`overage` — the extra-usage pool the other two spill into. Overage was
previously discarded as per-model detail. It is not: its refusal is what Claude
Code renders as `You've hit your monthly spend limit`, and its
`disabled-reason` of `org_level_disabled_until` means extra usage is not
enabled on the account — nobody has overspent anything, there was simply no
overflow pool when the 5-hour window emptied. Extra usage is a paid add-on, so
an account that has never turned it on reports a rejected overage permanently;
that is a healthy account's steady state, not a fault, and not a transient. Discarding it left that sentence
with no structured counterpart anywhere in patch, which is why nobody could
explain it. (The per-model `seven_day_opus`/`seven_day_sonnet` variants remain
unsurfaced.)

Each window carries `status` (`allowed`/`allowed_warning`/`rejected`),
`utilization` (0–1), `resetsAt` (epoch ms) and an optional `disabledReason`.
They fold onto the account's entry in the same per-host-per-backend
`daemon.account` report as `usage: { session?, week?, overage?, at? }`, so they
reach every surface through the existing cache/replay/store path with no new
wire message. `at` is when the reading was taken, and a surface must show it:
without it a stale figure is indistinguishable from a live one, which is how a
Wednesday reading came to be displayed on a Friday.

Each Claude-credential row shows a line per window it has data for — omitted
entirely for a window not yet reported, never a blank/zero placeholder, since
"not read" and "read as zero" must not look the same. Each line is the
percentage, a bar, and — when `resetsAt` is present — a local human time
(same-day `14:32`, otherwise `Wed 14:32`) with the UTC alongside on hover.
NEVER the raw epoch, never the raw enum, and never the provider's UTC prose
passed through: every instant patch displays is formatted from an epoch in the
reader's own zone. A `rejected` session or week window reads as blocked. A
rejected overage does NOT (spec/12 § A turn only dies for a reason someone
chose): that line reads as off, in neutral styling, and says that nothing has
been overspent. A row also carries a `Refresh` action, because the moment a
person wants the figure is the moment they are deciding whether to wait.

Usage also appears where the work happens: the composer's context ring opens a
popover naming the pool closest to its limit, or the refusal, with every
window shown alongside it (`14-design-web.md` § Usage popover). A not-yet-spawned
chat has no ring to measure it with, so the New chat screen carries the same
one-line summary beside the model instead (`14-design-web.md` §8 New-chat setup
row), with every window in its tooltip.

WHEN EVERY ACCOUNT ON A MACHINE IS SPENT, EVERY CHAT ON IT SAYS SO. A warning
banner in the chat chrome names the spent accounts, the machine, and the first
account to come back, counting down. This is a different fact from the per-chat
limit notice, and the per-chat notice cannot carry it: that one reaches only the
chat you happen to have open, and says nothing about the twenty others that are
equally parked or the jobs that will fire into them and park too.

It is a WARNING colour, not an error one — nothing is broken and it clears on
its own at the stated time — and it is per host, like the credential banner
beside it, because credit belongs to a machine's accounts and says nothing about
a chat running elsewhere.

IT STAYS SILENT UNLESS IT IS CERTAIN. Three states read as uncertain and show
nothing: no connected account (the sign-in banner's story, and two warnings
about one machine is noise), any account without a reading yet (unknown is not
spent — every cold start passes through this, and warning there would mean
warning on every load), and any account still usable (one account with credit
means work continues). A banner that cries wolf is worth nothing on the day it
is right.

Usage is per host per account: it is that host's view of that account's limits,
and it is not re-aggregated into one account-wide figure.

The server owns backend credentials, as an ordered list of named accounts per backend in its secrets store (`01-server.md` § Settings). A host reads only its copy from the last settings snapshot at query time; it never reads the backend's own login on that machine except to offer it for adoption.

- Disconnect empties an account's credential, leaving the account's entry and every machine's own login in place.
- Connect sets an account's credential: a pasted token, or a host's own login.
- Add account creates a new account entry from a pasted token, leaving every existing account untouched.
- The server alone renews provider credentials, serializing renewal and persisting each rotated refresh token before publishing new access credentials. Hosts never receive refresh tokens. Codex uses externally managed authentication. Signing in once makes the provider available on every linked host, including hosts that reconnect later. Renewal failures appear in Settings.

### Validating a pasted token

A pasted token is checked by the server against Anthropic's API (GET /v1/models) before it is
stored. The check uses the same OAuth bearer + `anthropic-beta: oauth-2025-04-20`
headers the host uses for model-catalogue reads.

- `200 OK` → the token is valid; the store write proceeds.
- `401`/`403` → Anthropic refused the token; the store is NOT written. The
  reply is `credential_rejected` naming why, shown inline on the credential row.
- Any other outcome (network error, unexpected status) → the result is
  inconclusive; the store is NOT written, and the reply is
  `credential_unreachable`. "We could not check" and "the token
  is bad" are distinguishable, but neither may lead to a store write: storing
  a token nobody has confirmed is how a bad one comes to be discovered by a
  failing chat rather than at entry.

The account email of a pasted token is unknowable — Anthropic's profile endpoint
refuses `claude setup-token` tokens — so a freshly connected account that was
added by paste shows no email until a host's next credential check resolves
one from the OAuth claims and sends it to the server.

## Surface linking (QR flow)

Any already-linked surface can link a new one.

1. On a linked surface, the user opens Link a device. That surface requests a single-use pairing nonce from the server — authenticated with its own credential — and renders it as a QR and as a short code, for a new surface that types rather than scans.
2. The new surface generates its device keypair, takes the nonce from the QR or the short code, and submits the nonce and its device public key to the server.
3. The server validates the nonce, mints a credential for the new surface bound to the nonce and the device public key, and returns it.
4. The new surface stores its credential and connects.

A pairing nonce is single-use and expires after five minutes. The credential is bound to the nonce and the device public key, so it cannot be replayed or retargeted to another device.

## Relay

A server with no address of its own — one running on a laptop, or behind a home router — is reached through a relay: a rendezvous both sides dial out to. The relay forwards bytes it cannot read.

- The server holds an Ed25519 relay identity (`relay.key` in its data directory, made on first use). Its channel is the first 22 characters of the base64url SHA-256 of the public key, so only the holder of the key can hold the channel: the relay makes a joining server sign a one-time challenge with it. A newer connection from the same server replaces the older.
- A device learns the relay's address, the channel and the server's public key from a pairing code (`05-surfaces.md` § Canonical QR payload). It connects to the channel; the relay tells the server a device has arrived and forwards binary frames each way, labelled so devices cannot see one another's.
- Everything between a device and the server is end-to-end encrypted. The device sends an ephemeral X25519 key sealed to the server's static key; the server answers with its own ephemeral key; each side derives one key per direction from both Diffie-Hellman results, and every message is a XChaCha20-Poly1305 frame whose nonce is an implicit counter. Only the holder of the server's key can read the first frame or answer it, so the device knows it is talking to its server and not to the relay; a frame the relay drops, repeats, reorders or alters fails to open and ends the session. The relay sees which channel, how many devices and how many bytes — never a path, header, body or message.
- Inside the session the device makes HTTP requests and opens WebSockets as though the server were next door, multiplexed as numbered streams. The server ends each one on its own loopback address: a request is made again, as an ordinary request, against the listening server, and a socket opened the same way. The tunnel therefore adds no access: every route needs the same credential it needs anywhere, and a device with only a pairing code can do only what the code allows.
- Relayed access is for surfaces. A host dials the server's address directly (`02-daemon.md`).
- A relay keeps no state. It limits frame size and devices per channel, and drops connections that stop answering pings. Running one is `11-deployment.md` § Relay.

A server is relayed when `PATCH_RELAY_URL` names a relay; Settings → Account shows whether it is reachable that way and by how many devices.

## Host registration (adding a host)

Every host machine registers its own host, opened from a linked surface. Hosts
are peers and any number may be registered; a second machine follows the same
flow as the first.

1. On a linked surface, the user opens Add host; the surface requests a single-use daemon-registration nonce from the server and renders it as a QR and as a short code, for a host where the code is typed rather than scanned. The QR and the short code carry the same nonce, so a host that scans and a host where it is typed submit the same value.
2. The host on the new host submits the nonce and its public key, as the installer's final step: run the install command, enter the pairing code, and the host appears in Settings → Hosts.
3. The server registers the host, issues its `daemonKey`, and records the host's self-description (`daemonId`, host name, platform, versions). With the `daemonKey` it hands over the voice-session secret every host verifies voice session tokens with (`PATCH_INTERNAL_TOKEN`), so the pairing code is the only thing a person gives the installer. An installer that is not already holding the secret pairs before it registers the service, since the service cannot start without it.
4. The host stores `~/.patch/daemon.key` and authenticates to the server with it thereafter.

The code travels in one direction: the server mints it at a linked surface's
request and the installer redeems it. Adding a host therefore starts on a
surface that is already linked, and the very first surface of an account gets
its credential from the server's administrator: `patch-server pair` on the
server prints a pairing code that makes the account the first time it is run
(`11-deployment.md` § Server installation), and `patch auth bootstrap`
(`17-cli.md` § Commands) does the same from a terminal, before any host can be
added.

Registration is per machine and idempotent: re-running the installer on a host
that is already registered re-uses its stored `daemonKey` rather than creating a
duplicate host. A machine that has been revoked pairs again from scratch.

Adding a host includes provisioning an agent backend and logging it in there
(`02-daemon.md` § Agent backends). Settings shows each host's backend accounts
separately, and each host's turns depend on its own credentials.

## Revocation

Any linked surface can be revoked from the app (Settings → Devices). Server invalidates the JWT and terminates the WebSocket.

Revoking a host decommissions that machine's install: its `daemonKey` is invalidated, its WebSocket dropped, and its chats become unreachable while their history is retained (`04-chats-and-folders.md`). Removing a host is confirmed, and the confirmation names how many chats live on it. Other hosts continue as they were.

## What's trusted vs untrusted

| Component                 | Trust                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A host (on its host)      | Trusted. Holds a copy of the shared backend credentials and provider keys, that host's plaintext history, and runs with the host user's full authority — see below. |
| Patch server              | Trusted — you run it. Plaintext content; no end-to-end encryption. Stores every shared credential, encrypted at rest (`01-server.md` § Settings).                   |
| Webhook callers (Todoist) | Untrusted. Rate-limit, JSONata-filter, no code exec.                                                                                                                |
| Phone/web clients         | Trusted via server-issued credential.                                                                                                                               |

### The authority of a turn

A turn carries the host user's authority, including `sudo` and `docker` where
that user has them (`02-daemon.md` § Runtime and installation). Two requirements
follow:

- Every trigger ingress — Todoist, inbound webhooks, cron
  (`08-triggers-and-jobs.md`) — is an entry point to that authority, and each is
  authenticated or secret-gated.
- The installer states what the host will be able to do on the machine, once,
  before it registers.

## Provider keys

Provider keys — the API keys the host itself uses for hosted voice and Groq
Whisper — are shared by every host and set and revoked from one Settings →
Keys page (`02-daemon.md` § Provider keys). The gate is every other shared
setting's: a live surface credential. They are stored like every other secret
(`01-server.md` § Settings): on the server, encrypted, sent to every host, and
never sent back to a surface, which sees where each key comes from and its
last four characters.

## Tokens on the wire

- EdDSA-JWT for surface/daemon-to-server WebSocket auth.
- A secret's value — a backend credential or a provider key — inbound on the
  REST call that sets it, outbound only in a `settings.snapshot` to a host, and
  from a host to the server when a host refreshes or adopts one. Never in a
  response to a surface, a report or a log.
- Webhook ingress is gated by the unguessable server-issued jobId in the URL, plus the trigger's own signature scheme where the source supports one (see `08-triggers-and-jobs.md`).

## Cross-refs

- QR flow mechanics: `05-surfaces.md`
- Host init sequence: `02-daemon.md`
- Server endpoints involved: `01-server.md`

The Codex Sign in action in the host list opens the same ChatGPT account form
as Credit sources → Add account, with all connection methods available. It
never asks for a Claude token. Claude-only add actions name Claude explicitly.
