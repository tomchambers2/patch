/// <reference types="vite/client" />

// Build provenance, injected as compile-time literals by `define` in
// vite.config.ts / vitest.config.ts (see ../build-info.ts). Read through
// src/lib/buildInfo.ts rather than referenced directly.
declare const __PATCH_VERSION__: string;
declare const __PATCH_GIT_SHA__: string;
declare const __PATCH_BUILT_AT__: string;
