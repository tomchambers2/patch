import { describe, test, expect } from 'vitest';
import { HOSTED_VOICE_INSTRUCTION, hostedVoiceInstruction } from '../src/audio/gemini-live.js';

describe('HOSTED_VOICE_INSTRUCTION', () => {
  test('allows one acknowledgement then silence until the agent result arrives', () => {
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/at most one/i);
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/silent|say nothing/i);
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/never repeat|do not repeat/i);
    expect(HOSTED_VOICE_INSTRUCTION).not.toMatch(/so you are never silent/i);
  });

  test('forbids answering from guesses what only the agent can know', () => {
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/never guess|do not guess|never make up/i);
    expect(HOSTED_VOICE_INSTRUCTION).toMatch(/files/i);
  });

  test('the async variant keeps the voice talking while the agent works, and says the result when it arrives', () => {
    const text = hostedVoiceInstruction('auto', true);
    expect(text).toMatch(/answers at once/i);
    expect(text).toMatch(/carry on the conversation/i);
    expect(text).toMatch(/never say "still working on it"/i);
    expect(text).toMatch(/result arrives as a message/i);
    expect(text).toMatch(/never guess/i);
  });
});
