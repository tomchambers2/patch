// ChatMarkdown.tsx — real output caching, not a component-memo wrapper.
//
// `<Markdown>` is React.memo'd, which only skips re-render for an ALREADY-
// MOUNTED instance with unchanged props; it does nothing for a fresh mount,
// which is what "leave a chat, come back" always produces (react-navigation
// unmounts a popped screen). So ChatMarkdown calls the library's own
// pipeline (parser + AstRenderer) directly and keeps the finished element,
// rather than rendering <Markdown> and hoping something downstream is free.
// These tests count how many times the STUB's `parser`
// (__tests__/stubs/markdown-display.ts) actually runs, to prove that
// pipeline fires at most once per distinct (content, style) combination,
// however many times ChatMarkdown itself is mounted.

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderRN, hasText } from './testUtils/render';
import { ChatMarkdown } from '../src/components/ChatMarkdown';
import { __parseCallCount, __resetParseCallCount } from './stubs/markdown-display';

beforeEach(() => {
  __resetParseCallCount();
});

describe('ChatMarkdown — real output caching', () => {
  it('renders the message content', () => {
    const r = renderRN(<ChatMarkdown content="hello there" color="#111" />);
    expect(hasText(r.root, 'hello there')).toBe(true);
  });

  it('parses once for a fresh mount, and NOT again for a second, unrelated mount of the same content', () => {
    const first = renderRN(<ChatMarkdown content="repeat me" color="#111" />);
    expect(hasText(first.root, 'repeat me')).toBe(true);
    expect(__parseCallCount()).toBe(1);

    // A SEPARATE renderer instance, standing in for "the chat screen that
    // rendered this message was unmounted and a fresh one mounted later" —
    // the exact case a `React.memo` on the library's own component cannot
    // help with.
    const second = renderRN(<ChatMarkdown content="repeat me" color="#111" />);
    expect(hasText(second.root, 'repeat me')).toBe(true);
    expect(__parseCallCount()).toBe(1);
  });

  it('parses again for genuinely different content', () => {
    renderRN(<ChatMarkdown content="message A" color="#111" />);
    renderRN(<ChatMarkdown content="message B" color="#111" />);
    expect(__parseCallCount()).toBe(2);
  });

  it('parses again when the same content is styled differently (a theme or bubble-colour change), never serving the wrong variant', () => {
    const onInk = renderRN(<ChatMarkdown content="same text" color="#111" onGreen={false} />);
    expect(hasText(onInk.root, 'same text')).toBe(true);
    const onGreen = renderRN(<ChatMarkdown content="same text" color="#fff" onGreen={true} />);
    expect(hasText(onGreen.root, 'same text')).toBe(true);
    expect(__parseCallCount()).toBe(2);

    // Re-rendering either variant again hits its own cache entry, not the
    // other one's.
    const onInkAgain = renderRN(<ChatMarkdown content="same text" color="#111" onGreen={false} />);
    expect(hasText(onInkAgain.root, 'same text')).toBe(true);
    expect(__parseCallCount()).toBe(2);
  });

  it('an empty message still renders without throwing', () => {
    expect(() => renderRN(<ChatMarkdown content="" color="#111" />)).not.toThrow();
  });

  // A long-running session must not accumulate one cache entry per message
  // ever seen — capped, FIFO eviction (not an LRU trying to guess what's
  // worth keeping; see the constant's own comment).
  it('caps the cache and evicts the oldest entries once the limit is exceeded', () => {
    // Comfortably past RENDER_CACHE_LIMIT (2000), whatever this file's
    // earlier tests already left cached.
    for (let i = 0; i < 2500; i++) {
      renderRN(<ChatMarkdown content={`filler ${i}`} color="#111" />);
    }
    __resetParseCallCount();
    renderRN(<ChatMarkdown content="filler 0" color="#111" />);
    expect(__parseCallCount()).toBe(1); // evicted — had to reparse
    __resetParseCallCount();
    renderRN(<ChatMarkdown content="filler 2499" color="#111" />);
    expect(__parseCallCount()).toBe(0); // most recent — still warm
  });
});
