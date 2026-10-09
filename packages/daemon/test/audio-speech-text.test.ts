import { describe, test, expect } from 'vitest';
import { stripMarkdownForSpeech, extractSentences } from '../src/audio/speechText.js';

describe('stripMarkdownForSpeech', () => {
  test('drops heading #, emphasis, rules and emoji; keeps the words', () => {
    const md = [
      '## 🍎 Endozoochory — Fleshy Fruit',
      '**Why July?** Peak *sunlight* = maximum sugar.',
      '',
      '---',
      '',
      '- Strawberries, raspberries',
    ].join('\n');
    const out = stripMarkdownForSpeech(md);
    expect(out).not.toMatch(/[#*_>|]/);
    expect(out).not.toMatch(/🍎/);
    expect(out).toContain('Endozoochory');
    expect(out).toContain('Why July?');
    expect(out).toContain('Peak sunlight = maximum sugar.');
    expect(out).toContain('Strawberries, raspberries');
  });

  test('drops fenced code blocks entirely but keeps inline code words', () => {
    const out = stripMarkdownForSpeech('Set `window` to 45. \n```\ncode here\n```\nDone.');
    expect(out).toContain('Set window to 45.');
    expect(out).toContain('Done.');
    expect(out).not.toContain('code here');
  });

  test('is a no-op on already-plain prose', () => {
    expect(stripMarkdownForSpeech('It fired fine at 17:00 today.')).toBe(
      'It fired fine at 17:00 today.',
    );
  });
});

describe('extractSentences', () => {
  test('splits on sentence-final punctuation followed by whitespace', () => {
    const { sentences, rest } = extractSentences('Hello there. How are you? I am fine');
    expect(sentences).toEqual(['Hello there.', 'How are you?']);
    expect(rest).toBe(' I am fine');
  });

  test('does not split mid-number or before more text arrives', () => {
    // "3.14" must not split; a trailing "." with nothing after it waits.
    const { sentences, rest } = extractSentences('Pi is 3.14 and that.');
    expect(sentences).toEqual([]);
    expect(rest).toBe('Pi is 3.14 and that.');
  });

  test('treats newlines as boundaries (lists/headings speak as units)', () => {
    const { sentences, rest } = extractSentences('Peas\nBroad beans\nrunner');
    expect(sentences).toEqual(['Peas', 'Broad beans']);
    expect(rest).toBe('runner');
  });
});
