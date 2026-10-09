// ChatMarkdown.tsx — markdown tables in the transcript (spec/14 § Theming →
// Tables, which the phone follows per spec/15 § Dark mode). Left to the
// library's own defaults a table is drawn in pure black lines — invisible on
// dark paper — with no header fill and nothing telling one row from the next.
// These render ChatMarkdown in each scheme and measure what the renderer is
// actually handed against the page the reply sits on (an assistant reply is
// not a bubble: it is text on `paper`, spec/15 § Chat detail).

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderRN } from './testUtils/render';
import { ChatMarkdown } from '../src/components/ChatMarkdown';
import { darkColors, lightColors, type ThemeColors } from '../src/lib/theme';
import { __lastRenderer } from './stubs/markdown-display';
import { __setColorScheme } from './stubs/react-native';

afterEach(() => {
  __setColorScheme('light');
});

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not an opaque #rrggbb colour: ${hex}`);
  const lin = (i: number): number => {
    const s = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

/** WCAG contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Render an assistant reply in `scheme` and return what its renderer was built with. */
let renders = 0;
function renderIn(
  scheme: 'light' | 'dark',
  colors: ThemeColors,
): ReturnType<typeof __lastRenderer> {
  __setColorScheme(scheme);
  // Fresh content every time: ChatMarkdown caches finished output by content,
  // and a cache hit would never reach the renderer.
  renders += 1;
  renderRN(
    <ChatMarkdown content={`| a | b |\n|---|---|\n| ${renders} | 2 |`} color={colors.ink} />,
  );
  return __lastRenderer();
}

type RowRule = (
  node: { key: string; index: number },
  children: React.ReactNode[],
  parent: Array<{ type: string }>,
  styles: Record<string, unknown>,
) => React.ReactElement<{ style: unknown }>;

/** The background a `tr` rule paints for a row at `index` under `section`. */
function rowFill(
  r: ReturnType<typeof __lastRenderer>,
  section: 'thead' | 'tbody',
  index: number,
): unknown {
  const tr = r.rules['tr'] as unknown as RowRule;
  const el = tr(
    { key: `row-${index}`, index },
    [],
    [{ type: section }, { type: 'table' }],
    r.style,
  );
  const flat = ([] as unknown[])
    .concat(el.props.style)
    .reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...(s as object) }), {});
  return flat['backgroundColor'];
}

describe.each([
  ['dark', darkColors],
  ['light', lightColors],
] as const)('ChatMarkdown tables — %s', (scheme, colors) => {
  it('draws the table edge and row lines at 3:1 or better against the page', () => {
    const r = renderIn(scheme, colors);
    const table = r.style['table']!;
    const tr = r.style['tr']!;
    expect(contrast(table['borderColor'] as string, colors.paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(tr['borderColor'] as string, colors.paper)).toBeGreaterThanOrEqual(3);
  });
});

describe('ChatMarkdown tables — dark', () => {
  it('fills the header row so it stands out from the page', () => {
    const r = renderIn('dark', darkColors);
    const head = r.style['thead']!['backgroundColor'] as string;
    expect(contrast(head, darkColors.paper)).toBeGreaterThanOrEqual(1.25);
    expect(contrast(darkColors.ink, head)).toBeGreaterThanOrEqual(7);
  });

  it('stripes every other body row, and never the header row', () => {
    const r = renderIn('dark', darkColors);
    expect(rowFill(r, 'tbody', 0)).toBeUndefined();
    const stripe = rowFill(r, 'tbody', 1) as string;
    expect(contrast(stripe, darkColors.paper)).toBeGreaterThanOrEqual(1.1);
    expect(contrast(darkColors.ink, stripe)).toBeGreaterThanOrEqual(7);
    expect(rowFill(r, 'tbody', 2)).toBeUndefined();
    expect(rowFill(r, 'thead', 1)).toBeUndefined();
    // The row lines still clear 3:1 on a striped row.
    expect(contrast(r.style['tr']!['borderColor'] as string, stripe)).toBeGreaterThanOrEqual(3);
  });
});
