// The /api/version response contract.
//
// A partial report must be REJECTED rather than coerced. If `drift` defaulted to
// `[]`, a broken server would make the panel announce "all layers agree" — the
// exact false-confidence that let a stale SPA sit in prod for eight days.

import { describe, it, expect } from 'vitest';
import { assertVersionReport } from '../src/index.js';

const VALID = {
  checkedAt: '2026-07-28T12:00:00.000Z',
  server: { version: '0.1.317', gitSha: '9b8635f', builtAt: null, startedAt: 'x' },
  web: null,
  daemon: null,
  desktop: null,
  android: null,
  clients: [],
  hosts: [],
  drift: [],
};

describe('assertVersionReport', () => {
  it('passes a well-formed report through', () => {
    expect(assertVersionReport(VALID)).toBe(VALID);
  });

  it('rejects a report with no host roster — absent must not read as "no machines"', () => {
    const { hosts: _omitted, ...withoutHosts } = VALID;
    void _omitted;
    expect(() => assertVersionReport(withoutHosts)).toThrow(/missing hosts/);
  });

  it('rejects a non-object body', () => {
    expect(() => assertVersionReport(null)).toThrow(/not an object/);
    expect(() => assertVersionReport('nope')).toThrow(/not an object/);
  });

  it('rejects a body with no checkedAt', () => {
    expect(() => assertVersionReport({ ...VALID, checkedAt: undefined })).toThrow(/checkedAt/);
  });

  it('rejects a body with no server layer', () => {
    expect(() => assertVersionReport({ ...VALID, server: null })).toThrow(/missing server/);
    expect(() => assertVersionReport({ ...VALID, server: { gitSha: 'x' } })).toThrow(
      /server\.version/,
    );
  });

  it('rejects a body missing drift — never treats absence as agreement', () => {
    expect(() => assertVersionReport({ ...VALID, drift: undefined })).toThrow(/missing drift/);
  });

  it('rejects a body missing clients', () => {
    expect(() => assertVersionReport({ ...VALID, clients: undefined })).toThrow(/missing clients/);
  });

  it('rejects the bare {ok:true} a mis-stubbed endpoint returns', () => {
    expect(() => assertVersionReport({ ok: true })).toThrow(/malformed/);
  });
});
