// Persisted per-machine state (spec/02 § Host identity, § Permission mode,
// § Agent backends; spec/04 § Folders).
//
// Everything a surface can CHANGE about a machine has to outlive that
// machine's process, or the change silently reverts the next time the host
// restarts — indistinguishable from an edit that never saved. One small JSON
// file at `<patchHome>/host.json`, written atomically (temp + fsync + rename).
//
// NO FALLBACK: a corrupt file throws rather than being silently reset — losing
// the user's designated project roots without saying so is worse than failing
// to boot with the reason on stderr.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServerList, PermissionMode } from '@patch/wire';
import type { Logger } from 'pino';

const HostStateFile = z
  .object({
    /** User-editable label (`host.rename`). Absent until renamed. */
    hostName: z.string().min(1).optional(),
    /** This machine's DEFAULT permission mode (`host.settings`). */
    permissionModeDefault: PermissionMode.optional(),
    /** Is this the account's home machine (`host.set_home`)? */
    isHomeHost: z.boolean().optional(),
    /**
     * The last Manager takeover this machine acted on (`host.manager_adopt` /
     * `host.manager_release`), so the same one told twice is acted on once.
     */
    managerEpoch: z.number().int().nonnegative().optional(),
    /** What the Manager is to be told with its next message, until it has been. */
    managerHandoff: z.string().optional(),
    /**
     * The model this machine's next model-less spawn runs on — the ACCOUNT's
     * `defaultModel`, mirrored down by the server (`host.settings`).
     *
     * Persisted so a host that restarts before the server's first push still
     * knows it. What this replaced (`lastUsedModel`) was DERIVED — the model of
     * whatever chat last ran here — so one cheap-model chat silently moved every
     * later model-less spawn onto it, unattended jobs included.
     */
    defaultModel: z.string().min(1).optional(),
    /** User-designated project roots (`host.folder_add` / `host.folder_remove`). */
    folderRoots: z.array(z.string().min(1)).optional(),
    /** Optional components installed on this machine, by id. */
    installedComponents: z.array(z.string().min(1)).optional(),
    /**
     * Currently selected Kokoro TTS voice (`host.settings` → `kokoroVoice`).
     * Absent means use the sidecar's own default ('af_heart').
     */
    kokoroVoice: z.string().min(1).optional(),
    /**
     * Account's per-surface voice config (`host.settings` → `voiceConfig`),
     * mirrored down the same way `defaultModel` is. Persisted so a host
     * that restarts before the server's first push still knows it. Absent
     * means every surface defaults to `{ backend: 'local', layer: 'direct' }`
     * (dictation: `{ backend: 'local' }`) — see packages/server/src/settings.ts.
     */
    voiceConfig: z
      .object({
        dictation: z.object({ backend: z.enum(['local', 'gemini', 'openai']) }).strict(),
        device: z
          .object({
            backend: z.enum(['local', 'gemini', 'openai']),
            layer: z.enum(['direct', 'light', 'heavy']),
            handoff: z.enum(['auto', 'always', 'never']).default('auto'),
          })
          .strict(),
        handsFree: z
          .object({
            backend: z.enum(['local', 'gemini', 'openai']),
            layer: z.enum(['direct', 'light', 'heavy']),
            handoff: z.enum(['auto', 'always', 'never']).default('auto'),
          })
          .strict(),
        call: z
          .object({
            backend: z.enum(['local', 'gemini', 'openai']),
            layer: z.enum(['direct', 'light', 'heavy']),
            handoff: z.enum(['auto', 'always', 'never']).default('auto'),
          })
          .strict(),
      })
      .strict()
      .optional(),
    /**
     * How many user messages between auto-regen of the chat name
     * (`host.settings` → `chatNameInterval`). `0` disables periodic regen.
     * Absent means 0 (initial message only, the old behaviour).
     */
    chatNameInterval: z.number().int().nonnegative().optional(),
    /**
     * The Manager's bounded context window (`host.settings` →
     * `managerContextWindow`, spec/06 § Manager conversation). Absent means
     * the host's own generous built-in default stands.
     */
    managerContextWindow: z.number().int().positive().optional(),
    /**
     * The goal judge's settings (`shared` → `goalEvalPrompt`, `goalModel`,
     * `goalRefusalLimit`, spec/04 § Goals), kept so a host that restarts before the
     * server's first push still judges goals the way Settings says. Absent means
     * the built-in defaults stand.
     */
    goalEvalPrompt: z.string().min(1).optional(),
    goalModel: z.string().min(1).optional(),
    goalRefusalLimit: z.number().int().positive().optional(),
    /**
     * Whether this host automatically retries a turn blocked by a Claude API
     * usage/rate limit. When true the host parks the pending user message and
     * re-queues it once the limit resets (or after a 60-second backoff).
     */
    autoResumeRateLimit: z.boolean().optional(),
    /**
     * Whether an unanswered `AskUserQuestion` on this host expires
     * (`host.settings` → `questionExpiry`), and the window in seconds it is
     * given. Absent means the host's own default: on, at
     * `QUESTION_EXPIRY_SECONDS_DEFAULT`.
     */
    questionExpiry: z.boolean().optional(),
    questionExpirySeconds: z.number().int().positive().optional(),
    /**
     * Per-host system prompt override passed to the SDK query's `systemPrompt`
     * option. Empty string means cleared (use SDK default). Absent means no
     * override (Task 3).
     */
    harnessSystemPrompt: z.string().optional(),
    /**
     * Per-host override of the built-in patch-tools guidance appended to the
     * system prompt. Absent means the built-in default; empty string means the
     * user turned it off.
     */
    harnessToolsPrompt: z.string().optional(),
    /**
     * Per-host skills to enable on every turn (`skills` SDK option). `'all'`
     * enables every discovered skill; an array enables only the named skills.
     * Absent means no override (Task 3).
     */
    harnessSkills: z.union([z.array(z.string().min(1)), z.literal('all')]).optional(),
    /**
     * Whether Claude Code's own persistent memory is enabled on this host
     * (spec/14 § Agent behavior). Absent means never explicitly set — the
     * host defaults it to `false`.
     */
    harnessMemoryEnabled: z.boolean().optional(),
    /**
     * LEGACY — the retired Browser tools toggle. Read once, to seed
     * `harnessMcpServers` on a host that has no list yet (its value becomes
     * the `enabled` of the seeded `playwright` + `chrome-devtools` pair);
     * never written since. Kept in the schema so an old file does not warn.
     */
    harnessBrowserToolsEnabled: z.boolean().optional(),
    /**
     * The MCP servers wired into every chat on this host, beside Patch's own
     * (Settings → MCP; `mcpServers.ts`). Absent means the host predates the
     * list and seeds it from `harnessBrowserToolsEnabled` on boot.
     */
    harnessMcpServers: McpServerList.optional(),
    /**
     * LEGACY — the retired CLAUDE.md toggle. The shipped Manager/
     * Speakers CLAUDE.md now always loads; a persisted `false` is ignored
     * (and logged once) rather than honoured, and nothing writes this any
     * more. Kept in the schema so an old file does not warn.
     */
    harnessClaudeMdEnabled: z.boolean().optional(),
    /**
     * Agent browser routing (`host.settings` → `browserRouteThrough`): the
     * `daemonId` of another of the user's hosts this host's `patch_browser_*`
     * traffic egresses through. Absent means direct (the default).
     */
    browserRouteThrough: z.string().min(1).optional(),
  })
  // NOT `.strict()`, deliberately. An unknown key is a file written by a
  // DIFFERENT VERSION of this host — a rollback, or a field that has since
  // been retired — and it is stripped with a warning rather than refused.
  //
  // It used to be strict, and that took the whole machine down: retiring
  // `lastUsedModel` meant every host on a host whose `host.json` still
  // carried it threw `Unrecognized key(s)` inside the HostStateStore
  // constructor, before anything was listening, and crash-looped. A field a
  // host does not understand is not a reason to refuse to run — and refusing
  // is worse than ignoring, because a host that will not boot cannot be
  // reached to be fixed.
  //
  // A key that is PRESENT but has an invalid VALUE still throws, which is the
  // case the strictness was actually for: silently resetting a user's
  // designated project roots is worse than failing with the reason on stderr.
  .passthrough();
export type HostStateFile = z.infer<typeof HostStateFile>;

/** Keys this host knows, so a stripped one can be named in the warning. */
const KNOWN_HOST_STATE_KEYS = new Set(Object.keys(HostStateFile.shape));

export class HostStateStore {
  private readonly path: string;
  private state: HostStateFile;

  constructor(patchHome: string, logger?: Pick<Logger, 'warn'>) {
    this.path = join(patchHome, 'host.json');
    if (existsSync(this.path)) {
      const raw = HostStateFile.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      // Drop what this version does not know, and SAY which — a key silently
      // carried forward would be written back on the next update, and a key
      // silently dropped is a setting that stopped applying with no trace.
      const unknown = Object.keys(raw).filter((k) => !KNOWN_HOST_STATE_KEYS.has(k));
      if (unknown.length > 0) {
        logger?.warn(
          { path: this.path, keys: unknown },
          'host state: keys this host does not know, ignored (written by another version)',
        );
        for (const k of unknown) delete (raw as Record<string, unknown>)[k];
      }
      this.state = raw;
    } else {
      this.state = {};
    }
  }

  get(): HostStateFile {
    return { ...this.state };
  }

  /** Merge a patch and persist. `undefined` values are left untouched. */
  update(patch: HostStateFile): void {
    this.state = { ...this.state, ...patch };
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    const fd = openSync(tmp, 'r');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.path);
  }
}
