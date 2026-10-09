import { describe, it, expect } from 'vitest';
import { parseReminderCommand } from '../lib/reminderCommand.js';

describe('parseReminderCommand (patch/todo.md — /remind)', () => {
  it('recognises `/remind <text>` and returns the trimmed reminder', () => {
    expect(parseReminderCommand('/remind Do not touch the prod database')).toEqual({
      isReminder: true,
      reminder: 'Do not touch the prod database',
    });
  });

  it('is case-insensitive on the command word only', () => {
    expect(parseReminderCommand('/REMIND Keep the Casing')).toEqual({
      isReminder: true,
      reminder: 'Keep the Casing',
    });
  });

  it('treats a bare `/remind` as a clear (reminder null)', () => {
    expect(parseReminderCommand('/remind')).toEqual({ isReminder: true, reminder: null });
    expect(parseReminderCommand('/remind   ')).toEqual({ isReminder: true, reminder: null });
  });

  it('tolerates leading/trailing whitespace around the whole message', () => {
    expect(parseReminderCommand('  /remind  water the plants  ')).toEqual({
      isReminder: true,
      reminder: 'water the plants',
    });
  });

  it('does NOT match a normal message or a different slash command', () => {
    expect(parseReminderCommand('please remind me later')).toEqual({
      isReminder: false,
      reminder: null,
    });
    expect(parseReminderCommand('/reminders list them')).toEqual({
      isReminder: false,
      reminder: null,
    });
    expect(parseReminderCommand('/goal ship it')).toEqual({ isReminder: false, reminder: null });
  });
});
