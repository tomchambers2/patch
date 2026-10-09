// The composer's `/` skill autocomplete preview panel (spec/14 § Skill
// autocomplete). Renders what the highlighted row's skill (or built-in
// command) IS before it runs: its full description, the rest of its
// frontmatter, and an Edit link to its source file. A standalone component so
// it can be dropped beside the list (desktop) or above it (mobile) without the
// caller reasoning about frontmatter shape or the Edit-link containment rule
// itself.
//
// NO FALLBACK: a skill with no frontmatter at all shows only its name and
// (where reachable) an Edit link — never an invented description or a "no
// description" filler line (spec/14 § Skill autocomplete).

import type { JSX } from 'react';
import { resolveSkillLink } from '../routes/JobEditorRoute.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';

/** The highlighted (or touched) row this panel previews. */
export interface SkillPreviewItem {
  name: string;
  isBuiltin: boolean;
  /** A built-in's one-line description — declared in code, not frontmatter,
   *  so it rides along on the item rather than through the `frontmatter` map. */
  description?: string;
}

export interface SkillPreviewPanelProps {
  item: SkillPreviewItem | undefined;
  /** Absolute host-side file per skill name, as reported by GET /api/skills. */
  paths: Record<string, string> | undefined;
  /** Each skill's whole frontmatter block, keyed by name then by field. */
  frontmatter: Record<string, Record<string, string>> | undefined;
  /** The composer's own host + folder — same containment rule as the Jobs
   *  view's Skill field (`resolveSkillLink`). */
  daemonId: string;
  folder: string;
}

/** Frontmatter fields already shown elsewhere in the panel (or the row above
 *  it) — excluded from the "rest of the frontmatter" list so nothing repeats. */
const SHOWN_ELSEWHERE = new Set(['name', 'description']);

export function SkillPreviewPanel({
  item,
  paths,
  frontmatter,
  daemonId,
  folder,
}: SkillPreviewPanelProps): JSX.Element | null {
  const chats = useChatStore((s) => s.chats);
  const setActiveChat = useChatStore((s) => s.setActiveChat);
  const openFileInBrowser = useUiStore((s) => s.openFileInBrowser);

  if (!item) return null;

  // The description is the SAME one the row above already resolved (from
  // `descriptions`, kept for a host too old to send `frontmatter` at all) —
  // not re-read from `frontmatter`, so an older host's panel still shows it.
  // A built-in has no `.claude/skills` file and therefore no frontmatter and
  // no Edit link.
  const description = item.description;
  const fields = item.isBuiltin ? undefined : frontmatter?.[item.name];
  const extraFields = fields
    ? Object.entries(fields).filter(([key]) => !SHOWN_ELSEWHERE.has(key))
    : [];

  const target = item.isBuiltin
    ? null
    : resolveSkillLink({
        skill: item.name,
        paths,
        daemonId,
        folder,
        chats: Object.values(chats).map((c) => ({
          chatId: c.chatId,
          folder: c.folder,
          daemonId: c.daemonId,
        })),
      });

  return (
    <div className="composer-skill-preview" data-testid="composer-skill-preview">
      <p className="composer-skill-preview-name">{item.name}</p>
      {description ? (
        <p className="composer-skill-preview-desc" data-testid="composer-skill-preview-desc">
          {description}
        </p>
      ) : null}
      {extraFields.length > 0 ? (
        <dl className="composer-skill-preview-fields" data-testid="composer-skill-preview-fields">
          {extraFields.map(([key, value]) => (
            <div key={key} className="composer-skill-preview-field">
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {target && !('reason' in target) ? (
        <button
          type="button"
          className="link-btn composer-skill-preview-edit"
          data-testid="composer-skill-preview-edit"
          onClick={() => {
            setActiveChat(target.chatId);
            openFileInBrowser(target);
          }}
        >
          Edit
        </button>
      ) : null}
    </div>
  );
}
