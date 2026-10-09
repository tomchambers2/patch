// Shared "near the bottom" scroll test for the sidebar's lifecycle band and
// its `/lifecycle/:kind` main-window twin (spec/14 § Sidebar item 6: "load a
// limited number... then load more on scroll"). Both scroll regions hold
// pagination-aware lists, so they share one threshold rather than drifting.

/** How close to the bottom, in px, counts as "load the next page". */
export const LIFECYCLE_SCROLL_THRESHOLD_PX = 120;

export function isNearScrollBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  thresholdPx: number = LIFECYCLE_SCROLL_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
}
