// WHERE a deploy runs, and WHAT it is allowed to ship from here.
//
// `pnpm run deploy` should do the right thing on any machine — that is the whole
// point of this file. Before it existed, typing it on a Mac was quietly
// destructive: ship.mjs treats `onMac()` as "I am the desktop sub-step of a
// deploy the box is already driving", so it skips the test gate, the deploy lock
// and the pinned build tree, and then rsyncs web-dist and the server dist into
// `/srv/patch` — a path that exists on the box and not on a Mac. An ungated
// deploy writing artifacts nowhere near the live stack is worse than a refusal.
//
// The box genuinely is the only machine that can deploy: the server and host
// are systemd units there, the SPA is served from its checkout, and the deploy
// lock lives on its disk. But the Mac is the only machine that can build the
// desktop shell, because Squirrel refuses an update signed with anything but the
// installed app's certificate and that key is here. So the two machines already
// drive each other over ssh, and the honest shape is:
//
//   box   → runs the deploy, delegates `--only=desktop|smoke` to the Mac
//   Mac   → runs those sub-steps in place; hands anything else to the box
//
// Kept apart from ship.mjs because ship.mjs deploys the moment it is imported.
// A decision this consequential should be assertable without shipping anything.

/**
 * The surfaces the box delegates to the Mac (ship.mjs `macCommand`). A Mac run
 * limited to these is a sub-step of a deploy that is already under way and has
 * already passed the gate; anything else is a person starting a deploy.
 */
export const MAC_DELEGATED_SURFACES = ['desktop', 'smoke'];

/**
 * 'here' to run in this process, 'box' to hand the whole deploy to the box.
 *
 * `prepared` is a lane child of a run that already resolved where it is — it
 * must never bounce anywhere.
 */
export function deployTarget({ platform, only, prepared = false }) {
  if (platform !== 'darwin') return 'here';
  if (prepared) return 'here';
  const surfaces = parseOnly(only);
  if (surfaces === null) return 'box'; // a full deploy is never a Mac sub-step
  if (surfaces.length === 0) return 'box'; // `--only=` means nothing — let the box refuse it
  return surfaces.every((s) => MAC_DELEGATED_SURFACES.includes(s)) ? 'here' : 'box';
}

/** `--only=a,b` → ['a','b']; absent → null (which means "everything"). */
export function parseOnly(only) {
  if (only === undefined || only === null || only === false) return null;
  return String(only)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What the Mac must do to origin before the box can ship what you meant.
 *
 * The box builds from a worktree pinned to a PUSHED commit, so work that exists
 * only on this Mac reaches nothing at all. Returns one of:
 *
 *   none        — origin already has exactly this commit
 *   push        — committed here and nowhere else; publish it, then ship it
 *   ship-origin — this checkout is behind; origin/main ships, including commits
 *                 you do not have. Allowed, but said out loud.
 *   refuse      — diverged. The box resolves this by shipping origin/main and
 *                 leaving the local commits alone, which is right for a shared
 *                 scratch checkout nobody is typing in. A Mac is the opposite:
 *                 someone is sitting here expecting THEIR commits to go out, and
 *                 silently shipping somebody else's instead is the surprise most
 *                 worth refusing over.
 *
 * `dirty` never blocks anything — uncommitted work simply is not in the deploy —
 * but it is always reported, because "I deployed and my change isn't there" is
 * the confusion this whole area exists to prevent.
 */
export function publishPlan({
  head,
  origin,
  originIsAncestorOfHead,
  headIsAncestorOfOrigin,
  dirty = '',
}) {
  const notes = [];
  if (dirty) {
    notes.push(
      'uncommitted changes here are NOT in this deploy — the box builds from the pushed commit',
    );
  }
  if (head === origin) return { action: 'none', sha: head, notes };
  if (originIsAncestorOfHead) return { action: 'push', sha: head, notes };
  if (headIsAncestorOfOrigin) {
    notes.push('this checkout is behind origin/main, so the deploy also ships newer commits');
    return { action: 'ship-origin', sha: origin, notes };
  }
  return { action: 'refuse', sha: null, notes };
}
