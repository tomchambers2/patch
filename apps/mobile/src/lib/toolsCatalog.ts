// Tool catalog — mirrors packages/web/src/lib/toolsCatalog.ts (deliberately
// duplicated rather than shared, same convention as chatStore/ws.ts between
// the two apps: mobile depends on @patch/wire, not on @patch/web).
//
// A curated, human-readable inventory of the tools an agent can reach for: the
// common native Claude Code tools plus Patch's own cross-chat MCP tools. Each
// entry carries the identifier the host uses to gate the tool (`name` — the
// SDK `disallowedTools` id), a friendly `label`, a plain-English `description`
// of WHAT IT DOES, and its `params` DEFINITION. The Tools sheet renders this
// list with a per-tool on/off switch; the OFF set rides `chat.input` and the
// host removes those tools from the model's context (spec/02 § Tools).
//
// This is presentation metadata, NOT the source of truth for which tools exist
// (that is the SDK + the `patch-tools` MCP server). An unknown tool the agent
// calls still renders via `describeTool`'s graceful fallback.

export type ToolCategory = 'native' | 'patch';

export interface ToolCatalogEntry {
  /** Identifier the host gates on (SDK `disallowedTools`). Native tools use
   *  the bare name (`Bash`); Patch MCP tools use the `mcp__patch__…` id. */
  name: string;
  /** Friendly display name (the bare tool name, no MCP prefix). */
  label: string;
  /** Native Claude Code tool vs Patch's own cross-chat MCP tool. */
  category: ToolCategory;
  /** Plain-English "what it does" — exactly ONE sentence, present tense,
   *  starting with the verb, describing the TOOL and never the toggle. */
  description: string;
  /** The tool's parameter DEFINITION (a compact signature). */
  params: string;
}

// The Patch MCP server is registered under the name `patch`, so its tools are
// exposed to the model as `mcp__patch__<tool>` — the id the host gates on.
export const PATCH_MCP_PREFIX = 'mcp__patch__';

/** Fully-qualified disallow id for a Patch MCP tool (`patch_spawn` → id). */
export function patchToolId(tool: string): string {
  return `${PATCH_MCP_PREFIX}${tool}`;
}

const NATIVE_TOOLS: ToolCatalogEntry[] = [
  {
    name: 'Bash',
    label: 'Bash',
    category: 'native',
    description: 'Runs a shell command in the chat folder.',
    params: 'command: string, timeout?: number, run_in_background?: boolean',
  },
  {
    name: 'Read',
    label: 'Read',
    category: 'native',
    description:
      'Reads a file from disk (text, images, PDFs, notebooks) so the agent can see its contents.',
    params: 'file_path: string, offset?: number, limit?: number',
  },
  {
    name: 'Edit',
    label: 'Edit',
    category: 'native',
    description: 'Makes an exact string replacement inside an existing file.',
    params: 'file_path: string, old_string: string, new_string: string, replace_all?: boolean',
  },
  {
    name: 'Write',
    label: 'Write',
    category: 'native',
    description: 'Creates a new file or overwrites an existing one with new contents.',
    params: 'file_path: string, content: string',
  },
  {
    name: 'Glob',
    label: 'Glob',
    category: 'native',
    description: 'Finds files by name pattern (e.g. `src/**/*.ts`).',
    params: 'pattern: string, path?: string',
  },
  {
    name: 'Grep',
    label: 'Grep',
    category: 'native',
    description: 'Searches file contents with a regular expression across the project.',
    params: 'pattern: string, path?: string, glob?: string, output_mode?: string',
  },
  {
    name: 'WebSearch',
    label: 'WebSearch',
    category: 'native',
    description: 'Searches the web and returns results the agent can read.',
    params: 'query: string, allowed_domains?: string[]',
  },
  {
    name: 'WebFetch',
    label: 'WebFetch',
    category: 'native',
    description: 'Fetches a URL and extracts its content for the agent to read.',
    params: 'url: string, prompt: string',
  },
  {
    name: 'Monitor',
    label: 'Monitor',
    category: 'native',
    description:
      'Runs a script in the background and turns every line it prints into an event in this chat — a log tail, a file watch, a poll loop.',
    params: 'command: string, description: string, timeout_ms?: number, persistent?: boolean',
  },
  {
    name: 'TaskStop',
    label: 'TaskStop',
    category: 'native',
    description: 'Stops a running background task — the way a monitor is cancelled early.',
    params: 'task_id: string',
  },
  {
    name: 'Task',
    label: 'Task',
    category: 'native',
    description:
      'Spawns an ephemeral sub-agent to run a scoped task on its own, then returns its result.',
    params: 'description: string, prompt: string, subagent_type: string',
  },
];

const PATCH_TOOLS: ToolCatalogEntry[] = [
  {
    name: patchToolId('patch_spawn'),
    label: 'patch_spawn',
    category: 'patch',
    description: 'Creates a brand-new persistent chat in a folder and returns its id.',
    params: 'folder: string, name?: string, prompt?: string',
  },
  {
    name: patchToolId('patch_send_to'),
    label: 'patch_send_to',
    category: 'patch',
    description:
      'Delivers a message into another existing chat as if the human sent it (agent-to-agent).',
    params: 'chatId: string, message: string, localId?: string',
  },
  {
    name: patchToolId('patch_send_back'),
    label: 'patch_send_back',
    category: 'patch',
    description:
      "Posts a side branch's conclusion back into its parent track as a quiet, summarised row.",
    params: '(no params)',
  },
  {
    name: patchToolId('patch_peek'),
    label: 'patch_peek',
    category: 'patch',
    description:
      "Reads another chat's live state and recent event stream without messaging it (read-only).",
    params: 'chatId: string, limit?: number',
  },
  {
    name: patchToolId('patch_notify'),
    label: 'patch_notify',
    category: 'patch',
    description: "Sends a push notification to the user's phone.",
    params: 'title: string, body: string',
  },
  {
    name: patchToolId('patch_artifact'),
    label: 'patch_artifact',
    category: 'patch',
    description:
      'Publishes an HTML file from the chat folder as a page you can open — the artifact appears as a card in the chat.',
    params: 'path: string, title?: string',
  },
  {
    name: patchToolId('view_file'),
    label: 'view_file',
    category: 'patch',
    description:
      "Shows an image or HTML file inline in the chat without reading it into the agent's context.",
    params: 'file_path: string',
  },
  {
    name: patchToolId('patch_wake_me'),
    label: 'patch_wake_me',
    category: 'patch',
    description:
      'Schedules the agent to be woken later with a message — the durable, self-wake timer.',
    params: 'message: string, in?: string, at?: string, notAfter?: string',
  },
  {
    name: patchToolId('patch_cancel_wake'),
    label: 'patch_cancel_wake',
    category: 'patch',
    description: "Cancels this chat's pending self-wake.",
    params: '(no params)',
  },
  {
    name: patchToolId('patch_watch'),
    label: 'patch_watch',
    category: 'patch',
    description:
      'Runs a shell command as a durable background task the host itself owns, holds a real pid for, and can kill.',
    params: 'command: string, description: string, cwd?: string',
  },
  {
    name: patchToolId('patch_watch_list'),
    label: 'patch_watch_list',
    category: 'patch',
    description: "Lists this chat's background tasks, running and recently finished.",
    params: '(no params)',
  },
  {
    name: patchToolId('patch_watch_output'),
    label: 'patch_watch_output',
    category: 'patch',
    description: "Reads a background task's combined stdout+stderr.",
    params: 'taskId: string, tail?: number',
  },
  {
    name: patchToolId('patch_watch_stop'),
    label: 'patch_watch_stop',
    category: 'patch',
    description: 'Kills a running background task outright, its whole process group.',
    params: 'taskId: string',
  },
  {
    name: patchToolId('patch_delegate'),
    label: 'patch_delegate',
    category: 'patch',
    description:
      'Runs a sub-task as a durable, invisible subagent and delivers its full result back to this chat when it finishes.',
    params:
      'prompt: string, model?: string, folder?: string, disallowedTools?: string[], wait?: boolean',
  },
  {
    name: patchToolId('patch_delegate_list'),
    label: 'patch_delegate_list',
    category: 'patch',
    description: "Lists this chat's subagents and their running/done/failed status.",
    params: '(no params)',
  },
  {
    name: patchToolId('patch_delegate_send'),
    label: 'patch_delegate_send',
    category: 'patch',
    description:
      "Sends a follow-up message to one of this chat's subagents, optionally waiting for its reply.",
    params: 'id: string, message: string, wait?: boolean',
  },
  {
    name: patchToolId('patch_delegate_stop'),
    label: 'patch_delegate_stop',
    category: 'patch',
    description: "Stops one of this chat's own subagents outright.",
    params: 'id: string',
  },
  {
    name: patchToolId('patch_history'),
    label: 'patch_history',
    category: 'patch',
    description: "Reads another chat's history, paginated.",
    params: 'chatId: string, fromSeq?: number, limit?: number',
  },
  {
    name: patchToolId('patch_list_chats'),
    label: 'patch_list_chats',
    category: 'patch',
    description: 'Lists every chat the user has, across every machine on the account.',
    params: "archived?: 'only' | 'include'",
  },
  {
    name: patchToolId('patch_list_devices'),
    label: 'patch_list_devices',
    category: 'patch',
    description: 'Lists the registered voice devices and whether each is online.',
    params: '(no params)',
  },
  {
    name: patchToolId('patch_stop'),
    label: 'patch_stop',
    category: 'patch',
    description: "Stops a chat's in-flight turn.",
    params: 'chatId: string',
  },
  {
    name: patchToolId('patch_speak'),
    label: 'patch_speak',
    category: 'patch',
    description: 'Says something out loud on a voice device in the house.',
    params: 'message: string, deviceId?: string',
  },
  {
    name: patchToolId('patch_ask_human'),
    label: 'patch_ask_human',
    category: 'patch',
    description:
      'Says the agent is blocked until the user does something themselves, in the world.',
    params: 'task: string, why?: string',
  },
  {
    name: patchToolId('patch_report'),
    label: 'patch_report',
    category: 'patch',
    description: "Puts a one-line finding on this chat's sidebar row, pulling it out of Archived.",
    params: 'summary: string',
  },
  {
    name: patchToolId('patch_call'),
    label: 'patch_call',
    category: 'patch',
    description:
      'Rings the user phone-style, dropping them into a voice call against this chat on accept.',
    params: 'chatId?: string, message?: string',
  },
  {
    name: patchToolId('patch_job_list'),
    label: 'patch_job_list',
    category: 'patch',
    description: "Lists the user's persistent jobs (cross-session automations).",
    params: '(no params)',
  },
  {
    name: patchToolId('patch_job_create'),
    label: 'patch_job_create',
    category: 'patch',
    description:
      'Creates a recurring or triggered job (cron / webhook / todoist) that spawns work over time.',
    params: 'name: string, trigger: object, action: object',
  },
  {
    name: patchToolId('patch_job_update'),
    label: 'patch_job_update',
    category: 'patch',
    description: 'Patches fields of an existing job.',
    params: 'jobId: string, trigger?: object, action?: object, enabled?: boolean, …',
  },
  {
    name: patchToolId('patch_job_delete'),
    label: 'patch_job_delete',
    category: 'patch',
    description: 'Deletes a job permanently.',
    params: 'jobId: string',
  },
  {
    name: patchToolId('patch_job_enable'),
    label: 'patch_job_enable',
    category: 'patch',
    description: 'Enables a previously disabled job again.',
    params: 'jobId: string',
  },
  {
    name: patchToolId('patch_job_disable'),
    label: 'patch_job_disable',
    category: 'patch',
    description: 'Pauses a job without deleting it.',
    params: 'jobId: string',
  },
  {
    name: patchToolId('patch_job_runs'),
    label: 'patch_job_runs',
    category: 'patch',
    description: "Reads a job's recent run log entries.",
    params: 'jobId: string, limit?: number',
  },
  {
    name: patchToolId('patch_job_webhooks'),
    label: 'patch_job_webhooks',
    category: 'patch',
    description: "Reads a job's recent inbound-webhook log entries.",
    params: 'jobId: string, limit?: number',
  },
  {
    name: patchToolId('patch_browser_open'),
    label: 'patch_browser_open',
    category: 'patch',
    description:
      'Opens a URL in a real browser on the host and returns a tabId for the other browser tools.',
    params: "url: string, profile?: 'logged-in' | 'logged-out'",
  },
  {
    name: patchToolId('patch_browser_read'),
    label: 'patch_browser_read',
    category: 'patch',
    description:
      "Reads a tab's page as an accessible snapshot — title, url, and every visible element with a ref.",
    params: 'tabId: string',
  },
  {
    name: patchToolId('patch_browser_click'),
    label: 'patch_browser_click',
    category: 'patch',
    description: 'Clicks the element at a ref with a real mouse event.',
    params: 'tabId: string, ref: string',
  },
  {
    name: patchToolId('patch_browser_type'),
    label: 'patch_browser_type',
    category: 'patch',
    description: 'Types text into the element at a ref as real, human-paced keystrokes.',
    params: 'tabId: string, ref: string, text: string, submit?: boolean',
  },
  {
    name: patchToolId('patch_browser_fill_form'),
    label: 'patch_browser_fill_form',
    category: 'patch',
    description: 'Fills several form fields — text, checkboxes, selects — in one call.',
    params: 'tabId: string, fields: { ref: string, value: string }[]',
  },
  {
    name: patchToolId('patch_browser_select'),
    label: 'patch_browser_select',
    category: 'patch',
    description: "Sets a <select> at a ref to a given option's value.",
    params: 'tabId: string, ref: string, value: string',
  },
  {
    name: patchToolId('patch_browser_upload'),
    label: 'patch_browser_upload',
    category: 'patch',
    description: 'Attaches local file(s) to a file input at a ref.',
    params: 'tabId: string, ref: string, filePaths: string[]',
  },
  {
    name: patchToolId('patch_browser_screenshot'),
    label: 'patch_browser_screenshot',
    category: 'patch',
    description: "Takes a PNG screenshot of the tab's current page.",
    params: 'tabId: string',
  },
  {
    name: patchToolId('patch_browser_tabs'),
    label: 'patch_browser_tabs',
    category: 'patch',
    description: 'Lists every open browser tab on this host.',
    params: '(no params)',
  },
  {
    name: patchToolId('patch_browser_close'),
    label: 'patch_browser_close',
    category: 'patch',
    description: 'Closes a browser tab.',
    params: 'tabId: string',
  },
];

/** The full toggleable inventory shown in the Tools sheet, native first. */
export const TOOL_CATALOG: ToolCatalogEntry[] = [...NATIVE_TOOLS, ...PATCH_TOOLS];

/** Friendly display name for a tool id — strips the MCP server prefix, if any. */
export function toolLabel(name: string): string {
  return name.startsWith(PATCH_MCP_PREFIX) ? name.slice(PATCH_MCP_PREFIX.length) : name;
}

/**
 * Looks a tool up in the curated catalog, falling back to a generic entry for
 * one the catalog doesn't enumerate — an MCP tool from a server this list
 * hasn't been updated for yet, say. Mirrors `packages/web/src/lib/
 * toolsCatalog.ts`'s `describeTool` so an uncatalogued tool still renders a
 * readable label instead of its raw wire id.
 */
export function describeTool(name: string): ToolCatalogEntry {
  const known = TOOL_CATALOG.find((t) => t.name === name);
  if (known) return known;
  return {
    name,
    label: toolLabel(name),
    category: name.startsWith(PATCH_MCP_PREFIX) ? 'patch' : 'native',
    description: 'No catalog description — this tool is not in the curated inventory.',
    params: '(definition unavailable)',
  };
}
