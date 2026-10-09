// Markdown — renders chat message content as markdown with syntax-highlighted
// code blocks (spec/14 ## Main chat panel: "markdown rendered, code blocks
// syntax-highlighted").
//
// react-markdown handles the markdown → React tree; highlight.js colours fenced
// code blocks. We highlight via a `code` component override so we control the
// language detection + the `hljs` class scope. The highlight.js theme is loaded
// once in index.css.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { Check, Copy, X } from 'lucide-react';
import { LinkPreviewToggle } from './LinkPreview.js';
import { SkillRef, SKILL_HREF_PREFIX } from './SkillRef.js';

// react-markdown's `components` map supplies the `code`/`pre`/`a` overrides as
// the ELEMENT TYPE for those tags — react-markdown (and the cached tree below)
// only builds the element descriptor; React itself calls `code()` later, once
// per actual mount. So caching the tree does not save a highlight.js re-run on
// a remount, only the caching HERE does: keyed on the same (text, lang) that
// determines the output, unaffected by which chat or how many times it mounts.
const highlightCache = new Map<string, string>();
const HIGHLIGHT_CACHE_LIMIT = 2000;
/**
 * And a BYTE budget, because an entry limit alone does not bound memory.
 *
 * Every entry is keyed by the whole code block, so the cost of 2000 entries is
 * however big 2000 code blocks happen to be — and a STREAMING code block
 * arrives as a new, one-character-longer block on every coalesced frame, so one
 * 20 KB block being streamed inserts a few hundred near-identical copies of
 * itself. Measured at 159 MB retained for a single 86 KB reply. Both caches
 * now evict on whichever limit bites first.
 */
const HIGHLIGHT_CACHE_BYTE_LIMIT = 4 * 1024 * 1024;
let highlightCacheBytes = 0;

function highlightCached(text: string, lang: string | undefined): string {
  const key = `${lang ?? ''}\u0000${text}`;
  const hit = highlightCache.get(key);
  if (hit !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, hit);
    return hit;
  }
  let html: string;
  try {
    html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang }).value
        : hljs.highlightAuto(text).value;
  } catch {
    // NO silent corruption: on a highlighter error fall back to the
    // escaped source so the code is still readable + visible.
    html = escapeHtml(text);
  }
  highlightCache.set(key, html);
  highlightCacheBytes += key.length + html.length;
  while (
    highlightCache.size > HIGHLIGHT_CACHE_LIMIT ||
    (highlightCacheBytes > HIGHLIGHT_CACHE_BYTE_LIMIT && highlightCache.size > 1)
  ) {
    const oldest = highlightCache.keys().next().value;
    if (oldest === undefined) break;
    highlightCacheBytes -= oldest.length + (highlightCache.get(oldest)?.length ?? 0);
    highlightCache.delete(oldest);
  }
  return html;
}

// A link to another chat: `/chats/<id>` (same-origin path) or `patch://chats/<id>`
// (the scheme the mobile app also opens). Normalised to the in-app path.
const CHAT_LINK = /^(?:patch:\/\/|\/)chats\/([^/?#\s]+)$/;
function chatLinkPath(href: string | undefined): string | null {
  const m = href ? CHAT_LINK.exec(href) : null;
  if (!m || m[1] === 'new') return null;
  return `/chats/${m[1]}`;
}

// A plain click moves to the chat inside the SPA (no reload); a modified
// click or middle click keeps the browser's own new-tab meaning.
function ChatLink({ path, children }: { path: string; children: unknown }): JSX.Element {
  const navigate = useNavigate();
  return (
    <a
      href={path}
      data-chat-link=""
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(path);
      }}
    >
      {children as JSX.Element}
    </a>
  );
}

const components = {
  code({ className, children, ...props }: { className?: string; children?: unknown }) {
    const text = String(children ?? '');
    // Fenced block: className like `language-ts`. Inline code has no
    // language and (in our content) no newline.
    const match = /language-(\w+)/.exec(className ?? '');
    const isBlock = match !== null || text.includes('\n');
    if (!isBlock) {
      return (
        <code className="md-inline-code" {...props}>
          {children as JSX.Element}
        </code>
      );
    }
    const lang = match?.[1];
    const html = highlightCached(text, lang);
    return (
      <CodeBlock source={text} className={`hljs ${lang ? `language-${lang}` : ''}`} html={html} />
    );
  },
  // react-markdown wraps a fenced block's `code` in its own `pre`, and
  // the block above already brings its own. Unwrap it so the copy
  // button's positioning container is a div rather than a second pre
  // (a div inside a pre is invalid, and inherits `white-space: pre`).
  pre({ children }: { children?: unknown }) {
    return <>{children as JSX.Element}</>;
  },
  // A link gets an icon that expands an inline mini-preview next to
  // it (spec/14 § Message links) — the link itself still navigates
  // normally.
  a({ href, children, ...props }: { href?: string; children?: unknown }) {
    if (href?.startsWith(SKILL_HREF_PREFIX))
      return <SkillRef name={href.slice(SKILL_HREF_PREFIX.length)} />;
    const chatPath = chatLinkPath(href);
    if (chatPath) return <ChatLink path={chatPath}>{children}</ChatLink>;
    // Any other root-relative href (e.g. a file path an agent wrote as a link)
    // resolves against the app origin. A real page load of it hits the server's
    // 404 and replaces the whole app, so route it through the SPA instead.
    if (href && href.startsWith('/') && !href.startsWith('//')) {
      return <ChatLink path={href}>{children}</ChatLink>;
    }
    return (
      <>
        <a href={href} {...props}>
          {children as JSX.Element}
        </a>
        {href ? <LinkPreviewToggle url={href} /> : null}
      </>
    );
  },
  // A table is centred on the panel rather than the reading column, so one
  // wider than the measure spills into both gutters evenly (spec/14 § Wide
  // tables). The wrapper is the box that spans the panel; the table centres
  // inside it with auto margins.
  table({ children, ...props }: { children?: unknown }) {
    return (
      <div className="md-table-wrap">
        <table {...props}>{children as JSX.Element}</table>
      </div>
    );
  },
};

// The built element tree, keyed on the raw markdown string. Content is
// immutable once streamed (spec/14 § Main chat panel), so the tree for a
// given string is the same every time — but going through `<ReactMarkdown>`
// as JSX only defers the actual parse (remark → mdast → hast → jsx) to
// whenever React mounts that element, so a per-render `useMemo` buys nothing
// across a REMOUNT: switching chats and coming back throws the previous
// mount away, and the next one reruns the full parse + highlight.js pass on
// content that hasn't changed (confirmed by CPU profile — react-markdown/
// micromark internals dominate a Back navigation into a long chat).
// `ReactMarkdown`'s default export (unlike `MarkdownHooks`/`MarkdownAsync`)
// is a synchronous, hook-free, context-free function — calling it directly
// instead of mounting it via JSX runs the parse ONCE here and caches its
// output tree, which still contains real `<CodeBlock>`/`<a>` elements that
// mount normally (with working state) wherever React puts them.
const RENDER_CACHE_LIMIT = 1000;
/**
 * A byte budget as well as an entry count, for the same reason as
 * `HIGHLIGHT_CACHE_BYTE_LIMIT`: 1000 entries is 1000 PARSED TREES, and the size
 * of one is the size of the message it came from. Measured at 116 MB retained
 * after streaming a single 43 KB reply, 159 MB for an 86 KB one. Charged by
 * source length, which is what the tree's size tracks and the only figure
 * available without walking it.
 */
const RENDER_CACHE_BYTE_LIMIT = 8 * 1024 * 1024;
const renderCache = new Map<string, JSX.Element>();
let renderCacheBytes = 0;

/** How long the last full parse took, for `useStreamingMarkdown`'s budget. */
let lastParseMs = 0;

/** @internal The cost of the most recent markdown parse, in ms. */
export function lastMarkdownParseMs(): number {
  return lastParseMs;
}

export function Markdown({
  content,
  /**
   * Is this content still arriving?
   *
   * It decides ONE thing: whether the parsed tree is worth keeping. The cache
   * exists so that re-MOUNTING immutable content (switching chats and coming
   * back) does not re-run the parse — and a streaming prefix is not immutable
   * and is never looked up again, because the next frame's string is one
   * character longer and a different key. So caching it is pure cost: a long
   * reply used to insert one full parsed tree per coalesced frame, churn the
   * whole 1000-entry cache every ~17 seconds, and hold hundreds of megabytes
   * of near-identical trees that nothing would ever read.
   *
   * Reads still hit: if the exact string IS cached (the final frame of a reply
   * that has since settled), that is a real hit and worth taking.
   */
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}): JSX.Element {
  const cached = renderCache.get(content);
  if (cached) {
    // Bump to most-recently-used: re-insert moves a key to the end of a Map's
    // iteration order, which is what the eviction below reads as "oldest".
    renderCache.delete(content);
    renderCache.set(content, cached);
    return cached;
  }
  // GFM = tables, strikethrough, task lists, autolinks. Without it the
  // agent's pipe-tables render as raw `| col | col |` text.
  const started = performance.now();
  const element = ReactMarkdown({
    remarkPlugins: [remarkGfm],
    components,
    urlTransform: (url) =>
      chatLinkPath(url) || url.startsWith(SKILL_HREF_PREFIX) ? url : defaultUrlTransform(url),
    children: content,
  }) as JSX.Element;
  lastParseMs = performance.now() - started;
  if (streaming) return element;
  renderCache.set(content, element);
  renderCacheBytes += content.length;
  while (
    renderCache.size > RENDER_CACHE_LIMIT ||
    (renderCacheBytes > RENDER_CACHE_BYTE_LIMIT && renderCache.size > 1)
  ) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break;
    renderCacheBytes -= oldest.length;
    renderCache.delete(oldest);
  }
  return element;
}

/**
 * The share of the main thread markdown re-parsing is allowed to take while a
 * message streams. At 1/4, a parse costing 60 ms earns a 240 ms gap after it.
 */
const STREAM_PARSE_DUTY = 0.25;
/** Never slower than this, so short messages still stream smoothly. */
const STREAM_MIN_INTERVAL_MS = 50;
/** Never slower than this, so a huge message still visibly moves. */
const STREAM_MAX_INTERVAL_MS = 500;

/**
 * The text to RENDER for a message that may still be arriving: the latest text,
 * but changing no more often than parsing it can afford.
 *
 * WHY THIS EXISTS. `chat.message_delta` frames are coalesced per animation
 * frame, so a streaming bubble re-rendered ~60 times a second — and because
 * markdown has no incremental parse, each of those re-parses the WHOLE message
 * from the start and re-highlights every code block in it. Measured on the real
 * component: 11.9 ms per frame for a 14 KB reply, 32.7 ms at 43 KB, 68.2 ms at
 * 86 KB (the cost is quadratic in the message, since it is paid per frame AND
 * grows with length). At 60 Hz that is 0.7–4 seconds of work demanded per
 * second of streaming: the main thread saturates, and the window stops
 * responding to input for as long as the agent is talking. Streaming one 86 KB
 * reply took 97 seconds of main thread.
 *
 * The interval is derived from the cost actually observed rather than fixed,
 * because the right rate depends entirely on the message: 60 Hz is fine for a
 * one-line reply and hopeless for an 86 KB one, and a constant that suits
 * either is wrong for the other.
 *
 * It only ever delays an INTERMEDIATE frame. The settled text is committed at
 * once when `streaming` goes false, so what a finished message shows is never
 * stale — the whole point is that nobody can tell, except that the window
 * still answers the keyboard.
 */
export function useStreamingMarkdownText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const committedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    // Settled, or nothing to hold back: show the truth now. This is also the
    // path every non-streaming message takes, so an ordinary transcript is
    // completely unaffected.
    if (!streaming || text === shown) {
      if (text !== shown) setShown(text);
      committedAt.current = performance.now();
      return;
    }
    const budget = Math.min(
      STREAM_MAX_INTERVAL_MS,
      Math.max(STREAM_MIN_INTERVAL_MS, lastMarkdownParseMs() / STREAM_PARSE_DUTY),
    );
    const due = committedAt.current + budget - performance.now();
    if (due <= 0) {
      committedAt.current = performance.now();
      setShown(text);
      return;
    }
    timer.current = window.setTimeout(() => {
      committedAt.current = performance.now();
      setShown(text);
    }, due);
    return () => window.clearTimeout(timer.current);
  }, [text, streaming, shown]);

  return shown;
}

// Test-only: both caches are module-level singletons, so a test relying on
// `hljs.highlight` actually running (a mocked throw, a call-count assertion)
// needs a clean slate — same reason `Sidebar.test.tsx` clears `localStorage`
// itself rather than trusting a global reset.
/** Test-only: what each cache is currently holding, for the bounds above. */
export function __markdownCacheSizesForTest(): {
  renderEntries: number;
  renderBytes: number;
  highlightEntries: number;
  highlightBytes: number;
} {
  return {
    renderEntries: renderCache.size,
    renderBytes: renderCacheBytes,
    highlightEntries: highlightCache.size,
    highlightBytes: highlightCacheBytes,
  };
}

export function __resetMarkdownCachesForTest(): void {
  renderCache.clear();
  highlightCache.clear();
  renderCacheBytes = 0;
  highlightCacheBytes = 0;
}

// spec/14 § Main chat panel — a fenced block carries an icon-only copy control
// in its corner. Its own component because it holds the confirmation state, and
// `Markdown` memoises the tree it sits in.
type CopyState = 'idle' | 'copied' | 'failed';

const COPY_STATES: Record<CopyState, { Icon: typeof Copy; label: string }> = {
  idle: { Icon: Copy, label: 'Copy' },
  copied: { Icon: Check, label: 'Copied' },
  failed: { Icon: X, label: 'Copy failed' },
};

/** How long the button holds its confirmation before settling back. */
const COPY_SETTLE_MS = 2000;

function CodeBlock({
  source,
  className,
  html,
}: {
  source: string;
  className: string;
  html: string;
}): JSX.Element {
  const [state, setState] = useState<CopyState>('idle');
  const settleTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  const copy = (): void => {
    const settle = (next: CopyState): void => {
      setState(next);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setState('idle'), COPY_SETTLE_MS);
    };
    // NO fallback path: a browser with no clipboard API, and a write the user
    // or the page's permissions refuse, both land on `failed` and say so on the
    // button — a copy that silently did nothing is the worst outcome here.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(source))
      .then(
        () => settle('copied'),
        () => settle('failed'),
      );
  };

  const { Icon, label } = COPY_STATES[state];
  return (
    <div className="md-code">
      <pre className="md-pre">
        <code
          className={className}
          // highlight.js returns sanitised HTML for the known grammar.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
      <button
        type="button"
        className="md-copy"
        data-testid="code-copy"
        data-state={state}
        title={label}
        aria-label={label}
        onClick={copy}
      >
        <Icon size={14} aria-hidden />
      </button>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
