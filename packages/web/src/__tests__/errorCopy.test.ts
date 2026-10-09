// lib/errorCopy — a machine's failure said in one plain sentence, with the
// machine-readable original kept as detail. The rules under test are the ones
// that keep jargon off the screen: never interpolate a code into the sentence,
// never repeat a daemon-authored paragraph, never drop either.

import { describe, it, expect } from 'vitest';
import { humaniseError } from '../lib/errorCopy.js';

// The real wording a host sends when a host has no model catalogue.
const DAEMON_PARAGRAPH =
  'machine dev-daemon-1 has never read a model catalogue, so it has no last-used model; ' +
  'name a model on the spawn or connect the backend credential on that machine';

describe('humaniseError', () => {
  it('never puts an unrecognised code in the sentence, but keeps it as detail', () => {
    const models = humaniseError({ code: 'upstream' }, 'models');
    expect(models.sentence).not.toContain('upstream');
    expect(models.sentence).toBe(
      'Couldn’t load the model list for that machine. Try again in a moment.',
    );
    expect(models.detail).toBe('upstream');

    const spawn = humaniseError({ code: 'wibble_wobble_9000' }, 'spawn');
    expect(spawn.sentence).not.toContain('wibble_wobble_9000');
    expect(spawn.sentence).toBe('Couldn’t start the chat. Try again in a moment.');
    expect(spawn.detail).toBe('wibble_wobble_9000');
  });

  it('replaces a daemon-authored paragraph rather than passing it through', () => {
    const out = humaniseError({ code: 'no_model_catalogue', message: DAEMON_PARAGRAPH }, 'spawn');
    expect(out.sentence).toBe('Pick a model before starting the chat.');
    expect(out.sentence).not.toContain('dev-daemon-1');
    expect(out.sentence).not.toContain('credential');
    // Kept in full — code AND the host's own words.
    expect(out.detail).toContain('no_model_catalogue');
    expect(out.detail).toContain(DAEMON_PARAGRAPH);
  });

  it('says what to do for each code it knows, and never says the code', () => {
    const cases: ReadonlyArray<[string, 'models' | 'spawn']> = [
      ['oauth_unavailable', 'models'],
      ['unauthenticated', 'models'],
      ['account_not_found', 'spawn'],
      ['no_model_catalogue', 'models'],
      ['no_machine_chosen', 'models'],
      ['unknown_host', 'models'],
      ['folder_not_found', 'spawn'],
      ['chat_not_found', 'spawn'],
    ];
    for (const [code, site] of cases) {
      const out = humaniseError({ code }, site);
      expect(out.sentence).not.toContain(code);
      expect(out.sentence).not.toContain('_');
      expect(out.sentence.endsWith('.')).toBe(true);
      expect(out.detail).toBe(code);
    }
  });

  it('gives the same code a different next step where the site demands one', () => {
    expect(humaniseError({ code: 'no_model_catalogue' }, 'models').sentence).toBe(
      'That machine hasn’t read a model list yet.',
    );
    expect(humaniseError({ code: 'no_model_catalogue' }, 'spawn').sentence).toBe(
      'Pick a model before starting the chat.',
    );
  });

  it('finds a code embedded in a longer message', () => {
    const out = humaniseError(
      { message: 'GET /api/models failed: oauth_unavailable on d1' },
      'models',
    );
    expect(out.sentence).toBe(
      'That machine isn’t signed in to Claude. Sign in from Settings → Hosts.',
    );
    expect(out.detail).toBe('GET /api/models failed: oauth_unavailable on d1');
  });

  it('has an empty detail when there was nothing to keep', () => {
    const out = humaniseError({}, 'models');
    expect(out.sentence).toBe(
      'Couldn’t load the model list for that machine. Try again in a moment.',
    );
    expect(out.detail).toBe('');
  });

  it('does not repeat itself when the code and the message are the same string', () => {
    const out = humaniseError({ code: 'folder_not_found', message: 'folder_not_found' }, 'spawn');
    expect(out.detail).toBe('folder_not_found');
  });
});
