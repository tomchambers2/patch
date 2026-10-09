// The running bundle must be able to say what it is.
//
// A bundle whose only identity was its content hash is why "which commit is this
// UI?" had no answer. These assert the `define`-injected literals actually reach
// runtime — if the vite/vitest `define` wiring regresses, importing this module
// throws ReferenceError and this test is the thing that catches it.

import { describe, it, expect } from 'vitest';
import { BUILD_INFO } from '../lib/buildInfo.js';

describe('BUILD_INFO', () => {
  it('carries a monotonic semver version', () => {
    expect(BUILD_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('carries the short git sha it was built from', () => {
    expect(BUILD_INFO.gitSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('carries a parseable build instant', () => {
    expect(Number.isNaN(Date.parse(BUILD_INFO.builtAt))).toBe(false);
  });

  it('is never the placeholder 0.0.0 that made update comparison impossible', () => {
    expect(BUILD_INFO.version).not.toBe('0.0.0');
  });
});
