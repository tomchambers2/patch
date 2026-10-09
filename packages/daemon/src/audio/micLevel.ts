// spec/07 — a session whose microphone delivers nothing but digital silence is
// failing, not quiet. On macOS an app without microphone permission is handed
// a silent stream rather than an error, so without this the user talks into a
// call that hears nothing and nothing says why.

/** Seconds of mic audio after which an all-zero stream is called out. */
const SILENT_AFTER_SECONDS = 5;
const SAMPLE_RATE = 16000;

/** What the user is told, with the fix for the device they are on. */
export function micSilentMessage(surfaceKind: string): string {
  const fix =
    surfaceKind === 'mobile'
      ? 'Allow Patch to use the microphone in Android Settings → Apps → Patch → Permissions.'
      : 'On a Mac, allow Patch in System Settings → Privacy & Security → Microphone, then quit ' +
        'and reopen Patch, and check the input device and its volume in System Settings → Sound.';
  return `Your microphone is sending silence, so nothing you say can be heard. ${fix}`;
}

export class MicLevelWatch {
  private samples = 0;
  private peak = 0;
  private reported = false;

  /** Feed one 16 kHz frame. True exactly once: when 5s have arrived and every sample was zero. */
  feed(pcm: Int16Array): boolean {
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.abs(pcm[i]!);
      if (v > this.peak) this.peak = v;
    }
    this.samples += pcm.length;
    if (this.reported || this.peak > 0) return false;
    if (this.samples < SILENT_AFTER_SECONDS * SAMPLE_RATE) return false;
    this.reported = true;
    return true;
  }

  /** Loudest sample so far in dBFS; -Infinity for a stream of zeros. */
  peakDbfs(): number {
    return this.peak === 0 ? -Infinity : 20 * Math.log10(this.peak / 32768);
  }
}
