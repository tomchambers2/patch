// Canonical Hook type (spec/20-hooks.md).
//
// A hook is a user-defined check Patch runs on a message before it reaches
// the agent (`when: 'user_message'`) or on the agent's reply before it settles
// (`when: 'agent_response'`). Stored on the server at `/data/hooks/*.json`,
// one file per hook, the same layout jobs use (`./jobs.ts`).

import { z } from 'zod';

export const HOOK_IMAGES_MAX = 5;
export const HOOK_IMAGE_MAX_BASE64 = 6_000_000;

export const HookWhen = z.enum(['user_message', 'agent_response']);
export type HookWhen = z.infer<typeof HookWhen>;

/** Both values are implemented (spec/20-hooks.md). */
export const SUPPORTED_HOOK_WHENS: readonly HookWhen[] = ['user_message', 'agent_response'];

export const HookKind = z.enum(['script', 'prompt']);
export type HookKind = z.infer<typeof HookKind>;

export const HookScript = z
  .object({
    /** The command itself, not a path (spec/08 § Gate's same rule). */
    command: z.string().min(1),
  })
  .strict();
export type HookScript = z.infer<typeof HookScript>;

/** An image attached to the message being checked (spec/20-hooks.md § Hook context). */
export const HookImage = z
  .object({
    mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    /** Base64, no `data:` prefix. */
    data: z.string().min(1).max(HOOK_IMAGE_MAX_BASE64),
  })
  .strict();
export type HookImage = z.infer<typeof HookImage>;
export const HookImages = z.array(HookImage).max(HOOK_IMAGES_MAX);

export const HookPrompt = z
  .object({
    instructions: z.string().min(1),
    /** Any model from the chat's own host's catalogue (spec/02 § Model catalogue). */
    model: z.string().min(1),
  })
  .strict();
export type HookPrompt = z.infer<typeof HookPrompt>;

/**
 * Which chats a hook applies to (spec/20-hooks.md § Gate) — the structural
 * half, matched before the hook ever runs. `hosts` / `folders` / `chatIds`
 * are each an optional allow-list: null/absent means no restriction on that
 * axis. `specialThreads` decides whether Manager/Speakers are in
 * scope at all — absent/false means ordinary chats only, true means special
 * threads only. `filter` is the same JSONata shape a job's filter is
 * (spec/08 § Filter), evaluated against `{ payload, now }`.
 */
export const HookGate = z
  .object({
    hosts: z.array(z.string().min(1)).nullable().optional(),
    folders: z.array(z.string().min(1)).nullable().optional(),
    chatIds: z.array(z.string().min(1)).nullable().optional(),
    specialThreads: z.boolean().optional(),
    filter: z.string().nullable().optional(),
  })
  .strict();
export type HookGate = z.infer<typeof HookGate>;

/** Default/ceiling for a hook's own run timeout (spec/20-hooks.md § Outcome). */
export const DEFAULT_HOOK_TIMEOUT_MS = 15_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;

const TimeoutMs = z.number().int().min(1000).max(MAX_HOOK_TIMEOUT_MS);

export const Hook = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    when: HookWhen,
    kind: HookKind,
    script: HookScript.optional(),
    prompt: HookPrompt.optional(),
    gate: HookGate,
    timeoutMs: TimeoutMs,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
export type Hook = z.infer<typeof Hook>;

export const HookCreateBody = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    when: HookWhen,
    kind: HookKind,
    script: HookScript.optional(),
    prompt: HookPrompt.optional(),
    gate: HookGate.optional(),
    timeoutMs: TimeoutMs.optional(),
  })
  .strict();
export type HookCreateBody = z.infer<typeof HookCreateBody>;

export const HookPatchBody = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    when: HookWhen.optional(),
    kind: HookKind.optional(),
    /** `null` clears the field (only meaningful alongside a `kind` switch). */
    script: HookScript.nullable().optional(),
    prompt: HookPrompt.nullable().optional(),
    gate: HookGate.optional(),
    timeoutMs: TimeoutMs.optional(),
  })
  .strict();
export type HookPatchBody = z.infer<typeof HookPatchBody>;

/** One hook's own answer to a check (spec/20-hooks.md § Outcome). */
export const HookDecision = z.enum(['pass', 'advise', 'block']);
export type HookDecision = z.infer<typeof HookDecision>;

export const HookCheckOutcome = z
  .object({
    decision: HookDecision,
    analysis: z.string().optional(),
    suggestion: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.decision !== 'pass' && val.analysis === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['analysis'],
        message: 'analysis is required on advise/block',
      });
    }
  });
export type HookCheckOutcome = z.infer<typeof HookCheckOutcome>;

/** One matching hook's result on `POST /api/hooks/check` (spec/20-hooks.md). */
export const HookRunResult = z
  .object({
    hookId: z.string().min(1),
    hookName: z.string().min(1),
    status: z.enum(['ok', 'failed', 'timeout']),
    decision: HookDecision.optional(),
    analysis: z.string().optional(),
    suggestion: z.string().optional(),
    /** Set when `status` is `'failed'` or `'timeout'`. */
    error: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type HookRunResult = z.infer<typeof HookRunResult>;

/**
 * The aggregate decision a client acts on. Only a genuine `block` from a hook
 * that ran holds a message: a `failed`/`timeout` result never does (a hook
 * must never block a send), it ranks as `advise` so the failure is shown on
 * the sent message. Ranked block > advise (incl. failed) > pass.
 */
export function aggregateHookDecision(results: readonly HookRunResult[]): HookDecision {
  if (results.some((r) => r.status === 'ok' && r.decision === 'block')) return 'block';
  if (results.some((r) => r.status !== 'ok' || r.decision === 'advise')) return 'advise';
  return 'pass';
}

export const HookCheckRequestBody = z
  .object({
    chatId: z.string().min(1),
    message: z.string(),
  })
  .strict();
export type HookCheckRequestBody = z.infer<typeof HookCheckRequestBody>;

export const HookCheckResponse = z
  .object({
    decision: HookDecision,
    results: z.array(HookRunResult),
  })
  .strict();
export type HookCheckResponse = z.infer<typeof HookCheckResponse>;

/**
 * The context a hook's gate is matched against, and (for `script`) the JSON
 * handed to the command on stdin (spec/20-hooks.md § `script`). `message` is
 * the text being judged: the user's message for a `user_message` hook, or the
 * agent's final reply for an `agent_response` one. `toolCallsSummary` is set
 * only for `agent_response` (spec/20-hooks.md § On the agent's response) — a
 * one-line, deterministic tally of the turn's tool calls (no model call of
 * its own), absent for `user_message`.
 */
export interface HookCheckContext {
  message: string;
  /** `user_message` only: the composer's image attachments, for a `prompt` hook to look at. */
  images?: HookImage[];
  chatId: string;
  folder: string;
  daemonId: string;
  specialThread: boolean;
  toolCallsSummary?: string;
}

/**
 * The structural half of the gate (spec/20-hooks.md § Gate) — hosts, folders,
 * chatIds, specialThreads. `filter` is evaluated separately (server-side,
 * JSONata) since it needs an async evaluator this package does not carry.
 */
export function hookGateMatches(gate: HookGate, ctx: HookCheckContext): boolean {
  if (gate.hosts != null && !gate.hosts.includes(ctx.daemonId)) return false;
  if (gate.folders != null && !gate.folders.includes(ctx.folder)) return false;
  if (gate.chatIds != null && !gate.chatIds.includes(ctx.chatId)) return false;
  const wantsSpecial = gate.specialThreads === true;
  if (wantsSpecial !== ctx.specialThread) return false;
  return true;
}

/**
 * Canonical interface for managing hooks, mirroring `JobsInterface`
 * (`./jobs.ts`). Owned by the server; data lives at `/data/hooks/*.json`.
 */
export interface HooksInterface {
  list(): Hook[];
  get(id: string): Hook | null;
  create(body: HookCreateBody): Hook;
  patch(id: string, body: HookPatchBody): Hook;
  delete(id: string): boolean;
  enable(id: string): Hook;
  disable(id: string): Hook;
  onChange(handler: (event: HooksChangeEvent) => void): () => void;
}

export type HooksChangeEvent =
  | { type: 'created'; hook: Hook }
  | { type: 'updated'; hook: Hook }
  | { type: 'deleted'; id: string };
