import { randomUUID } from 'node:crypto';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from './sdkBackend.js';
import { TurnFailedError } from './sdkBackend.js';
import { isAccountExhaustedError } from './accountFailover.js';
import { persistedUserContent } from './history.js';
import { CodexAccounts } from './codexAccounts.js';
import { CodexHistory } from './codexHistory.js';
import type { CodexNotification, RpcObject } from './codexClient.js';
import { toResponsesItems, type TrackEntry } from './nativeReconstruct.js';

/**
 * Whether a `thread/inject_items` failure is the injected track not fitting
 * the model's context window, as opposed to a real bug (a malformed item, a
 * dead connection) that trimming and retrying would only hide.
 */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context.{0,20}(window|length)|too (many|long|large)|token.{0,10}limit|exceeds.{0,20}(context|limit)/i.test(
    message,
  );
}

/**
 * Injects a reseed track's Responses items, trimming the OLDEST track
 * entries and retrying when the target rejects the payload as too big for
 * its context window (spec/04 § History — Codex has no auto-compaction of
 * its own for a freshly-injected thread, unlike Claude Code's own resume).
 * Returns the number of TRACK ENTRIES cut from the front (0 if none).
 * Rethrows any error that isn't a context-overflow shape unchanged.
 */
export async function injectWithTrim(
  events: readonly TrackEntry[],
  inject: (items: ReturnType<typeof toResponsesItems>) => Promise<unknown>,
): Promise<number> {
  let remaining = events;
  let trimmed = 0;
  for (;;) {
    const items = toResponsesItems(remaining);
    if (items.length === 0) return trimmed;
    try {
      await inject(items);
      return trimmed;
    } catch (error) {
      if (!isContextOverflowError(error) || remaining.length <= 1) throw error;
      const cut = Math.max(1, Math.ceil(remaining.length / 2));
      remaining = remaining.slice(cut);
      trimmed += cut;
    }
  }
}

export function codexPermission(mode: SdkRunOptions['permissionMode']): {
  approvalPolicy: string;
  sandbox: string;
} {
  if (mode === 'bypassPermissions')
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (mode === 'plan') return { approvalPolicy: 'on-request', sandbox: 'read-only' };
  if (mode === 'acceptEdits' || mode === 'default')
    return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  throw new Error(
    'Codex does not support Claude auto permissions. Choose default, accept edits, plan, or bypass permissions.',
  );
}
export function codexItem(item: RpcObject, complete: boolean): SdkEnvelope | undefined {
  const envelope = codexItemEnvelope(item, complete);
  return envelope && typeof item.id === 'string' ? { ...envelope, nativeId: item.id } : envelope;
}
/**
 * The model's reasoning on a completed Codex item, as the history log keeps it
 * (spec/04 § History). Undefined for any other item.
 */
export function codexThinking(item: RpcObject, complete: boolean): SdkEnvelope | undefined {
  if (!complete || item.type !== 'reasoning') return undefined;
  const parts = [...(item.summary ?? []), ...(item.content ?? [])].filter(
    (p: unknown): p is string => typeof p === 'string' && p.length > 0,
  );
  if (parts.length === 0) return undefined;
  return {
    type: 'system',
    thinking: parts.join('\n'),
    ...(typeof item.id === 'string' ? { nativeId: item.id } : {}),
  };
}
function codexItemEnvelope(item: RpcObject, complete: boolean): SdkEnvelope | undefined {
  if (item.type === 'agentMessage' && complete) return { type: 'assistant', content: item.text };
  const name =
    item.type === 'commandExecution'
      ? 'Bash'
      : item.type === 'fileChange'
        ? 'Edit'
        : item.type === 'mcpToolCall'
          ? `mcp__${item.server}__${item.tool}`
          : undefined;
  if (!name) return undefined;
  if (!complete)
    return {
      type: 'tool_use',
      tool: {
        name,
        callId: item.id,
        args:
          item.arguments ??
          (item.type === 'commandExecution'
            ? { command: item.command }
            : { changes: item.changes }),
      },
    };
  return {
    type: 'tool_result',
    toolResult: {
      name,
      callId: item.id,
      result: item.aggregatedOutput ?? item.result ?? item.error ?? item.changes ?? '',
      isError: item.status === 'failed' || Boolean(item.error),
    },
  };
}
export class CodexTurnError extends TurnFailedError {
  constructor(
    message: string,
    readonly retrySafe: boolean,
  ) {
    super(message, undefined);
  }
}
/**
 * Codex's `config.mcp_servers` for one turn: `patch` first, then
 * `opts.extraMcpServers` in list order — Claude Code's own discovered config
 * merged ahead of the host's enabled Settings → MCP list, the same set a
 * Claude chat on this host gets (`sdkBackend.ts` `buildSdkEnv`) — and gated the
 * same way: nothing at all when the caller configured no patch tools server.
 */
export function codexMcpServers(
  opts: Pick<SdkRunOptions, 'mcpServer' | 'extraMcpServers'>,
): Record<string, RpcObject> | undefined {
  if (!opts.mcpServer) return undefined;
  const servers: Record<string, RpcObject> = { patch: { ...opts.mcpServer, enabled: true } };
  for (const s of opts.extraMcpServers ?? []) {
    servers[s.name] = { command: s.command, args: s.args, env: s.env, enabled: true };
  }
  return servers;
}

export class CodexBackend implements SdkBackend {
  constructor(
    private accounts: CodexAccounts,
    readonly history: CodexHistory,
  ) {}
  async *run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    const policy = codexPermission(opts.permissionMode);
    if (opts.disabledTools?.length)
      throw new Error('Codex tool exclusions must be configured before running this chat');
    const { accountId } = await this.accounts
      .resolveChosen(opts.accountId, opts.model?.startsWith('openai/api/') ? 'apiKey' : 'chatgpt')
      .catch((error: Error) => {
        throw new CodexTurnError(error.message, true);
      });
    const client = await this.accounts.turnClient(accountId);
    try {
      const prior = opts.resumeSessionId;
      // A non-Codex `prior` is only meaningful as a reconstruction source
      // (spec/04 § History — a seamless switch onto Codex, or reseeding a
      // Codex thread that's gone): `codexReseed` carries the chat's own track
      // to inject into a brand-new thread. Without it, a non-Codex prior is a
      // caller bug — resuming a Claude session id as a Codex thread id would
      // otherwise fail confusingly deep inside the RPC call instead of here.
      if (prior && !prior.startsWith('codex-') && !opts.codexReseed) {
        throw new Error('A Claude session cannot be resumed with Codex without a reseed');
      }
      const config: RpcObject = {};
      const mcpServers = codexMcpServers(opts);
      if (mcpServers) config.mcp_servers = mcpServers;
      const base = {
        model: opts.model?.replace(/^openai\/(?:api\/)?/, ''),
        cwd: opts.cwd,
        ...policy,
        config,
        ...(opts.systemPrompt ? { baseInstructions: opts.systemPrompt } : {}),
        ...(opts.toolsPrompt ? { developerInstructions: opts.toolsPrompt } : {}),
      };
      const point = opts.fork?.resumeAtUuid;
      const reseeding = Boolean(opts.codexReseed);
      const fresh = !prior || (opts.fork && point === null) || reseeding;
      const codexPrior = prior && prior.startsWith('codex-') ? prior : undefined;
      const params = fresh
        ? base
        : {
            ...base,
            threadId: codexPrior!.slice(6),
            path: this.history.providerPath(codexPrior!),
            ...(point?.startsWith('before:')
              ? { beforeTurnId: point.slice(7) }
              : point?.startsWith('through:')
                ? { lastTurnId: point.slice(8) }
                : {}),
          };
      const response = await client.request(
        fresh ? 'thread/start' : opts.fork ? 'thread/fork' : 'thread/resume',
        params,
      );
      const threadId: string = response.thread.id;
      const sessionId = 'codex-' + threadId;
      this.history.begin(sessionId, response.thread.path);
      if (codexPrior && point) this.history.fork(codexPrior, sessionId, point);
      // spec/04 § History — preserve the cached prefix: `codexReseed` rebuilds
      // a fresh thread from the whole track (no prior session on this
      // harness); `codexAppendItems` hands over only the delta into a thread
      // that was just RESUMED above, riding its own existing prompt cache.
      const appendEvents = opts.codexReseed?.events ?? opts.codexAppendItems?.events;
      const seedTrim = appendEvents
        ? await injectWithTrim(appendEvents, (items) =>
            client.request('thread/inject_items', { threadId, items }),
          )
        : 0;
      yield { type: 'system', sessionId, ...(seedTrim > 0 ? { seedTrim } : {}) };
      const queue: CodexNotification[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = client.subscribe((message) => {
        if (message.params.threadId === threadId || message.method === 'patch/processFailed') {
          queue.push(message);
          wake?.();
        }
      });
      let turnId: string | undefined;
      let toolsStarted = false;
      let interruption: Promise<void> | undefined;
      const interrupt = (): void => {
        if (turnId && !interruption)
          interruption = (async () => {
            const descendants = await client.descendants();
            try {
              await client.request('turn/interrupt', { threadId, turnId });
              const deadline = Date.now() + 20000;
              while (Date.now() < deadline) {
                const snapshot = await client.request('thread/read', {
                  threadId,
                  includeTurns: true,
                });
                const turn = snapshot.thread.turns?.find((t: RpcObject) => t.id === turnId);
                if (turn && turn.status !== 'inProgress') {
                  this.history.setPending(sessionId, null);
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              throw new Error('Codex did not confirm interruption');
            } finally {
              client.terminateDescendants(descendants);
              await client.close();
            }
          })();
        wake?.();
      };
      opts.abortController.signal.addEventListener('abort', interrupt, { once: true });
      try {
        const pending = this.history.pending(sessionId);
        let previous: RpcObject | undefined;
        if (pending) {
          const snapshot = await client.request('thread/read', { threadId, includeTurns: true });
          previous = snapshot.thread.turns?.find((t: RpcObject) =>
            t.items?.some((i: RpcObject) => i.type === 'userMessage' && i.clientId === pending.id),
          );
          // Codex records a turn before it runs anything, so a successful read
          // that has no such turn proves the process died first: nothing ran.
          // Drop the marker and send the prompt fresh below. (A failed read
          // throws above and leaves the marker, since that is truly unknown.)
          if (!previous) this.history.setPending(sessionId, null);
        }
        if (pending && previous) {
          this.history.append(sessionId, previous.id, opts.chatId ?? threadId, {
            type: 'user',
            content: persistedUserContent(pending.prompt) ?? pending.prompt,
          });
          toolsStarted =
            previous.items?.some((i: RpcObject) => Boolean(codexItem(i, false))) ?? false;
          if (previous.status === 'inProgress') {
            if (pending.prompt !== opts.prompt)
              throw new Error(
                'The previous Codex turn is still running. Stop it before sending another turn.',
              );
            turnId = previous.id;
          } else {
            this.history.setPending(sessionId, null);
            for (const item of previous.items ?? []) {
              const startedItem = codexItem(item, false);
              if (startedItem)
                this.history.append(sessionId, previous.id, opts.chatId ?? threadId, startedItem);
              const envelope = codexItem(item, true);
              if (envelope) {
                this.history.append(sessionId, previous.id, opts.chatId ?? threadId, envelope);
                if (pending.prompt === opts.prompt) yield envelope;
              }
            }
            if (pending.prompt === opts.prompt) {
              if (previous.status !== 'completed')
                throw new Error(
                  `Previous Codex turn ${previous.status}; its tool actions were not repeated. Send a continuation to resume work.`,
                );
              yield { type: 'result', sessionId };
              return;
            }
          }
        }
        if (!turnId) {
          if (opts.abortController.signal.aborted) throw new Error('Codex turn interrupted');
          const clientId = randomUUID();
          this.history.setPending(sessionId, { id: clientId, prompt: opts.prompt });
          const started = await client.request('turn/start', {
            threadId,
            clientUserMessageId: clientId,
            input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
          });
          turnId = started.turn.id;
        }
        this.history.append(sessionId, turnId!, opts.chatId ?? threadId, {
          type: 'user',
          content: persistedUserContent(opts.prompt) ?? opts.prompt,
        });
        if (opts.abortController.signal.aborted) interrupt();
        while (true) {
          if (opts.abortController.signal.aborted) {
            interrupt();
            await interruption;
            throw new Error('Codex turn interrupted');
          }
          if (!queue.length) {
            let watchdog: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((resolve) => {
              wake = resolve;
              watchdog = setTimeout(resolve, 60000);
            });
            clearTimeout(watchdog);
            if (!queue.length && !opts.abortController.signal.aborted) {
              const snapshot = await client.request('thread/read', {
                threadId,
                includeTurns: true,
              });
              const turn = snapshot.thread.turns?.find((t: RpcObject) => t.id === turnId);
              if (!turn)
                throw new Error(
                  'Codex stopped reporting the active turn; its outcome is uncertain',
                );
              if (turn.status !== 'inProgress') {
                for (const item of turn.items ?? [])
                  queue.push({ method: 'item/completed', params: { threadId, item } });
                queue.push({ method: 'turn/completed', params: { threadId, turn } });
              }
            }
          }
          wake = undefined;
          const message = queue.shift();
          if (!message) continue;
          if (message.params.turnId && message.params.turnId !== turnId) continue;
          if (message.method === 'patch/processFailed') throw new Error(message.params.message);
          if (message.id !== undefined) {
            if (message.method.endsWith('/requestApproval')) {
              const decision = await opts.onPermissionRequest?.({
                tool: message.method.includes('fileChange') ? 'Edit' : 'Bash',
                args: message.params,
                description:
                  message.params.reason ?? message.params.command ?? 'Codex requests approval',
              });
              client.respond(message.id, { decision: decision?.approve ? 'accept' : 'decline' });
            } else if (message.method === 'item/tool/requestUserInput') {
              const questions = message.params.questions as RpcObject[];
              const result = await opts.onPermissionRequest?.({
                tool: 'AskUserQuestion',
                args: {
                  questions: questions.map((q) => ({
                    question: q.question,
                    header: q.header,
                    options: q.options ?? [],
                    multiSelect: false,
                  })),
                },
              });
              const answers = result?.updatedInput?.answers as Record<string, string> | undefined;
              client.respond(message.id, {
                answers: Object.fromEntries(
                  questions.map((q) => [
                    q.id,
                    { answers: answers?.[q.question] ? [answers[q.question]] : [] },
                  ]),
                ),
              });
            } else
              client.respond(message.id, undefined, `Unsupported Codex request: ${message.method}`);
            continue;
          }
          let envelope: SdkEnvelope | undefined;
          if (message.method === 'item/agentMessage/delta')
            envelope = { type: 'assistant_delta', content: message.params.delta };
          if (message.method === 'item/started' || message.method === 'item/completed') {
            const thinking = codexThinking(
              message.params.item,
              message.method === 'item/completed',
            );
            // Thinking is for the history log only — not part of Codex's own
            // transcript reconstruction.
            if (thinking) yield thinking;
            envelope = codexItem(message.params.item, message.method === 'item/completed');
          }
          if (envelope?.type === 'tool_use') toolsStarted = true;
          if (envelope) {
            this.history.append(sessionId, turnId!, opts.chatId ?? threadId, envelope);
            yield envelope;
          }
          // A tool call just finished: the tool boundary. Codex takes input
          // into the turn that is already running through `turn/steer`, which
          // is how a message sent mid-turn reaches the agent before the turn
          // ends (spec/04 § Message queueing — delivery at a tool boundary).
          if (envelope?.type === 'tool_result' && opts.onToolBoundary) {
            const text = await opts.onToolBoundary();
            if (text) {
              try {
                await client.request('turn/steer', {
                  threadId,
                  expectedTurnId: turnId,
                  input: [{ type: 'text', text, text_elements: [] }],
                });
              } catch (error) {
                // The message was already taken off the queue and recorded as
                // delivered, so a refusal must be seen, not swallowed (a turn
                // that finished under us, or one Codex will not steer).
                throw new CodexTurnError(
                  `Codex did not take a message sent while it was working: ${(error as Error).message}`,
                  false,
                );
              }
            }
          }
          if (message.method === 'turn/completed') {
            const turn = message.params.turn;
            this.history.setPending(sessionId, null);
            if (turn.status !== 'completed')
              throw new CodexTurnError(
                turn.error?.message ?? `Codex turn ${turn.status}`,
                !toolsStarted,
              );
            yield { type: 'result', sessionId };
            return;
          }
          if (message.method === 'error' && !message.params.willRetry)
            throw new CodexTurnError(
              message.params.error?.message ?? 'Codex turn failed',
              !toolsStarted,
            );
        }
      } catch (error) {
        if (isAccountExhaustedError((error as Error).message)) {
          this.accounts.markExhausted(accountId);
          void this.accounts.refresh();
        }
        throw error;
      } finally {
        unsubscribe();
        opts.abortController.signal.removeEventListener('abort', interrupt);
      }
    } finally {
      await this.accounts.releaseTurnClient(client);
    }
  }
}
