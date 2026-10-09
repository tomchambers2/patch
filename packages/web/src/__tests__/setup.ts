// Vitest setup — jsdom + jest-dom matchers.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { useUiStore } from '../stores/uiStore.js';
import { useComposerAttachmentStore } from '../stores/composerAttachmentStore.js';

// Testing Library gives `waitFor` one second by default, which is a statement
// about how fast the machine is rather than about the behaviour under test. On
// a shared box running a queue of agents the render this suite is waiting on
// routinely takes longer than that, and the assertion fails having never been
// wrong. `retry: 2` (vitest.config.ts) was the first answer to this and is not
// enough on its own: at load ~15 on 8 cores every attempt is starved and the
// test loses all three. Widen the budget instead — a real failure still fails,
// it just gets a fair hearing first.
configure({ asyncUtilTimeout: 3_000 });

// jsdom ships no ResizeObserver. ChatRoute uses one to keep the chat stream
// pinned to the latest message as content height changes. Provide a no-op stub
// so components mount in tests (the layout-driven scroll behaviour itself is
// exercised against the real browser, not jsdom which has no layout engine).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// jsdom ships no `Element.scrollIntoView` either. The sidebar calls it to bring
// a just-expanded section (or a just-saved draft) into its scrolling band. Same
// deal as ResizeObserver: it is layout behaviour, asserted against a real
// browser (e2e/sidebar-scroll-band.spec.ts), and here it only needs to exist.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

afterEach(() => {
  cleanup();
  // Unsent attachments live in a module-level store keyed by chat.
  useComposerAttachmentStore.getState()._reset();
  // The file browser remembers where it was left — directory, open file, filter,
  // unsaved draft — per chat, in the ui store and in localStorage (spec/14
  // § File browser). Every test in a file shares one jsdom window and one store,
  // so a test that opens a file hands that file to the next test rendering the
  // same chat, and the next test then passes or fails on state it never set.
  // Reset it centrally: it is per-user state no test should inherit, and a test
  // that wants it asserts it by setting it.
  useUiStore.setState({ browseByChat: {} });
  localStorage.removeItem('patch.browse.byChat.v1');
});
