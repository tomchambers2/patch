// spec/04 ## Message queueing — a queued turn's chip says WHEN it goes in, not
// merely that it is waiting. `pos` is the 1-based place within the queued
// block as currently rendered, so promoting or removing an entry renumbers the
// block and the chip never contradicts the order on screen.

function ordinal(n: number): string {
  // 11/12/13 take "th" despite ending 1/2/3 — and so do 111/112/113.
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

export function queueChipLabel(pos: number): string {
  return pos === 1 ? 'Queued' : `${ordinal(pos)} in queue`;
}

/** The event that releases this turn — the half of the mental model a bare position can't carry. */
export function queueChipTitle(pos: number): string {
  if (pos === 1) return 'Runs when the current turn finishes';
  const ahead = pos - 1;
  return `Runs after the current turn and ${ahead} message${ahead === 1 ? '' : 's'} ahead of it`;
}
