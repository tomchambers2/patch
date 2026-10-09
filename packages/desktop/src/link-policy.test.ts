// Unit tests for the link policy — spec/14 § "Links and the web panel".
//
// The rule that matters: the user CHOOSES where a link opens. A plain click
// opens it in Patch's own web panel; the browser's own "somewhere else"
// gestures (a modified click, `target="_blank"`, `window.open`) hand it to the
// real browser. Neither path may navigate the Patch SPA away, and neither may
// follow a non-http(s) scheme.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeLink, routeWindowOpen } from './link-policy';

const APP = 'http://localhost:3000';

test("a plain click on an external http(s) link opens Patch's own web panel", () => {
  assert.deepEqual(routeLink('https://example.com/thing', APP), {
    kind: 'panel',
    url: 'https://example.com/thing',
  });
  assert.deepEqual(routeLink('http://example.com/', APP), {
    kind: 'panel',
    url: 'http://example.com/',
  });
});

test('a same-origin URL is an ordinary in-app SPA navigation', () => {
  assert.deepEqual(routeLink('http://localhost:3000/app/chats/abc', APP), { kind: 'spa' });
});

test('a different port/host on the same scheme is a panel page (origin, not host, decides)', () => {
  assert.deepEqual(routeLink('http://localhost:4000/app', APP), {
    kind: 'panel',
    url: 'http://localhost:4000/app',
  });
});

test('non-http(s) schemes are blocked, never followed and never opened externally', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.com']) {
    assert.deepEqual(routeLink(url, APP), { kind: 'block' }, url);
  }
});

test('an unparseable URL is blocked (no crash, no navigation)', () => {
  assert.deepEqual(routeLink('not a url', APP), { kind: 'block' });
  assert.deepEqual(routeLink('', APP), { kind: 'block' });
});

test('about:blank is blocked, not followed', () => {
  assert.deepEqual(routeLink('about:blank', APP), { kind: 'block' });
});

test('a target=_blank / modified click on ANY http(s) URL opens the real browser', () => {
  // The other half of the choice (spec/14 § Links and the web panel): a
  // ⌘/Ctrl/Shift-click, a `target="_blank"` or a `window.open` is the
  // browser's own "open this somewhere else" gesture, and somewhere else means
  // the REAL browser — not the panel, and never a second Electron window. A
  // served attachment is same-origin and still leaves this way.
  assert.deepEqual(routeWindowOpen('http://localhost:3000/files/x.pdf'), {
    kind: 'external',
    url: 'http://localhost:3000/files/x.pdf',
  });
  assert.deepEqual(routeWindowOpen('https://example.com/x'), {
    kind: 'external',
    url: 'https://example.com/x',
  });
});

test('routeWindowOpen blocks non-http(s) and unparseable URLs', () => {
  assert.deepEqual(routeWindowOpen('file:///etc/passwd'), { kind: 'block' });
  assert.deepEqual(routeWindowOpen('javascript:alert(1)'), { kind: 'block' });
  assert.deepEqual(routeWindowOpen('nonsense'), { kind: 'block' });
});

test('the two paths disagree on purpose: same URL, panel in place, browser on a modified click', () => {
  // This is the whole feature in one assertion. Break it and the user loses one
  // of the two routes (spec/14 § Links and the web panel).
  const url = 'https://example.com/same';
  assert.equal(routeLink(url, APP).kind, 'panel');
  assert.equal(routeWindowOpen(url).kind, 'external');
});
