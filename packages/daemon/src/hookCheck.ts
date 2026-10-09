// Message hooks — the host half (spec/20-hooks.md).
//
// A hook's `hook.check_request` arrives with either a `script` (run on this
// host, message+context JSON on stdin) or a `prompt` (a one-shot, tool-less
// model query on this host's own backend — no separate paid API, the same
// credential gate a real chat turn uses). Either way the host answers
// `hook.check_result`, never silently.

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
import type { HookCheckRequestEvent, WireEvent } from '@patch/wire';
import { HookCheckOutcome } from '@patch/wire/hooks';
import { expandHome } from './expandHome.js';
import type { SdkBackend } from './sdkBackend.js';
import type { OAuthCheckResult } from './chatRunner.js';

/** Keep stdout/stderr from growing unbounded in the reply. */
const OUTPUT_TAIL_LIMIT = 4000;
function tail(s: string): string {
  const t = s.trimEnd();
  return t.length <= OUTPUT_TAIL_LIMIT ? t : `…${t.slice(t.length - OUTPUT_TAIL_LIMIT)}`;
}

/**
 * Parse a hook's stdout/model reply per spec/20-hooks.md § Outcome: empty →
 * pass; otherwise must parse as `HookCheckOutcome` JSON, allowing it to be
 * wrapped in a ```json fenced block (the common way a model replies).
 */
export function parseHookOutcome(raw: string): HookCheckOutcome | null {
  const trimmed = raw.trim();
  if (trimmed === '') return { decision: 'pass' };
  const unfenced = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  const result = HookCheckOutcome.safeParse(parsed);
  return result.success ? result.data : null;
}

export interface HandleHookCheckDeps {
  sdkBackend: SdkBackend;
  resolveOAuth: (model?: string) => OAuthCheckResult | Promise<OAuthCheckResult>;
  logger: Logger;
}

export async function handleHookCheck(
  event: HookCheckRequestEvent,
  sender: (e: WireEvent) => void,
  deps: HandleHookCheckDeps,
): Promise<void> {
  const started = Date.now();
  const reply = (r: {
    status: 'ok' | 'failed' | 'timeout';
    outcome?: HookCheckOutcome;
    error?: string;
  }): void => {
    sender({
      type: 'hook.check_result',
      requestId: event.requestId,
      hookId: event.hookId,
      status: r.status,
      ...(r.outcome !== undefined ? r.outcome : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      durationMs: Date.now() - started,
    });
  };

  if (event.kind === 'script') {
    runScriptHook(event, reply, deps.logger);
    return;
  }
  await runPromptHook(event, reply, deps);
}

function runScriptHook(
  event: HookCheckRequestEvent,
  reply: (r: {
    status: 'ok' | 'failed' | 'timeout';
    outcome?: HookCheckOutcome;
    error?: string;
  }) => void,
  logger: Logger,
): void {
  const script = event.script;
  if (!script) {
    reply({ status: 'failed', error: 'script hook carried no command' });
    return;
  }
  const folder = expandHome(event.context.folder);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    reply({ status: 'failed', error: `folder not found on this host: ${event.context.folder}` });
    return;
  }
  const stdin = JSON.stringify({
    message: event.context.message,
    chatId: event.context.chatId,
    folder: event.context.folder,
    daemonId: event.context.daemonId,
    specialThread: event.context.specialThread,
  });
  // Same login-then-plain-shell shape as a job's `script` action
  // (`jobExec.ts`) — see that file for why `exec` matters here.
  const child = execFile(
    '/bin/bash',
    ['-lc', 'exec /bin/bash -c "$PATCH_HOOK_COMMAND"'],
    {
      cwd: folder,
      env: { ...process.env, PATCH_HOOK_COMMAND: script.command },
      timeout: event.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
    },
    (err, stdout, stderr) => {
      if (err !== null) {
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        logger.warn(
          { hookId: event.hookId, err: err.message, killed },
          'hook.check_request: script failed',
        );
        reply({
          status: killed ? 'timeout' : 'failed',
          error: killed
            ? `command killed after its ${event.timeoutMs}ms timeout`
            : `command exited non-zero: ${tail(stderr) || err.message}`,
        });
        return;
      }
      const outcome = parseHookOutcome(stdout);
      if (outcome === null) {
        reply({
          status: 'failed',
          error: `stdout was not the documented JSON shape: ${tail(stdout)}`,
        });
        return;
      }
      reply({ status: 'ok', outcome });
    },
  );
  child.stdin?.write(stdin);
  child.stdin?.end();
  child.unref();
}

function buildPromptHookQuery(event: HookCheckRequestEvent): string {
  const prompt = event.prompt;
  const images = event.context.images?.length ?? 0;
  return [
    prompt?.instructions ?? '',
    '',
    `Message to check: ${event.context.message}`,
    ...(images > 0
      ? [
          '',
          `The message came with ${images} attached image${images === 1 ? '' : 's'}, shown above.`,
        ]
      : []),
    '',
    'Reply with ONLY a JSON object of the shape ' +
      '{"decision":"pass"|"advise"|"block","analysis"?:"...","suggestion"?:"..."}. ' +
      '`analysis` is required unless decision is "pass". No prose outside the JSON.',
  ].join('\n');
}

async function runPromptHook(
  event: HookCheckRequestEvent,
  reply: (r: {
    status: 'ok' | 'failed' | 'timeout';
    outcome?: HookCheckOutcome;
    error?: string;
  }) => void,
  deps: HandleHookCheckDeps,
): Promise<void> {
  const prompt = event.prompt;
  if (!prompt) {
    reply({ status: 'failed', error: 'prompt hook carried no instructions' });
    return;
  }
  const auth = await deps.resolveOAuth(prompt.model);
  if (!auth.ok) {
    reply({ status: 'failed', error: `no credential available: ${auth.reason}` });
    return;
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), event.timeoutMs);
  try {
    let finalText = '';
    let deltaText = '';
    for await (const env of deps.sdkBackend.run({
      prompt: buildPromptHookQuery(event),
      images: event.context.images,
      cwd: expandHome(event.context.folder),
      resumeSessionId: undefined,
      abortController,
      oauthAccessToken: auth.accessToken,
      model: prompt.model,
      permissionMode: 'bypassPermissions',
    })) {
      if (env.type === 'assistant' && env.content) finalText += env.content;
      else if (env.type === 'assistant_delta' && env.content) deltaText += env.content;
      else if (env.type === 'error') {
        throw new Error(env.errorMessage ?? 'hook prompt check: SDK error envelope');
      }
    }
    const raw = finalText !== '' ? finalText : deltaText;
    const outcome = parseHookOutcome(raw);
    if (outcome === null) {
      reply({
        status: 'failed',
        error: `model reply was not the documented JSON shape: ${tail(raw)}`,
      });
      return;
    }
    reply({ status: 'ok', outcome });
  } catch (err) {
    if (abortController.signal.aborted) {
      reply({ status: 'timeout', error: `no answer within ${event.timeoutMs}ms` });
      return;
    }
    deps.logger.warn(
      { hookId: event.hookId, err: (err as Error).message },
      'hook prompt check failed',
    );
    reply({ status: 'failed', error: (err as Error).message });
  } finally {
    clearTimeout(timer);
  }
}
