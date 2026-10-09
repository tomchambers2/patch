import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Waveform } from '../components/Waveform.js';

afterEach(cleanup);

describe('Waveform', () => {
  it('clamps the level into [0,1] and renders the default 12 bars', () => {
    render(<Waveform level={1.5} />);
    const el = screen.getByTestId('waveform');
    expect(el.getAttribute('data-level')).toBe('1.00');
    expect(el.querySelectorAll('.wave-bar')).toHaveLength(12);
  });

  it('clamps a negative level to 0', () => {
    render(<Waveform level={-0.5} />);
    expect(screen.getByTestId('waveform').getAttribute('data-level')).toBe('0.00');
  });

  it('renders a custom bar count', () => {
    render(<Waveform level={0.5} bars={5} />);
    expect(screen.getByTestId('waveform').querySelectorAll('.wave-bar')).toHaveLength(5);
  });

  it('applies a custom className alongside the base class', () => {
    render(<Waveform level={0.5} className="my-wave" />);
    expect(screen.getByTestId('waveform').className).toBe('waveform my-wave');
  });

  it('omits the extra space when no className is given', () => {
    render(<Waveform level={0.5} />);
    expect(screen.getByTestId('waveform').className).toBe('waveform');
  });

  // --- Improved animation (patch/todo.md: "Improve the animation of the voice
  // note"). The bars must animate continuously with a per-bar stagger so the
  // pulse travels across the row, and their amplitude must be driven by the
  // live mic level — not sit frozen at a level-derived height.

  it('exposes the clamped level as a CSS custom property so the animation amplitude tracks the voice', () => {
    render(<Waveform level={0.42} />);
    const el = screen.getByTestId('waveform');
    expect(el.style.getPropertyValue('--wave-level')).toBe('0.42');
  });

  it('clamps the level custom property into [0,1]', () => {
    const { rerender } = render(<Waveform level={1.5} />);
    expect(screen.getByTestId('waveform').style.getPropertyValue('--wave-level')).toBe('1');
    rerender(<Waveform level={-2} />);
    expect(screen.getByTestId('waveform').style.getPropertyValue('--wave-level')).toBe('0');
  });

  it('staggers each bar with a distinct animation-delay so the pulse travels across the row', () => {
    render(<Waveform level={0.5} bars={6} />);
    const bars = Array.from(
      screen.getByTestId('waveform').querySelectorAll<HTMLElement>('.wave-bar'),
    );
    const delays = bars.map((b) => b.style.animationDelay);
    // Every bar carries a delay …
    expect(delays.every((d) => d !== '')).toBe(true);
    // … and they are not all identical (a traveling wave, not lockstep).
    expect(new Set(delays).size).toBe(bars.length);
  });

  it('gives each bar its envelope as a custom property, taller in the middle than at the edges', () => {
    render(<Waveform level={0.8} bars={7} />);
    const bars = Array.from(
      screen.getByTestId('waveform').querySelectorAll<HTMLElement>('.wave-bar'),
    );
    const envelopes = bars.map((b) => Number(b.style.getPropertyValue('--wave-envelope')));
    expect(envelopes.every((e) => e > 0)).toBe(true);
    const mid = Math.floor(bars.length / 2);
    const [first] = envelopes;
    const last = envelopes[envelopes.length - 1];
    const middle = envelopes[mid];
    expect(middle).toBeGreaterThan(first as number);
    expect(middle).toBeGreaterThan(last as number);
  });
});
