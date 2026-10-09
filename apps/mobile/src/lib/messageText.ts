// The text a transcript row gives up when the user copies it (spec/15 § Chat
// detail — Copying message text). The WHOLE row, as the markdown/plain text
// it arrived as: a message's content verbatim (not the rendered glyphs), a
// tool call's summary + arguments + result, an error's message + code. Pure,
// so each row kind's text is unit-tested without rendering.

import type { ChatEventEntry } from '../stores/chatStore';
import { toolCallSummary } from './toolSummary';

/** A structured value as readable text: strings verbatim, the rest as JSON. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * The copyable text of one transcript row, or null when the row has none (an
 * empty message carrying only attachments) — the caller then offers nothing
 * rather than copying an empty string.
 */
export function copyableText(entry: ChatEventEntry): string | null {
  switch (entry.kind) {
    case 'tool_call': {
      const parts = [toolCallSummary(entry.tool, entry.toolArgs)];
      if (entry.toolArgs !== undefined) parts.push(asText(entry.toolArgs));
      if (entry.toolResult !== undefined) parts.push(asText(entry.toolResult));
      return parts.join('\n\n');
    }
    case 'tool_result': {
      if (entry.toolResult === undefined) return entry.tool ? `${entry.tool} done` : null;
      return asText(entry.toolResult);
    }
    case 'error': {
      const text = entry.content ?? '';
      const full = entry.errorCode ? `${text}\n${entry.errorCode}` : text;
      return full.trim() === '' ? null : full;
    }
    default: {
      const text = entry.content ?? '';
      return text.trim() === '' ? null : text;
    }
  }
}
