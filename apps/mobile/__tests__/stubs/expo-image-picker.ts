// expo-image-picker stub for unit tests. Defaults to a cancelled pick;
// individual tests vi.mock() this module for a specific scenario (granted
// permission + a chosen asset, or a denied permission).
export const MediaTypeOptions = { Images: 'Images', Videos: 'Videos', All: 'All' } as const;

export async function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}

export interface ImagePickerAsset {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  width?: number;
  height?: number;
}
export async function launchImageLibraryAsync(_opts?: unknown): Promise<
  { canceled: true } | { canceled: false; assets: ImagePickerAsset[] }
> {
  return { canceled: true };
}
