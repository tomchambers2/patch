// Whisper does not answer half a second of room tone with an empty string. It
// answers with the stock phrases its training data is full of, and on the live
// path those get painted into the composer as if the user had said them. This
// table is the real set — the ones that actually come back off
// whisper-large-v3-turbo for silence and for fragments.

import { describe, test, expect } from 'vitest';
import { isStockHallucination } from '../src/audio/partial-filter.js';

describe('stock hallucinations are dropped from a partial', () => {
  const stock = [
    'Thank you.',
    'thank you',
    'Thank you very much.',
    'Thank you so much!',
    'Thank you for watching.',
    'Thanks for watching!',
    'Thanks.',
    'you',
    'You.',
    'Bye.',
    'Bye bye.',
    'Goodbye.',
    '.',
    '..',
    '...',
    '…',
    '♪',
    '♪♪',
    '   ',
    '[BLANK_AUDIO]',
    '[Music]',
    '(silence)',
    '[ Applause ]',
    'Subtitles by the Amara.org community',
    'Subtitles by the Amara.org community.',
    'Transcription by CastingWords',
    'Captions by VITAC',
    'Please subscribe to my channel.',
    'Like and subscribe!',
    'See you next time.',
    'Sous-titrage ST’ 501',
    'Untertitel im Auftrag des ZDF, 2021',
  ];
  for (const text of stock) {
    test(`drops ${JSON.stringify(text)}`, () => {
      expect(isStockHallucination(text)).toBe(true);
    });
  }
});

describe('real speech is never dropped', () => {
  const speech = [
    'add milk to the shopping list',
    'thanks for watching the dog while we were away',
    'thank you for the invoice, can you check it',
    'you should look at the deploy log',
    'no',
    'yes',
    'okay',
    'yeah',
    'so',
    'um',
    'stop',
    'right',
    'I said bye to him',
    'music is too loud',
    'the silence in that room',
    'subtitles are wrong on this video',
  ];
  for (const text of speech) {
    test(`keeps ${JSON.stringify(text)}`, () => {
      expect(isStockHallucination(text)).toBe(false);
    });
  }
});

describe('the filter reads the whole utterance, not a fragment of it', () => {
  test('a stock phrase inside a real sentence is kept', () => {
    expect(isStockHallucination('thank you for sorting the bins out')).toBe(false);
  });
  test('the same phrase alone is dropped', () => {
    expect(isStockHallucination('thank you')).toBe(true);
  });
});
