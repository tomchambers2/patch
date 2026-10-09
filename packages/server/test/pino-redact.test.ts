// Sanity that pino's redact config we ship in app.ts removes credentials.
// We assert the config shape via PINO_REDACT_PATHS, then exercise pino with
// the same config and confirm the dangerous keys are removed.

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { PINO_REDACT_PATHS } from '../src/app.js';

function captureLines(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe('pino redaction', () => {
  it('removes credential, token, and authorization-header values', () => {
    const { stream, lines } = captureLines();
    const log = pino(
      { redact: { paths: PINO_REDACT_PATHS, remove: true }, base: undefined },
      stream,
    );
    log.info(
      {
        req: { headers: { authorization: 'Bearer secretvalue' } },
        credential: 'secret-cred',
        token: 'abc123',
        internalToken: 'shhh',
      },
      'hi',
    );
    const out = lines.join('');
    expect(out).not.toContain('secretvalue');
    expect(out).not.toContain('secret-cred');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('shhh');
    expect(out).toContain('"msg":"hi"');
  });

  it('removes notification-channel secrets (group 12 LOW-1)', () => {
    const { stream, lines } = captureLines();
    const log = pino(
      { redact: { paths: PINO_REDACT_PATHS, remove: true }, base: undefined },
      stream,
    );
    log.info(
      {
        pushToken: 'expo-XXX-secret',
        nested: {
          pushToken: 'expo-YYY-secret',
        },
      },
      'hi',
    );
    const out = lines.join('');
    expect(out).not.toContain('expo-XXX-secret');
    expect(out).not.toContain('expo-YYY-secret');
  });
});
