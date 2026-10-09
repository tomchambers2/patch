// Task 3: dev-mode error queue — accumulates unhandled errors in dev mode,
// does not touch the production bundle (import.meta.env.DEV guard).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installDevErrorQueue,
  getDevErrors,
  clearDevErrors,
  onDevErrors,
  _resetInstallState,
} from '../lib/devErrorQueue.js';

// vitest sets import.meta.env.DEV = true by default, so install() runs.

describe('devErrorQueue', () => {
  // Snapshot and restore the three collectors between tests so they don't
  // interfere with each other or with the test runner's own error handling.
  let origOnError: typeof window.onerror;
  let origOnUnhandledRejection: typeof window.onunhandledrejection;
  let origConsoleError: typeof console.error;

  beforeEach(() => {
    origOnError = window.onerror;
    origOnUnhandledRejection = window.onunhandledrejection;
    origConsoleError = console.error;
    clearDevErrors();
    _resetInstallState();
    installDevErrorQueue();
  });

  afterEach(() => {
    // Restore originals so subsequent tests get a clean slate.
    window.onerror = origOnError;
    window.onunhandledrejection = origOnUnhandledRejection;
    console.error = origConsoleError;
    clearDevErrors();
    _resetInstallState();
  });

  it('starts empty', () => {
    expect(getDevErrors()).toHaveLength(0);
  });

  it('accumulates a console.error call', () => {
    console.error('something went wrong');
    const q = getDevErrors();
    expect(q).toHaveLength(1);
    expect(q[0]?.type).toBe('console.error');
    expect(q[0]?.message).toContain('something went wrong');
  });

  it('accumulates multiple console.error calls', () => {
    console.error('first');
    console.error('second');
    expect(getDevErrors()).toHaveLength(2);
  });

  it('accumulates an onerror event', () => {
    const err = new Error('onerror-test');
    window.onerror?.call(window, 'onerror-test', 'file.js', 1, 1, err);
    const q = getDevErrors();
    expect(q).toHaveLength(1);
    expect(q[0]?.type).toBe('onerror');
    expect(q[0]?.message).toBe('onerror-test');
  });

  it('accumulates an unhandledrejection event', () => {
    // Use an already-settled rejected promise to avoid an actual unhandled
    // rejection leaking to the vitest runner — we only need the event object.
    const settled = Promise.resolve();
    const event = new PromiseRejectionEvent('unhandledrejection', {
      promise: settled as unknown as Promise<never>,
      reason: new Error('reject-test'),
    });
    window.onunhandledrejection?.call(window, event);
    const q = getDevErrors();
    expect(q).toHaveLength(1);
    expect(q[0]?.type).toBe('unhandledrejection');
    expect(q[0]?.message).toBe('reject-test');
  });

  it('clearDevErrors empties the queue', () => {
    console.error('to-clear');
    expect(getDevErrors()).toHaveLength(1);
    clearDevErrors();
    expect(getDevErrors()).toHaveLength(0);
  });

  it('onDevErrors subscriber fires when a new error is pushed', () => {
    const calls: number[] = [];
    const unsub = onDevErrors(() => calls.push(getDevErrors().length));
    console.error('sub-test');
    expect(calls).toContain(1);
    unsub();
  });

  it('onDevErrors subscriber fires when queue is cleared', () => {
    console.error('pre-clear');
    const calls: number[] = [];
    const unsub = onDevErrors(() => calls.push(getDevErrors().length));
    clearDevErrors();
    expect(calls).toContain(0);
    unsub();
  });

  it('install() is idempotent — calling twice does not double-wrap console.error', () => {
    // Calling install() a second time must be a no-op (installed flag).
    installDevErrorQueue();
    console.error('idempotent-test');
    // Should be exactly 1, not 2.
    expect(getDevErrors()).toHaveLength(1);
  });

  it('does NOT install when import.meta.env.DEV = false — install() is a no-op', () => {
    // Restore unmodified console.error first so there is no prior wrapping.
    console.error = origConsoleError;
    clearDevErrors();
    _resetInstallState();

    // Stub DEV to false (production mode).
    vi.stubEnv('DEV', false);
    installDevErrorQueue();

    // The install() should have been a no-op: console.error is still the
    // original and the queue is empty.
    expect(getDevErrors()).toHaveLength(0);
    // After a console.error call, nothing should be pushed to the queue since
    // the wrapper was never installed.
    console.error('prod-mode-test');
    expect(getDevErrors()).toHaveLength(0);

    vi.unstubAllEnvs();
    _resetInstallState();
  });
});
