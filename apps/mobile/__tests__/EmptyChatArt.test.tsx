// The empty-chat bubble + its tail must be ONE continuous path, matching web's
// EmptyChat (desktop review H4): a separate rect and tail read as two disjoint
// strokes where they meet.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderRN } from './testUtils/render';
import { EmptyChatArt } from '../src/components/EmptyChatArt';

describe('EmptyChatArt', () => {
  it('draws the bubble and tail as a single closed path with no rect', () => {
    const r = renderRN(<EmptyChatArt />);
    expect(r.root.findAll((n) => n.type === 'Rect')).toHaveLength(0);
    const bubbles = r.root.findAll(
      (n) => n.type === 'Path' && typeof n.props.stroke === 'string' && n.props.strokeWidth === 3,
    );
    expect(bubbles).toHaveLength(1);
    const d = bubbles[0]!.props.d as string;
    expect(d).toMatch(/A/);
    expect(d).toMatch(/162/);
    expect(d.trim().toUpperCase().endsWith('Z')).toBe(true);
  });

  it('leaf sits at the stem tip, not on the bubble edge', () => {
    const r = renderRN(<EmptyChatArt />);
    const ds = r.root.findAll((n) => n.type === 'Path').map((n) => n.props.d as string);
    expect(ds.some((d) => d.startsWith('M158 18'))).toBe(true);
    expect(ds.some((d) => d.endsWith('8 -22'))).toBe(true);
  });
});
