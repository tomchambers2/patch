// Window chrome — spec/05 § Desktop packaging (Electron) → Window chrome.
//
// The shell's document windows (the singleton main window and every child
// window from spec/14 § New windows) draw the SPA all the way to the window's
// top edge instead of hanging it under a native title bar: Tom, App Updates —
// "clean at top, no patch top bar. window extends right to top of screen".
//
// macOS ONLY, deliberately. `titleBarStyle: 'hidden'` there hides the bar but
// keeps the traffic lights floating over the content, so close/minimise/zoom
// all survive. On Windows and Linux the same option removes the window
// controls outright and puts nothing back (the Window Controls Overlay needs
// `titleBarOverlay`, which draws a bar again — the thing being removed), and
// Patch's own ⌘W only HIDES the main window, so a window opened that way could
// not be closed, minimised or zoomed at all. Those platforms keep their frame.
//
// `frame: false` was the other option and is rejected for the same reason: it
// takes the traffic lights with it, leaving Tom a window he cannot close.

/** BrowserWindow options that produce the overlay (hidden) title bar. */
export type WindowChrome = {
  titleBarStyle?: 'hidden';
  trafficLightPosition?: { x: number; y: number };
};

/** Diameter of a macOS traffic light, so `y` can be given as a centre-line. */
export const TRAFFIC_LIGHT_DIAMETER = 12;

/**
 * Where the traffic lights are pinned once the bar behind them is gone. The
 * default position assumes a title bar's height; with the bar hidden they would
 * ride higher than the app's own top row. `x` matches the top rows' feel; `y`
 * is the TOP of the lights, chosen so their centre lands on the sidebar brand
 * row's centre-line — the wordmark sits immediately right of them, and lights
 * a few pixels above its optical centre read as a stagger rather than a row.
 *
 * MIRRORED by `--overlay-titlebar-lights-centre` in packages/web/src/index.css;
 * window-chrome.test.ts reads that file and holds the two together.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 31 } as const;

/**
 * Width (px) of the top-left strip the SPA must keep clear of the traffic
 * lights: three 12px buttons on a 20px pitch from `TRAFFIC_LIGHT_POSITION.x`
 * (18 + 52 = 70) plus breathing room.
 *
 * MIRRORED by `--overlay-titlebar-inset` in `packages/web/src/index.css`.
 * The renderer is a separate bundle served over HTTP — it cannot import this
 * constant — so the two are kept in step by hand and asserted by
 * `window-chrome.test.ts`, which reads the stylesheet.
 */
export const TRAFFIC_LIGHT_INSET = 84;

/**
 * Whether this platform can hide the title bar and still leave the user a way
 * to close the window. Also what `preload.ts` hands the renderer, so the SPA
 * only reserves the traffic-light strip on a window that actually has one.
 */
export function overlayTitleBarSupported(platform: string): boolean {
  return platform === 'darwin';
}

/** Chrome options to spread into a document window's BrowserWindow config. */
export function windowChrome(platform: string): WindowChrome {
  if (!overlayTitleBarSupported(platform)) return {};
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
  };
}
