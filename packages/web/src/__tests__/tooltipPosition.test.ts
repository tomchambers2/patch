// spec/14 § Copy — Tooltips: "stays clear of the window edge, flipping to the
// opposite side of its control rather than clipping".

import { describe, it, expect } from 'vitest';
import { computeTooltipPosition, type Rect } from '../lib/tooltipPosition.js';

function rect(partial: Partial<Rect>): Rect {
  return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, ...partial };
}

const VIEWPORT = { width: 1000, height: 800 };
const TOOLTIP = { width: 80, height: 24 };

describe('computeTooltipPosition', () => {
  it('places itself below the trigger, centred, when there is room', () => {
    const trigger = rect({ top: 100, left: 100, bottom: 120, right: 140, width: 40, height: 20 });
    const pos = computeTooltipPosition(trigger, TOOLTIP, VIEWPORT);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(128); // bottom (120) + gap (8)
    expect(pos.left).toBe(80); // centred: 100 + 20 - 40
  });

  it('flips above when the trigger sits at the bottom of the viewport', () => {
    const trigger = rect({ top: 780, left: 100, bottom: 795, right: 140, width: 40, height: 15 });
    const pos = computeTooltipPosition(trigger, TOOLTIP, VIEWPORT);
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(780 - 8 - 24);
  });

  it('never lets the tooltip run past the left edge of the window', () => {
    const trigger = rect({ top: 100, left: 2, bottom: 120, right: 42, width: 40, height: 20 });
    const pos = computeTooltipPosition(trigger, TOOLTIP, VIEWPORT);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it('never lets the tooltip run past the right edge of the window', () => {
    const trigger = rect({ top: 100, left: 970, bottom: 120, right: 1010, width: 40, height: 20 });
    const pos = computeTooltipPosition(trigger, TOOLTIP, VIEWPORT);
    expect(pos.left + TOOLTIP.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it('stays below when there is no room on either side, rather than picking an arbitrary one', () => {
    const tallTooltip = { width: 80, height: 900 };
    const trigger = rect({ top: 400, left: 100, bottom: 420, right: 140, width: 40, height: 20 });
    const pos = computeTooltipPosition(trigger, tallTooltip, VIEWPORT);
    expect(pos.placement).toBe('below');
  });
});
