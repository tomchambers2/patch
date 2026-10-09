# Running Multiple Playwright Tests Concurrently

## The Problem

When multiple Claude Code agents use Playwright simultaneously, they can conflict:

- Chrome's singleton behavior means a second launch opens a tab in an existing instance instead of starting a new browser
- Agents get confused, try to kill Chrome, disrupting other agents and the user's workflow
- Pages get navigated out from under agents that are waiting

## Two Scenarios

There are two distinct concurrency scenarios with different solutions:

### 1. Separate Claude Code Processes (e.g. orchestrator spawning agents)

Each Claude Code process spawns its own Playwright MCP server via stdio. With the `--isolated` flag, each server creates a browser with a unique temporary profile directory, preventing Chrome's singleton behavior.

**Solution:** The global config at `~/.claude/settings.json` must include `--isolated`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--browser", "chromium", "--isolated", "--caps", "vision"]
    }
  }
}
```

**Critical rule: Do NOT define a `playwright` server in project-level `.mcp.json` files.** Project-level configs override the global config by server name, and forgetting to include `--isolated` causes the exact conflict described above. The global config is the single source of truth for Playwright MCP settings.

### 2. Subagents Within One Claude Code Session

Subagents spawned by the same Claude Code process (via the Agent tool) share a single Playwright MCP server. This means:

- All subagents control the same browser instance and the same "current tab"
- Navigation by one agent changes the page for all others
- Closing the browser in one agent kills it for all

**This cannot be fixed by configuration.** It is a fundamental aspect of how MCP servers are shared within a session.

**Workaround:** Do not run multiple subagents that use Playwright concurrently. Instead:

- Run Playwright-using agents sequentially
- Or have only one agent use Playwright while others do non-browser work

## Why `--isolated` Matters

Without `--isolated`, Playwright uses Chrome's default user data directory. Chrome enforces a singleton lock on this directory:

- A second process trying to use the same directory joins the existing instance (opening a new tab) instead of launching a new browser
- This is what causes the "blank tab" problem and process conflicts

With `--isolated`, each Playwright MCP server creates a temporary in-memory browser profile. Two separate servers get two completely independent Chromium processes that:

- Navigate independently
- Don't share tabs or state
- Can be closed without affecting each other

## Verification

To verify isolation is working between separate processes, check that:

1. Multiple Chromium processes exist (one per agent): `ps aux | grep chromium`
2. Each has a different `--user-data-dir` temp path in its arguments
3. Navigating in one agent's browser doesn't change pages in another's
4. Closing one agent's browser doesn't kill the other's

## Troubleshooting

**Agents still sharing a browser?**

- Check if a project `.mcp.json` overrides the global Playwright config: `cat .mcp.json | grep playwright`
- If so, remove the playwright entry from the project config
- Verify the global config has `--isolated`: `cat ~/.claude/settings.json`

**Chrome windows keep appearing?**

- Add `--headless` to the global config args if agents don't need visible browsers
- This also eliminates visual disruption when agents open/close browsers

**Subagents conflicting within one session?**

- This is expected behavior - subagents share the MCP server
- Restructure the workflow so only one subagent uses Playwright at a time
