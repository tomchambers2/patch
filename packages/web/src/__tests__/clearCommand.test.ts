// Unit tests for the /clear built-in slash command parser.

import { describe, it, expect } from 'vitest';
import {
  parseClearCommand,
  CLEAR_COMMAND_NAME,
  CLEAR_COMMAND_DESCRIPTION,
} from '../lib/clearCommand.js';

describe('parseClearCommand', () => {
  it('returns true for exact "/clear"', () => {
    expect(parseClearCommand('/clear')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseClearCommand('/Clear')).toBe(true);
    expect(parseClearCommand('/CLEAR')).toBe(true);
    expect(parseClearCommand('/cLeAr')).toBe(true);
  });

  it('trims leading/trailing whitespace before matching', () => {
    expect(parseClearCommand('  /clear  ')).toBe(true);
    expect(parseClearCommand('\t/clear\n')).toBe(true);
  });

  it('returns false when arguments follow /clear', () => {
    expect(parseClearCommand('/clear foo')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(parseClearCommand('')).toBe(false);
  });

  it('returns false for unrelated commands', () => {
    expect(parseClearCommand('/remind me')).toBe(false);
    expect(parseClearCommand('/goal something')).toBe(false);
    expect(parseClearCommand('clear')).toBe(false);
    expect(parseClearCommand('hello /clear')).toBe(false);
  });

  it('returns false for partial matches', () => {
    expect(parseClearCommand('/clea')).toBe(false);
    expect(parseClearCommand('/clearance')).toBe(false);
  });
});

describe('CLEAR_COMMAND constants', () => {
  it('exports the command name as "clear"', () => {
    expect(CLEAR_COMMAND_NAME).toBe('clear');
  });

  it('exports a non-empty description string', () => {
    expect(typeof CLEAR_COMMAND_DESCRIPTION).toBe('string');
    expect(CLEAR_COMMAND_DESCRIPTION.length).toBeGreaterThan(0);
  });
});
