// What the model is handed back on resume is the conversation — what a person
// sent and what a model answered — and nothing the harness wrote itself
// (spec/02 § Per-turn process / warm sessions).
//
// Claude Code writes its own turns into a session: a synthetic reply
// (`model: "<synthetic>"`, zero input tokens) such as `No response requested.`
// or an API error's text, often answering a turn it injected itself (an
// `isMeta` `Continue from where you left off.`). Resumed as-is, every one goes
// back to the model as the agent's own past words. Found live (2026-10-03):
// the Manager's session carried 54 placeholders and the agent had begun ending
// its own quiet turns with the same sentence.
//
// Stripping them is not enough on its own. Claude Code adds a fresh
// placeholder, and persists it, whenever a session it loads ENDS on a user
// turn with no reply (verified against 2.1.288). So trailing unanswered
// prompts are dropped too: the turn that produced nothing is already in the
// chat's own log, and a turn still owed is re-sent by the host as the new
// prompt (spec/12 § A turn only dies for a reason someone chose), so nothing the model
// needs is lost.

import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { isModelOutput } from './sdkBackend.js';

export interface SyntheticStripResult {
  entries: SessionStoreEntry[];
  /** Synthetic assistant entries removed. */
  synthetic: number;
  /** Harness-injected (`isMeta`) prompts removed because a synthetic entry answered them. */
  injectedPrompts: number;
  /** Trailing user prompts no model answered, removed so the harness cannot answer them itself. */
  unansweredPrompts: number;
}

type Entry = SessionStoreEntry & {
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: unknown;
  message?: { content?: unknown };
};

const isConversational = (e: Entry): boolean => e.type === 'user' || e.type === 'assistant';

/** A user entry carrying only tool results is the tail of a tool call, not a prompt. */
function isToolResultOnly(e: Entry): boolean {
  const content = e.message?.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (b) =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result',
    )
  );
}

/** Does a (stripped) session still hold anything a person or a model said? */
export function hasConversation(entries: readonly SessionStoreEntry[]): boolean {
  return (entries as readonly Entry[]).some(isConversational);
}

export function stripSyntheticTurns(input: readonly SessionStoreEntry[]): SyntheticStripResult {
  const entries = input as readonly Entry[];
  const byUuid = new Map<string, Entry>();
  for (const e of entries) if (e.uuid) byUuid.set(e.uuid, e);

  const dropped = new Set<string>();
  let synthetic = 0;
  let injectedPrompts = 0;
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.uuid || isModelOutput(e)) continue;
    dropped.add(e.uuid);
    synthetic += 1;
    const parent = e.parentUuid ? byUuid.get(e.parentUuid) : undefined;
    if (parent?.uuid && parent.type === 'user' && parent.isMeta === true) {
      if (!dropped.has(parent.uuid)) injectedPrompts += 1;
      dropped.add(parent.uuid);
    }
  }

  let kept = entries.filter((e) => !e.uuid || !dropped.has(e.uuid));

  // Trailing prompts, plus the attachments Claude Code hangs after each. A run
  // of them (several wakes in a row that all got a placeholder) goes as a run:
  // whichever is left at the end would be answered by the harness in turn.
  let unansweredPrompts = 0;
  for (;;) {
    let last = kept.length - 1;
    while (last >= 0 && !isConversational(kept[last]!)) last -= 1;
    const tail = last >= 0 ? kept[last]! : undefined;
    if (!tail?.uuid || tail.type !== 'user' || isToolResultOnly(tail)) break;
    unansweredPrompts += 1;
    dropped.add(tail.uuid);
    for (let i = last + 1; i < kept.length; i += 1) {
      const e = kept[i]!;
      if (e.type === 'attachment' && e.uuid) dropped.add(e.uuid);
    }
    kept = kept.filter((e) => !e.uuid || !dropped.has(e.uuid));
  }

  if (dropped.size === 0) {
    return { entries: [...input], synthetic, injectedPrompts, unansweredPrompts };
  }

  // Re-thread the chain past every removed entry, so each survivor points at
  // its nearest surviving ancestor.
  const survivingParent = (uuid: string | null | undefined): string | null => {
    let cur = uuid ?? null;
    while (cur !== null && dropped.has(cur)) cur = byUuid.get(cur)?.parentUuid ?? null;
    return cur;
  };
  const relinked = kept.map((e) =>
    e.parentUuid && dropped.has(e.parentUuid)
      ? ({ ...e, parentUuid: survivingParent(e.parentUuid) } as SessionStoreEntry)
      : (e as SessionStoreEntry),
  );
  return { entries: relinked, synthetic, injectedPrompts, unansweredPrompts };
}
