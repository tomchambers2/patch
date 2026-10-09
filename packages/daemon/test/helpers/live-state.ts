// Guards that keep a test out of the machine's own Patch state.
//
// A test that boots a real host supplies its own directory and its own
// socket. If any of that resolves into the machine's live `~/.patch`, the run
// is creating real chats in the user's account, which is indistinguishable
// from the user's own until someone reads the folder path. These assertions
// fail loudly instead, naming the path.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** The machine's own Patch state directory. Mirrors config.ts. */
export function livePatchHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['PATCH_HOME'] ?? join(homedir(), '.patch');
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Throws unless `p` sits outside the machine's own Patch state. `label` names
 * what the path is for, so the failure says which knob was wrong.
 */
export function assertIsolatedPath(
  label: string,
  p: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const live = resolve(livePatchHome(env));
  const target = resolve(p);
  if (isInside(target, live)) {
    throw new Error(
      `${label} resolves to ${target}, inside this machine's live Patch state (${live}). ` +
        'A test supplies its own directory and socket — refusing to run against live state.',
    );
  }
}

/**
 * Throws unless the patch tools MCP server has been built.
 *
 * This is an isolation guard, not a convenience check. The MCP server is how a
 * test's agent reaches the test's OWN host. When the binary is missing the
 * child dies at startup, the `patch_*` tools are simply absent from the
 * session, and an agent told to call them improvises with the next thing that
 * looks right — the `patch` CLI over Bash, which dials the MACHINE's host and
 * creates real chats in the user's account. A missing build must therefore fail
 * the run, never degrade it.
 */
export function assertToolsServerBuilt(binPath: string): void {
  if (existsSync(binPath)) return;
  throw new Error(
    `the patch tools MCP server is not built at ${binPath}. Without it the session has no ` +
      "patch_* tools and the agent reaches the machine's own host instead. Build it first: " +
      'corepack pnpm --filter @patch/daemon build',
  );
}

/** The chat ids currently in the machine's own chat store. */
export function liveChatIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const root = join(livePatchHome(env), 'chats');
  if (!existsSync(root)) return new Set();
  return new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );
}

/** The folder a live chat points at, or null when its meta cannot be read. */
function liveChatFolder(chatId: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const raw = readFileSync(join(livePatchHome(env), 'chats', chatId, 'meta.json'), 'utf8');
    const folder = (JSON.parse(raw) as { folder?: unknown }).folder;
    return typeof folder === 'string' ? folder : null;
  } catch {
    return null;
  }
}

/**
 * Throws if the machine's chat store gained a chat pointing into one of
 * `ownedFolders` — the folders this test created.
 *
 * Scoped to owned folders on purpose: the machine's real host keeps serving
 * the user while the suite runs, so an unrelated chat appearing mid-run is not
 * this test's doing. A chat whose meta cannot be read is reported rather than
 * assumed innocent, since its folder is unknown.
 */
export function assertNoLiveChatsCreated(
  before: Set<string>,
  ownedFolders: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const owned = ownedFolders.map((f) => resolve(f));
  const leaked: string[] = [];
  for (const chatId of liveChatIds(env)) {
    if (before.has(chatId)) continue;
    const folder = liveChatFolder(chatId, env);
    if (folder === null) {
      leaked.push(`${chatId} (folder unknown — meta unreadable)`);
      continue;
    }
    if (owned.some((o) => isInside(resolve(folder), o))) leaked.push(`${chatId} (${folder})`);
  }
  if (leaked.length === 0) return;
  throw new Error(
    `this test created ${leaked.length} chat(s) in the machine's live Patch state ` +
      `(${join(livePatchHome(env), 'chats')}): ${leaked.join(', ')}. ` +
      'They belong to the user and are NOT deleted automatically — the host under test ' +
      'reached the live socket instead of its own.',
  );
}
