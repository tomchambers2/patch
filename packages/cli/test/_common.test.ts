// Tests for shared command helpers in src/commands/_common.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorMessage, parseLimit } from '../src/commands/_common.js';
import { RestError } from '../src/transport/rest.js';

// Single shared --limit contract across every command that accepts --limit
// (history, logs, jobs runs, jobs hooks, hooks tail). Regression guard for
// G1-d2/d3/d4 — non-numeric, zero, and negative all rejected identically.
test('parseLimit: accepts a positive integer', () => {
  assert.equal(parseLimit('5'), 5);
  assert.equal(parseLimit('200'), 200);
});

test('parseLimit: rejects non-numeric, zero, and negative with one message + the bad value', () => {
  for (const bad of ['abc', '0', '-5', '1.5', '']) {
    assert.throws(
      () => parseLimit(bad),
      (err: unknown) =>
        err instanceof Error && err.message === `--limit must be a positive integer (got ${bad})`,
      `expected parseLimit(${JSON.stringify(bad)}) to throw the canonical message`,
    );
  }
});

test('errorMessage: RestError with body.error and body.message concatenates', () => {
  const err = new RestError(
    404,
    {
      error: 'folder_not_found',
      message: 'folder does not exist on the host: /tmp/x',
    },
    'Not Found',
    true,
  );
  assert.equal(errorMessage(err), 'folder_not_found: folder does not exist on the host: /tmp/x');
});

test('errorMessage: RestError with only body.error returns error', () => {
  const err = new RestError(400, { error: 'bad_request' }, 'Bad Request', true);
  assert.equal(errorMessage(err), 'bad_request');
});

test('errorMessage: RestError with only body.message returns message', () => {
  const err = new RestError(400, { message: 'oops' }, 'Bad Request', true);
  assert.equal(errorMessage(err), 'oops');
});
