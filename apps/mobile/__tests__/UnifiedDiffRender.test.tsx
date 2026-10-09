// Render coverage for <UnifiedDiff pairs={…}/> itself (spec/15 ## Chat
// detail: inline unified-format diffs). diffFromToolCall's own logic is
// already pinned in __tests__/unifiedDiff.test.ts — this file only exercises
// the RENDER: each of the three line kinds (context/add/del) must resolve to
// a visually distinct background/prefix/foreground colour, and a multi-pair
// diff (MultiEdit) must concatenate every pair's lines in order. It also
// closes two branch gaps the existing unifiedDiff.test.ts suite didn't reach
// (a full-deletion diff, and diffFromToolCall's `args ?? {}` default) —
// added here rather than duplicating that file's assertions.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderRN, findAllHost, byType, textOf } from './testUtils/render';
import { UnifiedDiff, diffFromToolCall, type DiffPair } from '../src/components/UnifiedDiff';
import { lightColors } from '../src/lib/theme';

describe('UnifiedDiff — line kinds (context / del / add)', () => {
  it('renders a context line unchanged, a removed line, and an added line with distinct styling', () => {
    const pairs: DiffPair[] = [{ oldText: 'a\nb\nc', newText: 'a\nX\nc' }];
    const r = renderRN(<UnifiedDiff pairs={pairs} />);
    const rows = findAllHost(r.root, byType('View')).filter(
      (v) => v.props.accessibilityLabel === undefined,
    );
    // 4 line rows: context 'a', del 'b', add 'X', context 'c'.
    expect(rows.length).toBe(4);

    const [rowA, rowDel, rowAdd, rowC] = rows;
    expect(textOf(rowA!)).toBe('  a'); // context prefix is a single space + text
    expect(rowA!.props.style.backgroundColor).toBe('transparent');

    expect(textOf(rowDel!)).toBe('- b');
    expect(rowDel!.props.style.backgroundColor).toBe(lightColors.diffDel);

    expect(textOf(rowAdd!)).toBe('+ X');
    expect(rowAdd!.props.style.backgroundColor).toBe(lightColors.diffAdd);

    expect(textOf(rowC!)).toBe('  c');
    expect(rowC!.props.style.backgroundColor).toBe('transparent');
  });

  it('foreground (ink) colour also differs per line kind', () => {
    const pairs: DiffPair[] = [{ oldText: 'same\nold', newText: 'same\nnew' }];
    const r = renderRN(<UnifiedDiff pairs={pairs} />);
    const texts = findAllHost(r.root, byType('Text'));
    // context, del, add — in that order (head, del, add — no tail here).
    expect(texts[0]!.props.style.color).toBe(lightColors.ink3);
    expect(texts[1]!.props.style.color).toBe(lightColors.diffDelInk);
    expect(texts[2]!.props.style.color).toBe(lightColors.diffAddInk);
  });
});

describe('UnifiedDiff — Write tool (all-added new file)', () => {
  it('renders every line as an addition when oldText is empty', () => {
    const pairs: DiffPair[] = [{ oldText: '', newText: 'hello\nworld' }];
    const r = renderRN(<UnifiedDiff pairs={pairs} />);
    expect(textOf(r.root)).toBe('+ hello+ world');
    const rows = findAllHost(r.root, byType('View')).filter(
      (v) => v.props.accessibilityLabel === undefined,
    );
    for (const row of rows) expect(row.props.style.backgroundColor).toBe(lightColors.diffAdd);
  });
});

describe('UnifiedDiff — MultiEdit (multiple pairs concatenated)', () => {
  it('concatenates the lines of every pair, in order', () => {
    const pairs: DiffPair[] = [
      { oldText: 'a', newText: 'A' },
      { oldText: 'b', newText: 'B' },
    ];
    const r = renderRN(<UnifiedDiff pairs={pairs} />);
    // Pair 1: del 'a', add 'A'. Pair 2: del 'b', add 'B'. In that sequence.
    expect(textOf(r.root)).toBe('- a+ A- b+ B');
  });
});

describe('UnifiedDiff — full deletion (newText empty)', () => {
  it('renders every remaining line as a removal when newText is empty', () => {
    const pairs: DiffPair[] = [{ oldText: 'a\nb', newText: '' }];
    const r = renderRN(<UnifiedDiff pairs={pairs} />);
    expect(textOf(r.root)).toBe('- a- b');
    const rows = findAllHost(r.root, byType('View')).filter(
      (v) => v.props.accessibilityLabel === undefined,
    );
    for (const row of rows) expect(row.props.style.backgroundColor).toBe(lightColors.diffDel);
  });
});

describe('diffFromToolCall — args defaulting (branch not covered by unifiedDiff.test.ts)', () => {
  it('treats a missing args object as {} rather than throwing', () => {
    // A tool call can in principle arrive with no args at all; `args ?? {}`
    // must default it so the string checks below simply fail closed to null.
    expect(diffFromToolCall('Edit', undefined)).toBeNull();
  });
});

describe('UnifiedDiff — container', () => {
  it('carries the "unified diff" accessibility label on its outer container', () => {
    const r = renderRN(<UnifiedDiff pairs={[{ oldText: 'x', newText: 'y' }]} />);
    const outer = findAllHost(r.root, byType('View')).find(
      (v) => v.props.accessibilityLabel === 'unified diff',
    );
    expect(outer).toBeDefined();
  });
});
