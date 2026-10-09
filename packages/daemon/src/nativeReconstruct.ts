// Reconstructing a chat's own log (spec/04 § History) as a NATIVE session on
// whichever harness it is about to run on — the mechanism behind a seamless
// provider switch, and behind reseeding a chat whose native session is
// missing (pruned, or a fork whose point was never cached). No summary, no
// pasted handoff block: the target harness gets the real conversation and
// resumes into it exactly as if it had been running there all along.
//
// Two directions, two very different target shapes:
//   - Claude: a `SessionStoreEntry[]` (claudeSessionStore.ts) — the SAME shape
//     as a line in Claude Code's own JSONL transcript, since that's what
//     `SessionStore.load()` materializes to disk for the CLI's existing
//     resume code to read.
//   - Codex: Responses-API items for `thread/inject_items` (codexBackend.ts)
//     — message / function_call / function_call_output objects.
//
// A tool call/result already carries a Claude-shaped `tool` name regardless
// of which harness originally ran it (`codexItemEnvelope` in codexBackend.ts
// translates Codex's own item types — commandExecution, fileChange,
// mcpToolCall — to Bash/Edit/mcp__server__tool at EMIT time, before it ever
// reaches the log), so reconstructing a Claude session never needs its own
// Codex-tool-name mapping: a tool the log already names Bash/Edit/etc. is
// native on Claude by construction. What it DOES need is a tool the log
// names something Claude has no such built-in for (an MCP tool the target
// session may not have configured, or anything else) — rendered as plain
// text, never a tool_use/tool_result pair the target session cannot resolve.

import { createHash } from 'node:crypto';
import type { LoggedEvent } from '@patch/wire';

/**
 * A stable, content-derived uuid-shaped id (spec/04 § History — "make the
 * rebuilt entries deterministic... so rebuilding the same track twice gives
 * byte-identical history"). `randomUUID()` would make every reconstruction of
 * the same track a fresh set of ids, which defeats `append()`'s dedup (a
 * resume-and-append that runs twice — a retried turn, a re-derived delta —
 * would double every entry instead of no-opping) and makes two rebuilds of an
 * identical track incomparable. Not a real UUID version (no RFC compliance
 * needed here, just uuid-SHAPED so it drops into fields typed like one).
 */
function stableUuid(...parts: readonly (string | number)[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Claude Code's own built-in tool names — always safe to reconstruct as a
 * real tool_use/tool_result pair, since every Claude Code session has them
 * (barring an explicit `disallowedTools`, which a resumed session does not
 * retroactively apply to history already in its transcript). Anything else —
 * including an `mcp__` tool, since the target session may not have that
 * server configured — falls back to text. */
const CLAUDE_NATIVE_TOOLS = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'NotebookEdit',
  'SlashCommand',
  'ExitPlanMode',
]);

export interface TrackEntry {
  record: { seq: number; at: number };
  event: LoggedEvent;
}

/** A line in the shape `SessionStore.load()` returns — see
 * `@anthropic-ai/claude-agent-sdk`'s `SessionStoreEntry`: a loosely-typed
 * pass-through blob, `{type, uuid?, timestamp?, ...}`, matching Claude Code's
 * own on-disk transcript line shape closely enough that the CLI's existing
 * resume code accepts it once materialized to a temp file. */
export type ClaudeSessionEntry = Record<string, unknown> & { type: string; uuid: string };

function shortJson(v: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Translate one chat's track (a `readTrack` result, oldest first) into the
 * `SessionStoreEntry[]` a Claude Code resume materializes from. `chat.message`
 * events with `role: 'system'` (permission-mode markers, compaction notes,
 * failed-turn notes) are dropped — they were never part of the MODEL's own
 * context to begin with (the live emit path never sends them to Claude
 * either), so reconstructing them would show the target model conversation
 * turns it never actually had.
 */
export function toClaudeSessionEntries(
  events: readonly TrackEntry[],
  opts: {
    sessionId: string;
    folder: string;
    model: string | null;
    /**
     * Set only when this reconstruction CONTINUES an existing session (spec/04
     * § History — riding its prompt cache back onto a harness the chat used
     * before, appending only the delta rather than rebuilding from scratch):
     * the uuid of the mirror's own last entry, so the first delta entry
     * threads onto it instead of starting a disconnected second root.
     * Defaults to `null` — a from-scratch reconstruction.
     */
    startParentUuid?: string | null;
  },
): ClaudeSessionEntry[] {
  const out: ClaudeSessionEntry[] = [];
  let parentUuid: string | null = opts.startParentUuid ?? null;

  const push = (seq: number, partial: { type: string } & Record<string, unknown>): void => {
    const uuid = stableUuid('patch-claude-entry', opts.sessionId, seq);
    out.push({
      sessionId: opts.sessionId,
      cwd: opts.folder,
      isSidechain: false,
      version: 'patch-reconstructed',
      ...partial,
      uuid,
      parentUuid,
    });
    parentUuid = uuid;
  };

  for (const { record, event } of events) {
    const timestamp = new Date(record.at).toISOString();
    if (event.type === 'chat.message') {
      if (event.role === 'system') continue;
      push(record.seq, {
        type: event.role,
        timestamp,
        ...(event.role === 'user' ? { userType: 'external' } : {}),
        message: {
          role: event.role,
          content: event.content,
          ...(event.role === 'assistant' && opts.model ? { model: opts.model } : {}),
        },
      });
    } else if (event.type === 'chat.tool_call') {
      if (CLAUDE_NATIVE_TOOLS.has(event.tool)) {
        push(record.seq, {
          type: 'assistant',
          timestamp,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: event.callId, name: event.tool, input: event.args }],
          },
        });
      } else {
        push(record.seq, {
          type: 'assistant',
          timestamp,
          message: {
            role: 'assistant',
            content: `[${event.tool}(${shortJson(event.args)})]`,
          },
        });
      }
    } else if (event.type === 'chat.tool_result') {
      if (CLAUDE_NATIVE_TOOLS.has(event.tool)) {
        push(record.seq, {
          type: 'user',
          timestamp,
          userType: 'external',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: event.callId,
                content:
                  typeof event.result === 'string' ? event.result : shortJson(event.result, 4000),
                ...(event.isError ? { is_error: true } : {}),
              },
            ],
          },
        });
      } else {
        push(record.seq, {
          type: 'user',
          timestamp,
          userType: 'external',
          message: { role: 'user', content: `[→ ${shortJson(event.result)}]` },
        });
      }
    } else if (event.type === 'chat.artifact') {
      push(record.seq, {
        type: 'assistant',
        timestamp,
        message: { role: 'assistant', content: `[artifact published: ${event.title}]` },
      });
    }
  }

  return closeDanglingToolUse(out);
}

/**
 * A reconstruction that ends mid-tool-call (the track's last event is a
 * `tool_use` with no following `tool_result` — an interrupted turn) cannot be
 * resumed into: the Messages API requires every `tool_use` to be answered by
 * the very next message. Close it with a synthetic error result rather than
 * dropping the call silently, so the target model sees that its last action
 * did not finish.
 */
// -----------------------------------------------------------------------
// Codex direction: a chat's track → raw Responses API items for
// `thread/inject_items` (codexBackend.ts). Codex's OWN function tools are
// `shell` (a command execution) and `apply_patch` (a file change) — Claude's
// `Bash`/`Edit`/`Write`/`MultiEdit` map onto them; everything else has no
// Codex equivalent and becomes plain message text, same policy as the Claude
// direction and for the same reason: a function_call the injected thread's
// own tool list doesn't recognise is worse than a text note describing it.

export type ResponsesItem = Record<string, unknown>;

function claudeToolAsCodexFunctionCall(tool: string, args: unknown): unknown {
  if (tool === 'Bash') {
    const a = (args ?? {}) as { command?: unknown };
    return { command: typeof a.command === 'string' ? a.command : shortJson(args) };
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    return { changes: args };
  }
  return undefined;
}

function codexFunctionNameFor(tool: string): string | undefined {
  if (tool === 'Bash') return 'shell';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return 'apply_patch';
  return undefined;
}

/**
 * Translate one chat's track into Responses API items for
 * `thread/inject_items`. `chat.message` events with `role: 'system'` are
 * dropped, same reasoning as the Claude direction.
 */
export function toResponsesItems(events: readonly TrackEntry[]): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  for (const { event } of events) {
    if (event.type === 'chat.message') {
      if (event.role === 'system') continue;
      out.push({
        type: 'message',
        role: event.role,
        content: [
          {
            type: event.role === 'assistant' ? 'output_text' : 'input_text',
            text: event.content,
          },
        ],
      });
    } else if (event.type === 'chat.tool_call') {
      const codexName = codexFunctionNameFor(event.tool);
      if (codexName) {
        out.push({
          type: 'function_call',
          call_id: event.callId,
          name: codexName,
          arguments: JSON.stringify(claudeToolAsCodexFunctionCall(event.tool, event.args)),
        });
      } else {
        out.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `[${event.tool}(${shortJson(event.args)})]` }],
        });
      }
    } else if (event.type === 'chat.tool_result') {
      const codexName = codexFunctionNameFor(event.tool);
      if (codexName) {
        out.push({
          type: 'function_call_output',
          call_id: event.callId,
          output: typeof event.result === 'string' ? event.result : shortJson(event.result, 4000),
        });
      } else {
        out.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[→ ${shortJson(event.result)}]` }],
        });
      }
    } else if (event.type === 'chat.artifact') {
      out.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `[artifact published: ${event.title}]` }],
      });
    }
  }
  return closeDanglingFunctionCall(out);
}

/** Same closing rule as the Claude direction: a trailing unanswered
 * function_call cannot be injected as model-visible history on its own. */
function closeDanglingFunctionCall(items: ResponsesItem[]): ResponsesItem[] {
  const last = items.at(-1);
  if (!last || last['type'] !== 'function_call') return items;
  return [
    ...items,
    {
      type: 'function_call_output',
      call_id: last['call_id'],
      output: '(interrupted — the chat switched sessions before this call finished)',
    },
  ];
}

function closeDanglingToolUse(entries: ClaudeSessionEntry[]): ClaudeSessionEntry[] {
  const last = entries.at(-1);
  if (!last || last['type'] !== 'assistant') return entries;
  const message = last['message'] as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return entries;
  const call = content.find(
    (b): b is { type: string; id: string } =>
      typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_use',
  );
  if (!call) return entries;
  return [
    ...entries,
    {
      uuid: stableUuid('patch-claude-entry-close', last['uuid'] as string),
      parentUuid: last['uuid'] as string,
      sessionId: last['sessionId'],
      cwd: last['cwd'],
      isSidechain: false,
      version: 'patch-reconstructed',
      type: 'user',
      // Deterministic — same reasoning as the uuid above. There is no real
      // moment this synthetic entry happened at, so it reuses the tool_use's
      // own timestamp rather than `Date.now()`.
      timestamp: last['timestamp'] as string,
      userType: 'external',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call.id,
            content: '(interrupted — the chat switched sessions before this call finished)',
            is_error: true,
          },
        ],
      },
    } as ClaudeSessionEntry,
  ];
}

/**
 * Rough token count for a track a switch would hand the target harness
 * (spec/04 § History — show the cost in the switch confirmation). chars/4 is
 * the documented ballpark estimate when an exact count isn't worth a real
 * tokenizer call; labelled "~" wherever it's shown, never presented as exact.
 * `role: 'system'` messages are excluded — same reasoning as everywhere else
 * in this file: they never reach the reconstruction itself.
 */
export function estimateTokens(events: readonly TrackEntry[]): number {
  let chars = 0;
  for (const { event } of events) {
    if (event.type === 'chat.message') {
      if (event.role === 'system') continue;
      chars += event.content.length;
    } else if (event.type === 'chat.tool_call') {
      chars += event.tool.length + shortJson(event.args).length;
    } else if (event.type === 'chat.tool_result') {
      chars +=
        event.tool.length +
        (typeof event.result === 'string'
          ? event.result.length
          : shortJson(event.result, 4000).length);
    } else if (event.type === 'chat.artifact') {
      chars += event.title.length;
    }
  }
  return Math.round(chars / 4);
}
