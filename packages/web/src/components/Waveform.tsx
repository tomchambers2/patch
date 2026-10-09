// Waveform — a small bar-graph visualiser of the incoming mic level, shared by
// the voice-note and voice-call overlays (spec/07: "waveform visualiser of
// incoming audio").
//
// The motion is CSS-driven (see `.wave-bar` / `@keyframes wave-osc` in
// index.css) rather than a frozen height computed from the level alone: every
// bar runs a continuous scaleY oscillation so the row keeps breathing even when
// the user pauses, and each bar is offset by a negative `animation-delay` so the
// pulse travels across the row instead of moving in lockstep. Amplitude is
// handed to the CSS via two custom properties:
//   --wave-level    the smoothed 0..1 mic level (louder → taller swing)
//   --wave-envelope a static per-bar shape (taller in the middle)

import type { CSSProperties, JSX } from 'react';

export interface WaveformProps {
  /** Smoothed input level 0..1. */
  level: number;
  bars?: number;
  className?: string;
}

// A gentle idle sway between adjacent bars, in milliseconds. Negative delays
// start each bar mid-cycle so the wave is already in motion on first paint.
const STAGGER_MS = 90;

export function Waveform({ level, bars = 12, className }: WaveformProps): JSX.Element {
  const clamped = Math.max(0, Math.min(1, level));
  const rootStyle = { '--wave-level': String(clamped) } as CSSProperties;
  return (
    <div
      className={`waveform ${className ?? ''}`.trim()}
      data-testid="waveform"
      data-level={clamped.toFixed(2)}
      style={rootStyle}
      aria-hidden
    >
      {Array.from({ length: bars }, (_, i) => {
        // A static envelope (taller in the middle) so the row reads as a hump
        // rather than a flat block; the live level scales the whole thing.
        const envelope = 0.4 + 0.6 * Math.sin((Math.PI * (i + 1)) / (bars + 1));
        const barStyle = {
          '--wave-envelope': envelope.toFixed(3),
          animationDelay: `${-i * STAGGER_MS}ms`,
        } as CSSProperties;
        return <span key={i} className="wave-bar" style={barStyle} />;
      })}
    </div>
  );
}
