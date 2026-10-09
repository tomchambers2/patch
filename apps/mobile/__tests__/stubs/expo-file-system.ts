export const cacheDirectory: string = 'file:///cache/';

export enum EncodingType {
  UTF8 = 'utf8',
  Base64 = 'base64',
}

const files = new Map<string, string>();

export async function writeAsStringAsync(
  fileUri: string,
  contents: string,
  _options?: { encoding?: EncodingType | 'utf8' | 'base64' },
): Promise<void> {
  files.set(fileUri, contents);
}

export async function readAsStringAsync(fileUri: string): Promise<string> {
  return files.get(fileUri) ?? '';
}

export async function deleteAsync(fileUri: string): Promise<void> {
  files.delete(fileUri);
}
