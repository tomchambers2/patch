// expo-document-picker stub for unit tests. Defaults to a cancelled pick;
// individual tests vi.mock() this module for a specific chosen asset.
export interface DocumentPickerAsset {
  uri: string;
  name: string;
  mimeType?: string | null;
}
export async function getDocumentAsync(_opts?: unknown): Promise<
  { canceled: true } | { canceled: false; assets: DocumentPickerAsset[] }
> {
  return { canceled: true };
}
