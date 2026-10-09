// Dispatches a check to every matching hook, in parallel, and aggregates the
// results (spec/20-hooks.md § Checking a message, § On the agent's
// response). Shared by both `when` values — `check` (user_message) and
// `checkAgentResponse` (agent_response) differ only in which hooks they
// match against; running one and aggregating is identical either way.
//
// Each matching hook is sent to the CHAT'S OWN host as a `hook.check_request`
// (spec/03-wire-protocol.md § Hooks) and awaited up to that hook's own
// `timeoutMs`. An offline host fails every hook addressed to it immediately
// — this is a synchronous per-check dispatch, not a persistent fire, so there
// is nothing to buffer for later (unlike a job's action; `../jobs/dispatcher.ts`).

import type { Logger } from 'pino';
import type {
  HookAgentResponseCheckRequestEvent,
  HookCheckRequestEvent,
  HookCheckResultEvent,
  WireEvent,
} from '@patch/wire';
import type { DaemonLink } from '../daemon-link.js';
import { hookMatches } from './gate.js';
import {
  aggregateHookDecision,
  type Hook,
  type HookCheckContext,
  type HookRunResult,
  type HookWhen,
  type HooksInterface,
} from './types.js';

const HOOK_CHECK_SURFACE_ID = 'hooks-check';

export interface HookRunnerOptions {
  hooks: HooksInterface;
  daemonLink: DaemonLink;
  logger: Logger;
  idGenerator?: () => string;
  nowMs?: () => number;
}

export interface HookCheckResult {
  decision: 'pass' | 'advise' | 'block';
  results: HookRunResult[];
}

export class HookRunner {
  private readonly hooks: HooksInterface;
  private readonly daemonLink: DaemonLink;
  private readonly logger: Logger;
  private readonly idGenerator: () => string;
  private readonly nowMs: () => number;
  private readonly pending = new Map<
    string,
    { hookId: string; startedAt: number; resolve: (ev: HookCheckResultEvent) => void }
  >();

  constructor(opts: HookRunnerOptions) {
    this.hooks = opts.hooks;
    this.daemonLink = opts.daemonLink;
    this.logger = opts.logger;
    this.idGenerator = opts.idGenerator ?? ((): string => Math.random().toString(36).slice(2));
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.daemonLink.onEvent((event: WireEvent) => {
      if (event.type === 'hook.check_result') {
        const waiter = this.pending.get(event.requestId);
        if (!waiter) return;
        this.pending.delete(event.requestId);
        waiter.resolve(event);
        return;
      }
      if (event.type === 'hook.agent_response_check_request') {
        void this.handleAgentResponseCheckRequest(event);
      }
    });
  }

  /**
   * spec/20-hooks.md § On the agent's response — the host kicks this off
   * once a turn settles (it has the reply text and tool summary without a
   * round trip); this resolves matching hooks and dispatches each to THAT
   * SAME host via the ordinary `hook.check_request`/`hook.check_result`
   * pair, then reports every result back in one `hook.agent_response_outcome`
   * — the host, not the server, decides what a result means for the chat.
   */
  private async handleAgentResponseCheckRequest(
    event: HookAgentResponseCheckRequestEvent,
  ): Promise<void> {
    try {
      const results = await this.checkAgentResponse({
        message: event.reply,
        chatId: event.chatId,
        folder: event.folder,
        daemonId: event.daemonId,
        specialThread: event.specialThread,
        toolCallsSummary: event.toolCallsSummary,
      });
      this.daemonLink.sendTo(event.daemonId, HOOK_CHECK_SURFACE_ID, {
        type: 'hook.agent_response_outcome',
        daemonId: event.daemonId,
        chatId: event.chatId,
        checkId: event.checkId,
        results,
      });
    } catch (err) {
      this.logger.error(
        { chatId: event.chatId, checkId: event.checkId, err },
        'hook: agent_response check request failed to resolve',
      );
    }
  }

  /** Every enabled hook of `when` whose gate (incl. filter) matches `ctx`. */
  async matchingHooks(ctx: HookCheckContext, when: HookWhen = 'user_message'): Promise<Hook[]> {
    const now = this.nowMs();
    const candidates = this.hooks.list().filter((h) => h.when === when);
    const matches: Hook[] = [];
    for (const hook of candidates) {
      const ok = await hookMatches(hook, ctx, now, (err) => {
        this.logger.warn(
          { hookId: hook.id, err: err.message },
          'hook: filter failed to evaluate, treating as no match',
        );
      });
      if (ok) matches.push(hook);
    }
    return matches;
  }

  async check(ctx: HookCheckContext): Promise<HookCheckResult> {
    const matches = await this.matchingHooks(ctx, 'user_message');
    if (matches.length === 0) return { decision: 'pass', results: [] };
    const results = await Promise.all(matches.map((hook) => this.runOne(hook, ctx)));
    return { decision: aggregateHookDecision(results), results };
  }

  /**
   * spec/20-hooks.md § On the agent's response. Returns every matching
   * hook's own result — unlike `check`, the CALLER decides what each result
   * means (a host resubmit, a deferred advise, a failure notice), since
   * `aggregateHookDecision`'s "a failed hook holds the message like a block"
   * rule is specific to `user_message` (nothing is being sent yet, so holding
   * it is free); an `agent_response` turn has already happened, so a broken
   * hook must not force a redo it never earned.
   */
  async checkAgentResponse(ctx: HookCheckContext): Promise<HookRunResult[]> {
    const matches = await this.matchingHooks(ctx, 'agent_response');
    if (matches.length === 0) return [];
    return Promise.all(matches.map((hook) => this.runOne(hook, ctx)));
  }

  private runOne(hook: Hook, ctx: HookCheckContext): Promise<HookRunResult> {
    const startedAt = this.nowMs();
    const base = { hookId: hook.id, hookName: hook.name };
    if (!this.daemonLink.isOnline(ctx.daemonId)) {
      return Promise.resolve({
        ...base,
        status: 'failed' as const,
        error: `${ctx.daemonId} is offline`,
        durationMs: 0,
      });
    }
    const requestId = this.idGenerator();
    const event: HookCheckRequestEvent = {
      type: 'hook.check_request',
      daemonId: ctx.daemonId,
      requestId,
      hookId: hook.id,
      kind: hook.kind,
      ...(hook.script !== undefined ? { script: hook.script } : {}),
      ...(hook.prompt !== undefined ? { prompt: hook.prompt } : {}),
      timeoutMs: hook.timeoutMs,
      context: {
        message: ctx.message,
        // Only a prompt hook can look at an image; a script's stdin is text.
        ...(ctx.images !== undefined && hook.kind === 'prompt' ? { images: ctx.images } : {}),
        chatId: ctx.chatId,
        folder: ctx.folder,
        daemonId: ctx.daemonId,
        specialThread: ctx.specialThread,
        ...(ctx.toolCallsSummary !== undefined ? { toolCallsSummary: ctx.toolCallsSummary } : {}),
      },
    };
    return new Promise<HookRunResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ...base, status: 'timeout', durationMs: this.nowMs() - startedAt });
      }, hook.timeoutMs);
      this.pending.set(requestId, {
        hookId: hook.id,
        startedAt,
        resolve: (ev) => {
          clearTimeout(timer);
          if (ev.status !== 'ok') {
            resolve({
              ...base,
              status: ev.status,
              error: ev.error ?? 'hook failed',
              durationMs: ev.durationMs,
            });
            return;
          }
          resolve({
            ...base,
            status: 'ok',
            decision: ev.decision,
            ...(ev.analysis !== undefined ? { analysis: ev.analysis } : {}),
            ...(ev.suggestion !== undefined ? { suggestion: ev.suggestion } : {}),
            durationMs: ev.durationMs,
          });
        },
      });
      this.daemonLink.sendTo(ctx.daemonId, HOOK_CHECK_SURFACE_ID, event);
    });
  }
}
