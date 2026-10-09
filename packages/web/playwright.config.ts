import { defineConfig } from '@playwright/test';

// UI / layout tests in a REAL browser — the things jsdom can't verify (computed
// styles, element heights). They run against the DEV HARNESS (dev-harness.html),
// which mounts the real components with the real CSS and needs no backend/auth.
// The vite dev server serves files fresh from disk, so this reflects the current
// working tree.
// The machine this runs on is shared — it hosts the agents' own chats, and any
// of them may have a dev server on the default port. With `reuseExistingServer`
// this run would silently ADOPT that server: a different working tree, torn
// down whenever its owner finishes. That is what it looks like when whole spec
// files fail at once with ERR_CONNECTION_REFUSED, or popups resolve to "/"
// because the server they were opening against had just gone.
//
// Set PATCH_PW_PORT to give a run a port of its own. It then starts and owns its
// server and never adopts a stranger's. Unset, the behaviour is unchanged: the
// default port, reused when convenient — which is what you want at a desk.
const PORT = Number(process.env['PATCH_PW_PORT'] ?? 5173);
const OWN_PORT = process.env['PATCH_PW_PORT'] !== undefined;

export default defineConfig({
  testDir: './e2e',
  // Budgets sized for the machine this ACTUALLY runs on, which is never idle.
  //
  // The box hosts every agent's chats, so a deploy's browser suite routinely runs
  // beside several others' test runs and builds: load 20-37 on 8 cores is
  // ordinary. Three consecutive deploys failed this gate on NINE different specs,
  // every failure a timeout — 9s, 14s, 31s on assertions that take milliseconds —
  // and each one passed on its own on that same box (document-title 30/30). The
  // gate was reporting "broken" when it meant "starved", and a gate that cries
  // wolf is one people start deploying around.
  //
  // This deliberately does NOT add retries. A retry makes an intermittent real
  // bug disappear on the second go, which is precisely the failure this codebase
  // refuses to paper over. Raising the budgets hides nothing: an assertion that
  // sees the WRONG VALUE still fails instantly, with that value. All that changes
  // is the implicit "…and within 5 seconds" claim — which no spec here ever meant
  // to make, and which was only ever true on an empty machine.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    // vite directly, NOT `pnpm run dev`: pnpm forwards a literal `--` through to
    // the script, vite then reads the flags after it as positional arguments
    // and silently keeps its default port — so the server comes up somewhere
    // the tests never look and the run dies waiting for it. `--strictPort` so a
    // port that is somehow taken fails loudly rather than letting vite drift to
    // another one, which would be the same silent miss again.
    command: `npx vite --port ${PORT}${OWN_PORT ? ' --strictPort' : ''}`,
    url: `http://localhost:${PORT}/app/dev-harness.html`,
    reuseExistingServer: OWN_PORT ? false : !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
