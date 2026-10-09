export const Audio = {
  RecordingOptionsPresets: { HIGH_QUALITY: {} as unknown },
  Recording: class {
    async prepareToRecordAsync(): Promise<void> {}
    async startAsync(): Promise<void> {}
    async stopAndUnloadAsync(): Promise<void> {}
    getURI(): string | null {
      return 'file:///tmp/test.m4a';
    }
  },
  async requestPermissionsAsync(): Promise<{ granted: boolean }> {
    return { granted: true };
  },
  // Read the current grant WITHOUT prompting — how dictation warms the audio
  // plane before the user ever touches the mic.
  async getPermissionsAsync(): Promise<{ granted: boolean }> {
    return { granted: true };
  },
  async setAudioModeAsync(): Promise<void> {},
};
