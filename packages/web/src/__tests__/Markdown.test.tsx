import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import hljs from 'highlight.js';
import type { JSX } from 'react';
import {
  Markdown,
  useStreamingMarkdownText,
  __markdownCacheSizesForTest,
  __resetMarkdownCachesForTest,
} from '../components/Markdown.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // The render + highlight caches are module-level singletons (that's the
  // point — they survive a remount), so a test that mocks `hljs.highlight` or
  // counts its calls needs each content string treated as unseen, same as
  // every other test in this file.
  __resetMarkdownCachesForTest();
});

describe('Markdown', () => {
  it('renders bold, inline code and lists', () => {
    const { container } = render(
      <Markdown content={'Here is **bold** and `inline`:\n- one\n- two'} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('.md-inline-code')?.textContent).toBe('inline');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('syntax-highlights fenced code blocks with a known language', () => {
    const { container } = render(<Markdown content={'```js\nconst x = 42;\n```'} />);
    const pre = container.querySelector('.md-pre');
    expect(pre).not.toBeNull();
    const code = container.querySelector('code.hljs');
    expect(code).not.toBeNull();
    expect(code?.className).toContain('language-js');
    // highlight.js wraps tokens in hljs-* spans.
    expect(container.querySelectorAll('[class^="hljs-"]').length).toBeGreaterThan(0);
  });

  it('falls back to highlightAuto for an unrecognised fenced language', () => {
    const { container } = render(<Markdown content={'```notareallang\nsome text\n```'} />);
    const code = container.querySelector('code.hljs');
    expect(code).not.toBeNull();
    expect(code?.className).toContain('language-notareallang');
  });

  it('renders a multi-line block with no language marker at all (bare fence)', () => {
    const { container } = render(<Markdown content={'```\nline one\nline two\n```'} />);
    const code = container.querySelector('code.hljs');
    expect(code).not.toBeNull();
    // No `language-` class when the fence carries no language hint.
    expect(code?.className.trim()).toBe('hljs');
  });

  it('handles a completely empty fenced code block without throwing', () => {
    const { container } = render(<Markdown content={'```\n```'} />);
    expect(container).toBeTruthy();
  });

  it('falls back to escaped source when the highlighter itself throws', () => {
    vi.spyOn(hljs, 'highlight').mockImplementation(() => {
      throw new Error('boom');
    });
    const { container } = render(<Markdown content={'```js\n<script>&"\n```'} />);
    const code = container.querySelector('code.hljs');
    expect(code).not.toBeNull();
    expect(code!.innerHTML).toContain('&lt;script&gt;');
    expect(code!.innerHTML).toContain('&amp;');
  });

  // spec/14 § Message links — the preview toggle icon rides alongside a link,
  // without disturbing the link's own href/navigation.
  it('adds a preview toggle next to an http(s) link', () => {
    const { container, getByRole } = render(
      <Markdown content={'see https://example.com/article for more'} />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/article');
    expect(getByRole('button', { name: /preview link/i })).toBeTruthy();
  });

  // spec/14 § Main chat panel — a fenced code block carries a copy control.
  describe('the code block copy button', () => {
    function stubClipboard(writeText: (t: string) => Promise<void>): void {
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    }

    it('puts a copy button on a fenced code block', () => {
      const { getByTestId } = render(<Markdown content={'```js\nconst x = 42;\n```'} />);
      expect(getByTestId('code-copy')).toBeTruthy();
    });

    it('puts no copy button on inline code', () => {
      const { queryByTestId } = render(<Markdown content={'a `bit` of code'} />);
      expect(queryByTestId('code-copy')).toBeNull();
    });

    it('copies the block source — no highlighting markup, no fence', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      const { getByTestId } = render(
        <Markdown content={'```js\nconst x = 42;\nconst y = x + 1;\n```'} />,
      );
      await act(async () => {
        getByTestId('code-copy').click();
      });
      expect(writeText).toHaveBeenCalledWith('const x = 42;\nconst y = x + 1;\n');
    });

    it('confirms the copy on the button itself, then settles back', async () => {
      vi.useFakeTimers();
      try {
        stubClipboard(vi.fn().mockResolvedValue(undefined));
        const { getByTestId } = render(<Markdown content={'```\nhello\n```'} />);
        const btn = getByTestId('code-copy');
        expect(btn.getAttribute('data-state')).toBe('idle');
        await act(async () => {
          btn.click();
        });
        expect(btn.getAttribute('data-state')).toBe('copied');
        expect(btn.getAttribute('title')).toBe('Copied');
        await act(async () => {
          vi.advanceTimersByTime(2500);
        });
        expect(btn.getAttribute('data-state')).toBe('idle');
        expect(btn.getAttribute('title')).toBe('Copy');
      } finally {
        vi.useRealTimers();
      }
    });

    it('says so loudly when the clipboard write fails — never a silent no-op', async () => {
      stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
      const { getByTestId } = render(<Markdown content={'```\nhello\n```'} />);
      await act(async () => {
        getByTestId('code-copy').click();
      });
      await waitFor(() => {
        expect(getByTestId('code-copy').getAttribute('data-state')).toBe('failed');
      });
      expect(getByTestId('code-copy').getAttribute('title')).toBe('Copy failed');
    });

    it('reports a failure when the browser exposes no clipboard at all', async () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
      const { getByTestId } = render(<Markdown content={'```\nhello\n```'} />);
      await act(async () => {
        getByTestId('code-copy').click();
      });
      await waitFor(() => {
        expect(getByTestId('code-copy').getAttribute('data-state')).toBe('failed');
      });
    });

    it('gives each block its own button and its own copied state', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      const { getAllByTestId } = render(<Markdown content={'```\none\n```\n\n```\ntwo\n```'} />);
      const btns = getAllByTestId('code-copy');
      expect(btns).toHaveLength(2);
      await act(async () => {
        btns[1]!.click();
      });
      expect(writeText).toHaveBeenCalledWith('two\n');
      expect(btns[0]!.getAttribute('data-state')).toBe('idle');
      expect(btns[1]!.getAttribute('data-state')).toBe('copied');
    });
  });

  it('does not add a preview toggle next to a mailto link', () => {
    const { container, queryByTestId } = render(
      <Markdown content={'[email me](mailto:tom@example.com)'} />,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe('mailto:tom@example.com');
    expect(queryByTestId('link-preview-toggle')).toBeNull();
  });

  // Todoist: "Patch back button is really slow" — navigating away from a chat
  // and back unmounts and remounts its whole transcript, which used to rerun
  // every message's markdown parse and syntax highlight from scratch even
  // though the content hadn't changed (spec/14 § Main chat panel). These cover
  // the fix: identical content across two mounts is cheap AND still behaves
  // like a fresh one, not a stale copy of the first.
  describe('caching across a remount (chat switch, then Back)', () => {
    const CONTENT = '```js\nconst x = 42;\n```';

    it('does not re-run remark/highlight.js for content already rendered once', () => {
      const highlightSpy = vi.spyOn(hljs, 'highlight');
      const { unmount } = render(<Markdown content={CONTENT} />);
      expect(highlightSpy).toHaveBeenCalledTimes(1);
      unmount();

      // A second, independent mount — same as reopening a chat that's still
      // held in the store after navigating away and clicking Back.
      render(<Markdown content={CONTENT} />);
      expect(highlightSpy).toHaveBeenCalledTimes(1);
    });

    it('still highlights DIFFERENT content normally — the cache is keyed, not a blanket skip', () => {
      const highlightSpy = vi.spyOn(hljs, 'highlight');
      render(<Markdown content={CONTENT} />);
      render(<Markdown content={'```js\nconst y = 43;\n```'} />);
      expect(highlightSpy).toHaveBeenCalledTimes(2);
    });

    it('gives a remounted code block a fresh, independent copy button', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

      const first = render(<Markdown content={CONTENT} />);
      await act(async () => {
        first.getByTestId('code-copy').click();
      });
      expect(first.getByTestId('code-copy').getAttribute('data-state')).toBe('copied');
      first.unmount();

      // The cached tree still mounts a genuinely fresh `CodeBlock` — its own
      // `useState('idle')` — rather than reusing the first mount's DOM/state.
      const second = render(<Markdown content={CONTENT} />);
      expect(second.getByTestId('code-copy').getAttribute('data-state')).toBe('idle');
      await act(async () => {
        second.getByTestId('code-copy').click();
      });
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(second.getByTestId('code-copy').getAttribute('data-state')).toBe('copied');
    });

    it('still shows the escaped-source fallback on a remount if highlighting fails', () => {
      // A content string that fails the highlighter must reach the fallback
      // path on every remount, since the render cache stores a fully-built
      // tree per content string — this proves that tree is really the escaped
      // fallback, not something a shared cache quietly upgraded on a re-look.
      const failingContent = '```js\n<script>&"\n```';
      vi.spyOn(hljs, 'highlight').mockImplementation(() => {
        throw new Error('boom');
      });
      const first = render(<Markdown content={failingContent} />);
      expect(first.container.querySelector('code.hljs')!.innerHTML).toContain('&lt;script&gt;');
      first.unmount();
      const second = render(<Markdown content={failingContent} />);
      expect(second.container.querySelector('code.hljs')!.innerHTML).toContain('&lt;script&gt;');
    });
  });

  // THE LOCK-UP. A streaming bubble re-renders on every coalesced frame, and
  // markdown has no incremental parse, so each frame re-parses the whole
  // message and re-highlights every code block in it. Measured on this
  // component: 11.9 ms/frame for a 14 KB reply, 68.2 ms at 86 KB — at 60 Hz
  // that demands more than a second of work per second of streaming, and the
  // window stops answering the keyboard for as long as the agent is talking.
  // Worse, every one of those intermediate trees was CACHED: 159 MB retained
  // after one 86 KB reply, which is what eventually killed the renderer
  // (20 Oilpan-exhaustion crashes in the four days to 6 Oct 2026).
  describe('streaming content is not cached', () => {
    it('keeps NOTHING for the frames of a message still arriving', () => {
      // One reply streaming in, a frame at a time. Nothing will ever ask for
      // any of these prefixes again in life — the next frame's string is one
      // character longer and a different key — so every one of them used to be
      // a full parsed tree retained for nothing.
      const full = 'Some prose, then:\n\n```js\nconst x = 42;\n```\n';
      for (let i = 1; i <= full.length; i += 3) {
        render(<Markdown content={full.slice(0, i)} streaming />);
        cleanup();
      }
      expect(__markdownCacheSizesForTest().renderEntries).toBe(0);
      expect(__markdownCacheSizesForTest().renderBytes).toBe(0);
    });

    it('keeps exactly ONE entry for the message once it settles', () => {
      const full = 'Some prose, then:\n\n```js\nconst x = 42;\n```\n';
      for (let i = 1; i <= full.length; i += 3) {
        render(<Markdown content={full.slice(0, i)} streaming />);
        cleanup();
      }
      render(<Markdown content={full} />);
      expect(__markdownCacheSizesForTest().renderEntries).toBe(1);
    });

    it('still caches the SETTLED message, which is what the cache is for', () => {
      const highlightSpy = vi.spyOn(hljs, 'highlight');
      const settled = '```js\nconst x = 42;\n```';
      render(<Markdown content={settled} />);
      cleanup();
      render(<Markdown content={settled} />);
      expect(highlightSpy).toHaveBeenCalledTimes(1);
    });

    it('takes a cache HIT while streaming — a hit is free, it is the write that costs', () => {
      const highlightSpy = vi.spyOn(hljs, 'highlight');
      const content = '```js\nconst x = 42;\n```';
      render(<Markdown content={content} />);
      cleanup();
      render(<Markdown content={content} streaming />);
      expect(highlightSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('useStreamingMarkdownText', () => {
  function Harness({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
    return <span data-testid="out">{useStreamingMarkdownText(text, streaming)}</span>;
  }

  it('passes a settled message straight through, unchanged and undelayed', () => {
    const r = render(<Harness text="hello" streaming={false} />);
    expect(r.getByTestId('out').textContent).toBe('hello');
    r.rerender(<Harness text="hello there" streaming={false} />);
    expect(r.getByTestId('out').textContent).toBe('hello there');
  });

  it('holds an intermediate frame back rather than re-parsing on every one', () => {
    vi.useFakeTimers();
    try {
      const r = render(<Harness text="a" streaming />);
      // The first frame commits at once, then the budget applies.
      act(() => {
        r.rerender(<Harness text="ab" streaming />);
      });
      act(() => {
        r.rerender(<Harness text="abc" streaming />);
      });
      expect(r.getByTestId('out').textContent).not.toBe('abc');
      // ...and it is a DELAY, not a drop: the latest text arrives once the
      // budget has passed. A held frame that never landed would be a bubble
      // frozen mid-sentence.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(r.getByTestId('out').textContent).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits the final text the moment streaming ends, with no wait', () => {
    vi.useFakeTimers();
    try {
      const r = render(<Harness text="a" streaming />);
      act(() => {
        r.rerender(<Harness text="the whole reply" streaming />);
      });
      // Settled. Whatever the budget had left to run, the truth wins now —
      // a finished message must never show a stale prefix.
      act(() => {
        r.rerender(<Harness text="the whole reply" streaming={false} />);
      });
      expect(r.getByTestId('out').textContent).toBe('the whole reply');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Markdown chat links', () => {
  function renderLinked(content: string) {
    return render(
      <MemoryRouter initialEntries={['/chats/here']}>
        <Routes>
          <Route path="/chats/:chatId" element={<Markdown content={content} />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
  }
  function Where(): JSX.Element {
    return <span data-testid="where">{useLocation().pathname}</span>;
  }

  it.each([
    ['[other](/chats/abc-123)', '/chats/abc-123'],
    ['[other](patch://chats/abc-123)', '/chats/abc-123'],
  ])('renders %s as an in-app chat link without a web preview', (md, href) => {
    const { container, queryByTestId } = renderLinked(md);
    const a = container.querySelector('a[data-chat-link]');
    expect(a?.getAttribute('href')).toBe(href);
    expect(queryByTestId('link-preview-toggle')).toBeNull();
  });

  it('a plain click navigates in-app without a page load', () => {
    const { container, getByTestId } = renderLinked('[other](/chats/abc-123)');
    const a = container.querySelector('a[data-chat-link]') as HTMLAnchorElement;
    const notPrevented = fireEvent.click(a);
    expect(notPrevented).toBe(false);
    expect(getByTestId('where').textContent).toBe('/chats/abc-123');
  });

  it('leaves a modified click to the browser', () => {
    const { container } = renderLinked('[other](/chats/abc-123)');
    const a = container.querySelector('a[data-chat-link]') as HTMLAnchorElement;
    expect(fireEvent.click(a, { ctrlKey: true })).toBe(true);
  });

  it('does not treat an external chats URL as a chat link', () => {
    const { container } = renderLinked('[x](https://example.com/chats/abc)');
    expect(container.querySelector('a[data-chat-link]')).toBeNull();
  });

  it('a plain click on a root-relative path (a file path) stays in the SPA instead of loading the page', () => {
    const { container, getByTestId } = renderLinked('[s](/Users/tom/projects/x/SOURCES.md)');
    const a = container.querySelector('a[data-chat-link]') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(fireEvent.click(a)).toBe(false);
    expect(getByTestId('where').textContent).toBe('/Users/tom/projects/x/SOURCES.md');
  });

  it('leaves protocol-relative and external links alone', () => {
    const { container } = renderLinked('[a](//example.com/x) [b](https://example.com/x)');
    expect(container.querySelector('a[data-chat-link]')).toBeNull();
  });
});
