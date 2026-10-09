# Deploying Patch

```sh
pnpm run deploy
```

That's it, and it works from anywhere — the Mac or the box. One command ships
every surface: the web SPA, the server, the host, the phone (OTA, plus a new
APK when one is needed) and the Mac desktop shell. It fast-forwards to
`origin/main` and pushes anything committed locally first, so what ships is
always a real, pushed commit.

## Where it actually runs

Only the box can deploy: the server and host are systemd units there,
installed under `~/.patch-server` and `~/.patch`. Only the Mac
can build the desktop shell, because Squirrel refuses an update signed with
anything but the installed app's certificate and that key is on the Mac. So the
two machines drive each other over ssh, and the command sorts it out for you:

| You type it on | What happens                                                           |
| -------------- | ---------------------------------------------------------------------- |
| the box        | it deploys, delegating the signed desktop shell to the Mac over ssh    |
| the Mac        | it pushes your commit and runs the deploy on the box, which calls back |

Run from the Mac it first tells you two things worth knowing, then hands over:
uncommitted changes are **not** in the deploy (the box builds from the pushed
commit), and if your checkout is behind `origin/main` the deploy also ships the
commits you don't have. A checkout that has _diverged_ from `origin/main` is
refused outright rather than guessed at — rebase and run it again.

`--only=desktop` and `--only=smoke` are the exception: those are the sub-steps
the box delegates, so on a Mac they run in place. Everything else goes to the
box. See `scripts/deploy-target.mjs`.

`pnpm run deploy`, never `pnpm deploy` — the latter resolves to pnpm's builtin
workspace-deploy command and exits `ERR_PNPM_NOTHING_TO_DEPLOY` without touching
anything.

## Services

Both the server and host run as native systemd user services — not Docker.

| Service | Unit file                                     | Command                                 |
| ------- | --------------------------------------------- | --------------------------------------- |
| Server  | `~/.config/systemd/user/patch-server.service` | `systemctl --user restart patch-server` |
| Host    | `~/.config/systemd/user/patch-daemon.service` | `systemctl --user restart patch-daemon` |

The server runs from an installed **release**, never from a git checkout. A
deploy builds one (`scripts/build-server.mjs`: the server's dist and production
`node_modules`, the SPA, a launcher and an installer) and runs its `install`,
which is exactly what a self-hoster runs (`README.md`, `spec/11-deployment.md`
§ Server installation). Everything live is in `~/.patch-server`:

| Path                  | What                                                           |
| --------------------- | -------------------------------------------------------------- |
| `versions/<release>/` | the current release and the two before it, for a hand rollback |
| `current`             | → the running release; the unit runs `current/patch-server`    |
| `data/`               | the server's state                                             |
| `downloads/`          | the update channel: host artifacts, APK, desktop feed          |
| `server.env`          | config + secrets (the unit's `EnvironmentFile`)                |
| `logs/server.log`     | the server's output                                            |

The deploy's own bookkeeping is in `~/.patch-deploy`: `logs/` (deploy and APK
build logs), `apk-fingerprint.json`, and APKs in transit. Port 3000 — host Caddy
proxies to it.

Nothing an agent does in `/srv/patch` can reach any of that. It used to: the SPA
and the update channel lived in `/srv/patch/deploy/`, untracked, and on 30 Sep
an agent's `git stash -u` swept them into a stash — prod served "route not
found" at `/app` for 14 hours while `/api/healthz` said ok. The server now also
refuses to boot if the SPA it was given is missing.

To roll back by hand, point `current` at an older release and restart:

```sh
ln -sfn ~/.patch-server/versions/<release> ~/.patch-server/current
systemctl --user restart patch-server
```

To check service status:

```sh
systemctl --user status patch-server
systemctl --user status patch-daemon
tail -f ~/.patch-server/logs/server.log
tail -f ~/.patch/logs/daemon.log
```

## What to expect when you run it

**It returns immediately and keeps working.** The last thing a deploy does is
apply the host update, which restarts the host and kills every chat on the
host — including the agent chat that started the deploy. So the run detaches
itself, prints its log path, and carries on without you. Don't wait for it, and
don't re-run it because the chat died: that is the expected ending.

**The chats it killed pick themselves back up.** A chat that was mid-turn when
the host went down is re-sent that turn by the new host as it starts, in the
same Claude session and told it was cut off partway through, with anything queued
behind it still queued behind it. You don't have to be watching — open the app
later and the work has carried on. (The `errored` /
"Connection to the host was lost. Message will resend." you may see while it is
down resolves itself.) The turns are held in `~/.patch/chats/<id>/meta.json` as `pendingTurns`,
written as the queue changes and cleared as it drains, so a clean shutdown leaves
nothing to resume.

It reports the result on its own stdout when it finishes, and again later if a
queued APK build lands — including the APK's download URL. A deploy is run by an
agent, so that is where the result goes; it does NOT push to Tom's phone. Set
`PATCH_NTFY_URL` to a topic to put those pushes back on a device.

**It verifies itself.** Every surface is checked against the commit being
deployed before the run counts as a success, and a mismatch fails loudly. There
is no separate list of curls to run afterwards.

**It refuses rather than guesses.** Uncommitted changes, the wrong checkout, a
missing signing key, an unreachable Mac, an OTA the phone could never fetch — each
of these stops the deploy instead of half-shipping.

## The Mac's host

Hetzner's host is built on the box; the macOS one (`darwin-arm64`) can only be
built on the Mac, where its codesigning identity is. The `daemon-mac` step does
that over ssh in a tree pinned to the commit, copies the artifact back and adds
it to the `daemon-latest.json` the box just published, then checks the server
serves both. It needs `~/.patch-daemon-build/` on the Mac: `vendor/` (the macOS
Node, onnxruntime-node's `darwin-arm64` prebuild, `silero_vad.onnx`) and the same
`artifact-signing.key` as the box's. A sleeping Mac fails this step on its own
and holds nothing else back; the Mac's host then reports that the published
build has no artifact for it until a deploy runs with the Mac awake.

## The parts that need a human

- **A new APK is built in the cloud and takes hours** (EAS free-tier queue). The
  deploy doesn't wait: it starts the build, finishes everything else, and a
  detached follower publishes the APK and pings your phone when it lands. A new
  APK is only built when the _native_ fingerprint changes — every other change
  reaches the phone as an OTA within minutes.
- **When EAS's free plan runs out of Android builds** (it does, partway through
  a month), the `apk` surface fails and says so — it does not quietly build
  somewhere else. Build it on the Mac instead, which is free and signs with the
  same key:

  ```sh
  pnpm run deploy --only=ota,apk --apk-local
  ```

  That runs `scripts/build-apk-local.mjs` on the Mac over ssh, in a worktree
  pinned to the commit (same as the desktop and smoke lanes): a gradle
  `assembleRelease` of the committed `android/` project, stamped with the
  commit's `EXPO_PUBLIC_*` values and signed with the release key from the Mac's
  `~/.patch-mobile-credentials/`. It takes ~5 minutes, the Mac pushes the APK to
  the box, and the box publishes it through the same `publishApk` the EAS
  follower uses. It is recorded in `~/.patch-deploy/apk-fingerprint.json` as a local
  build, so the next deploy does not queue a duplicate on EAS. `--apk-local`
  (and `--apk-here`) are honoured by a full `pnpm run deploy` too — the lanes
  are started with them (`laneArgs` in `scripts/deploy-scope.mjs`).

- **When the Mac is off as well**, build it on the box — only by asking:

  ```sh
  pnpm run deploy --only=ota,apk --apk-here
  ```

  The same `scripts/build-apk-local.mjs`, stamps and `publishApk`, run in the
  box's pinned build tree under caps (`boxBuildCommand`): a
  `systemd-run --user --scope -p MemoryMax=5G -p CPUQuota=300%` scope,
  `nice -n 19 ionice -c3`, and `GRADLE_OPTS` holding gradle to a 3g heap, two
  workers and no parallelism (the limits `bin/publish` uses on Hetzner), with
  no gradle daemon so the build cannot slip into an uncapped one. The scope is
  stopped afterwards. It is slow — a cold build is up to an hour — and writes
  its own log, `~/.patch-deploy/logs/patch-apk-build-<sha>-<ms>.log`, named in the
  deploy output. Never the default: an uncapped React
  Native build took the box, and everything it serves, off the network. Needs
  `platforms;android-35` and `ndk;26.1.10909125` in `~/Android/sdk` (installed
  2026-09-25) and a few GB free on `/`.

- **Every published APK is checked before it is visible**, however it was
  built (`publishApk` in `scripts/ship.mjs`, decisions in
  `scripts/apk-publish.mjs`): it must be signed by the same certificate as the
  `patch.apk` live now (Android refuses an update with a different key — on the
  phone, not here), be `io.github.tomchambers2.patch`, and — for a Mac build — carry
  the commit's stamps in its JS bundle (`verify-apk-bundle.mjs`). It then gets a
  filename no build has had (`patch-<sha>.apk`, `patch-<sha>-2.apk` for a
  rebuild of the same commit), `patch.apk` and `android-latest.json` are
  updated, both are fetched back over the public URL, and Tom's phone gets an
  ntfy with the download link — the one deploy push that does go to the phone,
  because installing it needs him. The `version` in `android-latest.json` is
  the APK's own versionName.
- **Installing that APK.** Android can't self-install. The phone shows the
  published build under Settings → Version with a download button.
- **The desktop shell needs the Mac**, because it must be codesigned. The deploy
  drives it over ssh automatically; if the Mac is asleep the deploy fails rather
  than silently skipping it. It runs _first_, before the server restart: that
  restart is what reconnects every surface, and the reconnect is what tells the
  running shell to update (below).

The shell is not restarted _by_ the deploy. It updates itself: the SPA sees a new
bundle hash on its post-deploy reconnect and asks the shell to check its own feed
and install immediately, which relaunches it. The deploy used to replace
`/Applications/Patch.app` directly instead — that quit the app, never brought it
back, and left the desktop dead after every deploy. `pnpm --filter @patch/desktop
install:app` still does a deliberate local install by hand, and now refuses
outright if Patch is still running rather than deleting a live bundle.

## Running less than everything

```sh
pnpm run deploy --only=web            # one surface
pnpm run deploy --only=web,server     # several
pnpm run deploy --foreground          # watch it instead of detaching
```

Surfaces: `web`, `server`, `daemon`, `ota`, `apk`, `desktop`, `smoke`, `apply`
(the host restart). `--apk-local` makes `apk` build on the Mac instead of EAS,
`--apk-here` on this box under caps (above); not both. Anything without `apply` runs inline, since nothing will kill the chat.

## Things the command can't know

- **Signing material lives outside the repo**, because `/srv/patch` is a shared
  checkout that other agents reset, stash and clean: `~/.patch-daemon-build/` (host vendor tree +
  Ed25519 artifact key) and `~/.patch-mobile-credentials/` (the Android release
  keystore `patch-upload.keystore` + its `credentials.json`, on the box AND on
  the Mac for `--apk-local`, used on the box by `--apk-here`; certificate SHA-256 `06000dae…6fac2161`). This is
  NOT `~/.android-personal/`, the key `bin/publish` signs Tom's other apps with. The keystore must stay the same one — Android refuses to upgrade an
  installed app in place if the signing key changes.
- **The Mac's code-signing cert expires 2027-07-28.** Self-signed is fine:
  Squirrel only requires an update to carry the same certificate as the installed
  app. It just must not be _unsigned_ — Squirrel refuses to update an
  adhoc-signed app, which is how the shell once became unable to self-update.
- **`/api/version` is the cross-surface truth** — it reports server, web, host,
  APK and desktop versions together, and each client shows its own under
  Settings → Version. That's where to look when something seems stale.

## Disk

The box is a cx43 (8 vCPU / 16 GB / 160 GB). Docker is no longer used for the
server or host.

**Every deploy cleans up after itself**, on each machine it used, at the end of
the run — success or failure (`scripts/deploy-cleanup.mjs`, called by
`ship.mjs`; it used to prune nothing on the box, and `/` reached 97% with ~36
build trees in `~/.patch-deploy-build`). Where it runs:

- **the box** at the end of every deploy — before the host restart when there
  is one, since that restart can take the deploy's own process down — and from
  the exit handler if the run dies early; a detached APK follower cleans up
  when it finishes;
- **the Mac** at the end of every delegated sub-step (`--only=desktop`,
  `--only=smoke`), and over ssh after an `--apk-local` APK has been copied back.

What it removes:

| What                                                          | Kept                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.patch-deploy-build/tree*`                                 | the newest 2 and anything younger than 2h (`TREE_POLICY` in `build-tree.mjs` — the one policy), then `git worktree prune`                                                                                  |
| APK build output in a tree                                    | nothing: `apps/mobile/android/{app/build,app/.cxx,build,.gradle}` and each native module's `android/{build,.cxx}` go once the APK is published (box `--apk-here`, Mac `--apk-local`); `node_modules` stays |
| `~/.patch-deploy/logs/*.log` (box)                            | the 30 newest, and anything younger than 30 days                                                                                                                                                           |
| `~/.patch-server/downloads` (box)                             | whatever `android-latest.json` / `daemon-latest.json` / `desktop-latest.json` / `latest-mac.yml` name, plus the build before each (rollback) — `prune-downloads.mjs`                                       |
| `~/.patch/versions/*`                                         | the version `~/.patch/current` points at, anything newer, the newest older one (rollback), anything under 2h                                                                                               |
| `~/.patch-deploy/apk-incoming-*.apk`, `$TMPDIR/patch-smoke-*` | anything under 2h                                                                                                                                                                                          |

It never deletes this run's tree, the tree a concurrent deploy is building in
(each deploy records its own at `~/.patch-deploy-build/deploy.lock`), or
anything a running process stands in, runs from
or holds open — a detached APK follower runs `ship.mjs` from its tree for
hours (`scripts/lib/in-use.mjs`: `/proc` on the box, `ps` + `lsof` on the Mac).
If the process table cannot be read it sweeps nothing that depends on it.
Nothing live is served from a tree: the server and SPA run from
`~/.patch-server/current`, the downloads are in `~/.patch-server/downloads`, and
the host runs from `~/.patch/versions/<v>`.

It prints one line — what went, what that freed, how full the disk is now —
which is also in the deploy's summary. A cleanup failure reads
`CLEANUP FAILED … (the deploy result stands)` there, loudly, and never turns a
successful ship into a failed one.

Gradle: the box build has no daemon (and its scope is stopped); the Mac build
runs `gradlew --stop` when it finishes, and the Kotlin daemon exits once no
gradle client is left. `~/.gradle/caches` (~9 GB on the box) is shared with
`bin/publish` and left alone.

To run it by hand (`--dry-run` to see first):

```sh
node scripts/deploy-cleanup.mjs --downloads=$HOME/.patch-server/downloads --deploy-state=$HOME/.patch-deploy --dry-run    # the box
node scripts/deploy-cleanup.mjs --dry-run                     # the Mac
```

## OpenAI runtime

Patch provisions pinned Codex 0.154.0 under `~/.patch/backends/codex` when connecting the first account. macOS uses Keychain. On the Linux host, run `bash scripts/setup-codex-keyring-linux.sh` once before connecting accounts; the native keyring unlock credential is encrypted with systemd credentials. Deploy builds use a fresh isolated worktree on each host.

Desktop signing is launched in the logged-in Mac GUI session through `scripts/mac-gui-run.mjs`. SSH does not have access to that session’s unlocked signing keys. The deploy never assumes an empty login password and never copies a keychain password into its command line.

## Two deploys at once

Allowed, and not serialised. Each deploy pins its OWN build worktree
(`~/.patch-deploy-build/tree-<ms>-<pid>`), so there is nothing shared for a
second one to corrupt, and it records that tree at
`~/.patch-deploy-build/deploy.lock` purely so `deploy-cleanup` knows not to
sweep a tree still being built in.

This used to be a lock that REFUSED the second deploy, from when every deploy
pinned the same tree. It outlived that design and became the problem it was
meant to prevent: `apply` waits up to half an hour for the host to find a
moment with no turn running, a deploy run by an agent is itself one of those
turns, so the claim sat held for the better part of an hour — and the agents
behind it spin-waited on the holder's pid and then shipped in a burst, each
deploy restarting the host and killing every live chat. See
`scripts/deploy-lock.mjs`.

What is NOT serialised and is worth knowing: two deploys landing at the same
instant both install and both restart the units, so the last one to finish is
the one that sticks. Each still verifies every surface against its own commit
and fails loudly if it does not match, so a mixed outcome is reported rather
than silent — but if two agents ship different commits seconds apart, which one
production ends on is whichever finished last, not whichever was newer.

## Relay and install channel

A server deploy also (re)installs the relay (`scripts/install-relay.mjs` →
`~/.patch-relay`, user service `patch-relay` on 127.0.0.1:8787, reached at
`wss://patch.tomchambers.me/relay` through a `handle_path /relay/*` block in the
box's `/etc/caddy/Caddyfile`) and publishes `install.sh`, `patch-server.tar.gz`
and its `.sha256` to `downloads/server-release/`, served at
`/api/server-release/`. The deploy's web check fails if those are not served.
