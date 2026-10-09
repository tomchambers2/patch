// An AudioContext bound to no output device (`sinkId: { type: 'none' }`,
// Chromium 110+), for audio work that never plays anything — mic capture.
//
// A plain `new AudioContext()` opens the default output device the moment it
// runs, even when nothing is ever connected to it audibly. When that default
// is a monitor's DisplayPort/HDMI sink, the sink wakes and whooshes through
// the speakers at the exact moment dictation starts — the same bug Natter hit
// with its cue sounds. With no sink, the graph
// still renders (so a ScriptProcessor still fires) but no device is opened.

export function silentAudioContext(AudioCtx: typeof AudioContext): AudioContext {
  // `sinkId` is not in TypeScript's AudioContextOptions yet.
  return new AudioCtx({ sinkId: { type: 'none' } } as AudioContextOptions);
}
