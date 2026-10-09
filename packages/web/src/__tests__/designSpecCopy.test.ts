import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The design spec must explicitly forbid AI-added helper/explainer text.
// Buttons and controls should be clear from the UX; tooltips are the rare
// exception for icon-only controls. See patch/todo.md § Updates.
function findSpec(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'spec', '14-design-web.md');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate spec/14-design-web.md above ' + process.cwd());
}

const spec = readFileSync(findSpec(), 'utf8');

describe('design spec — no helper text principle', () => {
  it('has a dedicated section prohibiting helper/explainer copy', () => {
    // A heading naming the rule, so it is discoverable and hard to miss.
    expect(spec).toMatch(/^#+ .*(no helper text|helper text)/im);
  });

  it('states controls must be self-evident from the UX, not described in prose', () => {
    expect(spec).toMatch(/clear from the UX|self-evident|speak for themselves/i);
    // The behaviour we are guarding against: long-winded explanations of what a control does.
    expect(spec).toMatch(/what (a|the) (button|control)|explain(s|ing)? what/i);
  });

  it('names tooltips as the rare exception, chiefly for icon-only controls', () => {
    // A tooltip is allowed, but framed as the exception rather than the norm.
    expect(spec).toMatch(/tooltip/i);
    expect(spec).toMatch(
      /tooltip[\s\S]{0,160}(exception|rare|sparing|icon-only|icon-only|where appropriate)/i,
    );
  });

  it('does not blanket-ban helper text — the empty-state single plain sentence stays sanctioned', () => {
    // Guard the reconciliation: the new rule must not contradict the existing
    // empty-state pattern (one plain helper sentence) documented in 15-design-mobile.md.
    expect(spec).toMatch(/empty state/i);
  });
});

// todo.md § Updates: "make the delete/close icons bigger nicer and clearer.
// use a more fun bin icon. and encode icon use in design spec."
describe('design spec — icon usage principle', () => {
  it('has a dedicated Icons section', () => {
    expect(spec).toMatch(/^#+ .*icons?/im);
  });

  it('names the shared icon module as the single source (no ad-hoc per-call sizing)', () => {
    expect(spec).toMatch(/single source|shared|one (module|place|source)/i);
    expect(spec).toMatch(/icons?\.tsx|shared icon/i);
  });

  it('assigns distinct glyphs: a bin for delete, an × for close/dismiss', () => {
    expect(spec).toMatch(/bin/i);
    expect(spec).toMatch(/delete|destructive/i);
    expect(spec).toMatch(/close|dismiss/i);
    // The bin is deliberately friendly, not a stark trash can.
    expect(spec).toMatch(/friendly|fun/i);
  });

  it('requires delete/close icons to share one generous, consistent size', () => {
    expect(spec).toMatch(/consistent|same size|one size|shared size/i);
    // Guards against the old jumble of tiny 12–14px glyphs.
    expect(spec).toMatch(/generous|bigger|large|comfortab|easy to (see|hit|tap)/i);
  });
});
