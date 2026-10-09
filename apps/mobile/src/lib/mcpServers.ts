// Settings → MCP: turning a host's MCP server entries into the two fields the
// edit screen shows — one command line, and environment as KEY=VALUE lines —
// and back, validated against the wire's own McpServerList before anything is
// sent (design/settings-redesign). Pure, so the screen and its tests share it.

import { McpServerList, type McpServerConfig } from '@patch/wire';

/** `npx @playwright/mcp --headless` — the command and its args, as one line. */
export function commandLine(s: Pick<McpServerConfig, 'command' | 'args'>): string {
  return [s.command, ...s.args].map(quoteArg).join(' ');
}

function quoteArg(a: string): string {
  if (a !== '' && !/[\s"'\\]/.test(a)) return a;
  return `"${a.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Split a command line into words the way a shell would for the simple cases
 * people type: whitespace separates, single or double quotes group, a
 * backslash escapes the next character. An unclosed quote is an error rather
 * than a guess.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in the command line`);
  if (inWord) out.push(cur);
  return out;
}

/** Environment as `KEY=VALUE` lines, in insertion order. */
export function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Parse `KEY=VALUE` lines; blank lines are skipped, anything else is an error. */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Environment line ${i + 1} is not KEY=VALUE`);
    }
    if (key in env) throw new Error(`${key} is set twice`);
    env[key] = line.slice(eq + 1).trim();
  });
  return env;
}

export interface McpDraft {
  name: string;
  commandLine: string;
  envText: string;
}

/**
 * The host's whole list with one entry added (`original` null) or replaced
 * (the entry named `original`), validated with McpServerList — the same schema
 * the host applies. Returns the list to send, or the first problem in words.
 */
export function applyMcpDraft(
  list: readonly McpServerConfig[],
  original: string | null,
  draft: McpDraft,
): { ok: true; list: McpServerConfig[] } | { ok: false; message: string } {
  let words: string[];
  let env: Record<string, string>;
  try {
    words = splitCommandLine(draft.commandLine);
    env = parseEnvText(draft.envText);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const [command, ...args] = words;
  if (command === undefined) return { ok: false, message: 'A command is required' };
  const prev = original === null ? undefined : list.find((s) => s.name === original);
  const entry: McpServerConfig = {
    name: draft.name.trim(),
    command,
    args,
    env,
    enabled: prev?.enabled ?? true,
  };
  const next =
    original === null ? [...list, entry] : list.map((s) => (s.name === original ? entry : s));
  const parsed = McpServerList.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.includes('name') ? 'Name: ' : '';
    const message =
      issue?.message === 'Invalid'
        ? 'Name may use only letters, digits, - and _'
        : (issue?.message ?? 'Invalid server');
    return { ok: false, message: `${path}${message}` };
  }
  return { ok: true, list: parsed.data };
}
