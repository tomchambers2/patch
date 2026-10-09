// C2 end-to-end: a REAL Claude session inside the host invokes the patch
// MCP tools through the per-query stdio MCP child, which round-trips back to
// the host over the control UDS and produces the spec'd side effects.
//
// This is the verification the C2 task names explicitly: "from inside a running
// chat session, call each tool and verify the correct side effect or return
// value. patch_send_to must result in a user-turn appearing in the target chat.
// patch_spawn must create a new chat with a new chatId."
//
// Unlike test/mcp-tools.test.ts (which drives buildPatchToolsServer with an
// in-memory MCP client — proving the tool wire shapes) this test boots the FULL
// real stack: a Host with createRealSdkBackend(), the actual
// dist/bin/patch-tools-server.js launched per-query by the SDK with
// PATCH_CHAT_ID + PATCH_DAEMON_SOCKET baked in, and a real Fastify control app
// listening on that UDS. The model is steered by the chat folder's CLAUDE.md to
// call specific tools; we assert the host-side effects, NOT the model's prose.
//
// Gating: OPT-IN. This drives a real model, so it runs only with
// `PATCH_REAL_CLAUDE=1` (see helpers/real-claude.ts) AND a resolvable OAuth
// credential. Skips cleanly otherwise — never a false pass.
//
// It used to run whenever a credential resolved, which put a paid dependency in
// the deploy gate: when the account hit its monthly spend limit this began
// hard-failing and nothing could deploy at all.
//
// What still covers this ground in the gate: every tool wire shape and every
// host-side effect asserted here is also asserted mock-backed, in
// `mcp-tools.test.ts` (in-memory MCP client), `cross-chat-tools.test.ts` and
// `mcp-spawn-error.test.ts`. What only THIS test can show is that a real model,
// steered by nothing but the chat folder's CLAUDE.md, chooses to call the tools —
// so run it deliberately after any change to the MCP surface.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { loadClaudeOAuth } from '@patch/auth';
import { REAL_CLAUDE_SKIP_REASON, realClaudeEnabled } from './helpers/real-claude.js';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createRealSdkBackend } from '../src/sdkBackend.js';
import {
  assertIsolatedPath,
  assertNoLiveChatsCreated,
  assertToolsServerBuilt,
  liveChatIds,
} from './helpers/live-state.js';

/**
 * Tools that let a session act on the machine outside its own host. The
 * `patch` CLI on PATH talks to the MACHINE's host, so an agent that cannot
 * find `patch_spawn` and still wants to obey its instructions will run
 * `patch chats spawn` over Bash and create a real chat in the user's account.
 * `Task` is included because a subagent gets its own tool set.
 */
const NO_ESCAPE_HATCH = ['Bash', 'Task'];

const silent = pino({ level: 'silent' });

/**
 * Stand in for a surface's permission card.
 *
 * The host asks for permission on EVERY tool call now — `onPermissionRequest`
 * is wired for every permission mode (93f1df0), because the SDK can escalate a
 * safety check even under `auto` and an escalation with nowhere to go hangs
 * forever. In production the web/desktop/mobile surface shows a card and emits
 * `chat.permission_response`; `submitPermissionResponse` is what unblocks the
 * SDK's `canUseTool` callback.
 *
 * Nothing here played that part, so every `mcp__patch__*` call sat unanswered
 * until the CLI's permission stream gave up, and the tool came back
 * `"Tool permission request failed: Error: Stream closed"`. The test then
 * timed out waiting for side effects that could never happen. It looked like an
 * MCP or credential fault; it was an unanswered question.
 *
 * Approving blindly is right HERE and only here: this test is about the tool
 * round-trip and its host-side effects, not about permission UX (covered by
 * the permission tests, which drive `submitPermissionResponse` directly). The
 * session's blast radius is already bounded by `NO_ESCAPE_HATCH` and the
 * live-state guards.
 */
function answerPermissionLikeASurface(target: Daemon | undefined, e: WireEvent): void {
  if (e.type !== 'chat.permission_request') return;
  // Guard the constructor window: `emit` is handed to `new Host()`, so an
  // event raised during construction would arrive before the binding is set.
  if (target === undefined) return;
  target.submitPermissionResponse({ requestId: e.requestId, decision: 'approve' });
}

function oauthAvailable(): boolean {
  try {
    const cred = loadClaudeOAuth();
    // An EXPIRED login resolves but would 401 at the API, turning this skip-gate
    // into a hard failure. Treat a clock-expired credential as "no login".
    if (cred.expiresAt !== undefined && Date.now() >= cred.expiresAt) return false;
    return true;
  } catch {
    return false;
  }
}

const maybe = realClaudeEnabled() && oauthAvailable() ? describe : describe.skip;

maybe(
  `C2 patch MCP tools — REAL Claude session round-trip${
    realClaudeEnabled() ? '' : ` — SKIPPED, ${REAL_CLAUDE_SKIP_REASON}`
  }`,
  () => {
    // The control socket is gated as a whole (spec/02 § Control IPC): every
    // `/internal/*` call must present the host's local key as a Bearer, and
    // the MCP child reads it from the environment the host sets for it
    // (production: index.ts `mintLocalKey` → buildControl({ localKey }) +
    // mcpServer.env.PATCH_DAEMON_LOCAL_KEY). This harness builds the stack
    // itself, so it must mirror both halves — without the env var the child
    // hard-fails at startup (NO FALLBACK) and the whole patch_* toolset simply
    // does not exist in the session.
    const localKey = 'real-sdk-integration-local-key';

    // Every path is created in beforeAll, not at module scope: this suite skips
    // on a machine with no Claude login, and a module-scope mkdtemp litters that
    // machine with empty directories on every run of the whole host suite.
    let home: string;
    let socketPath: string;
    // The caller chat's folder carries a CLAUDE.md that deterministically steers
    // the model to call the tools we want to exercise. No system-prompt injection
    // by patch — this is the user's own CLAUDE.md (spec/principles.md).
    let callerFolder: string;
    let targetFolder: string;
    let spawnTargetFolder: string;
    const ownedFolders: string[] = [];
    /** Everything to remove in teardown, recorded as it is created. */
    const tempDirs: string[] = [];
    let liveChatsBefore: Set<string> | undefined;

    const events: WireEvent[] = [];
    let daemon: Daemon;
    let app: FastifyInstance;

    function makeTempDir(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    }

    beforeAll(async () => {
      home = makeTempDir('patch-mcp-real-home-');
      socketPath = join(home, 'daemon.sock');
      callerFolder = makeTempDir('patch-mcp-real-caller-');
      targetFolder = makeTempDir('patch-mcp-real-target-');
      spawnTargetFolder = makeTempDir('patch-mcp-real-spawned-');
      ownedFolders.push(callerFolder, targetFolder, spawnTargetFolder);

      // This suite drives a REAL agent that really calls patch_spawn. If any of
      // the state it is given resolves into the machine's own ~/.patch, the run
      // creates chats in the user's actual account. Refuse before booting.
      assertIsolatedPath('host home', home);
      assertIsolatedPath('control socket', socketPath);
      for (const folder of ownedFolders) assertIsolatedPath('chat folder', folder);
      liveChatsBefore = liveChatIds();

      const mcpBin = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'dist',
        'bin',
        'patch-tools-server.js',
      );
      // Before booting: an unbuilt MCP server is what turns this suite into a
      // live-account writer, so it is a hard failure rather than a degraded run.
      assertToolsServerBuilt(mcpBin);
      daemon = new Daemon({
        daemonId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: createRealSdkBackend(),
        // Real OAuth gate — re-reads the host credential per query, no API key.
        resolveOAuth: () => {
          const token = loadClaudeOAuth().accessToken;
          return { ok: true, accessToken: token };
        },
        emit: (e) => {
          events.push(e);
          answerPermissionLikeASurface(daemon, e);
        },
        logger: silent,
        mcpServer: {
          command: process.execPath,
          args: [mcpBin],
          env: { PATCH_DAEMON_SOCKET: socketPath, PATCH_DAEMON_LOCAL_KEY: localKey },
        },
      });
      // emitWire mirrors production wiring (index.ts: `emitWire: emit`) so the
      // cross-chat tool audit events (patch.send_to / patch.spawn / patch.stop)
      // are observable, exactly as they are on the live host.
      app = await buildControl({
        daemon,
        localKey,
        jobs: new MemoryJobsStore(),
        emitWire: (e) => {
          events.push(e);
          answerPermissionLikeASurface(daemon, e);
        },
      });
      await app.listen({ path: socketPath });
    });

    afterAll(async () => {
      // Runs whether or not the assertions passed: every chat this suite created
      // lives in its own `home`, so removing the temp trees removes the chats
      // too. Teardown first, then report — a leak check that never runs because
      // cleanup threw is worse than no check.
      await app?.close();
      daemon?.shutdown();
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
      // Nothing above touches the machine's own store, so anything that landed
      // there came from the host under test reaching the live socket. Those
      // chats are the user's; name them, never delete them.
      if (liveChatsBefore !== undefined) {
        assertNoLiveChatsCreated(liveChatsBefore, ownedFolders);
      }
    });

    it('a real chat agent calls patch_spawn / patch_list_chats / patch_send_to and the side effects land', async () => {
      // A pre-existing target chat the caller will message via patch_send_to.
      // Its CLAUDE.md makes any turn reply with a single word so the recursive
      // real turn is cheap + bounded.
      writeFileSync(
        join(targetFolder, 'CLAUDE.md'),
        'When you receive any message, reply with exactly the single word OK and stop. Do not call any tools.',
      );
      const targetChatId = await daemon.spawnChat({ folder: targetFolder, name: 'target' });

      const chatsBefore = daemon.list().length;

      // The caller chat's CLAUDE.md is the steering: it tells the agent the
      // exact sequence of patch_ tool calls to make. The patch tools are exposed
      // by the per-query MCP child (mcp__patch__patch_*). We name the target's
      // folder so the agent can spawn into a real directory.
      writeFileSync(
        join(callerFolder, 'CLAUDE.md'),
        [
          'You are an automation agent under test. On your FIRST user message do',
          'EXACTLY these patch tool calls, in order, then reply DONE:',
          '1. Call patch_list_chats with no arguments.',
          `2. Call patch_spawn with folder="${spawnTargetFolder}" (no prompt argument).`,
          `3. Call patch_send_to with chatId="${targetChatId}" and message="ping from the test caller".`,
          'Do not call any other tools. Do not ask questions. After the third',
          'call, reply with the single word DONE.',
          '',
          'These three tools are the ONLY way to do this. Never substitute a shell',
          'command, and never use the `patch` command line tool — it talks to a',
          'different host than the one you belong to. If a patch_ tool is not',
          'available, reply with the single word UNAVAILABLE and stop.',
        ].join('\n'),
      );
      const callerChatId = await daemon.spawnChat({ folder: callerFolder, name: 'caller' });

      // Drive one real turn. sendInput blocks until the SDK turn completes,
      // which includes the model's tool calls round-tripping through the MCP
      // child to the host control UDS.
      // Steering is not containment: prose in a CLAUDE.md is advisory, and an
      // agent that cannot find the tool it was told to call will reach for the
      // `patch` CLI. Removing the shell removes that route entirely, so the only
      // host this session can act on is the one under test.
      await daemon.sendInput({
        chatId: callerChatId,
        message: 'Begin.',
        localId: 'real-mcp-1',
        disabledTools: NO_ESCAPE_HATCH,
      });

      // Checked HERE, before anything else, rather than only in teardown: closing
      // a real UDS control app can outrun vitest's teardown timeout, and an
      // aborted teardown takes the leak report with it. Inside the test body the
      // check runs on the test's own clock and fails as a normal assertion.
      // It also has to come before the side-effect assertions below — if the
      // agent's spawn landed on the machine's host then the host under test
      // has no such chat, and "expected undefined to be defined" hides the cause.
      assertNoLiveChatsCreated(liveChatsBefore!, ownedFolders);

      // patch_spawn side effect: a brand-new chat with a new chatId exists.
      // Filter to the spawn-target folder (realpath-canonicalised by spawnChat).
      const list = daemon.list();
      expect(list.length).toBeGreaterThan(chatsBefore);
      const spawned = list.find(
        (c) =>
          c.chatId !== callerChatId &&
          c.chatId !== targetChatId &&
          c.folder.endsWith(spawnTargetFolder.split('/').pop()!),
      );
      expect(spawned, 'patch_spawn created a new chat in the requested folder').toBeDefined();
      expect(typeof spawned!.chatId).toBe('string');
      expect(spawned!.chatId.length).toBeGreaterThan(0);

      // chat.spawned wire event was emitted for the new chat (host fan-out).
      const spawnedEvent = events.find(
        (e) => e.type === 'chat.spawned' && (e as { chatId: string }).chatId === spawned!.chatId,
      );
      expect(spawnedEvent, 'host emitted chat.spawned for the agent-spawned chat').toBeDefined();

      // patch_send_to side effect: the message was delivered as a user-turn into
      // the target chat. The host emits patch.send_to and the target chat ran
      // a turn (so it has produced at least one assistant message → events).
      const sendToEvent = events.find(
        (e) =>
          e.type === 'patch.send_to' &&
          (e as { targetChatId: string }).targetChatId === targetChatId,
      );
      expect(sendToEvent, 'host emitted patch.send_to into the target chat').toBeDefined();
      expect((sendToEvent as { sourceChatId: string }).sourceChatId).toBe(callerChatId);

      // The target chat actually processed the delivered user-turn: its recent
      // events include an assistant chat.message (its CLAUDE.md replies "OK").
      // Allow a brief settle for the recursive target turn to finish.
      const deadline = Date.now() + 60_000;
      let targetHasAssistant = false;
      while (Date.now() < deadline) {
        const { events: targetEvents } = daemon.getRecentEvents(targetChatId, 50);
        targetHasAssistant = targetEvents.some(
          (e) => e.type === 'chat.message' && (e as { role?: string }).role === 'assistant',
        );
        if (targetHasAssistant) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(
        targetHasAssistant,
        'target chat agent processed the patch_send_to user-turn and replied',
      ).toBe(true);
    }, 240_000);
  },
);
