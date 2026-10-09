// What preload.ts hands the renderer on a window whose title bar is hidden —
// the one value the SPA's overlay-titlebar layout keys off.
window.patch = { overlayTitleBar: true };
