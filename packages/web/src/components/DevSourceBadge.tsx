// DevSourceBadge — a small marker in the sidebar brand row that makes it
// unmistakable that the app you're looking at is being served from the LOCAL
// vite dev server (i.e. the latest working-copy code), NOT the deployed
// production build.
//
// Gated on `import.meta.env.DEV`, which is true only when the bundle is served
// by `vite dev` (the local-review stack) and false in the Caddy-served
// production build. So the rule is simple and one-directional: if you can see
// this badge, you're on local-latest; if you can't, you're on production. It
// never ships in the production bundle.
//
// The label carries the served host (e.g. `localhost:5173`) and the full origin
// on hover, so "where is this served from?" is answerable at a glance.

import type { JSX } from 'react';

export function DevSourceBadge(): JSX.Element | null {
  if (!import.meta.env.DEV) return null;
  /* v8 ignore next 2 -- jsdom (the test environment) always defines `window`; this SSR/non-DOM guard cannot be exercised under vitest+jsdom. */
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <span
      className="dev-source-badge"
      data-testid="dev-source-badge"
      title={`Local review mode: ${origin}`}
    >
      <span className="dev-source-dot" aria-hidden="true" />
      {/* The label is its own element so it can ellipsise: the badge shares the
          brand row with the sidebar's collapse / new-window controls, and a
          bare text node in a flex container clips flush instead of truncating.
          Nothing is lost when it does — the `title` above carries the origin. */}
      <span className="dev-source-label">LOCAL · {host}</span>
    </span>
  );
}
