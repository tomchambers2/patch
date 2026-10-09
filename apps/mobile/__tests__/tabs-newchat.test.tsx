// The New chat tab, and the two things that made tapping it paint a blank
// screen (spec/15 § Navigation shell).
//
// 1. `<Redirect>` fires from `useFocusEffect`. A tab that stays focused after
//    the redirect fires it again — mount → replace → mount — until React gives
//    up with "Maximum update depth exceeded" and renders nothing. The loop also
//    wedged the whole UI, so no other tab responded either. The tab press is now
//    intercepted in `_layout.tsx` and the route file re-exports the flow, so
//    nothing here can bounce off itself.
// 2. A `(group)` segment is transparent in the URL, so `app/(tabs)/new-chat.tsx`
//    and `app/new-chat.tsx` both claimed `/new-chat`. The route-table test below
//    fails on ANY two files claiming one URL, not just that pair.

import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import NewChatTab from '../app/(tabs)/new';
import NewChat from '../app/new-chat';

const APP_DIR = fileURLToPath(new URL('../app', import.meta.url));

/** Every route file under app/, as a path relative to app/. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.startsWith('_')) {
      out.push(relative(APP_DIR, full));
    }
  }
  return out;
}

/**
 * The URL expo-router serves a route file at. Group segments `(x)` vanish, an
 * `index` file is its directory, and dynamic segments collapse to a wildcard so
 * `chats/[chatId]` and a hypothetical `chats/[id]` would read as one route.
 */
function urlPath(file: string): string {
  const segments = file
    .replace(/\.tsx?$/, '')
    .split('/')
    .filter((s) => !/^\(.*\)$/.test(s))
    .filter((s) => s !== 'index')
    .map((s) => (/^\[.*\]$/.test(s) ? '[param]' : s));
  return `/${segments.join('/')}`;
}

describe('the New chat tab route', () => {
  it('IS the new-chat flow, not a redirect that can bounce off itself', () => {
    expect(NewChatTab).toBe(NewChat);
  });

  it('does not sit at /new-chat — two files on one URL is how the loop started', () => {
    expect(urlPath('(tabs)/new.tsx')).not.toBe('/new-chat');
  });
});

describe('the route table', () => {
  it('never gives two files the same URL', () => {
    const byUrl = new Map<string, string[]>();
    for (const file of routeFiles(APP_DIR)) {
      const url = urlPath(file);
      byUrl.set(url, [...(byUrl.get(url) ?? []), file]);
    }
    const collisions = [...byUrl].filter(([, files]) => files.length > 1);
    expect(collisions).toEqual([]);
  });
});
