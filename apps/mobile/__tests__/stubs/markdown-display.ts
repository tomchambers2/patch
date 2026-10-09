// react-native-markdown-display stub for unit tests. ChatMarkdown.tsx calls
// this library's pipeline directly (parser + AstRenderer) rather than
// rendering its <Markdown> component — see that file's own comment on why
// (genuinely caching the finished output, not just a wrapper around
// re-running it). This stub mirrors that pipeline just enough to exercise
// ChatMarkdown's own logic (variant-keyed caching) without a real
// markdown-it AST: `parser` treats the whole source as a single text node
// and calls straight through to whatever `text` rule it was given —
// ChatMarkdown always overrides that rule (to add `selectable`), so tests
// can assert on the REAL rule's output.
import React from 'react';
import type { RenderRules } from 'react-native-markdown-display';

export const renderRules: RenderRules = {};
export const styles: Record<string, object> = {};

export function removeTextStyleProps(style: object): object {
  return style;
}

export function MarkdownIt(): { parse(source: string, opts: unknown): unknown[] } {
  return {
    parse(source: string): unknown[] {
      return [{ type: 'stub', content: source }];
    },
  };
}

// Test helper: how many times the stub's `parser` has actually run — not a
// `vi.spyOn`, because ChatMarkdown.tsx captures this function into a
// module-level constant once at its own load time (see its own comment on
// why: a shared, not-per-render, parse pipeline), so a spy attached later
// wouldn't intercept the reference it already holds. Counting inside the
// stub itself is robust regardless of when or how it was captured.
let _parseCalls = 0;
export function __parseCallCount(): number {
  return _parseCalls;
}
export function __resetParseCallCount(): void {
  _parseCalls = 0;
}

export function parser(
  source: string,
  renderer: (nodes: unknown[]) => React.ReactElement,
  _markdownIt: unknown,
): React.ReactElement {
  _parseCalls++;
  return renderer([{ key: 'stub-text', content: source }]);
}

// Test helper: the rules and merged styles of the renderer that most recently
// RENDERED (a cached renderer is reused across mounts, so construction alone
// would name a stale one) — i.e. the rules and styles it was handed — what the real library would paint every node with. The stub
// never parses real markdown, so this is how a test reaches the table styles
// and rules ChatMarkdown supplies.
let _lastRenderer: { rules: RenderRules; style: Record<string, Record<string, unknown>> } | null =
  null;
export function __lastRenderer(): {
  rules: RenderRules;
  style: Record<string, Record<string, unknown>>;
} {
  if (!_lastRenderer) throw new Error('no AstRenderer has been built');
  return _lastRenderer;
}

export class AstRenderer {
  private renderRulesArg: RenderRules;
  private styleArg: unknown;

  constructor(renderRulesArg: RenderRules, styleArg: unknown, ..._rest: unknown[]) {
    this.renderRulesArg = renderRulesArg;
    this.styleArg = styleArg;
  }

  render = (nodes: unknown[]): React.ReactElement => {
    _lastRenderer = {
      rules: this.renderRulesArg,
      style: this.styleArg as Record<string, Record<string, unknown>>,
    };
    const node = nodes[0] as { key: string; content: React.ReactNode };
    const textRule = this.renderRulesArg['text'];
    if (textRule) {
      return textRule(node as never, [], [], this.styleArg, {}) as React.ReactElement;
    }
    return React.createElement('Markdown', { style: this.styleArg }, node.content);
  };
}
