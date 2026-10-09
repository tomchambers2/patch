// A compact, friendly name for a model id — what the composer's model pill
// reads (spec/15 § Composer — Model pill), where there is room for about
// "Opus 5.5" and not for "Claude Opus 5.5" or `claude-opus-5-5-20260101`.

/**
 * The catalogue's own label when there is one, minus the brand prefix every
 * Claude model shares; otherwise the id itself reduced the same way
 * (`claude-opus-5-5` → `Opus 5.5`). An id that fits neither shape is shown as
 * it is — surfaced, never swapped for a guess.
 */
export function compactModelLabel(modelId: string, catalogueLabel?: string): string {
  if (catalogueLabel !== undefined && catalogueLabel !== '') {
    return catalogueLabel.replace(/^Claude\s+/i, '');
  }
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(modelId);
  if (m === null) return modelId;
  const family = m[1] ?? '';
  const version = m[3] !== undefined ? `${m[2]}.${m[3]}` : m[2];
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`;
}
