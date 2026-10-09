// How long since the user last touched this computer (spec/09 § Presence
// heuristic), for the `surface.input` report the server routes notifications
// by: at the computer, a notification goes to the desktop and the phone stays
// in the pocket; away from it, the phone.
//
// In the desktop app the answer is the whole machine's input idle time, so
// typing in any app counts. A browser tab cannot see past its own page, so
// there the answer is input on this page — a narrower question, and the report
// says which one it answered.

import type { WireEvent } from '@patch/wire';
import { getDesktopBridge } from './desktopBridge.js';

/** How often a surface reports. The server treats three missed reports as silence. */
export const INPUT_REPORT_INTERVAL_MS = 15_000;

type InputReport = Extract<WireEvent, { type: 'surface.input' }>;

let lastPageInputAt = Date.now();
let listening = false;

function markInput(): void {
  lastPageInputAt = Date.now();
}

/** Start noting input on this page. Idempotent. */
export function listenForPageInput(): void {
  /* v8 ignore next -- jsdom always defines `window`; this SSR guard can't be hit under vitest+jsdom. */
  if (listening || typeof window === 'undefined') return;
  listening = true;
  for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) {
    window.addEventListener(type, markInput, { capture: true, passive: true });
  }
}

/**
 * The report to send now. Rejects when the desktop shell cannot say — a
 * shell that has the method but fails is an error to see, not a reason to
 * quietly report the page's narrower answer as if it were the machine's.
 */
export async function readInputReport(now: number = Date.now()): Promise<InputReport> {
  const bridge = getDesktopBridge();
  if (bridge?.getSystemIdleMs) {
    const idleMs = Math.max(0, Math.round(await bridge.getSystemIdleMs()));
    return { type: 'surface.input', idleMs, scope: 'system' };
  }
  return { type: 'surface.input', idleMs: Math.max(0, now - lastPageInputAt), scope: 'page' };
}

/** Test seam. */
export function __setLastPageInputAt(at: number): void {
  lastPageInputAt = at;
}
