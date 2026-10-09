// H4 (desktop review): the empty-chat speech bubble + its tail must be ONE
// continuous shape — a single <path> — rather than a rounded <rect> plus a
// separate tail <path> that read as two disjoint strokes where they meet.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyChat } from '../components/EmptyChat.js';

describe('EmptyChat', () => {
  it('renders the given title', () => {
    render(<EmptyChat title="New chat" />);
    expect(screen.getByTestId('empty-chat').querySelector('.empty-chat-title')?.textContent).toBe(
      'New chat',
    );
  });

  it('defaults the title when none is given', () => {
    render(<EmptyChat />);
    expect(screen.getByTestId('empty-chat').querySelector('.empty-chat-title')?.textContent).toBe(
      'No messages yet',
    );
  });

  it('H4: the bubble + tail is a single continuous path (no separate rect/tail)', () => {
    render(<EmptyChat />);
    const svg = screen.getByTestId('empty-chat').querySelector('svg') as SVGSVGElement;
    // No <rect> — the bubble is no longer a rounded rectangle drawn separately
    // from its tail.
    expect(svg.querySelector('rect')).toBeNull();
    // Exactly ONE path carries the bubble outline+fill (the leaf/stem are their
    // own separate decorative paths, not `.empty-chat-bubble`).
    const bubblePaths = svg.querySelectorAll('path.empty-chat-bubble');
    expect(bubblePaths.length).toBe(1);
    // That single path traces both the rounded body and the tail: its `d` must
    // include a curve/arc (rounded corners) AND descend to the tail tip.
    const d = bubblePaths[0]?.getAttribute('d') ?? '';
    expect(d).toMatch(/A/); // arc commands for the rounded corners
    expect(d).toMatch(/162/); // the tail tip y-coordinate
    // The bubble path is a single closed shape.
    expect(d.trim().toUpperCase().endsWith('Z')).toBe(true);
  });
});

describe('EmptyChat sprout', () => {
  it('leaf sits at the stem tip, not on the bubble edge', () => {
    render(<EmptyChat />);
    const svg = screen.getByTestId('empty-chat').querySelector('svg') as SVGSVGElement;
    expect(svg.querySelector('path.empty-chat-leaf')?.getAttribute('d')).toMatch(/^M158 18/);
    expect(svg.querySelector('path.empty-chat-stem')?.getAttribute('d')).toMatch(/8 -22$/);
  });
});
