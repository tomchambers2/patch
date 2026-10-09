// GoalBanner — the Goal bar above the chat (spec/04 § Goals, spec/14 § Main
// chat panel — Goal bar). The goal is set from the composer via `/goal <text>`
// (which also starts a turn with the condition as the directive) and cleared
// with a bare `/goal`; this bar is the always-visible readout of what Patch's
// own evaluator is judging — condition, running time, turns evaluated, tokens
// spent, and its latest reason — so the user can see progress without opening
// the transcript. The condition's text is shown in full (wrapped, never
// truncated) and edited in a modal opened by clicking it (re-arms the
// evaluator on the new text as a fresh goal, same as typing a new `/goal`).
// Editing and the clear (×) control are both optimistic, reverting + surfacing
// a toast on failure (NO FALLBACK), mirroring the ArchivedBanner's per-chat
// pattern.

import { useEffect, useRef, useState, type JSX } from 'react';
import { Target, X } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

/**
 * Humanise time elapsed since a goal started: `9m`, `1h 4m`, `3h`. Coarsest
 * two units, no seconds — a running total is read at a glance, not ticked
 * precisely like a countdown to a specific instant (`WakeBar.formatWakeCountdown`).
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Humanise a token count: `842`, `8.2k`, `1.4M`. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function GoalEditModal({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (next: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  function save(): void {
    const next = draft.trim();
    if (next === '') return;
    if (next !== value) onSave(next);
    onClose();
  }
  return (
    <div className="modal-overlay" data-testid="goal-edit-overlay">
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className="modal-card goal-edit-modal"
        data-testid="goal-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit goal"
      >
        <textarea
          ref={ref}
          className="goal-edit-input"
          data-testid="goal-edit-input"
          value={draft}
          rows={5}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="goal-edit-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="goal-edit-save"
            disabled={draft.trim() === ''}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function GoalBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const setGoal = useChatStore((s) => s.setGoal);
  const pushError = useUiStore((s) => s.pushError);
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);

  const goal = row.goal;
  const progress = row.goalProgress;

  // Tick the running-time readout. Only while a goal is active — no timer for
  // the (overwhelmingly common) chat with none.
  useEffect(() => {
    if (goal === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [goal]);

  if (goal === null || goal.trim() === '') return null;

  async function writeGoal(next: string | null): Promise<void> {
    const prev = goal;
    setGoal(row.chatId, next);
    try {
      await api.setGoal(row.chatId, next);
    } catch (err) {
      setGoal(row.chatId, prev);
      pushError(
        `${next === null ? 'clearing' : 'updating'} goal failed: ${(err as Error).message}`,
      );
    }
  }

  const metrics: string[] = [];
  if (progress) {
    metrics.push(formatElapsed(now - progress.startedAt));
    metrics.push(`${progress.turnsEvaluated} turn${progress.turnsEvaluated === 1 ? '' : 's'}`);
    if (progress.tokensSpent > 0) metrics.push(`${formatTokenCount(progress.tokensSpent)} tokens`);
  }
  const reason =
    progress?.lastVerdict === 'not_met' && progress.lastReason !== null
      ? `Not met: ${progress.lastReason}`
      : null;

  return (
    <div className="goal-banner" data-testid="goal-banner" role="status">
      <div className="goal-banner-meta" data-testid="goal-banner-meta">
        <Target size={16} aria-hidden />
        {metrics.length > 0 && (
          <span className="goal-banner-metrics" data-testid="goal-banner-metrics">
            {metrics.join(' · ')}
          </span>
        )}
        {reason !== null && (
          <span className="goal-banner-reason" data-testid="goal-banner-reason" title={reason}>
            {reason}
          </span>
        )}
        <button
          type="button"
          className="goal-clear-btn"
          data-testid="goal-clear-btn"
          aria-label="Clear goal"
          title="Clear goal"
          onClick={() => void writeGoal(null)}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <button
        type="button"
        className="goal-banner-text"
        data-testid="goal-banner-text"
        aria-label="Edit goal"
        onClick={() => setEditing(true)}
      >
        {goal}
      </button>
      {editing && (
        <GoalEditModal
          value={goal}
          onSave={(next) => void writeGoal(next)}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
