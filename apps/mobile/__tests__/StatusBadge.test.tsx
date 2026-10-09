// Render coverage for the seven-state status badge (spec/15 § the same
// seven-state vocabulary as the web sidebar). Each branch renders a visually
// distinct treatment:
//   - 'read'       → a small grey check glyph
//   - 'working'    → the looped opacity-pulse ring (WorkingPulse)
//   - 'done'       → a solid ring + dot in the leaf accent
//   - 'permission' → the same ring shape but in the waiting/amber colour
//   - 'errored'    → a drawn TriangleAlert glyph in the danger red
//   - 'background' → a static (non-spinning) Terminal glyph, muted grey
//   - 'monitoring' → a static Clock glyph, muted grey
// 'done' and 'permission' share one render branch in the component but must
// resolve to DIFFERENT colours via badgeColor(), which this pins.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderRN, findHost, findAllHost, byType, hasText, actSync } from './testUtils/render';
import { StatusBadge } from '../src/components/StatusBadge';
import { lightColors } from '../src/lib/theme';
import { badgeColor } from '../src/lib/badge';

describe('StatusBadge — read', () => {
  it('renders the grey check glyph inside a plain sized wrapper (no ring)', () => {
    const r = renderRN(<StatusBadge badge="read" />);
    expect(hasText(r.root, '✓')).toBe(true);
    const text = findHost(r.root, byType('Text'));
    expect(text.props.style.color).toBe(lightColors.inkFaint);
    // Exactly one View — the size+4 wrapper — no ring/dot structure.
    const views = findAllHost(r.root, byType('View'));
    expect(views.length).toBe(1);
    expect(views[0]!.props.style.width).toBe(16); // size(12) + 4
    expect(views[0]!.props.style.borderWidth).toBeUndefined();
  });
});

describe('StatusBadge — working (looped pulse)', () => {
  it('mounts a ring wrapping an Animated.View pulse in the leaf colour', () => {
    const r = renderRN(<StatusBadge badge="working" size={12} />);
    const ring = findHost(r.root, byType('View'));
    expect(ring.props.style.width).toBe(20); // ringSize = size + 8
    expect(ring.props.style.height).toBe(20);
    const pulse = findHost(r.root, byType('Animated.View'));
    expect(pulse.props.style.width).toBe(12);
    expect(pulse.props.style.backgroundColor).toBe(badgeColor('working', lightColors));
    // opacity is a live Animated.Value the loop drives — present, not a bare number.
    expect(pulse.props.style.opacity).toBeDefined();
  });

  it('tears the loop down on unmount without throwing (loop.stop() cleanup runs)', () => {
    const r = renderRN(<StatusBadge badge="working" />);
    expect(() => actSync(() => r.unmount())).not.toThrow();
  });
});

describe('StatusBadge — done / permission (ring + dot, distinct colours)', () => {
  it("'done' renders the ring+dot in the leaf colour", () => {
    const r = renderRN(<StatusBadge badge="done" size={12} />);
    const views = findAllHost(r.root, byType('View'));
    // ring (outer) + dot (inner)
    expect(views.length).toBe(2);
    const [ring, dot] = views;
    expect(ring!.props.style.borderColor).toBe(badgeColor('done', lightColors));
    expect(ring!.props.style.width).toBe(20);
    expect(dot!.props.style.backgroundColor).toBe(badgeColor('done', lightColors));
  });

  it("'permission' renders the SAME shape but in the waiting/amber colour", () => {
    const r = renderRN(<StatusBadge badge="permission" size={12} />);
    const [ring] = findAllHost(r.root, byType('View'));
    expect(ring!.props.style.borderColor).toBe(badgeColor('permission', lightColors));
    // Distinct from 'done' — pins the two branches never collapsing to one colour.
    expect(badgeColor('permission', lightColors)).not.toBe(badgeColor('done', lightColors));
  });
});

describe('StatusBadge — errored (drawn glyph, danger red)', () => {
  it('renders a TriangleAlert in the danger colour, not a tinted dot', () => {
    const r = renderRN(<StatusBadge badge="errored" size={12} />);
    const icon = findHost(r.root, (i) => i.type === 'Icon');
    expect(icon.props.name).toBe('TriangleAlert');
    expect(icon.props.color).toBe(badgeColor('errored', lightColors));
  });
});

describe('StatusBadge — background (static Terminal glyph, muted grey)', () => {
  it('renders a Terminal glyph in the same muted grey as read', () => {
    const r = renderRN(<StatusBadge badge="background" size={12} />);
    const icon = findHost(r.root, (i) => i.type === 'Icon');
    expect(icon.props.name).toBe('Terminal');
    expect(icon.props.color).toBe(badgeColor('background', lightColors));
    expect(badgeColor('background', lightColors)).toBe(lightColors.ink3);
  });
});

describe('StatusBadge — monitoring (static Clock glyph, muted grey)', () => {
  it('renders a Clock glyph, distinct from the Terminal background glyph', () => {
    const r = renderRN(<StatusBadge badge="monitoring" size={12} />);
    const icon = findHost(r.root, (i) => i.type === 'Icon');
    expect(icon.props.name).toBe('Clock');
    expect(icon.props.color).toBe(badgeColor('monitoring', lightColors));
  });
});
