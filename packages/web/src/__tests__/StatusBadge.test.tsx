import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StatusBadge } from '../components/StatusBadge.js';

describe('StatusBadge', () => {
  it('renders working with no ring', () => {
    render(<StatusBadge badge="working" />);
    expect(screen.getByTestId('badge-working')).toBeInTheDocument();
  });
  it('renders permission with orange ring', () => {
    render(<StatusBadge badge="permission" />);
    expect(screen.getByTestId('badge-permission')).toBeInTheDocument();
  });
  it('renders done unread', () => {
    render(<StatusBadge badge="done" />);
    expect(screen.getByTestId('badge-done')).toBeInTheDocument();
  });
  // B4 (DESKTOP-REVIEW): the read tick is a proper drawn glyph (an SVG
  // double-check read-receipt), not the blunt `✓` text character.
  it('renders read as a drawn SVG tick, not the raw ✓ character', () => {
    const { container } = render(<StatusBadge badge="read" />);
    const el = screen.getByTestId('badge-read');
    expect(el).toBeInTheDocument();
    // No literal check character in the text content.
    expect(el.textContent).not.toContain('✓');
    // A drawn glyph: an inline SVG.
    expect(container.querySelector('[data-testid="badge-read"] svg')).not.toBeNull();
    // Still labelled "read" for assistive tech.
    expect(el).toHaveAttribute('aria-label', 'read');
  });

  // spec/14 § Copy: a tooltip is a short name, never a sentence explaining the
  // control. These four were em-dashed explainers ("Working — the agent is
  // mid-turn"); they name the state and stop.
  it.each([
    ['working', 'Working'],
    ['permission', 'Needs your decision'],
    ['done', 'Done'],
    ['read', 'Read'],
    ['background', 'Background job running'],
    ['monitoring', 'Monitoring'],
  ] as const)('titles the %s badge "%s" — a name, not an explainer', (badge, title) => {
    render(<StatusBadge badge={badge} />);
    const el = screen.getByTestId(`badge-${badge}`);
    expect(el).toHaveAttribute('title', title);
    expect(el.getAttribute('title')).not.toContain('—');
  });
});

// REGRESSION ("new chat thing is massive", Todoist). The variant class must stay
// NAMESPACED. `StatusBadge` used to emit `class="badge permission"`, and
// index.css also has an unrelated `.permission` rule for the transcript's
// approval card (`padding: 12px; margin: 12px 0`) — which landed on the 8px
// sidebar dot and drew a 32px purple blob over the row title.
//
// jsdom applies no stylesheet, so it cannot see the painted size (that is
// e2e/status-badge-size.spec.ts). What it CAN lock is the contract that made the
// collision possible: no bare state name in the class list, and no bare
// state-name selector in the stylesheet that a badge could pick up.
describe('StatusBadge class-name contract', () => {
  const BADGES = [
    'working',
    'permission',
    'done',
    'read',
    'errored',
    'background',
    'monitoring',
  ] as const;

  it.each(BADGES)('emits `badge badge-%s`, never the bare state name', (badge) => {
    render(<StatusBadge badge={badge} />);
    const el = screen.getByTestId(`badge-${badge}`);
    const classes = [...el.classList];
    expect(classes).toContain('badge');
    expect(classes).toContain(`badge-${badge}`);
    // The whole bug: a bare `permission` class in this list is what let the
    // approval-card rule reach the dot.
    expect(classes).not.toContain(badge);
  });

  it('the stylesheet declares no bare state-name rule a badge could collide with', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    // Comments stripped first — the rules above talk ABOUT `.badge.permission`.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Every `.badge.*` variant selector must carry the `badge-` prefix.
    const variantSelectors = [...rules.matchAll(/\.badge\.([a-z][\w-]*)/g)].map((m) => m[1]!);
    expect(variantSelectors.length).toBeGreaterThan(0);
    for (const sel of variantSelectors) {
      expect(sel.startsWith('badge-')).toBe(true);
    }
    // And the approval-card rule that caused this is still there, still bare —
    // i.e. the fix is the namespacing, not a deletion that would restyle the card.
    expect(/^\.permission \{/m.test(rules)).toBe(true);
  });
});
