// Minimal expo-camera stub for unit tests. Only the surface the tested
// modules touch is provided.
export const Camera = {
  async requestCameraPermissionsAsync(): Promise<{ granted: boolean }> {
    return { granted: true };
  },
};

// ── useCameraPermissions / CameraView (app/pair.tsx) ───────────────────────
// Real expo-camera's useCameraPermissions returns [permission, requestFn];
// `permission` is null until the hook resolves the OS's current grant, then
// an object with `granted`. Mutable module state + a test helper lets a test
// drive all three states (not-yet-decided / denied / granted).
import React from 'react';

export interface CameraPermissionResponse {
  granted: boolean;
}
let _cameraPermission: CameraPermissionResponse | null = null;
/** Test helper: set what useCameraPermissions() currently reports. */
export function __setCameraPermission(p: CameraPermissionResponse | null): void {
  _cameraPermission = p;
}
export function useCameraPermissions(): [
  CameraPermissionResponse | null,
  () => Promise<CameraPermissionResponse>,
] {
  const request = async (): Promise<CameraPermissionResponse> => {
    _cameraPermission = { granted: true };
    return _cameraPermission;
  };
  return [_cameraPermission, request];
}

export const CameraView = React.forwardRef<unknown, Record<string, unknown>>((props, ref) =>
  React.createElement('CameraView', { ...props, ref }),
);
