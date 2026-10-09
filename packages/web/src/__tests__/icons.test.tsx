import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CloseIcon, DeleteIcon, CLOSE_ICON_SIZE, DELETE_ICON_SIZE } from '../components/icons.js';

// todo.md § Updates: "make the delete/close icons bigger nicer and clearer.
// use a more fun bin icon." The delete/close glyphs used to render at a jumble
// of sizes (12, 13, 14, 16, 18, 20 and a bare "×"). They now come from ONE
// shared module so they read the same everywhere, are comfortably large, and
// the delete glyph is a friendly custom bin rather than the flat lucide Trash2.

describe('shared delete/close icons', () => {
  it('exposes ONE generous, consistent size for both glyphs', () => {
    // Consistency: a bin and an × should read at the same weight.
    expect(CLOSE_ICON_SIZE).toBe(DELETE_ICON_SIZE);
    // "Bigger": the legacy dismiss buttons were 12–14px. The shared size must
    // clear that comfortably so the controls are easy to see and hit.
    expect(CLOSE_ICON_SIZE).toBeGreaterThanOrEqual(18);
    expect(DELETE_ICON_SIZE).toBeGreaterThanOrEqual(18);
  });

  it('DeleteIcon renders a custom FUN bin, not the plain lucide Trash2', () => {
    const { container } = render(<DeleteIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // Our own marker — proves it is the bespoke bin, not a lucide icon.
    expect(svg!.getAttribute('data-icon')).toBe('delete-bin');
    // lucide icons stamp a `lucide` class; the bespoke bin must not.
    expect(svg!.getAttribute('class') ?? '').not.toMatch(/lucide/);
    // A bin has a lid (a shape distinct from the can body) — more than the two
    // paths of a bare trash glyph, giving it its friendlier character.
    const shapes = svg!.querySelectorAll('path, rect, line, polyline');
    expect(shapes.length).toBeGreaterThanOrEqual(3);
  });

  it('DeleteIcon defaults to the shared size and is square', () => {
    const { container } = render(<DeleteIcon />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe(String(DELETE_ICON_SIZE));
    expect(svg.getAttribute('height')).toBe(String(DELETE_ICON_SIZE));
  });

  it('CloseIcon renders an svg at the shared size and is decorative', () => {
    const { container } = render(<CloseIcon />);
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('width')).toBe(String(CLOSE_ICON_SIZE));
    expect(svg.getAttribute('height')).toBe(String(CLOSE_ICON_SIZE));
    // Decorative — labelling lives on the wrapping button (aria-label/title).
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('both icons accept a size override for tight clusters', () => {
    const del = render(<DeleteIcon size={16} />);
    expect(del.container.querySelector('svg')!.getAttribute('width')).toBe('16');
    const close = render(<CloseIcon size={22} />);
    expect(close.container.querySelector('svg')!.getAttribute('width')).toBe('22');
  });
});
