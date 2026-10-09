// Whether the tests that spend REAL Claude tokens may run.
//
// Two of them exist — `real-backend.integration.test.ts` and
// `mcp-tools-real-sdk.integration.test.ts` — and they drive the genuine SDK
// against the host's OAuth credential. They are opt-in, and the deploy gate does
// not opt in.
//
// Why: cost is the reason a harness stops being run, and these turned that from
// a principle into an outage. Once the account hit its monthly spend limit, both
// tests began failing with `You've hit your monthly spend limit`, the verify gate
// failed at stage 3, and NOTHING could deploy — not a one-line server fix, not
// the fix for the very bug that was being chased. A paid dependency in the gate
// makes delivery hostage to a billing state, and a spend limit is not a product
// regression.
//
// This is the shape CLAUDE.md already prescribes: "Replay generated output
// (model, TTS) by default; paying is an explicit flag for when the writing itself
// is under test."
//
// What is NOT lost: the tool wire shapes and every host-side effect these
// assert are covered mock-backed in `mcp-tools.test.ts` (in-memory MCP client),
// `cross-chat-tools.test.ts` and `mcp-spawn-error.test.ts`. What IS lost while
// they are off is the claim that a real model, steered only by a folder's
// CLAUDE.md, chooses to call the tools at all — so run them deliberately before
// a release, and after any change to the MCP surface:
//
//   PATCH_REAL_CLAUDE=1 pnpm --filter @patch/daemon exec vitest run test/real-backend.integration.test.ts
//   PATCH_REAL_CLAUDE=1 pnpm --filter @patch/daemon exec vitest run test/mcp-tools-real-sdk.integration.test.ts

/**
 * True only when someone has explicitly asked to spend money on this run.
 *
 * Deliberately an opt-IN with no "unless CI" escape hatch: an env var that
 * defaults to spending is how the gate ends up paying again.
 */
export function realClaudeEnabled(): boolean {
  return process.env['PATCH_REAL_CLAUDE'] === '1';
}

/** Why a real-Claude test skipped, for a log line that is not just silence. */
export const REAL_CLAUDE_SKIP_REASON =
  'opt-in: set PATCH_REAL_CLAUDE=1 to run the tests that spend real Claude tokens';
