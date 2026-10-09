import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toastSound, URGENT_TOAST_SOUND } from './toastSound';

// spec/09 § Reaching the user — urgent is normal with a more urgent sound.
test('urgent plays the urgent sound, normal the default, silent none', () => {
  assert.deepEqual(toastSound('urgent'), { silent: false, sound: URGENT_TOAST_SOUND });
  assert.deepEqual(toastSound('normal'), { silent: false });
  assert.deepEqual(toastSound(undefined), { silent: false });
  assert.deepEqual(toastSound('silent'), { silent: true });
});
