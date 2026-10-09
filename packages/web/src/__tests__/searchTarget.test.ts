// spec/14 § Reserved OS chords — resolving "the search field on this page"
// for ⌘K / ⌘F. The marker is an attribute, not a route list, so these tests
// build the DOM by hand: that IS the contract every search field opts into.

import { describe, it, expect, afterEach } from 'vitest';
import { findPageSearchInput, focusPageSearch } from '../lib/searchTarget.js';

function mount(html: string): void {
  document.body.innerHTML = html;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('findPageSearchInput', () => {
  it('returns null on a page with no marked field', () => {
    mount('<main><input id="not-search" /><textarea></textarea></main>');
    expect(findPageSearchInput()).toBeNull();
  });

  it('finds the one marked field', () => {
    mount('<main><input id="a" data-search-input /></main>');
    expect(findPageSearchInput()?.id).toBe('a');
  });

  it('prefers the main content area over the sidebar and the editor rail', () => {
    // The sidebar is first in DOM order, so this only passes on the rank.
    mount(`
      <aside id="sidebar"><input id="sb" data-search-input /></aside>
      <main><input id="main" data-search-input /></main>
      <aside id="rail"><input id="rail-filter" data-search-input /></aside>
    `);
    expect(findPageSearchInput()?.id).toBe('main');
  });

  it('falls back to a chrome field when the content area has none, in DOM order', () => {
    mount(`
      <aside id="sidebar"><input id="sb" data-search-input /></aside>
      <main><p>no search here</p></main>
      <aside id="rail"><input id="rail-filter" data-search-input /></aside>
    `);
    expect(findPageSearchInput()?.id).toBe('sb');
  });

  it('skips a marked field that is not on screen and takes the next one', () => {
    // e.g. the sidebar's archived search while that section is collapsed.
    mount(`
      <aside id="sidebar" style="display:none"><input id="sb" data-search-input /></aside>
      <main><input id="main" data-search-input /></main>
    `);
    expect(findPageSearchInput()?.id).toBe('main');
  });

  it('returns null when every marked field is hidden', () => {
    mount(`
      <aside style="display:none"><input id="sb" data-search-input /></aside>
      <main><input id="main" data-search-input hidden /></main>
      <div style="visibility:hidden"><input id="v" data-search-input /></div>
    `);
    expect(findPageSearchInput()).toBeNull();
  });
});

describe('focusPageSearch', () => {
  it('focuses and selects the field, and reports that it took the chord', () => {
    mount('<main><input id="a" data-search-input value="typed query" /></main>');
    const el = document.getElementById('a') as HTMLInputElement;
    expect(focusPageSearch()).toBe(true);
    expect(document.activeElement).toBe(el);
    // Selected, so typing replaces the previous query rather than appending.
    expect(el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)).toBe('typed query');
  });

  it('reports false, and moves focus nowhere, when the page has none', () => {
    mount('<main><input id="other" /></main>');
    const other = document.getElementById('other') as HTMLInputElement;
    other.focus();
    expect(focusPageSearch()).toBe(false);
    expect(document.activeElement).toBe(other);
  });
});

// The sidebar's global chat search is on screen on nearly every view. It answers
// ⌘K as a last resort, and never ⌘F — over a transcript that chord is the
// browser's find bar (spec/14 § Reserved OS chords).
describe('the global chat search field', () => {
  const GLOBAL =
    '<aside id="sidebar"><input id="global" data-search-input data-search-global /></aside>';

  it('is where ⌘K lands when the view has no field of its own', () => {
    mount(`${GLOBAL}<main><p>transcript</p></main>`);
    expect(findPageSearchInput('k')?.id).toBe('global');
    expect(focusPageSearch('k')).toBe(true);
  });

  it('is never where ⌘F lands, so the chord stays with the browser', () => {
    mount(`${GLOBAL}<main><p>transcript</p></main>`);
    expect(findPageSearchInput('f')).toBeNull();
    expect(focusPageSearch('f')).toBe(false);
  });

  it('loses ⌘K to any field the view offers, even one in a rail', () => {
    mount(
      `${GLOBAL}<main></main><aside id="rail"><input id="rail-filter" data-search-input /></aside>`,
    );
    expect(findPageSearchInput('k')?.id).toBe('rail-filter');
    expect(findPageSearchInput('f')?.id).toBe('rail-filter');
  });
});
