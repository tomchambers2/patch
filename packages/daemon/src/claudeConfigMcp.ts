// MCP servers Claude Code's own process would already run for a chat, read
// from the same files the `claude` CLI itself reads — never written to (spec/02
// § MCP server: "No mutation of `~/.claude.json`"). A host's Settings → MCP
// list (`mcpServers.ts`) is what the USER told Patch to add; this is what the
// user already told CLAUDE to add, outside Patch entirely, and a Patch-run
// chat would otherwise never see because the SDK's inline `mcpServers` option
// doesn't merge any of these in (`sdkBackend.ts` `buildSdkEnv`).
//
// Sources, later overriding earlier by name (matching increasing specificity —
// a project-local entry beats the user's global one for a chat in that
// project):
//   1. `~/.claude/settings.json`      `mcpServers`               (global)
//   2. `~/.claude.json`               `mcpServers`                (global)
//   3. `~/.claude.json` → `projects[<folder>]`      `mcpServers`  (this project)
//   4. `<folder>/.mcp.json`           `mcpServers`  — ONLY names already listed
//      in that same project's `enabledMcpjsonServers`. That array is how the
//      `claude` CLI itself records that a human clicked "yes" on its
//      trust-this-project prompt; an entry nobody has ever approved on this
//      machine is not one Claude's own process would run either, so Patch
//      doesn't run it unattended.
//
// Only stdio servers (a `command` to spawn) are representable — remote/SSE
// entries are skipped, since `McpServerConfig` (spec/03) has no URL shape.
// Any read that fails (file missing, malformed JSON, wrong shape) contributes
// nothing rather than throwing: a chat must be able to start with a Claude
// config that's absent, empty, or briefly being rewritten by another process.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@patch/wire';

type RawServerEntry = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
};

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalise one `claude`-shaped entry, or drop it if it isn't a stdio server. */
function toMcpServerConfig(name: string, raw: unknown): McpServerConfig | undefined {
  if (!NAME_RE.test(name) || name === 'patch') return undefined;
  if (!isRecord(raw)) return undefined;
  const entry = raw as RawServerEntry;
  if (typeof entry.command !== 'string' || entry.command.length === 0) return undefined;
  const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [];
  const env = isRecord(entry.env)
    ? Object.fromEntries(
        Object.entries(entry.env).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string',
        ),
      )
    : {};
  return { name, command: entry.command, args, env, enabled: true };
}

/** Every `mcpServers`-shaped entry in an object, normalised and name-filtered. */
function collectServers(mcpServers: unknown): Map<string, McpServerConfig> {
  const out = new Map<string, McpServerConfig>();
  if (!isRecord(mcpServers)) return out;
  for (const [name, raw] of Object.entries(mcpServers)) {
    const server = toMcpServerConfig(name, raw);
    if (server) out.set(name, server);
  }
  return out;
}

/**
 * The MCP servers Claude Code's own config already names for a chat running
 * in `folder`, in the merge order documented above. `home` is injectable for
 * tests; real callers always take the default.
 */
export function discoverClaudeMcpServers(
  folder: string,
  home: string = homedir(),
): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();

  const settings = readJsonFile(join(home, '.claude', 'settings.json'));
  for (const [name, server] of collectServers(isRecord(settings) ? settings.mcpServers : undefined))
    merged.set(name, server);

  const claudeJson = readJsonFile(join(home, '.claude.json'));
  const claudeJsonObj = isRecord(claudeJson) ? claudeJson : undefined;
  for (const [name, server] of collectServers(claudeJsonObj?.mcpServers)) merged.set(name, server);

  const projects = isRecord(claudeJsonObj?.projects) ? claudeJsonObj.projects : undefined;
  const project = isRecord(projects) ? projects[folder] : undefined;
  const projectObj = isRecord(project) ? project : undefined;
  for (const [name, server] of collectServers(projectObj?.mcpServers)) merged.set(name, server);

  const trusted = new Set(
    Array.isArray(projectObj?.enabledMcpjsonServers)
      ? projectObj.enabledMcpjsonServers.filter((n): n is string => typeof n === 'string')
      : [],
  );
  if (trusted.size > 0) {
    const mcpJson = readJsonFile(join(folder, '.mcp.json'));
    for (const [name, server] of collectServers(
      isRecord(mcpJson) ? mcpJson.mcpServers : undefined,
    )) {
      if (trusted.has(name)) merged.set(name, server);
    }
  }

  return [...merged.values()];
}
