import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  MeetingDetector,
  PcmAligner,
  SystemAudio,
  callingAppsIn,
  type MicProcess,
} from './meeting-audio.js';

const proc = (bundleId: string, pid = 1): MicProcess => ({ pid, bundleId });

test('callingAppsIn names calling apps, via helper bundle IDs, and ignores Patch itself', () => {
  const apps = callingAppsIn(
    [
      proc('com.google.Chrome.helper', 1),
      proc('us.zoom.xos', 2),
      proc('io.github.tomchambers2.patch.helper', 3),
      proc('com.spotify.client', 4),
    ],
    'io.github.tomchambers2.patch',
  );
  assert.deepEqual(apps, ['Chrome call', 'Zoom']);
});

test('MeetingDetector: one start, and one end only after the grace period', () => {
  const events: string[] = [];
  const d = new MeetingDetector(
    { started: (a) => events.push(`start ${a}`), ended: (a) => events.push(`end ${a}`) },
    10_000,
  );
  d.update(['Zoom'], 0);
  d.update(['Zoom'], 1_000);
  d.update([], 2_000); // mic closed (e.g. muted)
  d.tick(8_000);
  assert.deepEqual(events, ['start Zoom']);
  d.update(['Zoom'], 9_000); // mic back inside the grace: same meeting
  d.update([], 10_000);
  d.tick(18_999);
  assert.deepEqual(events, ['start Zoom']);
  d.tick(19_000);
  assert.deepEqual(events, ['start Zoom', 'end Zoom']);
  d.update(['Zoom'], 30_000); // a new meeting
  assert.deepEqual(events, ['start Zoom', 'end Zoom', 'start Zoom']);
});

test('MeetingDetector: ends only when the last calling app lets go', () => {
  const events: string[] = [];
  const d = new MeetingDetector(
    { started: (a) => events.push(`start ${a}`), ended: (a) => events.push(`end ${a}`) },
    1_000,
  );
  d.update(['Teams'], 0);
  d.update(['Teams', 'Zoom'], 100);
  d.update(['Teams'], 200); // Zoom let go, Teams still on
  d.tick(5_000);
  assert.deepEqual(events, ['start Teams', 'start Zoom']);
  d.update([], 5_100);
  d.tick(7_000);
  assert.equal(events.filter((e) => e.startsWith('end')).length, 1);
});

test('PcmAligner never hands on half a sample', () => {
  const a = new PcmAligner();
  assert.deepEqual([...(a.push(Buffer.from([1, 2, 3])) ?? [])], [1, 2]);
  assert.deepEqual([...(a.push(Buffer.from([4, 5])) ?? [])], [3, 4]);
  assert.equal(a.push(Buffer.from([])), null);
});

function fakeChild(): ChildProcessWithoutNullStreams & EventEmitter {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & EventEmitter;
  (child as { stdout: unknown }).stdout = new EventEmitter();
  (child as { stderr: unknown }).stderr = new EventEmitter();
  (child as { kill: unknown }).kill = () => child.emit('exit', null, 'SIGTERM');
  return child;
}

test('SystemAudio: resolves on ready, streams aligned PCM, reports an unasked exit', async () => {
  const child = fakeChild();
  const audio = new SystemAudio(
    () => '/bin/helper',
    () => child,
  );
  const got: number[][] = [];
  let failed = '';
  const started = audio.start({ onPcm: (b) => got.push([...b]), onFailed: (m) => (failed = m) });
  child.stderr.emit('data', Buffer.from('ready\n'));
  await started;
  child.stdout.emit('data', Buffer.from([1, 2, 3]));
  child.stdout.emit('data', Buffer.from([4]));
  assert.deepEqual(got, [
    [1, 2],
    [3, 4],
  ]);
  child.stderr.emit('data', Buffer.from('boom\n'));
  child.emit('exit', 1, null);
  assert.match(failed, /boom/);
  assert.equal(audio.running, false);
});

test('SystemAudio: an exit before ready rejects with the helper’s own message', async () => {
  const child = fakeChild();
  const audio = new SystemAudio(
    () => '/bin/helper',
    () => child,
  );
  const started = audio.start({ onPcm: () => undefined, onFailed: () => undefined });
  child.stderr.emit('data', Buffer.from('patch-audio: create audio tap failed (OSStatus 1)\n'));
  child.emit('exit', 1, null);
  await assert.rejects(started, /create audio tap failed/);
});

test('SystemAudio: a stop is not a failure', async () => {
  const child = fakeChild();
  const audio = new SystemAudio(
    () => '/bin/helper',
    () => child,
  );
  let failed = false;
  const started = audio.start({ onPcm: () => undefined, onFailed: () => (failed = true) });
  child.stderr.emit('data', Buffer.from('ready\n'));
  await started;
  audio.stop();
  assert.equal(failed, false);
});
