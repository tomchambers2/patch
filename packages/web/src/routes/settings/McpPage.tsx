// Settings → MCP: the MCP servers one host wires into every chat it runs,
// beside Patch's own tools server, which is always on.
//
// The host holds the list (`harnessMcpServers` in `daemon.host`) and every
// edit sends the WHOLE list back (`host.settings`), checked against the wire's
// own `McpServerList` first so a bad name or a duplicate is refused here, in
// the wire's words, rather than by the host after the fact. Nothing is
// patched locally: the list settles on the host's next report.

import type { JSX } from 'react';
import { useState } from 'react';
import { McpServerList, type McpServerConfig } from '@patch/wire';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import type { HostPresence } from '../../stores/presenceStore.js';
import { hostLabel } from './hostScope.js';
import { sendHostSettings } from './hostWrite.js';
import { Group, Note, Row, SettingsPage, useHostGate } from './ui.js';

/** `npx -y @playwright/mcp --headless` → command + args. Quotes group words. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** The reverse, quoting any word with a space in it. */
export function joinCommandLine(words: string[]): string {
  return words.map((w) => (/\s/.test(w) || w === '' ? `"${w}"` : w)).join(' ');
}

/** `KEY=VALUE` lines → env. A line with no `=` is an error, named. */
export function parseEnvLines(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `Environment line "${line}" is not KEY=VALUE` };
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return { env };
}

export function envToLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** The first thing the wire's schema says is wrong with a list, or null. */
export function mcpListProblem(list: McpServerConfig[]): string | null {
  const parsed = McpServerList.safeParse(list);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (!issue) return 'Invalid MCP server list';
  const field = issue.path.filter((p) => typeof p === 'string').join('.');
  if (field === 'name' && issue.code === 'invalid_string') {
    return 'Name may only use letters, digits, - and _ (at most 64)';
  }
  if (field === 'command') return 'Command is required';
  return issue.message;
}

export function McpPage(): JSX.Element {
  const { host, gate } = useHostGate();
  const [adding, setAdding] = useState(false);
  const servers = host?.host?.harnessMcpServers;
  const canEdit = gate === null && servers !== undefined;
  return (
    <SettingsPage
      title="MCP"
      testid="settings-mcp"
      hostSwitch
      actions={
        canEdit ? (
          <button
            type="button"
            className="set-btn primary"
            data-testid="mcp-add"
            onClick={() => setAdding(true)}
            disabled={adding}
          >
            Add server
          </button>
        ) : null
      }
    >
      {gate ??
        (host && servers === undefined ? (
          <Group>
            <Note testid="mcp-unsupported">Update {hostLabel(host)} to manage its MCP servers</Note>
          </Group>
        ) : host && servers ? (
          <ServerList
            host={host}
            servers={servers}
            adding={adding}
            onAddDone={() => setAdding(false)}
          />
        ) : null)}
    </SettingsPage>
  );
}

function ServerList({
  host,
  servers,
  adding,
  onAddDone,
}: {
  host: HostPresence;
  servers: McpServerConfig[];
  adding: boolean;
  onAddDone: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const pushError = useUiStore((s) => s.pushError);

  /** Validate and send the whole list. Returns whether it went. */
  function save(next: McpServerConfig[]): string | null {
    const problem = mcpListProblem(next);
    if (problem) return problem;
    if (!sendHostSettings(host, { harnessMcpServers: next })) return 'Not sent';
    return null;
  }

  return (
    <Group label="Servers chats get" testid="mcp-servers">
      <Row title="Patch" sub="Built in" testid="mcp-server-patch">
        <span className="set-val">Always on</span>
      </Row>
      {servers.map((s, i) =>
        editing === s.name ? (
          <ServerEditor
            key={s.name}
            initial={s}
            onCancel={() => setEditing(null)}
            onSave={(next) => {
              const problem = save(servers.map((x, j) => (j === i ? next : x)));
              if (problem === null) setEditing(null);
              return problem;
            }}
            onRemove={async () => {
              const ok = await useUiStore.getState().confirm({
                title: `Remove ${s.name}`,
                message: `Remove the ${s.name} MCP server from ${hostLabel(host)}? New chats there stop getting its tools.`,
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!ok) return;
              const problem = save(servers.filter((_, j) => j !== i));
              if (problem === null) setEditing(null);
              else if (problem !== 'Not sent') pushError(problem);
            }}
          />
        ) : (
          <Row
            key={s.name}
            title={s.name}
            sub={<span className="mono">{joinCommandLine([s.command, ...s.args])}</span>}
            testid={`mcp-server-${s.name}`}
            onClick={() => setEditing(s.name)}
          >
            <Toggle
              checked={s.enabled}
              testid={`mcp-server-${s.name}-enabled`}
              onChange={(next) => {
                const problem = save(
                  servers.map((x, j) => (j === i ? { ...x, enabled: next } : x)),
                );
                if (problem !== null && problem !== 'Not sent') pushError(problem);
              }}
            />
          </Row>
        ),
      )}
      {adding ? (
        <ServerEditor
          initial={{ name: '', command: '', args: [], env: {}, enabled: true }}
          onCancel={onAddDone}
          onSave={(next) => {
            const problem = save([...servers, next]);
            if (problem === null) onAddDone();
            return problem;
          }}
        />
      ) : null}
    </Group>
  );
}

function ServerEditor({
  initial,
  onSave,
  onCancel,
  onRemove,
}: {
  initial: McpServerConfig;
  /** Returns the reason it was not saved, or null. */
  onSave: (next: McpServerConfig) => string | null;
  onCancel: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const [name, setName] = useState(initial.name);
  const [commandLine, setCommandLine] = useState(
    initial.command === '' ? '' : joinCommandLine([initial.command, ...initial.args]),
  );
  const [envText, setEnvText] = useState(envToLines(initial.env));
  const [problem, setProblem] = useState<string | null>(null);

  function submit(): void {
    const env = parseEnvLines(envText);
    if ('error' in env) {
      setProblem(env.error);
      return;
    }
    const [command = '', ...args] = splitCommandLine(commandLine);
    const result = onSave({
      name: name.trim(),
      command,
      args,
      env: env.env,
      enabled: initial.enabled,
    });
    setProblem(result === 'Not sent' ? null : result);
  }

  return (
    <form
      className="set-row stack set-form"
      data-testid="mcp-editor"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="set-field">
        <span className="set-row-title">Name</span>
        <input
          value={name}
          data-testid="mcp-editor-name"
          placeholder="playwright"
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>
      <label className="set-field">
        <span className="set-row-title">Command</span>
        <input
          className="mono"
          value={commandLine}
          data-testid="mcp-editor-command"
          placeholder="npx @playwright/mcp --headless"
          onChange={(e) => setCommandLine(e.target.value)}
        />
      </label>
      <label className="set-field">
        <span className="set-row-title">Environment</span>
        <textarea
          value={envText}
          rows={3}
          data-testid="mcp-editor-env"
          placeholder="KEY=VALUE"
          onChange={(e) => setEnvText(e.target.value)}
        />
      </label>
      {problem ? (
        <p className="set-error" role="alert" data-testid="mcp-editor-error">
          {problem}
        </p>
      ) : null}
      <div className="set-actions">
        {onRemove ? (
          <button
            type="button"
            className="set-btn danger"
            data-testid="mcp-editor-remove"
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
        <span className="set-spacer" />
        <button
          type="button"
          className="set-btn ghost"
          data-testid="mcp-editor-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="set-btn primary" data-testid="mcp-editor-save">
          Save
        </button>
      </div>
    </form>
  );
}
