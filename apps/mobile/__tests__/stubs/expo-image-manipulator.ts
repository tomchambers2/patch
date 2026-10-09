// expo-image-manipulator stub for unit tests. `manipulateAsync` echoes back
// a plausible result (same uri, a fixed size) — imageResize.test.ts vi.mocks
// this module directly for width/height-dependent scenarios.
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png' } as const;

export interface ManipulateResult {
  uri: string;
  width: number;
  height: number;
}
export async function manipulateAsync(
  uri: string,
  _actions: unknown[],
  _opts?: unknown,
): Promise<ManipulateResult> {
  return { uri, width: 100, height: 100 };
}
