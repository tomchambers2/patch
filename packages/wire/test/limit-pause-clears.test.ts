import { describe, it, expect } from 'vitest';
import { ChatActivity, IN_FLIGHT_CHAT_ACTIVITIES, clearsLimitPause } from '../src/index.js';

// spec/12 § A usage or rate limit — a surface withdraws the limit notice the
// moment the chat reports a turn in flight, because a running turn and a limit
// pause cannot both be true of one chat. The set is here rather than in each
// store so the two surfaces and the spec cannot drift, and this file is the
// lock on it: adding `idle` would erase an armed pause the instant it was
// announced, and adding `errored` would erase a limit nobody parked — which is
// the state the whole notice exists for.
describe('the activities that end a limit pause', () => {
  it('is exactly the in-flight pair', () => {
    expect([...IN_FLIGHT_CHAT_ACTIVITIES]).toEqual(['running', 'awaiting-permission']);
  });

  it('every one of them is a real ChatActivity', () => {
    for (const activity of IN_FLIGHT_CHAT_ACTIVITIES) {
      expect(ChatActivity.safeParse(activity).success).toBe(true);
    }
  });

  it('says yes to a turn in flight and no to the two shapes a pause wears', () => {
    expect(clearsLimitPause('running')).toBe(true);
    expect(clearsLimitPause('awaiting-permission')).toBe(true);
    // An armed pause IS an idle chat; a limit nobody parked IS an errored one.
    expect(clearsLimitPause('idle')).toBe(false);
    expect(clearsLimitPause('errored')).toBe(false);
  });

  it('says no to an absent or unrecognised activity', () => {
    // A frame from a build this one does not understand is not licence to
    // delete a pause the user can still act on.
    expect(clearsLimitPause(undefined)).toBe(false);
    expect(clearsLimitPause('something_from_the_future')).toBe(false);
  });
});
