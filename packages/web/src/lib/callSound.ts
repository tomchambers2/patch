// The two short sounds of a call: a rising pair when it connects, a falling pair when it
// ends. Played in the page, on the same output the call's audio uses, so they are heard
// where the call is heard and cost nothing.

type Kind = 'pickup' | 'hangup';

const NOTES: Record<Kind, [number, number]> = {
  pickup: [660, 880],
  hangup: [880, 523],
};
const NOTE_SECONDS = 0.09;
const GAIN = 0.1;

export function playCallSound(kind: Kind): void {
  const Ctx: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctx === undefined) {
    console.error(`call sound (${kind}): this browser has no AudioContext`);
    return;
  }
  const ctx = new Ctx();
  const out = ctx.createGain();
  out.gain.value = GAIN;
  out.connect(ctx.destination);
  const start = ctx.currentTime;
  NOTES[kind].forEach((hz, i) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const at = start + i * NOTE_SECONDS;
    osc.type = 'sine';
    osc.frequency.value = hz;
    // A short fade in and out, so each note starts and stops without a click.
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + 0.01);
    env.gain.linearRampToValueAtTime(0, at + NOTE_SECONDS);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + NOTE_SECONDS);
  });
  window.setTimeout(() => void ctx.close(), NOTES[kind].length * NOTE_SECONDS * 1000 + 100);
}
