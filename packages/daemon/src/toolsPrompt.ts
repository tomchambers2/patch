/**
 * The built-in guidance patch appends to the agent's system prompt, telling it
 * what patch's own tools are for and when to reach for them.
 *
 * Shipped as a DEFAULT, not as a hidden directive: `principles.md § No
 * system-prompt injection` allows platform prompt content only where the user
 * can see it and edit it, which is the whole reason for that rule. This text is
 * shown in Settings, editable there, and cleared by emptying the field.
 *
 * It exists because patch's tools are deferred: the agent is told their names
 * and nothing else, so a tool it has never loaded loses every time to a
 * built-in that looks like it would do. `view_file` lost to `Read` that way —
 * `Read` renders an image collapsed into the agent's own context, so the user
 * never sees the picture, and nothing in the transcript says why.
 */
const PATCH_TOOLS_PROMPT_BASE = `# Patch tools

You are running inside patch, which adds its own tools alongside the built-in
ones. They are deferred: you are given their names but not their schemas, so
load one with ToolSearch (\`select:mcp__patch__<name>\`) before calling it.

Reach for them in these situations, in preference to a built-in that looks
similar:

- To put an image, screenshot, diagram, chart or rendered page in front of the
  user, use \`view_file\` — never \`Read\`. \`Read\` pulls the file into your own
  context and shows the user a collapsed row, so they never see the picture.
  \`view_file\` puts it on their screen and returns only a short ack.
- To hand the user a page they will work with rather than glance at — a report,
  a dashboard, a live result — write the HTML and publish it with
  \`patch_artifact\`. It opens in a side panel and republishing the same path
  replaces it in place.
- To show the user a design they will react to — a layout, a mockup, a change
  to an app screen — start a Pad with \`patch_pad_create\` rather than
  describing it: they edit it directly and their changes come back to this chat
  as a message. Answer with \`patch_pad_reply\`; keep the Pad current with
  \`patch_pad_update\`.
- To reach the user when they are not already reading the conversation — a long
  build finished, a watched condition tripped — use \`patch_notify\`. Do not use
  it to reply to a turn they just sent.
- For a sub-task you want run on its own — scoped research, a chunk of a
  larger job, anything you would otherwise hand off to run independently —
  use \`patch_delegate\`, not \`patch_spawn\` (that makes a chat the user has
  to deal with). \`patch_delegate\` is durable, invisible to the user, and
  hands its full result back to THIS chat when it finishes; you do not wait
  for it.

Everything else is ordinary: patch does not replace the agent's own file
editing or process spawning.`;

/**
 * The patch-tools guidance: a DEFAULT the user can see and edit in Settings,
 * shown as `harnessToolsPromptDefault` and appended when no per-host override
 * is set. It says only what patch's own tools are for. Anything about a
 * particular machine — "this box is headless, never hand out localhost URLs" —
 * belongs to that machine's own agent instructions (its `~/.claude/CLAUDE.md`),
 * which the user owns, rather than being decided here by platform.
 */
export function getPatchToolsPrompt(): string {
  return PATCH_TOOLS_PROMPT_BASE;
}

/**
 * What a Settings save of the tools prompt stores: `null` restores the
 * built-in default, and so does saving the default's own text. Stored, that
 * text would be a frozen copy that never picks up a later change to the
 * built-in guidance — which is how hetzner's agents went two weeks without the
 * headless-host paragraph: its override was the guidance as it stood before
 * the paragraph was added. `''` is a real override (the guidance turned off).
 */
export function toolsPromptOverride(saved: string | null): string | undefined {
  return saved === null || saved === getPatchToolsPrompt() ? undefined : saved;
}
