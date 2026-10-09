// Unit tests for the shared relative-time format.
//
// The version panel depends on this staying purely relative across every
// magnitude: "deployed 8d ago" next to "up 2h ago" is what makes a stale layer
// obvious at a glance, and an absolute date on one row would bury the contrast.

import { describe, it, expect } from 'vitest';
import { relativeIso, relativeTime } from '../lib/relativeTime.js';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const ago = (ms: number): number => NOW - ms;

describe('relativeTime', () => {
  it('collapses anything under a minute to "just now"', () => {
    expect(relativeTime(ago(0), { now: NOW })).toBe('just now');
    expect(relativeTime(ago(59_000), { now: NOW })).toBe('just now');
  });

  it('formats every magnitude relatively, up to years', () => {
    expect(relativeTime(ago(5 * 60_000), { now: NOW })).toBe('5m ago');
    expect(relativeTime(ago(3 * 3_600_000), { now: NOW })).toBe('3h ago');
    expect(relativeTime(ago(2 * 86_400_000), { now: NOW })).toBe('2d ago');
    expect(relativeTime(ago(10 * 86_400_000), { now: NOW })).toBe('1w ago');
    expect(relativeTime(ago(60 * 86_400_000), { now: NOW })).toBe('2mo ago');
    expect(relativeTime(ago(400 * 86_400_000), { now: NOW })).toBe('1y ago');
  });

  it('renders the 8-day staleness that went unnoticed in prod', () => {
    expect(relativeTime(ago(8 * 86_400_000), { now: NOW })).toBe('1w ago');
  });

  it('labels a future timestamp as scheduled by default (the jobs list)', () => {
    expect(relativeTime(NOW + 60_000, { now: NOW })).toBe('scheduled');
  });

  it('lets the version panel call trivial clock skew "just now" instead', () => {
    expect(relativeTime(NOW + 5_000, { now: NOW, futureLabel: 'just now' })).toBe('just now');
  });

  it('defaults `now` to the real clock', () => {
    expect(relativeTime(Date.now())).toBe('just now');
  });
});

describe('relativeIso', () => {
  it('formats an ISO instant', () => {
    expect(relativeIso('2026-07-28T09:00:00.000Z', { now: NOW })).toBe('3h ago');
  });

  it('renders a missing timestamp as "never" — never as a plausible time', () => {
    expect(relativeIso(null, { now: NOW })).toBe('never');
    expect(relativeIso(undefined, { now: NOW })).toBe('never');
  });

  it('accepts a caller-specific sentinel for "we have no stamp"', () => {
    expect(relativeIso(null, { now: NOW, neverLabel: 'unstamped' })).toBe('unstamped');
  });

  it('reports an unparseable timestamp as unknown rather than guessing', () => {
    expect(relativeIso('not-a-date', { now: NOW })).toBe('unknown');
  });

  it('treats a future ISO instant as clock skew', () => {
    expect(relativeIso('2026-07-28T12:00:30.000Z', { now: NOW })).toBe('just now');
  });
});
