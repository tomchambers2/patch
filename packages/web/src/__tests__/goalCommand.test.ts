import { describe, it, expect } from 'vitest';
import { parseGoalCommand } from '../lib/goalCommand.js';

describe('parseGoalCommand (patch/todo.md — /goal)', () => {
  it('recognises `/goal <text>` and returns the trimmed goal', () => {
    expect(parseGoalCommand('/goal Ship the release by Friday')).toEqual({
      isGoal: true,
      goal: 'Ship the release by Friday',
    });
  });

  it('is case-insensitive on the command word only', () => {
    expect(parseGoalCommand('/GOAL Keep the Casing')).toEqual({
      isGoal: true,
      goal: 'Keep the Casing',
    });
  });

  it('treats a bare `/goal` as a clear (goal null)', () => {
    expect(parseGoalCommand('/goal')).toEqual({ isGoal: true, goal: null });
    expect(parseGoalCommand('/goal   ')).toEqual({ isGoal: true, goal: null });
  });

  it('tolerates leading/trailing whitespace around the whole message', () => {
    expect(parseGoalCommand('  /goal  finish the docs  ')).toEqual({
      isGoal: true,
      goal: 'finish the docs',
    });
  });

  it('does NOT match a normal message or a different slash command', () => {
    expect(parseGoalCommand('let us set a goal today')).toEqual({ isGoal: false, goal: null });
    expect(parseGoalCommand('/goalie save the shot')).toEqual({ isGoal: false, goal: null });
    expect(parseGoalCommand('/plan the week')).toEqual({ isGoal: false, goal: null });
  });
});
