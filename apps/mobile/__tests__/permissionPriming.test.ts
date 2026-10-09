// Item 19 — first-launch permission priming (spec/15 § First-launch
// permission priming). On first launch the app requests microphone,
// notifications and camera UP FRONT, once each; a second launch (primed flag
// set) requests none.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import { Camera } from 'expo-camera';
import { runPermissionPriming, hasPrimedPermissions } from '../src/lib/permissionPriming';
import { store } from '../src/lib/credential';

let audioReq: ReturnType<typeof vi.spyOn>;
let notifReq: ReturnType<typeof vi.spyOn>;
let camReq: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store().clearAll();
  audioReq = vi.spyOn(Audio, 'requestPermissionsAsync');
  notifReq = vi.spyOn(Notifications, 'requestPermissionsAsync');
  camReq = vi.spyOn(Camera, 'requestCameraPermissionsAsync');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('permission priming', () => {
  it('on first launch requests mic + notifications + camera once each', async () => {
    expect(hasPrimedPermissions()).toBe(false);
    const ran = await runPermissionPriming();
    expect(ran).toBe(true);
    expect(audioReq).toHaveBeenCalledTimes(1);
    expect(notifReq).toHaveBeenCalledTimes(1);
    expect(camReq).toHaveBeenCalledTimes(1);
    expect(hasPrimedPermissions()).toBe(true);
  });

  it('on a subsequent launch (already primed) requests nothing', async () => {
    await runPermissionPriming();
    audioReq.mockClear();
    notifReq.mockClear();
    camReq.mockClear();
    const ran = await runPermissionPriming();
    expect(ran).toBe(false);
    expect(audioReq).not.toHaveBeenCalled();
    expect(notifReq).not.toHaveBeenCalled();
    expect(camReq).not.toHaveBeenCalled();
  });
});
