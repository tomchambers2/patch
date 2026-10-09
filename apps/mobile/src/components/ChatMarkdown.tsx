// Renders chat message text as Markdown on mobile (spec/15 § Chat detail:
// "Message text renders as Markdown … not raw asterisks/backticks"). Uses
// react-native-markdown-display (pure JS — no native module) so headings,
// bold/italic, inline + fenced code, lists and links render as real RN nodes.
//
// `color` is the base text colour so the same renderer works on both the
// ink-on-paper assistant bubble and the white-on-green user bubble.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  AstRenderer,
  MarkdownIt,
  parser as mdParser,
  removeTextStyleProps,
  renderRules as defaultRenderRules,
  styles as defaultMdStyles,
  type ASTNode,
  type RenderRules,
} from 'react-native-markdown-display';
import { fonts, radii, space, useTheme } from '../lib/theme';

// The library's default `text`/`code_inline`/`code_block`/`fence` rules render
// a plain `<Text>` with no way to set RN's `selectable` (a component prop, not
// a style), so those four leaf rules are overridden here to carry it. Trims a
// trailing parser newline off code blocks/fences, matching the library's own
// default rule.
//
// The chat transcript renders with `selectable={false}` (spec/15 § Chat
// detail — Copying message text): a selectable leaf swallows the long-press
// that opens Copy text / Select text, and Android selection can't cross from
// one leaf to the next anyway, so partial selection lives in the full-screen
// select view (components/MessageActions.tsx), not in the bubble.
function trimTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content.slice(0, -1) : content;
}
function leafRules(selectable: boolean): RenderRules {
  return {
    // Every other BODY row takes the stripe fill (spec/14 § Theming → Tables);
    // `node.index` is the row's position among its siblings, and the header
    // row is already set apart by its own fill.
    tr: (node, children, parent, styles) => (
      <View
        key={node.key}
        style={[
          styles._VIEW_SAFE_tr,
          parent[0]?.type === 'tbody' && node.index % 2 === 1 ? styles._VIEW_SAFE_tr_stripe : null,
        ]}
      >
        {children}
      </View>
    ),
    text: (node: ASTNode, _children, _parent, styles, inheritedStyles = {}) => (
      <Text key={node.key} selectable={selectable} style={[inheritedStyles, styles.text]}>
        {node.content}
      </Text>
    ),
    code_inline: (node: ASTNode, _children, _parent, styles, inheritedStyles = {}) => (
      <Text key={node.key} selectable={selectable} style={[inheritedStyles, styles.code_inline]}>
        {node.content}
      </Text>
    ),
    code_block: (node: ASTNode, _children, _parent, styles, inheritedStyles = {}) => (
      <Text key={node.key} selectable={selectable} style={[inheritedStyles, styles.code_block]}>
        {trimTrailingNewline(node.content)}
      </Text>
    ),
    fence: (node: ASTNode, _children, _parent, styles, inheritedStyles = {}) => (
      <Text key={node.key} selectable={selectable} style={[inheritedStyles, styles.fence]}>
        {trimTrailingNewline(node.content)}
      </Text>
    ),
  };
}

// ── Real caching, not a component wrapper ──────────────────────────────────
//
// `<Markdown>` is `React.memo`'d, but memo only skips re-render for an
// ALREADY-MOUNTED instance with unchanged props — it does nothing for a
// fresh mount, which is what "leave a chat, come back" always produces
// (react-navigation unmounts a popped screen; that's the platform, not a
// bug of ours). Wrapping a cached RESULT in `<Markdown>` again — tried
// first — doesn't help either: React still calls `Markdown`'s own render
// body (a full markdown-it parse + AST-to-element walk) on every fresh
// mount, no matter whose element object is sitting above it.
//
// The only way to actually skip that work on a repeat view is to cache what
// `Markdown` produces INSTEAD of the component — call its own pipeline
// directly and keep the finished element. `parser`, `AstRenderer`,
// `renderRules`, `MarkdownIt`, `styles` and `removeTextStyleProps` are all
// genuine top-level exports of the library (its own index.js
// `export {...}` block — types/react-native-markdown-display.d.ts fills in
// two of them the package's own .d.ts omits, and fixes `AstRenderer`'s
// constructor arity, which is also wrong there). This is the library's
// public surface, not its internals — `Markdown` itself is built from
// exactly these same pieces (see its index.js `getRenderer`/`getStyle`,
// reproduced below).
//
// One shared markdown-it instance: parsing doesn't depend on style, so
// there's no reason to build a fresh parser per message. `Markdown` itself
// does, incidentally — its `markdownit` prop defaults to a freshly
// constructed one on every render it isn't given — but that's the library
// being slightly wasteful under its own component API, not something this
// direct path needs to copy.
const markdownIt = MarkdownIt({ typographer: true });

// Reproduces `getStyle` from the library's index.js (not itself exported —
// these ~15 lines are the whole of it): merge OUR style keys over the
// library's own defaults, then derive the `_VIEW_SAFE_*` variants
// `AstRenderer` needs for its View-vs-Text style split.
function buildMergedStyles(style: Record<string, object>): Record<string, object> {
  const merged: Record<string, object> = {};
  for (const key of Object.keys(style)) {
    merged[key] = { ...(StyleSheet.flatten(style[key]) as object) };
  }
  for (const key of Object.keys(defaultMdStyles)) {
    merged[key] = {
      ...defaultMdStyles[key],
      ...(StyleSheet.flatten(style[key]) as object),
    };
  }
  for (const key of Object.keys(merged)) {
    merged[`_VIEW_SAFE_${key}`] = removeTextStyleProps(merged[key] as object);
  }
  return StyleSheet.create(merged);
}

// `Markdown`'s default image/renderer knobs (index.js's own defaults for the
// props ChatMarkdown never sets) — kept identical so the built renderer
// behaves exactly as `<Markdown style rules>{content}</Markdown>` would.
const DEFAULT_ALLOWED_IMAGE_HANDLERS = [
  'data:image/png;base64',
  'data:image/gif;base64',
  'data:image/jpeg;base64',
  'https://',
  'http://',
];
const topLevelMaxExceededItem = <Text key="dotdotdot">...</Text>;

// The library's own .d.ts declares `AstRenderer`'s constructor as
// `(renderRules, style?)` — two params — but the real (pinned 7.0.2) class
// takes eight, and `Markdown` itself always constructs one with all eight
// (index.js `getRenderer`). TS declaration merging can't widen an existing
// class constructor (tried in types/react-native-markdown-display.d.ts,
// silently lost to the original), so the real arity is typed once here,
// locally, rather than reached past with a cast at every call site.
type AstRendererCtor = new (
  renderRules: RenderRules,
  style: unknown,
  onLinkPress: ((url: string) => boolean) | undefined,
  maxTopLevelChildren: number | null,
  topLevelMaxExceededItem: React.ReactNode,
  allowedImageHandlers: string[],
  defaultImageHandler: string,
  debugPrintTree: boolean,
) => AstRenderer;
const FullAstRenderer = AstRenderer as unknown as AstRendererCtor;

// One `AstRenderer` per distinct (style, rules) combination — in practice
// two: the ink-on-paper assistant bubble and the white-on-green user one.
// Unbounded is fine: this is bounded by how many distinct THEMES × bubble
// colours exist, not by how many messages there are.
const rendererCache = new Map<string, AstRenderer>();

function rendererFor(
  variantKey: string,
  style: Record<string, object>,
  selectable: boolean,
): AstRenderer {
  const existing = rendererCache.get(variantKey);
  if (existing) return existing;
  const renderer = new FullAstRenderer(
    { ...defaultRenderRules, ...leafRules(selectable) },
    buildMergedStyles(style),
    undefined,
    null,
    topLevelMaxExceededItem,
    DEFAULT_ALLOWED_IMAGE_HANDLERS,
    'https://',
    false,
  );
  rendererCache.set(variantKey, renderer);
  return renderer;
}

// The actual expensive step — markdown-it parse + AST build + AST-to-element
// walk — cached by content AND style variant. A message rendered once (this
// app session) is never reparsed again, regardless of how many times its
// containing screen mounts and unmounts: this is what "revisiting a chat is
// instant" (spec/15) actually requires, not a hide-the-cost trick.
//
// Capped so a long-running session doesn't accumulate one entry per message
// ever seen; FIFO on a Map (insertion order) is enough — this is a "don't
// redo work already done this session" cache, not an LRU trying to guess
// what's worth keeping.
const RENDER_CACHE_LIMIT = 2000;
const renderCache = new Map<string, React.ReactElement>();

// `parser`'s own .d.ts declares its renderer param as `(node: ASTNode) =>
// View` — but `parser` always calls it with the whole AST ARRAY
// (`tokensToAST` returns `ASTNode[]`, passed straight to `renderer(...)`),
// matching what `AstRenderer.render` actually accepts
// (`ReadonlyArray<any>`), not a single node. Typed once here rather than
// cast at the call site.
type MarkdownParserFn = (
  source: string,
  renderer: AstRenderer['render'],
  markdownIt: unknown,
) => React.ReactElement;
const parseMarkdown = mdParser as unknown as MarkdownParserFn;

function renderMarkdownCached(
  content: string,
  variantKey: string,
  style: Record<string, object>,
  selectable: boolean,
): React.ReactElement {
  const cacheKey = `${variantKey}\u0000${content}`;
  const cached = renderCache.get(cacheKey);
  if (cached) return cached;
  const renderer = rendererFor(variantKey, style, selectable);
  const element = parseMarkdown(content, renderer.render, markdownIt);
  if (renderCache.size >= RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  renderCache.set(cacheKey, element);
  return element;
}

export function ChatMarkdown({
  content,
  color,
  onGreen = false,
  selectable = true,
}: {
  content: string;
  color: string;
  onGreen?: boolean;
  /** Leaf text takes the OS selection long-press (see `leafRules`). */
  selectable?: boolean;
}): React.ReactElement {
  const colors = useTheme();
  // Code backgrounds differ by ground: a soft hairline tint on the page, a
  // translucent wash on a solid accent fill so code stays legible either way.
  const codeBg = onGreen ? colors.codeOnAccent : colors.lineSoft;
  const blockBg = onGreen ? colors.codeOnAccent : colors.paperRaised;
  const codeFg = onGreen ? colors.onAccent : colors.ink2;
  const styles = {
    body: { color, fontSize: 16, fontFamily: fonts.body },
    paragraph: { marginTop: 0, marginBottom: space.sm, color },
    strong: { fontFamily: fonts.bodyBold, color },
    em: { fontStyle: 'italic' as const, color },
    heading1: { color, fontFamily: fonts.bodyBold, fontSize: 20, marginBottom: 4 },
    heading2: { color, fontFamily: fonts.bodyBold, fontSize: 18, marginBottom: 4 },
    heading3: { color, fontFamily: fonts.bodyBold, fontSize: 16, marginBottom: 4 },
    bullet_list: { marginBottom: 4 },
    ordered_list: { marginBottom: 4 },
    list_item: { color, flexDirection: 'row' as const },
    link: {
      color: onGreen ? colors.onAccent : colors.leaf,
      textDecorationLine: 'underline' as const,
    },
    code_inline: {
      fontFamily: fonts.mono,
      fontSize: 13,
      color: codeFg,
      backgroundColor: codeBg,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    code_block: {
      fontFamily: fonts.mono,
      fontSize: 13,
      color: codeFg,
      backgroundColor: blockBg,
      borderWidth: 1,
      borderColor: colors.lineSoft,
      borderRadius: radii.md,
      padding: space.md,
    },
    table: { borderWidth: 1, borderColor: colors.tableLine, borderRadius: radii.sm / 2 },
    thead: { backgroundColor: colors.tableHead },
    tr: { borderBottomWidth: 1, borderColor: colors.tableLine, flexDirection: 'row' as const },
    tr_stripe: { backgroundColor: colors.tableStripe },
    fence: {
      fontFamily: fonts.mono,
      fontSize: 13,
      color: codeFg,
      backgroundColor: blockBg,
      borderWidth: 1,
      borderColor: colors.lineSoft,
      borderRadius: radii.md,
      padding: space.md,
    },
  };
  // Every input that changes what gets rendered, joined with a separator
  // that can't appear inside any of them (colours are hex/rgba strings) — a
  // theme switch (light/dark) changes `colors.*` and so correctly misses
  // the cache rather than serving stale colours from the other theme.
  const variantKey = `${color}\u0000${onGreen}\u0000${codeBg}\u0000${blockBg}\u0000${codeFg}\u0000${colors.tableLine}\u0000${selectable}`;
  return renderMarkdownCached(content, variantKey, styles, selectable);
}
