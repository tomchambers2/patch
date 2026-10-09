// patch-tools-server — stdio MCP server launched by every SDK query.
//
// Per spec/02-daemon.md "MCP server" + spec/06 ## Cross-chat tools: the SDK
// passes inline mcpServers configuration that boots this script. The MCP
// child reads PATCH_CHAT_ID + PATCH_DAEMON_SOCKET from env and tags every
// tool call with chatId. Side effects round-trip back to the host over
// the UDS internal endpoints (no auth — same host, same user, mode-0600
// socket, per spec/02 "No auth").
//
// The tools are thin wrappers over the host's
// `/internal/*` endpoints. The heavy lifting lives host-side.

import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export interface PatchToolsServerOptions {
  /** UDS path for host control HTTP. */
  daemonSocketPath: string;
  /** chatId baked into env (PATCH_CHAT_ID). */
  chatId: string;
  /**
   * The host's current local key (PATCH_DAEMON_LOCAL_KEY), presented as a
   * Bearer on every socket call (spec/02 § MCP server). The host minted it
   * and put it in this child's environment; the child does not read the file.
   */
  localKey: string;
  /**
   * Which branch this turn is running on (spec/04 § Branching — PATCH_BRANCH_ID).
   * Absent for a turn on the chat's active branch (every turn before parallel
   * branches existed) — `patch_send_back` has nothing to send FROM in that
   * case and refuses saying so.
   */
  branchId?: string;
}

interface UdsRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Bearer presented on the socket. */
  localKey?: string;
}

const CHAT_ID_PARAM = "The target chat's id (from patch_list_chats).";
/** The image plus the viewport it was taken in, so coordinates stay unambiguous. */
function screenshotResult(res: { data: string; mimeType: string; width: number; height: number }) {
  return {
    content: [
      { type: 'image' as const, data: res.data, mimeType: res.mimeType },
      { type: 'text' as const, text: `viewport ${res.width}x${res.height}` },
    ],
  };
}

const TAB_ID_PARAM = 'The tabId returned by patch_browser_open (or listed by patch_browser_tabs).';
const JOB_ID_PARAM = "The job's id (from patch_job_list).";
const JOB_LIMIT_PARAM =
  'Max entries to return, newest first. Default 50; above 200 is clamped to 200.';
const JOB_ACTION_PARAM =
  'What a fire does — one of four shapes. Every one except script needs a `prompt`, a `skill`, or both (the first user turn). ' +
  '{type:"spawn", daemonId, folder, prompt?, skill?, model?, permissionMode?, startHidden?, notifyOnComplete?, includePayload?, goal?} starts a fresh chat in `folder` on machine `daemonId` each fire. ' +
  '{type:"continue", daemonId, folder, prompt?, skill?, key?, model?, startHidden?, notifyOnComplete?, includePayload?, goal?} messages ONE durable chat, creating it on the first fire; `key` (a mustache template such as "{{payload.event_data.id}}") gives each distinct subject its own chat, unkeyed means one chat for every fire. ' +
  '{type:"message", chatId, prompt?, skill?, includePayload?} delivers into an existing chat, which supplies its own host, folder and model. ' +
  '{type:"script", daemonId, folder, command, timeoutMs?} runs a shell command with no chat or agent turn (timeoutMs 1000-600000, default 60000). ' +
  "includePayload:false stops a todoist/webhook fire's event JSON being appended after the prompt (default: appended). " +
  'daemonId comes from patch_list_chats. An unknown field or shape is rejected with the reason.';
const JOB_TRIGGER_PARAM =
  'What fires the job — one of four shapes. {type:"cron", expression, timezone?} and {type:"recurrence", rrule, timezone} are described in the tool description. ' +
  '{type:"webhook", scheme, secret?, path?} fires on an inbound HTTP POST to the job\'s own URL (unguessable, derived from the jobId); `scheme` is "none", "hmac-sha256", "github", "stripe" or "todoist" and picks how the signature is checked, `secret` is the shared secret and is required for every scheme but "none", `path` is only a label. ' +
  'Todoist is not a trigger of its own: use scheme "todoist" with the Todoist app\'s client secret as `secret`, and narrow it with the job-level JSONata `filter`. Todoist\'s one callback URL is `/api/webhooks/todoist`, which fans out to every such job.';
const JOB_FILTER_PARAM =
  "Optional JSONata expression evaluated against the trigger's payload; a fire only proceeds when it is truthy. Use gate instead for a question about the world rather than the payload.";
const JOB_CONCURRENCY_PARAM =
  'Max simultaneous fires of this job (at least 1). Prefer queueing, which also supports a per-key limit; the two cannot be combined.';

/**
 * Build the MCP server with the full patch tool catalogue. Caller wires it
 * to a transport (stdio in production, in-memory pair in tests).
 */
export function buildPatchToolsServer(opts: PatchToolsServerOptions): McpServer {
  const server = new McpServer(
    { name: 'patch-tools', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'To show a design or UI for the user to react to, use a Pad (patch_pad_create) instead of describing it.',
    },
  );
  const callerChatId = opts.chatId;
  const callerBranchId = opts.branchId;

  function uds<T>(req: UdsRequestOptions): Promise<T> {
    return udsRequest<T>(opts.daemonSocketPath, { ...req, localKey: opts.localKey });
  }

  function toolResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  // ---- patch_peek ---------------------------------------------------------
  server.registerTool(
    'patch_peek',
    {
      description:
        "Read another chat's live state plus the most-recent slice of its wire-event stream — on ANY registered host, not just this one. Returns { chat_state, events, truncated }: chat_state is the snapshot (activity, name, folder, last update); events is the recent wire-event window (default 50, up to 200 via limit); truncated:true means older events exist — call patch_history to paginate. Use to check what a sibling chat is doing right now without sending a message. Read-only, no summary pass.",
      inputSchema: {
        chatId: z.string().min(1).describe(CHAT_ID_PARAM),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ chatId, limit }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      // Correlates a cross-host relay to this chat, and rate-limits it — the
      // target may not be local (spec/03 § Cross-chat tools).
      params.set('callerChatId', callerChatId);
      const qs = params.toString();
      const peeked = await uds<unknown>({
        method: 'GET',
        path: `/internal/peek/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`,
      });
      return toolResult(peeked);
    },
  );

  // ---- patch_send_to ------------------------------------------------------
  server.registerTool(
    'patch_send_to',
    {
      description:
        "Agent-to-agent. Deliver a message as a user-turn into another existing chat — on ANY registered host, not just this one — the recipient's agent processes it as if the human sent it. Pass an idempotent localId if you want retries to dedupe.",
      inputSchema: {
        chatId: z.string().min(1).describe(CHAT_ID_PARAM),
        message: z.string().min(1),
        voicePrefix: z
          .string()
          .optional()
          .describe(
            'Tag prepended to the delivered turn to mark it as spoken input. Leave unset for ordinary text.',
          ),
        localId: z.string().min(1).max(128).optional(),
      },
    },
    async ({ chatId, message, voicePrefix, localId }) => {
      const body: Record<string, unknown> = { chatId, message, callerChatId };
      if (voicePrefix !== undefined) body['voicePrefix'] = voicePrefix;
      if (localId !== undefined) body['localId'] = localId;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/send-to', body });
      return toolResult(res);
    },
  );

  // ---- patch_send_back ----------------------------------------------------
  server.registerTool(
    'patch_send_back',
    {
      description:
        'Only callable from a SIDE BRANCH — a chat you were started as a side thread of another conversation, not a chat started directly. Posts your conclusion back into the parent track as a quiet row carrying a short summary the host generates from what you were asked and what you last said. Refused if you are not running on a side branch, or if this branch already sent back once.',
      inputSchema: {},
    },
    async () => {
      if (!callerBranchId) {
        throw new Error(
          'patch_send_back: this turn is not running on a side branch (NO FALLBACK — there is no parent to send back to)',
        );
      }
      const res = await uds<{ ok: boolean; error?: string }>({
        method: 'POST',
        path: '/internal/send-back',
        body: { chatId: callerChatId, branchId: callerBranchId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_suggest ---------------------------------------------------
  server.registerTool(
    'patch_doc_suggest',
    {
      description:
        "Propose a tracked edit to a Markdown document open in Propose mode — rendered to the user as an accept/reject suggestion, never applied directly. Refused outright if the document is not in Propose mode (use Edit/Write in Change mode; use patch_doc_comment in Comment mode — no text tool reaches the document there). `find` must be an EXACT, CURRENTLY UNIQUE substring of the document, same contract Edit's old_string holds. `replace` is what it becomes if accepted — empty string for a pure deletion.",
      inputSchema: {
        path: z.string().min(1).describe("The document's path, relative to this chat's folder."),
        find: z.string().min(1),
        replace: z.string(),
      },
    },
    async (args: { path: string; find: string; replace: string }) => {
      const res = await uds<{ id: string; status: string }>({
        method: 'POST',
        path: '/internal/doc/suggest',
        body: { chatId: callerChatId, path: args.path, find: args.find, replace: args.replace },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_comment ----------------------------------------------------
  server.registerTool(
    'patch_doc_comment',
    {
      description:
        "Leave a NEW comment thread on a Markdown document, anchored to a passage — available in every mode (it never touches the document's text). Use when you have something to say about a passage that doesn't call for patch_doc_suggest/Edit — a question, a flag, a note. `anchor` should be a short exact quote from the document.",
      inputSchema: {
        path: z.string().min(1).describe("The document's path, relative to this chat's folder."),
        anchor: z.string().describe('A short exact quote from the document this comment is about.'),
        text: z.string().min(1),
      },
    },
    async (args: { path: string; anchor: string; text: string }) => {
      const res = await uds<{ id: string }>({
        method: 'POST',
        path: '/internal/doc/comment',
        body: { chatId: callerChatId, path: args.path, anchor: args.anchor, text: args.text },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_reply ------------------------------------------------------
  server.registerTool(
    'patch_doc_reply',
    {
      description:
        'Reply inside an EXISTING comment thread on a Markdown document — how you answer a comment the user left, which arrives as a <system-reminder> naming the threadId. Available in every mode.',
      inputSchema: {
        path: z.string().min(1).describe("The document's path, relative to this chat's folder."),
        threadId: z.string().min(1),
        text: z.string().min(1),
      },
    },
    async (args: { path: string; threadId: string; text: string }) => {
      const res = await uds<{ id: string }>({
        method: 'POST',
        path: '/internal/doc/reply',
        body: { chatId: callerChatId, path: args.path, threadId: args.threadId, text: args.text },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_convert ----------------------------------------------------
  server.registerTool(
    'patch_doc_convert',
    {
      description:
        "Convert a .docx in this chat's folder to the Markdown document editor — the same conversion opening the file in a surface triggers. The original .docx is left untouched; the converted .md lands beside it (same basename). Re-running this on a .docx that hasn't changed since the last conversion is a no-op (reused:true) rather than overwriting any edits made to the .md since. Returns `{mdPath, warnings, reused}` — `warnings` names anything that couldn't convert (tracked changes, embedded objects, multi-column layout), never silently dropped.",
      inputSchema: {
        path: z.string().min(1).describe("The .docx file's path, relative to this chat's folder."),
      },
    },
    async (args: { path: string }) => {
      const res = await uds<{ mdPath: string; warnings: string[]; reused: boolean }>({
        method: 'POST',
        path: '/internal/doc/convert',
        body: { chatId: callerChatId, path: args.path },
      });
      return toolResult(res);
    },
  );

  // ---- patch_doc_export -----------------------------------------------------
  server.registerTool(
    'patch_doc_export',
    {
      description:
        "Export a Markdown document this chat's folder holds to .docx, .pdf or .md — the agent-side equivalent of the editor's Download/Save as menu. Writes the exported file beside the .md (same basename, new extension) and returns `{path, warnings}` — `warnings` names anything the export couldn't carry over (e.g. an image it couldn't embed), never silently dropped. The file's bytes are NOT returned here (base64 would waste context on binary); read the result with a file tool if you need to inspect it, or just tell the user it's there.",
      inputSchema: {
        path: z.string().min(1).describe("The .md file's path, relative to this chat's folder."),
        format: z
          .enum(['docx', 'pdf', 'md'])
          .describe('Output format; the file is written beside the .md with this extension.'),
      },
    },
    async (args: { path: string; format: 'docx' | 'pdf' | 'md' }) => {
      const res = await uds<{ path: string; warnings: string[] }>({
        method: 'POST',
        path: '/internal/doc/export',
        body: { chatId: callerChatId, path: args.path, format: args.format },
      });
      return toolResult(res);
    },
  );

  // ---- patch_spawn --------------------------------------------------------
  server.registerTool(
    'patch_spawn',
    {
      description:
        "Create a brand-new persistent chat in a folder, optionally on ANOTHER machine. Returns the new chatId and the machine it was created on; a spawn the target machine refuses (unknown folder, no model catalogue there) fails with that machine's own reason, so a result you get back is a chat that really exists. Use when the user wants a new long-lived, user-visible chat as an artifact — not for work that should finish inside this turn. `host` is the daemonId of the machine to create it on (see patch_list_chats for which machines chats live on); omitted means this machine. `model` is optional — the target machine picks its own last-used model.",
      inputSchema: {
        folder: z.string().min(1),
        host: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      },
    },
    async ({ folder, host, name, prompt, model }) => {
      const body: Record<string, unknown> = { folder, callerChatId };
      if (host !== undefined) body['host'] = host;
      if (model !== undefined) body['model'] = model;
      if (name !== undefined) body['name'] = name;
      if (prompt !== undefined) body['prompt'] = prompt;
      // A cross-machine spawn blocks here until the NAMED machine answers with
      // its own outcome. NO FALLBACK: a refusal (or an unanswered call) is a
      // tool ERROR naming the machine, never a `created:'remote'` for a chat
      // that was never created — an agent orchestrating work on a chat that
      // does not exist is the worst possible failure mode.
      try {
        const res = await uds<{ chatId?: string; host?: string }>({
          method: 'POST',
          path: '/internal/spawn',
          body,
        });
        return toolResult(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          host !== undefined
            ? `patch_spawn on machine ${host} failed, no chat was created: ${message}`
            : `patch_spawn failed, no chat was created: ${message}`,
        );
      }
    },
  );

  // ---- patch_wake_me ------------------------------------------------------
  server.registerTool(
    'patch_wake_me',
    {
      description:
        'Schedule a DURABLE self-wake: the host delivers `message` back into THIS chat as a new turn after a delay, then you decide what to do (re-arm for a loop, or stop). You do NOT wait — call this and END your turn; the host owns the timer and survives restarts. Use for a self-rescheduling reminder/check loop (e.g. nag every 10 min until done). Provide exactly one of `in` (relative: "10m", "1h30m", "90s", or seconds) or `at` (absolute ISO 8601 — compute the user\'s local time yourself). Optional `notAfter` (ISO) voids the wake if it would fire past it. Re-calling REPLACES the pending wake (one per chat). This is NOT a job (jobs fire an external schedule into a new chat) — a job is for a different or new chat, this is for re-invoking THIS one.',
      inputSchema: {
        message: z.string().min(1),
        in: z.union([z.string(), z.number()]).optional(),
        at: z.string().optional(),
        notAfter: z.string().optional(),
      },
    },
    async ({ message, in: inDelay, at, notAfter }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, message };
      if (inDelay !== undefined) body['in'] = inDelay;
      if (at !== undefined) body['at'] = at;
      if (notAfter !== undefined) body['notAfter'] = notAfter;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/wake', body });
      return toolResult(res);
    },
  );

  // ---- patch_loop -----------------------------------------------------------
  server.registerTool(
    'patch_loop',
    {
      description:
        'Arm a DURABLE recurring self-wake: the host delivers `message` back into THIS chat as a new turn every `every`, forever — no need to re-arm it yourself each time (that is `patch_wake_me`; this is for the fixed-cadence case where the interval never changes). Same underlying timer as `patch_wake_me` — one pending wake per chat, arming a loop REPLACES any pending wake_me/loop and vice versa. `every` is a duration ("10m", "1h30m", "90s", or seconds) — the first fire is one `every` from now, then every `every` thereafter. Optional `notAfter` (ISO 8601) stops the loop once a fire would land past it. Stop the loop with `patch_cancel_wake` — there is no separate stop tool.',
      inputSchema: {
        message: z.string().min(1),
        every: z.union([z.string(), z.number()]),
        notAfter: z.string().optional(),
      },
    },
    async ({ message, every, notAfter }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, message, every };
      if (notAfter !== undefined) body['notAfter'] = notAfter;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/wake', body });
      return toolResult(res);
    },
  );

  // ---- patch_cancel_wake --------------------------------------------------
  server.registerTool(
    'patch_cancel_wake',
    {
      description:
        "Cancel this chat's pending self-wake — a one-shot `patch_wake_me` OR a `patch_loop` (stop the loop). No-op if none is pending. Use when the reminder condition is satisfied and you should stop nagging.",
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/wake/cancel',
        body: { chatId: callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_goal_set -------------------------------------------------------
  server.registerTool(
    'patch_goal_set',
    {
      description:
        "Set THIS chat's goal — the same mechanism `/goal <condition>` sets from " +
        'the composer. One per chat; calling this again REPLACES whatever goal was set before. After ' +
        "each turn settles, Patch's own evaluator judges `condition` against the conversation: not met " +
        'continues with the reason as guidance, met or impossible clears it. Unlike the composer command, ' +
        'calling this tool does NOT also send `condition` as a turn — it only arms the evaluator, since ' +
        'you are already mid-conversation. Visible to the user the whole time, via a bar above the chat.',
      inputSchema: {
        condition: z.string().min(1),
      },
    },
    async ({ condition }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/goal',
        body: { chatId: callerChatId, goal: condition },
      });
      return toolResult(res);
    },
  );

  // ---- patch_goal_get -------------------------------------------------------
  server.registerTool(
    'patch_goal_get',
    {
      description:
        "Read THIS chat's goal: the active condition plus live progress (turns evaluated, tokens " +
        "spent, the evaluator's latest verdict/reason), or — once it has resolved — the most recently " +
        'finished one (condition, duration, turns, tokens, outcome, reason). Both are `null` if no goal ' +
        'has ever been set on this chat.',
      inputSchema: {},
    },
    async () => {
      const params = new URLSearchParams({ chatId: callerChatId });
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/goal?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_goal_clear -----------------------------------------------------
  server.registerTool(
    'patch_goal_clear',
    {
      description:
        "Clear THIS chat's goal without judging it — no met/impossible verdict is recorded, the " +
        'evaluator simply stops. No-op if none is set. Use when the goal is no longer relevant (the ' +
        'user changed direction) rather than letting the evaluator eventually call it impossible.',
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/goal',
        body: { chatId: callerChatId, goal: null },
      });
      return toolResult(res);
    },
  );

  // ---- patch_watch ----------------------------------------------------------
  server.registerTool(
    'patch_watch',
    {
      description:
        'Run a command as a DURABLE background task the host itself owns — the replacement for ' +
        "Bash's `run_in_background` (disabled: see the tool-call denial for why). Spawns " +
        '`command` as a detached process the host holds a real pid for, persists it, and returns ' +
        'immediately with `{ taskId }` — it does NOT block this turn. The host polls it in the ' +
        'background and, once it exits, delivers a `[watch]`-prefixed message into THIS chat as a new ' +
        'turn (survives a host restart either way — the task keeps running and is re-attached). Use ' +
        'for anything that takes longer than you want to wait: a build, a long test run, a download. ' +
        "`cwd` defaults to this chat's own folder.",
      inputSchema: {
        command: z.string().min(1),
        description: z
          .string()
          .min(1)
          .describe(
            'Short human label for what this task is, shown in patch_watch_list and the chat.',
          ),
        cwd: z.string().min(1).optional(),
      },
    },
    async ({ command, description, cwd }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, command, description };
      if (cwd !== undefined) body['cwd'] = cwd;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/watch', body });
      return toolResult(res);
    },
  );

  // ---- patch_watch_list -----------------------------------------------------
  server.registerTool(
    'patch_watch_list',
    {
      description:
        'List every background task THIS chat has running or recently finished — each with its ' +
        'taskId, description, command, status, startedAt, and endedAt/exitCode where it has ended. ' +
        'Use to check on work started with patch_watch without reading its full output.',
      inputSchema: {},
    },
    async () => {
      const params = new URLSearchParams({ chatId: callerChatId });
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/watch?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_watch_output -----------------------------------------------------
  server.registerTool(
    'patch_watch_output',
    {
      description:
        "Read a patch_watch task's combined stdout+stderr. Pass `tail` to get only the last N lines " +
        'of a long-running task instead of the whole thing.',
      inputSchema: {
        taskId: z.string().min(1).describe('The taskId returned by patch_watch.'),
        tail: z.number().int().positive().optional(),
      },
    },
    async ({ taskId, tail }) => {
      const params = new URLSearchParams({ chatId: callerChatId });
      if (tail !== undefined) params.set('tail', String(tail));
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/watch/${encodeURIComponent(taskId)}/output?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_watch_stop -----------------------------------------------------
  server.registerTool(
    'patch_watch_stop',
    {
      description:
        'Kill a running patch_watch task outright (its whole process group). Idempotent: stopping an ' +
        'already-ended task returns `stopped: false` rather than erroring.',
      inputSchema: { taskId: z.string().min(1).describe('The taskId returned by patch_watch.') },
    },
    async ({ taskId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: `/internal/watch/${encodeURIComponent(taskId)}/stop`,
        body: { chatId: callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_open ---------------------------------------------------
  server.registerTool(
    'patch_browser_open',
    {
      description:
        'Open a URL in a REAL browser on this host (Chrome/Chromium, never headless, a normal fingerprint with no automation flags) and return a tabId for the other patch_browser_* tools. `profile` (default "logged-in") picks which cookies it carries: "logged-in" is the ONE persistent profile shared by every chat on this host, so a site logged into once stays logged in; "logged-out" is a throwaway profile with no cookies, for a task that must run signed out. Fails clearly, with no fallback to another browser, if the host has no browser component installed. Use patch_browser_read next to see the page.',
      inputSchema: {
        url: z.string().min(1),
        profile: z.enum(['logged-in', 'logged-out']).optional(),
      },
    },
    async ({ url, profile }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, url };
      if (profile !== undefined) body['profile'] = profile;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/browser/open', body });
      return toolResult(res);
    },
  );

  // ---- patch_delegate -------------------------------------------------------
  server.registerTool(
    'patch_delegate',
    {
      description:
        'Delegate a sub-task to a DURABLE subagent: a worker that runs `prompt` to ' +
        'completion and hands its FULL final reply back to THIS chat as a `[from <label>]`-prefixed ' +
        'message once nothing is running or queued in it any more — survives this turn ending and a ' +
        'host restart either way. By default returns immediately with `{ id, label }` and you end your ' +
        'turn (like patch_watch). Pass `wait: true` to block instead: the call returns ' +
        "`{ id, label, status, reply }` with the subagent's final reply as the tool result (no " +
        '`[from]` message is sent). `disallowedTools` withholds tools from it (e.g. ["Bash", "Write", ' +
        '"Edit"] for a read-only researcher). It stays alive after finishing: continue it with ' +
        'patch_delegate_send. Several can run in parallel. Unlike patch_spawn, the ' +
        'subagent is NOT a chat the user ever sees — not in their sidebar, search, or notifications; ' +
        'the only way into it is from a tool-call row in THIS chat. It cannot talk to the user itself ' +
        '(patch_notify/patch_report/patch_call/patch_speak/patch_ask_human/patch_artifact are disabled ' +
        "for it) and runs under this chat's permission mode — if it needs a decision (including its " +
        "own AskUserQuestion), that decision surfaces on THIS chat, labelled with the subagent's name. " +
        'A subagent that fails (error, a usage limit it cannot get past) delivers that failure the same ' +
        "way — never silently. `folder`/`model` default to this chat's own. Use for a scoped sub-task " +
        "you want run in the background while you carry on, or that doesn't need you in the loop at all.",
      inputSchema: {
        prompt: z.string().min(1),
        model: z.string().min(1).optional(),
        folder: z.string().min(1).optional(),
        disallowedTools: z.array(z.string().min(1)).optional(),
        wait: z.boolean().optional(),
      },
    },
    async ({ prompt, model, folder, disallowedTools, wait }) => {
      const body: Record<string, unknown> = { chatId: callerChatId, prompt };
      if (disallowedTools !== undefined) body['disallowedTools'] = disallowedTools;
      if (wait !== undefined) body['wait'] = wait;
      if (model !== undefined) body['model'] = model;
      if (folder !== undefined) body['folder'] = folder;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/delegate', body });
      return toolResult(res);
    },
  );

  // ---- patch_delegate_send ---------------------------------------------------
  server.registerTool(
    'patch_delegate_send',
    {
      description:
        "Send a follow-up message to one of THIS chat's own patch_delegate subagents — running or " +
        'already finished; a finished one wakes with its whole context intact. With `wait: true` the ' +
        'call blocks and returns `{ id, status, reply }`; otherwise its next reply is delivered to ' +
        'this chat as a `[from <label>]` message. Errors for an id this chat did not create.',
      inputSchema: {
        id: z.string().min(1),
        message: z.string().min(1),
        wait: z.boolean().optional(),
      },
    },
    async ({ id, message, wait }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/delegate/send',
        body: { chatId: callerChatId, id, message, ...(wait !== undefined ? { wait } : {}) },
      });
      return toolResult(res);
    },
  );

  // ---- patch_delegate_list ---------------------------------------------------
  server.registerTool(
    'patch_delegate_list',
    {
      description:
        'List every patch_delegate subagent THIS chat has created — id, label, status ' +
        '(running/awaiting-permission/done/failed/stopped), createdAt, finishedAt. Use to check on ' +
        'work started with patch_delegate without waiting for its delivery.',
      inputSchema: {},
    },
    async () => {
      const params = new URLSearchParams({ chatId: callerChatId });
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/delegate?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_delegate_stop ---------------------------------------------------
  server.registerTool(
    'patch_delegate_stop',
    {
      description:
        "Stop one of THIS chat's own subagents outright — no result is delivered for it (the caller " +
        'already knows it stopped it). Idempotent: stopping one already finished, or an id this chat ' +
        'did not create, returns `stopped: false` rather than erroring.',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/delegate/stop',
        body: { chatId: callerChatId, id },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_read ----------------------------------------------------
  server.registerTool(
    'patch_browser_read',
    {
      description:
        "Read the tab's current page as an accessible snapshot: title, url, and a flat list of every visible interactive element (links, buttons, form fields, headings) each with a stable `ref` — pass that ref to patch_browser_click/_type/_fill_form/_select/_upload. Call this again after any navigation or DOM change; a ref from a stale snapshot will not resolve.",
      inputSchema: { tabId: z.string().min(1).describe(TAB_ID_PARAM) },
    },
    async ({ tabId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/read',
        body: { tabId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_click ---------------------------------------------------
  server.registerTool(
    'patch_browser_click',
    {
      description:
        'Click the element at `ref` (from patch_browser_read) with a real mouse event. Ask the user first before a click that is irreversible — submitting a payment, sending a message, placing an order, deleting something.',
      inputSchema: { tabId: z.string().min(1).describe(TAB_ID_PARAM), ref: z.string().min(1) },
    },
    async ({ tabId, ref }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/click',
        body: { tabId, ref },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_type ----------------------------------------------------
  server.registerTool(
    'patch_browser_type',
    {
      description:
        'Type `text` into the element at `ref` as real keystrokes, human-paced — not a value set directly. `submit` (default false) presses Enter afterwards. Ask the user first before typing and submitting something irreversible (e.g. sending a message).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        ref: z.string().min(1),
        text: z.string(),
        submit: z.boolean().optional(),
      },
    },
    async ({ tabId, ref, text, submit }) => {
      const body: Record<string, unknown> = { tabId, ref, text };
      if (submit !== undefined) body['submit'] = submit;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/browser/type', body });
      return toolResult(res);
    },
  );

  // ---- patch_browser_fill_form ------------------------------------------------
  server.registerTool(
    'patch_browser_fill_form',
    {
      description:
        'Fill several fields of a form in one call: `fields` is a list of `{ref, value}` from patch_browser_read\'s snapshot. Handles text inputs, checkboxes/radios ("true"/"false") and <select>s. Does NOT submit the form — call patch_browser_click on the submit button after, and ask the user first if submitting is irreversible (a payment, a booking, a message).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        fields: z.array(z.object({ ref: z.string().min(1), value: z.string() })).min(1),
      },
    },
    async ({ tabId, fields }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/fill_form',
        body: { tabId, fields },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_select ---------------------------------------------------
  server.registerTool(
    'patch_browser_select',
    {
      description:
        "Set a <select> at `ref` (from patch_browser_read) to `value` (an option's value or visible text).",
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        ref: z.string().min(1),
        value: z.string(),
      },
    },
    async ({ tabId, ref, value }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/select',
        body: { tabId, ref, value },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_upload ---------------------------------------------------
  server.registerTool(
    'patch_browser_upload',
    {
      description:
        'Attach one or more local files (absolute paths on THIS host) to the file input at `ref` (from patch_browser_read).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        ref: z.string().min(1),
        filePaths: z
          .array(z.string().min(1))
          .min(1)
          .describe('Absolute paths of the files to attach, on this host.'),
      },
    },
    async ({ tabId, ref, filePaths }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/upload',
        body: { tabId, ref, filePaths },
      });
      return toolResult(res);
    },
  );

  // ---- patch_browser_screenshot ------------------------------------------------
  server.registerTool(
    'patch_browser_screenshot',
    {
      description:
        "A PNG screenshot of the tab's current page, to see what patch_browser_read's text snapshot cannot (layout, an image, a captcha/bot check).",
      inputSchema: { tabId: z.string().min(1).describe(TAB_ID_PARAM) },
    },
    async ({ tabId }) => {
      const res = await uds<{ data: string; mimeType: string }>({
        method: 'POST',
        path: '/internal/browser/screenshot',
        body: { tabId },
      });
      return { content: [{ type: 'image' as const, data: res.data, mimeType: res.mimeType }] };
    },
  );

  // ---- patch_browser_mouse ----------------------------------------------------
  server.registerTool(
    'patch_browser_mouse',
    {
      description:
        'Act at pixel coordinates, the way a person looks at the screen and points: for canvases, maps, custom widgets, drag and drop and wheel scrolling, where patch_browser_read has no ref to give. Coordinates are in the screenshot you were last shown (x right, y down from its top-left). `action`: click, double_click, right_click, move (hover), drag (x,y to toX,toY), scroll (wheel at x,y by scrollX/scrollY pixels, positive = down/right). Returns a fresh screenshot of the result, so you can see what happened without another call. Prefer patch_browser_click with a ref when the element has one. Ask the user first before a click that is irreversible.',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        action: z.enum(['click', 'double_click', 'right_click', 'move', 'drag', 'scroll']),
        x: z.number(),
        y: z.number(),
        toX: z.number().optional().describe('drag destination x'),
        toY: z.number().optional().describe('drag destination y'),
        scrollX: z.number().optional(),
        scrollY: z.number().optional(),
      },
    },
    async ({ tabId, ...rest }) => {
      const body: Record<string, unknown> = { tabId };
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
      const res = await uds<{ data: string; mimeType: string; width: number; height: number }>({
        method: 'POST',
        path: '/internal/browser/mouse',
        body,
      });
      return screenshotResult(res);
    },
  );

  // ---- patch_browser_key ------------------------------------------------------
  server.registerTool(
    'patch_browser_key',
    {
      description:
        'Press keys into whatever has focus, in order: key names ("Enter", "Tab", "Escape", "ArrowDown", "PageDown", "a") or chords ("Control+a", "Shift+Tab", "Meta+c"). Use after patch_browser_mouse focuses something, or for shortcuts and navigation keys patch_browser_type cannot send. Returns a fresh screenshot of the result. Ask the user first before a key press that is irreversible (Enter on a payment or send).',
      inputSchema: {
        tabId: z.string().min(1).describe(TAB_ID_PARAM),
        keys: z.array(z.string().min(1)).min(1),
      },
    },
    async ({ tabId, keys }) => {
      const res = await uds<{ data: string; mimeType: string; width: number; height: number }>({
        method: 'POST',
        path: '/internal/browser/key',
        body: { tabId, keys },
      });
      return screenshotResult(res);
    },
  );

  // ---- patch_browser_tabs -----------------------------------------------------
  server.registerTool(
    'patch_browser_tabs',
    {
      description:
        'List every open browser tab on this host — tabId, title, url, profile — across every chat.',
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({ method: 'GET', path: '/internal/browser/tabs' });
      return toolResult(res);
    },
  );

  // ---- patch_browser_close ----------------------------------------------------
  server.registerTool(
    'patch_browser_close',
    {
      description:
        'Close a browser tab opened with patch_browser_open. A "logged-out" tab\'s throwaway cookies go with it.',
      inputSchema: { tabId: z.string().min(1).describe(TAB_ID_PARAM) },
    },
    async ({ tabId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/browser/close',
        body: { tabId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_history ------------------------------------------------------
  server.registerTool(
    'patch_history',
    {
      description:
        "Paginated read of another chat's history — on ANY registered host, not just this one. limit defaults to 50; values above the 200 hard cap are clamped to 200 (not rejected). Use after patch_peek when you need older events.",
      inputSchema: {
        chatId: z.string().min(1).describe(CHAT_ID_PARAM),
        fromSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Event sequence number to start reading from; omit to start at the beginning of the retained history.',
          ),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ chatId, fromSeq, limit }) => {
      const params = new URLSearchParams();
      if (fromSeq !== undefined) params.set('fromSeq', String(fromSeq));
      if (limit !== undefined) params.set('limit', String(limit));
      // Correlates a cross-host relay to this chat (spec/03 § Cross-chat tools).
      params.set('callerChatId', callerChatId);
      const qs = params.toString();
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/history/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_list_chats ---------------------------------------------------
  server.registerTool(
    'patch_list_chats',
    {
      description:
        "List all chats the user has, ACROSS every machine on the account. Each entry names the machine it lives on (daemonId). Default omits archived. Pass archived='only' for archived only, archived='include' for active+archived. Sorted: pinned first, then most-recent.",
      inputSchema: { archived: z.enum(['only', 'include']).optional() },
    },
    async ({ archived }) => {
      const params = new URLSearchParams();
      params.set('callerChatId', callerChatId);
      if (archived !== undefined) params.set('archived', archived);
      const qs = params.toString();
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/chats${qs ? `?${qs}` : ''}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_activity ------------------------------------------------------
  server.registerTool(
    'patch_activity',
    {
      description:
        "Read the USER'S OWN messages for a window — not agent output, which is already reachable via patch_peek/patch_history. Returns { messages, messagesTruncated, nextMessagesCursor? }. messages are ones the user actually sent, oldest first, across every host (chatId, chatName, daemonId, folder, text, ts — ms-epoch). `since`/`until` are ms-epoch and the window is capped server-side (30 days) regardless of what you ask for. If `messagesTruncated` is true, re-call with `nextMessagesCursor` as `messagesCursor` (same since/until) to continue. Read-only.",
      inputSchema: {
        since: z.number().int().nonnegative(),
        until: z.number().int().nonnegative(),
        messagesCursor: z.number().int().nonnegative().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Max messages per page, up to 500; page on with messagesCursor.'),
      },
    },
    async ({ since, until, messagesCursor, limit }) => {
      const params = new URLSearchParams();
      params.set('callerChatId', callerChatId);
      params.set('since', String(since));
      params.set('until', String(until));
      if (messagesCursor !== undefined) params.set('messagesCursor', String(messagesCursor));
      if (limit !== undefined) params.set('limit', String(limit));
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/activity?${params.toString()}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_list_devices -------------------------------------------------
  server.registerTool(
    'patch_list_devices',
    {
      description:
        'List the registered physical voice devices (HA Voice PE units) with live presence: deviceId, name, online, muted, lastUsedAt. Use to pick a deviceId for patch_speak({ message, deviceId }) or to check which speaker is currently reachable. Read-only.',
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({ method: 'GET', path: '/internal/devices' });
      return toolResult(res);
    },
  );

  // ---- patch_stop ---------------------------------------------------------
  server.registerTool(
    'patch_stop',
    {
      description:
        'Stop a running chat (aborts the in-flight SDK query). Idempotent: already-idle chats no-op.',
      inputSchema: { chatId: z.string().min(1).describe(CHAT_ID_PARAM) },
    },
    async ({ chatId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: `/internal/stop/${encodeURIComponent(chatId)}`,
        body: { callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_notify -------------------------------------------------------
  server.registerTool(
    'patch_notify',
    {
      description:
        "Tell the user something they did not ask for right now — a build finished, a watched condition tripped, they are still up at 1am. NOT for replying to a turn they just sent. You choose two things and only two: what to say, and how much it matters. Where it lands is not yours to pick — Patch sends it to the desktop when they are at a computer and to the phone when they are not, because only Patch knows where they are. importance: 'silent' makes no sound and asks for nothing now, it is simply there next time they look (a daily summary, a watcher's line); 'normal' is an ordinary notification, held back while they are already at a surface that shows this chat; 'urgent' is 'normal' with a more urgent sound, routed and held back the same way — use it when you can say what is lost by waiting an hour. Tapping it opens this chat, unless deepLink names somewhere better to land (an installed app's custom-scheme or https URI, e.g. the task the notification is about). Your message must NAME where that link goes — say the app or the thing, e.g. 'open it in Citymapper' — because a link the message does not mention is refused and the tap opens this chat instead. quickReplies is at most 2 short strings (e.g. 'Yes', 'Snooze 10 min'); each renders as its own button on the notification that, tapped, sends that exact text back into this chat as the user's reply — use it when you can predict the answer, not as a substitute for asking a real question.",
      inputSchema: {
        message: z.string().min(1),
        importance: z.enum(['silent', 'normal', 'urgent']),
        deepLink: z.string().min(1).optional(),
        quickReplies: z.array(z.string().min(1).max(40)).max(2).optional(),
      },
    },
    async ({ message, importance, deepLink, quickReplies }) => {
      const body: Record<string, unknown> = { message, priority: importance, callerChatId };
      if (deepLink !== undefined) body['deepLink'] = deepLink;
      if (quickReplies !== undefined) body['quickReplies'] = quickReplies;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/notify', body });
      return toolResult(res);
    },
  );

  // ---- patch_speak --------------------------------------------------------
  server.registerTool(
    'patch_speak',
    {
      description:
        "Say something OUT LOUD on a voice device in the house. A different act from notifying: it fills the room, anyone there hears it, and it is gone — no notification is left behind for later. Use it when the user is in the house and away from screens, and the thing is worth saying to the room. deviceId picks a speaker ('kitchen', 'bedroom'); omit it and Patch picks the one most recently used, or all of them quietly if none was. If no speaker is reachable it falls through to a push.",
      inputSchema: {
        message: z.string().min(1),
        deviceId: z.string().min(1).optional(),
      },
    },
    async ({ message, deviceId }) => {
      const body: Record<string, unknown> = { channel: 'speakers', message, callerChatId };
      if (deviceId !== undefined) body['deviceId'] = deviceId;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/notify', body });
      return toolResult(res);
    },
  );

  // ---- patch_ask_human ----------------------------------------------------
  server.registerTool(
    'patch_ask_human',
    {
      description:
        "Say you are BLOCKED until the user does something themselves, in the world: grant a permission the OS will only take by hand, plug something in, sign a form, take a photo. Not for a decision (ask a question) and not for approving a tool (that already prompts) — this is for work only they can do. It pushes to their phone, pulls this chat out of Hidden (or Archived), and leaves the task ON the chat's row until they act on it — so a hidden job cannot sit blocked where nobody is looking, and a missed notification does not lose the request. Say the task as an instruction they could follow without reading the chat ('grant Screen Recording to Foreman Observer in System Settings'), and put the consequence in `why` ('until then I am judging your day from window titles alone'). Having called it, decide for yourself whether to wait or carry on with what is still possible.",
      inputSchema: {
        task: z.string().min(1),
        why: z.string().min(1).optional(),
      },
    },
    async ({ task, why }) => {
      const body: Record<string, unknown> = { task, callerChatId };
      if (why !== undefined) body['why'] = why;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/ask_human', body });
      return toolResult(res);
    },
  );

  // ---- patch_report -------------------------------------------------------
  server.registerTool(
    'patch_report',
    {
      description:
        "Say this chat is worth the user SEEING, when nothing is blocked and nothing is being asked. It takes the chat out of Archived and puts one line on its row in the sidebar. It makes NO sound — use patch_notify if it also needs to reach them now; the two are independent and a chat can do either, both, or neither. This is the only sidebar state an agent chooses for itself, so hold a high bar: the user may have twenty jobs finish overnight and wants the one or two that actually matter, not twenty rows saying a job ran. A job that did what it always does and found nothing unusual should say NOTHING and stay hidden. Write the summary as the finding itself ('the backup has been failing silently since Tuesday'), not as a description of the run ('backup check complete').",
      inputSchema: {
        summary: z.string().min(1).max(200),
      },
    },
    async ({ summary }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/report',
        body: { summary, callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_artifact -----------------------------------------------------
  server.registerTool(
    'patch_artifact',
    {
      description:
        "Publish an HTML file from this chat's folder as a page the user can open — Patch's own Artifact tool. Use it whenever the answer is better as a page than as chat text (a report, a dashboard, a table, a rendered result): write the .html file, then publish it. Returns { artifactId, url, title }; the page appears as a card in the chat and opens in Patch's side panel. Republishing the SAME path replaces that page at the same URL, so iterate on one file instead of making new ones. path is relative to the chat folder; HTML only; 2 MB max.",
      inputSchema: {
        path: z.string().min(1),
        title: z.string().min(1).optional(),
      },
    },
    async ({ path, title }) => {
      const body: Record<string, unknown> = { path, callerChatId };
      if (title !== undefined) body['title'] = title;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/artifact', body });
      return toolResult(res);
    },
  );

  // ---- patch_pad_* ---------------------------------------------------------
  const padCall = async (body: Record<string, unknown>): Promise<ReturnType<typeof toolResult>> =>
    toolResult(
      await uds<unknown>({
        method: 'POST',
        path: '/internal/pad',
        body: { ...body, callerChatId },
      }),
    );

  server.registerTool(
    'patch_pad_create',
    {
      description:
        'Start a Pad: a design space the user opens beside this chat and edits directly (select, move, resize, retype, delete, note, draw). Use it whenever you would otherwise describe a design in words, send a screenshot or ask "what do you think of this layout" — the user reacts to the real thing. WORKFLOW: (1) Put the screens in a folder in this chat\'s folder, ideally inside the project (e.g. projects/<app>/design/<name>/), not a temp dir: one .html file per screen (index.html first), or a pad.json `{ "screens": [{ "id", "name", "path" }] }` (path may carry a #fragment); assets load relative to the folder. Screens fill the viewport and are responsive; no fake device frames or title banners. (2) For a change to an existing screen, start from the app\'s REAL markup and styles, not a from-scratch mockup. (3) Check each screen renders (desktop and phone width) before creating. (4) Call this tool; the Pad appears as a card in this chat — there is no link to hand over. (5) The user\'s changes arrive as a [Pad] message with a picture of each: open every picture before acting, make each change real in the source in the code\'s own idiom, then call patch_pad_update(padId, dir) to publish the revision and patch_pad_reply(padId, text) to close the batch. Fails with "no index.html or pad.json in <dir>" if the folder has neither. `app` files the Pad under that app\'s name (e.g. "Patch"); `device` is how it opens (default desktop). Returns { id, name, screens }; the Pad appears as a card in this chat.',
      inputSchema: {
        dir: z.string().min(1),
        name: z.string().min(1),
        app: z.string().min(1).optional(),
        device: z.enum(['desktop', 'phone']).optional(),
      },
    },
    async ({ dir, name, app, device }) =>
      padCall({ op: 'create', dir, name, ...(app ? { app } : {}), ...(device ? { device } : {}) }),
  );

  server.registerTool(
    'patch_pad_update',
    {
      description:
        "Replace the contents of a Pad this chat created with the current files in `dir` — new and changed screens, new assets, removed screens. The user's pending changes stay; an open editor reloads itself. Use it after acting on a [Pad] message (before patch_pad_reply), or to add a screen. Needs a Pad from patch_pad_create; the folder needs index.html or pad.json. Returns { id, name, screens, addedScreens }; the Pad's card in this chat is refreshed.",
      inputSchema: {
        padId: z.string().min(1).describe('The Pad id returned by patch_pad_create.'),
        dir: z.string().min(1),
      },
    },
    async ({ padId, dir }) => padCall({ op: 'update', padId, dir }),
  );

  server.registerTool(
    'patch_pad_reply',
    {
      description:
        'Answer the batch of changes the user sent from a Pad: closes the oldest open batch, marks its changes done and shows your reply under it. Call it once you have acted on a [Pad] message, after patch_pad_update; it fails with "no open batch for this pad" when no [Pad] message is waiting. `text` is one or two lines on what you did.',
      inputSchema: {
        padId: z.string().min(1).describe('The Pad id named in the [Pad] message.'),
        text: z.string().min(1),
      },
    },
    async ({ padId, text }) => padCall({ op: 'reply', padId, text }),
  );

  server.registerTool(
    'patch_pad_list',
    {
      description:
        'List the Pads this chat owns, with their screens, pending change counts and whether a batch is waiting on you.',
      inputSchema: {},
    },
    async () => padCall({ op: 'list' }),
  );

  // ---- view_file ----------------------------------------------------------
  server.registerTool(
    'view_file',
    {
      description:
        "Show a file to the USER, inline in the chat. The opposite of Read: Read pulls a file into YOUR context to work on; view_file puts it on the user's screen and returns only a short ack, so the contents never enter your context. Use it whenever you want them to LOOK at something — a screenshot or diagram you made or found, a chart, a rendered HTML page, a PDF. Images (.png .jpg .jpeg .gif .webp .svg) render as a picture; .pdf renders in a viewer; .html renders as a live page. Images and PDFs 1.4 MB max, pages 2 MB max. file_path may be absolute or relative to the chat folder, but must resolve inside it. Returns { kind, url, name } — having shown it, do not also Read it back to describe it unless asked; they can see it.",
      inputSchema: {
        file_path: z.string().min(1),
      },
    },
    async ({ file_path }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: '/internal/view_file',
        body: { file_path, callerChatId },
      });
      return toolResult(res);
    },
  );

  // ---- patch_call ---------------------------------------------------------
  server.registerTool(
    'patch_call',
    {
      description:
        'Ring the user phone-style (concurrent push + desktop ring; first surface to accept wins). On accept, drops the user into a sustained voice call against the calling chat. On decline / 30s timeout / all surfaces missed, falls back to a push notification carrying the reason text. Use sparingly — a call demands attention. Pass chatId to ring on behalf of another chat; otherwise rings for the calling chat.',
      inputSchema: {
        chatId: z.string().min(1).optional(),
        message: z.string().min(1).optional(),
      },
    },
    async ({ chatId, message }) => {
      const body: Record<string, unknown> = { callerChatId };
      if (chatId !== undefined) body['chatId'] = chatId;
      if (message !== undefined) body['message'] = message;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/call', body });
      return toolResult(res);
    },
  );

  // ---- patch_job_list -----------------------------------------------------
  server.registerTool(
    'patch_job_list',
    {
      description:
        "List the user's persistent jobs (cross-session automations). Each job has a trigger (cron/recurrence/webhook/todoist) and an action (spawn/continue/message/script).",
      inputSchema: {},
    },
    async () => {
      const res = await uds<unknown>({ method: 'GET', path: '/internal/jobs' });
      return toolResult(res);
    },
  );

  // ---- patch_job_create ---------------------------------------------------
  // spec/08 § Gate. Written once and used by create and update so the two can
  // never describe the same field differently.
  const GATE_TOOL_DESCRIPTION =
    'A shell command asked BEFORE each fire, which decides whether the action runs at all: ' +
    '{daemonId, folder, command, timeoutMs?}. `exit 0` runs the action. `exit 1` holds it, and MUST ' +
    "print why on stdout — that line becomes the run's headline. Any other exit code, a bare `exit 1` " +
    'with nothing printed, or a timeout is a FAULT and is recorded loudly, because a gate that has ' +
    'quietly stopped deciding otherwise looks exactly like a quiet week. Use one for a watcher that ' +
    'should cost nothing on most fires (is there a new photo, is anything due) rather than spawning a ' +
    'chat to discover there is no work. `null` removes a gate.';
  // spec/08 § Run window.
  const RUN_WINDOW_TOOL_DESCRIPTION =
    "Hours the job may START a fire: {start:'HH:MM', end:'HH:MM', timezone:'<IANA zone>'}, 24-hour wall-clock, start inclusive, end exclusive; an end earlier than the start wraps midnight (22:00-06:00). A fire arriving outside the window is held and runs when it next opens - e.g. a task that arrives at night runs in the morning. A manual run ignores it. On update, null removes the window.";
  // spec/08 § Autonomy prompt. Written once and used by create and update so
  // the two can never describe the field differently.
  const QUEUEING_TOOL_DESCRIPTION =
    'How this job\'s fires relate to each other. One of: { mode: "parallel" } (every fire runs at once — the default); { mode: "queue", concurrency?: N (default 1), key?: mustache template } (fires wait their turn N at a time; with a key the limit applies per subject, e.g. "{{event_data.id}}", and a key that renders empty is refused); { mode: "append", idleTimeoutMs?, resetAfterMs?, resetAfterMessages? } (every fire is delivered into one durable chat — action type "continue" only — which starts afresh after it has been idle that long, has lived that long, or has been sent that many fires). Do not combine with `concurrency`.';

  const AUTONOMY_PROMPT_TOOL_DESCRIPTION =
    'Text prepended to this job’s first user-turn, replacing the account-wide autonomy prompt ' +
    '(set once in Settings → Jobs; by default "You are running autonomously, don’t stop to ask ' +
    'the user questions"). Every job fires unattended, so every fire carries one — there is no ' +
    'way to turn it off, only to override it for this job. Omit to use the account-wide one.';
  server.registerTool(
    'patch_job_create',
    {
      description:
        "Create a persistent job. Use for cross-session automations: 'every weekday 7am, spawn a fresh bus-watch chat'. For a same-conversation reminder use patch_wake_me (or patch_loop for a fixed-cadence repeat) instead — those end this turn and re-invoke THIS chat; a job always spawns or messages a chat independently of this turn. " +
        "A cron trigger is {type:'cron', expression:'<5-field cron>', timezone:'<IANA zone>'}: write the expression in the user's OWN wall-clock time and name their zone (e.g. 'Europe/London') — it is evaluated there and tracks DST. Omit `timezone` only if you mean UTC. " +
        "For a schedule cron cannot express — an nth-weekday or a date-range pattern like 'every 3rd Sunday, May through August' — use a recurrence trigger instead: {type:'recurrence', rrule:'<bare RRULE value, e.g. FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0>', timezone:'<IANA zone>'}. No `RRULE:` label and no `DTSTART` — timezone is REQUIRED here (unlike cron's optional one).",
      inputSchema: {
        trigger: z.unknown().describe(JOB_TRIGGER_PARAM),
        action: z.unknown().describe(JOB_ACTION_PARAM),
        filter: z.string().min(1).optional().describe(JOB_FILTER_PARAM),
        gate: z.unknown().optional().describe(GATE_TOOL_DESCRIPTION),
        name: z.string().min(1).optional(),
        concurrency: z.number().int().min(1).optional().describe(JOB_CONCURRENCY_PARAM),
        queueing: z.unknown().optional().describe(QUEUEING_TOOL_DESCRIPTION),
        window: z.unknown().optional().describe(RUN_WINDOW_TOOL_DESCRIPTION),
        oneOff: z
          .boolean()
          .optional()
          .describe(
            'Run once, then expire. The first fire that the host confirms landed disables the job and stamps it expired; it stays visible (folded away in the Jobs view) so its run and its chat remain reachable. Use this for a single-purpose job — "when the parcel webhook arrives, spawn a chat about it" — rather than leaving a spent job enabled for ever. A fire that fails to dispatch does NOT expire it, so it will try again. To re-invoke THIS chat later, use patch_wake_me instead: it is still the right tool for an in-chat reminder.',
          ),
        group: z
          .string()
          .optional()
          .describe(
            'Optional free-text group name for organising this job in the Jobs view, e.g. "Home", "Finance", "Watchers". Purely organisational — never affects whether or how the job fires.',
          ),
        autonomyPrompt: z.string().min(1).optional().describe(AUTONOMY_PROMPT_TOOL_DESCRIPTION),
      },
    },
    async ({
      trigger,
      action,
      filter,
      gate,
      name,
      concurrency,
      queueing,
      window,
      oneOff,
      group,
      autonomyPrompt,
    }) => {
      const body: Record<string, unknown> = { trigger, action };
      if (filter !== undefined) body['filter'] = filter;
      if (gate !== undefined) body['gate'] = gate;
      if (name !== undefined) body['name'] = name;
      if (concurrency !== undefined) body['concurrency'] = concurrency;
      if (queueing !== undefined) body['queueing'] = queueing;
      // `null` removes the window on update; omitting the key leaves it.
      if (window !== undefined) body['window'] = window;
      if (oneOff !== undefined) body['oneOff'] = oneOff;
      if (group !== undefined) body['group'] = group;
      if (autonomyPrompt !== undefined) body['autonomyPrompt'] = autonomyPrompt;
      const res = await uds<unknown>({ method: 'POST', path: '/internal/jobs', body });
      return toolResult(res);
    },
  );

  // ---- patch_job_update ---------------------------------------------------
  server.registerTool(
    'patch_job_update',
    {
      description:
        'Patch fields of an existing job. Pass only the fields to change. ' +
        "`trigger` is replaced wholesale, not merged — re-send a cron trigger's `timezone` alongside its `expression` or the job silently reverts to being evaluated in UTC.",
      inputSchema: {
        jobId: z.string().min(1).describe(JOB_ID_PARAM),
        trigger: z.unknown().optional().describe(JOB_TRIGGER_PARAM),
        action: z.unknown().optional().describe(JOB_ACTION_PARAM),
        filter: z.string().min(1).optional().describe(JOB_FILTER_PARAM),
        gate: z.unknown().optional().describe(GATE_TOOL_DESCRIPTION),
        name: z.string().min(1).optional(),
        enabled: z
          .boolean()
          .optional()
          .describe(
            'true re-enables the job, false pauses it (same as patch_job_enable / patch_job_disable).',
          ),
        /** `null` removes the limit; omitted leaves it as it is. */
        concurrency: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe(JOB_CONCURRENCY_PARAM + ' null clears it.'),
        queueing: z
          .unknown()
          .optional()
          .describe(`${QUEUEING_TOOL_DESCRIPTION} \`null\` removes it (back to parallel).`),
        window: z.unknown().optional().describe(RUN_WINDOW_TOOL_DESCRIPTION),
        oneOff: z
          .boolean()
          .optional()
          .describe(
            'Make this job run once and then expire, or (false) make a one-off job recurring again. Clearing it does not un-expire a job that has already fired — setting `enabled: true` is what re-arms one for another single fire.',
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Put this job away, or (false) bring it back. An archived job does not fire at all and folds out of the jobs list, keeping its run history. Separate from `enabled`, which it never changes — un-archiving restores the job exactly as it was.',
          ),
        group: z
          .string()
          .optional()
          .describe(
            'Change or clear this job\'s free-text organisational group. `""` clears it to ungrouped. Purely organisational — never affects whether or how the job fires.',
          ),
        /** `null` clears back to the default; omitted leaves it as it is. */
        autonomyPrompt: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(`${AUTONOMY_PROMPT_TOOL_DESCRIPTION} \`null\` clears a custom one back to it.`),
      },
    },
    async ({
      jobId,
      trigger,
      action,
      filter,
      gate,
      name,
      enabled,
      concurrency,
      queueing,
      window,
      oneOff,
      archived,
      group,
      autonomyPrompt,
    }) => {
      const body: Record<string, unknown> = {};
      if (trigger !== undefined) body['trigger'] = trigger;
      if (action !== undefined) body['action'] = action;
      if (filter !== undefined) body['filter'] = filter;
      // `null` is meaningful here and must survive: it REMOVES the gate, where
      // omitting the key leaves the stored one alone.
      if (gate !== undefined) body['gate'] = gate;
      if (name !== undefined) body['name'] = name;
      if (enabled !== undefined) body['enabled'] = enabled;
      if (concurrency !== undefined) body['concurrency'] = concurrency;
      if (queueing !== undefined) body['queueing'] = queueing;
      // `null` removes the window on update; omitting the key leaves it.
      if (window !== undefined) body['window'] = window;
      if (oneOff !== undefined) body['oneOff'] = oneOff;
      if (archived !== undefined) body['archived'] = archived;
      if (group !== undefined) body['group'] = group;
      // `null` is meaningful here too — it clears a custom prompt back to the
      // default, where omitting the key leaves whatever the job already has.
      if (autonomyPrompt !== undefined) body['autonomyPrompt'] = autonomyPrompt;
      const res = await uds<unknown>({
        method: 'PATCH',
        path: `/internal/jobs/${encodeURIComponent(jobId)}`,
        body,
      });
      return toolResult(res);
    },
  );

  // ---- patch_job_delete ---------------------------------------------------
  server.registerTool(
    'patch_job_delete',
    {
      description: 'Permanently delete a job.',
      inputSchema: { jobId: z.string().min(1).describe(JOB_ID_PARAM) },
    },
    async ({ jobId }) => {
      const res = await uds<unknown>({
        method: 'DELETE',
        path: `/internal/jobs/${encodeURIComponent(jobId)}`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_job_enable / disable -----------------------------------------
  server.registerTool(
    'patch_job_enable',
    {
      description: 'Re-enable a previously disabled job.',
      inputSchema: { jobId: z.string().min(1).describe(JOB_ID_PARAM) },
    },
    async ({ jobId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: `/internal/jobs/${encodeURIComponent(jobId)}/enable`,
      });
      return toolResult(res);
    },
  );

  server.registerTool(
    'patch_job_disable',
    {
      description:
        'Pause a job without deleting it. Triggers will be ignored until patch_job_enable.',
      inputSchema: { jobId: z.string().min(1).describe(JOB_ID_PARAM) },
    },
    async ({ jobId }) => {
      const res = await uds<unknown>({
        method: 'POST',
        path: `/internal/jobs/${encodeURIComponent(jobId)}/disable`,
      });
      return toolResult(res);
    },
  );

  // ---- patch_job_runs / patch_job_webhooks --------------------------------
  server.registerTool(
    'patch_job_runs',
    {
      description:
        "Read a job's recent run log entries (every fire — cron, webhook, todoist). Newest first. limit defaults to 50; values above the 200 hard cap are clamped to 200 (not rejected).",
      inputSchema: {
        jobId: z.string().min(1).describe(JOB_ID_PARAM),
        limit: z.number().int().positive().optional().describe(JOB_LIMIT_PARAM),
      },
    },
    async ({ jobId, limit }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      const qs = params.toString();
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/jobs/${encodeURIComponent(jobId)}/runs${qs ? `?${qs}` : ''}`,
      });
      return toolResult(res);
    },
  );

  server.registerTool(
    'patch_job_webhooks',
    {
      description:
        "Read a job's recent inbound-webhook log entries (signature pass/fail, filter pass/fail). Newest first. limit defaults to 50; values above the 200 hard cap are clamped to 200 (not rejected).",
      inputSchema: {
        jobId: z.string().min(1).describe(JOB_ID_PARAM),
        limit: z.number().int().positive().optional().describe(JOB_LIMIT_PARAM),
      },
    },
    async ({ jobId, limit }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      const qs = params.toString();
      const res = await uds<unknown>({
        method: 'GET',
        path: `/internal/jobs/${encodeURIComponent(jobId)}/webhooks${qs ? `?${qs}` : ''}`,
      });
      return toolResult(res);
    },
  );

  return server;
}

// patch_peek response shape (spec/06): chat_state snapshot + recent wire-event
// slice + truncated flag.
export interface PeekChatState {
  chatId: string;
  name: string | null;
  folder: string;
  activity: string;
  status: string;
  pinned: boolean;
  pinnedAt: number | null;
  lastMessages: unknown[];
  lastUpdated: number;
  lastMessage?: string;
  lastError: unknown;
}

export interface PeekResponse {
  chat_state: PeekChatState;
  events: unknown[];
  truncated: boolean;
}

export function peekViaUds(
  socketPath: string,
  chatId: string,
  opts?: { limit?: number; localKey?: string },
): Promise<PeekResponse> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return udsRequest<PeekResponse>(socketPath, {
    method: 'GET',
    path: `/internal/peek/${encodeURIComponent(chatId)}${qs ? `?${qs}` : ''}`,
    ...(opts?.localKey !== undefined ? { localKey: opts.localKey } : {}),
  });
}

/** Internal: HTTP request via UDS, JSON in / JSON out. NO FALLBACK on errors. */
export function udsRequest<T>(socketPath: string, opts: UdsRequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.localKey !== undefined) headers['authorization'] = `Bearer ${opts.localKey}`;
    let bodyBuf: Buffer | undefined;
    if (opts.body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(opts.body), 'utf8');
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(bodyBuf.length);
    }
    const req = httpRequest(
      { socketPath, method: opts.method, path: opts.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`patch-tools-server: host HTTP ${res.statusCode}: ${text}`));
            return;
          }
          if (text.length === 0) {
            resolve(undefined as unknown as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(new Error(`patch-tools-server: bad JSON from host: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export async function runPatchToolsServerStdio(): Promise<void> {
  const chatId = process.env['PATCH_CHAT_ID'];
  const daemonSocketPath = process.env['PATCH_DAEMON_SOCKET'];
  const localKey = process.env['PATCH_DAEMON_LOCAL_KEY'];
  // Which branch this turn is running on (spec/04 § Branching). Unset for
  // every turn predating parallel branches — reads as the chat's active
  // branch, which has no send-back of its own to make (`patch_send_back`
  // refuses it, below), so this is optional, not NO-FALLBACK like the three
  // above.
  const branchId = process.env['PATCH_BRANCH_ID'];
  if (!chatId || chatId.length === 0) {
    throw new Error('patch-tools-server: PATCH_CHAT_ID env var missing (NO FALLBACK)');
  }
  if (!daemonSocketPath || daemonSocketPath.length === 0) {
    throw new Error('patch-tools-server: PATCH_DAEMON_SOCKET env var missing (NO FALLBACK)');
  }
  // The host always sets this for the children it starts. Missing it means
  // this process was not started by a host, and every call it makes would be
  // refused anyway — so it fails here, where the reason is legible.
  if (!localKey || localKey.length === 0) {
    throw new Error('patch-tools-server: PATCH_DAEMON_LOCAL_KEY env var missing (NO FALLBACK)');
  }
  const server = buildPatchToolsServer({
    daemonSocketPath,
    chatId,
    localKey,
    ...(branchId && branchId.length > 0 ? { branchId } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
