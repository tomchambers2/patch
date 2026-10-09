// Unit tests for the /model built-in slash command — parsing and catalogue matching
// (spec/04-chats-and-folders.md § Model).

import { describe, it, expect } from 'vitest';
import { parseModelCommand, matchModel } from '../lib/modelCommand.js';
import type { ModelOption } from '../lib/models.js';

describe('parseModelCommand', () => {
  it('recognises `/model <name>` and returns the trimmed query', () => {
    expect(parseModelCommand('/model opus')).toEqual({ isModel: true, query: 'opus' });
  });

  it('is case-insensitive on the command word only, preserving query case', () => {
    expect(parseModelCommand('/MODEL Claude Opus 5')).toEqual({
      isModel: true,
      query: 'Claude Opus 5',
    });
  });

  it('treats a bare `/model` as having no query (a usage error, not a clear)', () => {
    expect(parseModelCommand('/model')).toEqual({ isModel: true, query: null });
    expect(parseModelCommand('/model   ')).toEqual({ isModel: true, query: null });
  });

  it('trims surrounding whitespace around the query', () => {
    expect(parseModelCommand('  /model   sonnet  ')).toEqual({ isModel: true, query: 'sonnet' });
  });

  it('does NOT match a normal message or a different slash command', () => {
    expect(parseModelCommand('let us model this out')).toEqual({ isModel: false, query: null });
    expect(parseModelCommand('/modeling opus')).toEqual({ isModel: false, query: null });
    expect(parseModelCommand('/goal the week')).toEqual({ isModel: false, query: null });
  });
});

describe('matchModel', () => {
  const models: readonly ModelOption[] = [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ];

  it('matches an exact id, case-insensitively', () => {
    expect(matchModel('claude-sonnet-5-5', models)).toEqual({
      status: 'found',
      modelId: 'claude-sonnet-5-5',
    });
    expect(matchModel('CLAUDE-SONNET-5-5', models)).toEqual({
      status: 'found',
      modelId: 'claude-sonnet-5-5',
    });
  });

  it('matches an exact label, case-insensitively', () => {
    expect(matchModel('opus 5.5', models)).toEqual({
      status: 'found',
      modelId: 'claude-opus-5-5',
    });
  });

  it('matches a unique substring of an id or label', () => {
    expect(matchModel('haiku', models)).toEqual({
      status: 'found',
      modelId: 'claude-haiku-4-5-20251001',
    });
  });

  it('is ambiguous when a substring matches more than one entry', () => {
    expect(matchModel('5.5', models)).toEqual({
      status: 'ambiguous',
      candidates: ['Opus 5.5', 'Sonnet 5.5'],
    });
  });

  it('is not_found when nothing matches', () => {
    expect(matchModel('gpt-nonexistent', models)).toEqual({ status: 'not_found' });
  });

  it('prefers an exact match over a substring match that would otherwise be ambiguous', () => {
    const withPrefix: readonly ModelOption[] = [
      { id: 'opus', label: 'Opus' },
      { id: 'opus-legacy', label: 'Opus Legacy' },
    ];
    expect(matchModel('opus', withPrefix)).toEqual({ status: 'found', modelId: 'opus' });
  });
});
