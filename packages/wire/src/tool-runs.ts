// spec/14 ## Main chat panel — "Tool runs collapse to one row". Which tool
// calls may fold into a run is decided HERE, once, because three places must
// agree on it: web and mobile draw the runs, and the host summarises each run
// it saw close (`chat.tool_run_summary`, keyed by the run's call ids). A run the
// host cut differently from a surface would name calls that surface never
// grouped, and its summary would have nowhere to go.

/**
 * Can this tool call fold into a run? A file edit keeps its own row for its
 * inline diff, a `Monitor` for the watcher it armed, and a `view_file` because
 * its row IS the file — folded away, the picture only mounts on expand.
 */
export function isGroupableToolCall(tool: string | undefined, args: unknown): boolean {
  if (tool === undefined) return true;
  if (tool === 'Monitor') return false;
  if (tool === 'view_file' || tool === 'mcp__patch__view_file') return false;
  // A notification is a message to the user: it stays in the transcript.
  if (tool === 'patch_notify' || tool === 'mcp__patch__patch_notify') return false;
  return !isEditToolCall(tool, args);
}

/** A file-edit call, which renders its own row with an inline diff. */
export function isEditToolCall(tool: string, args: unknown): boolean {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  return (
    /edit|write/i.test(tool) &&
    typeof a['file_path'] === 'string' &&
    (typeof a['old_string'] === 'string' || typeof a['new_string'] === 'string')
  );
}
