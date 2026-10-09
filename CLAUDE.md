# Patch is a public product

Patch is distributed to other people, who install it, run it on their own machines and update it from published releases. Tom is its first user and its developer, not its only user. Write everything here as if a stranger will run it.

- No hacks for one person. Hostnames, accounts, app ids, paths and preferences that belong to Tom come from configuration or from his private overlay, never from product code. `node scripts/personal-check.mjs` (part of `pnpm verify`) fails on new personal strings; it is a ratchet, so lower the baseline with `--ratchet` when you remove some and never raise an entry to get a change through.
- Releases are the way a change reaches anyone else. A deploy publishes a version, and every client checks and downloads it. Nothing may depend on one particular machine being awake at deploy time; a piece that can only be built on a Mac or on the box is built by CI and shown as pending until it lands.
- Tom's rapid private deploys continue for development, and a stable release is cut when something is ready. Do not special-case the development channel in product code.
- No fallbacks that hide errors. If something does not work, it must say so.
- Secrets never go in the repo. Check `git status` for credentials, keys and `.env` files before committing.
- Versions: development builds are `<major>.<minor>.<commit count>` from `scripts/version.mjs`; stable releases are tagged semver. Anything that changes a wire message must keep older supported clients working or raise the minimum supported protocol version.

The direction is written up in `spec/11-deployment.md`. The distribution work is tracked as: groundwork, secrets scan, CI build and publish, channels in the clients, id rename, notarisation, first stable release.
