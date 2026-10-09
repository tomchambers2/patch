// Inline unified-format diff for mobile chat detail (spec/15 ## Chat detail:
// "Diffs render inline using a mobile-friendly unified format — no
// side-by-side; the screen isn't wide enough").
//
// Produced from an Edit/Write/MultiEdit tool call's args:
//   - Edit:      { old_string, new_string }  → diff old → new
//   - Write:     { content }                 → all-added diff (new file)
//   - MultiEdit: { edits: [{old_string,new_string}, …] } → concatenated
//
// We compute a minimal line-level unified diff (common prefix/suffix trimmed)
// so the agent's edit reads like `git diff`: context lines, `-` removals,
// `+` additions. This is intentionally a small dependency-free LCS-free
// approximation — adequate for the short hunks Claude's Edit tool produces.

import React from 'react';
import { Text, View } from 'react-native';
import { fonts, radii, space, useTheme, textMin } from '../lib/theme';

export interface DiffPair {
  oldText: string;
  newText: string;
}

/** Extract the diff pair(s) from a tool-call's args, or null if not a diff tool. */
export function diffFromToolCall(tool: string | undefined, args: unknown): DiffPair[] | null {
  if (!tool) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  const t = tool.toLowerCase();
  if (t === 'edit' && typeof a['old_string'] === 'string' && typeof a['new_string'] === 'string') {
    return [{ oldText: a['old_string'] as string, newText: a['new_string'] as string }];
  }
  if (t === 'write' && typeof a['content'] === 'string') {
    return [{ oldText: '', newText: a['content'] as string }];
  }
  if (t === 'multiedit' && Array.isArray(a['edits'])) {
    const pairs: DiffPair[] = [];
    for (const e of a['edits'] as Array<Record<string, unknown>>) {
      if (typeof e['old_string'] === 'string' && typeof e['new_string'] === 'string') {
        pairs.push({ oldText: e['old_string'] as string, newText: e['new_string'] as string });
      }
    }
    return pairs.length > 0 ? pairs : null;
  }
  return null;
}

interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

/** Minimal line-level unified diff: trim common head/tail, mark the rest. */
function unifiedLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length > 0 ? oldText.split('\n') : [];
  const newLines = newText.length > 0 ? newText.split('\n') : [];

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }

  // Every loop below indexes strictly within the array it reads (bounded by
  // that same array's own `.length`), and `String.split('\n')` never
  // produces sparse holes — each `?? ''` only satisfies TypeScript's
  // noUncheckedIndexedAccess, never a real path.
  const out: DiffLine[] = [];
  /* v8 ignore next */
  for (let i = 0; i < head; i++) out.push({ kind: 'context', text: oldLines[i] ?? '' });
  for (let i = head; i < oldLines.length - tail; i++) {
    /* v8 ignore next */
    out.push({ kind: 'del', text: oldLines[i] ?? '' });
  }
  for (let i = head; i < newLines.length - tail; i++) {
    /* v8 ignore next */
    out.push({ kind: 'add', text: newLines[i] ?? '' });
  }
  for (let i = oldLines.length - tail; i < oldLines.length; i++) {
    /* v8 ignore next */
    out.push({ kind: 'context', text: oldLines[i] ?? '' });
  }
  return out;
}

export function UnifiedDiff({ pairs }: { pairs: DiffPair[] }): React.ReactElement {
  const colors = useTheme();
  const lines: DiffLine[] = [];
  for (const p of pairs) lines.push(...unifiedLines(p.oldText, p.newText));
  return (
    <View
      style={{
        backgroundColor: colors.paper,
        borderRadius: radii.sm,
        borderWidth: 1,
        borderColor: colors.divider,
        paddingVertical: space.xs,
        marginTop: space.xs,
      }}
      accessibilityLabel="unified diff"
    >
      {lines.map((l, idx) => {
        const bg =
          l.kind === 'add' ? colors.diffAdd : l.kind === 'del' ? colors.diffDel : 'transparent';
        const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
        const fg =
          l.kind === 'add' ? colors.diffAddInk : l.kind === 'del' ? colors.diffDelInk : colors.ink3;
        return (
          <View key={idx} style={{ backgroundColor: bg, paddingHorizontal: space.sm }}>
            <Text style={{ fontFamily: fonts.mono, fontSize: textMin, color: fg }}>
              {prefix} {l.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
