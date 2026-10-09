import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readBuildInfo, buildInfoDefines } from './build-info';

// Build provenance, from the monorepo's single source of truth
// (scripts/version.mjs). Until this existed, a built bundle's only identity was
// its content hash — so nothing could say WHICH commit the running UI came from,
// and server↔web drift after a deploy was invisible.
const BUILD_INFO = readBuildInfo();

/**
 * Emit `dist/version.json` alongside the bundle. The SERVER reads this to report
 * what SPA it is actually serving (`GET /api/version`) — it must not have to
 * parse minified JS to find out, and the content hash alone can't be mapped back
 * to a commit.
 */
const emitVersionJson = {
  name: 'patch-emit-version-json',
  apply: 'build' as const,
  generateBundle(this: { emitFile: (f: Record<string, unknown>) => void }) {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify(BUILD_INFO, null, 2),
    });
  },
};

// The web SPA is served by Caddy under `/app/` in production, so all asset
// URLs need to be prefixed with `/app/`. The Vite dev server uses the same
// base so the Electron shell + reverse proxy behave identically.
//
// Dev override: the API/WS proxy target defaults to the docker test stack
// (`localhost:13000`) but can be repointed with `PATCH_API_PROXY` so the local
// dev-auth harness (a fresh server on its own port with a writable dataDir)
// can be driven without colliding with the docker stack. Use an explicit
// 127.0.0.1 form when overriding to avoid the localhost→IPv6 ambiguity that
// lets a stray `::1:13000` listener (e.g. docker) silently shadow the dev
// server.
const apiProxy = process.env.PATCH_API_PROXY ?? 'http://localhost:13000';
const wsProxy = apiProxy.replace(/^http/, 'ws');

// The host's per-session audio WSS (`/audio/<sessionId>`, spec/07) is a
// DIRECT host endpoint (the server is not in the audio path — spec/01). In
// dev the host's audio port is 3013 (PATCH_DAEMON_AUDIO_PORT); proxy `/audio`
// to it so the browser reaches the audio plane same-origin via :5173, matching
// the production topology where Caddy fronts it. Default 127.0.0.1 (not
// localhost) to dodge the IPv6 shadow trap.
const audioPort = process.env.PATCH_DAEMON_AUDIO_PORT ?? '3013';
const audioProxy = `ws://127.0.0.1:${audioPort}`;

// DEV-ONLY auth seam for automated e2e: when the dev bring-up exports
// PATCH_DEV_WEB_CREDENTIAL (a minted `web` JWT), seed the surface
// credential straight into localStorage before the app bundle loads, so
// http://localhost:5173/app/ boots AUTHENTICATED with no ?credential= param or
// pairing step. `apply: 'serve'` means this never touches a production build —
// and production is served by the server/Caddy, not this dev server, so the
// seam cannot reach prod. NO FALLBACK: only active when the env var is present.
const devCredential = process.env.PATCH_DEV_WEB_CREDENTIAL;
const devAuthSeed = {
  name: 'patch-dev-auth-seed',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    if (!devCredential) return html;
    const tag = `<script>try{localStorage.setItem('patch.credential.v1',${JSON.stringify(devCredential)})}catch(e){}</script>`;
    return html.replace('</head>', `${tag}</head>`);
  },
};

export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss(), devAuthSeed, emitVersionJson],
  define: buildInfoDefines(BUILD_INFO),
  server: {
    port: 5173,
    // NO FALLBACK: the frontend e2e tests target http://localhost:5173/app/,
    // so that contract depends on this server owning 5173. Silently
    // bumping to 5174 when another dev server squats 5173 hides the collision
    // and makes a reviewer test the wrong app on 5173. Fail loudly instead.
    strictPort: true,
    proxy: {
      '/api': apiProxy,
      '/ws': { target: wsProxy, ws: true },
      '/audio': { target: audioProxy, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
