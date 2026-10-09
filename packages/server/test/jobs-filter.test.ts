// Group 9B: JSONata filter evaluation.

import { describe, it, expect } from 'vitest';
import { evaluateFilter, filterContext, FilterError } from '../src/jobs/filter.js';

describe('evaluateFilter', () => {
  it('returns true for null/empty filters', async () => {
    expect(await evaluateFilter(null, { x: 1 })).toBe(true);
    expect(await evaluateFilter('', { x: 1 })).toBe(true);
    expect(await evaluateFilter(undefined, { x: 1 })).toBe(true);
  });

  it('evaluates a JSONata expression to truthy/falsy', async () => {
    const expr = 'payload.action = "closed" and payload.pull_request.merged = true';
    const truePayload = {
      payload: { action: 'closed', pull_request: { merged: true } },
    };
    const falsePayload = {
      payload: { action: 'opened', pull_request: { merged: false } },
    };
    expect(await evaluateFilter(expr, truePayload)).toBe(true);
    expect(await evaluateFilter(expr, falsePayload)).toBe(false);
  });

  it('throws FilterError on a syntactically broken expression (fail-closed)', async () => {
    await expect(evaluateFilter('this is }} not jsonata', {})).rejects.toBeInstanceOf(FilterError);
  });

  it('throws FilterError on runtime evaluation errors', async () => {
    // Force a runtime error by referencing a non-callable.
    await expect(evaluateFilter('$notAFunction()', {})).rejects.toBeInstanceOf(FilterError);
  });
});

// filterContext (spec/08 § Filter): every trigger type's evaluation root is
// `{ payload, now }`, so a filter can express a date-bounded condition as a
// plain field comparison — `now >= "..."` — regardless of trigger type.
describe('filterContext', () => {
  it('wraps the trigger data under payload and adds now as an ISO string', () => {
    const ctx = filterContext(1_700_000_000_000, { firedAt: 'x' });
    expect(ctx).toEqual({
      payload: { firedAt: 'x' },
      now: new Date(1_700_000_000_000).toISOString(),
    });
  });

  it('now is usable as an ordinary field in a filter, not a function call', async () => {
    const past = filterContext(Date.now(), {});
    const inRange = 'now >= "2020-01-01T00:00:00.000Z" and now <= "2099-01-01T00:00:00.000Z"';
    expect(await evaluateFilter(inRange, past)).toBe(true);
    const future = 'now >= "2099-01-01T00:00:00.000Z"';
    expect(await evaluateFilter(future, past)).toBe(false);
  });

  it('preserves whatever data shape the trigger passes as payload, untouched', () => {
    const rawBody = { action: 'opened', pull_request: { merged: false } };
    expect(filterContext(0, rawBody).payload).toBe(rawBody);
  });
});
