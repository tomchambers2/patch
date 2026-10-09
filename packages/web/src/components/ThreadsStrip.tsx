// The Threads strip beneath the Manager conversation (spec/14 § Manager view).
//
// One conversation to talk to, and everything it is watching visible
// underneath. Each row is a chat on some host; each row's controls are the
// decision it is blocked on, so the everyday ones can be taken without leaving
// the Manager and opening the chat.
//
// It has no scope picker on purpose: the Manager watches everything (spec/06
// § The watch loop), and a view showing less than the thing doing the watching
// would be lying about what it can see.

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Square, ArrowRight, ExternalLink } from 'lucide-react';
import { threadRowState as rowState, threadRows as sharedThreadRows } from '@patch/wire';
import { deriveBadge, useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { getActiveWs } from '../api/ws.js';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { nudgeContinue } from '../lib/carryOn.js';
import { parseAskUserQuestion, ASK_USER_QUESTION } from '../lib/askUserQuestion.js';
import { StatusBadge } from './StatusBadge.js';
import { ReachSwitch } from './ReachSwitch.js';
import { SweepStatusLine } from './SweepStatusLine.js';
import type { ChatRow, PendingPermission } from '../stores/types.js';

/** Default height of the strip, and the bounds a drag keeps it inside. */
export const DEFAULT_STRIP_HEIGHT = 240;
const MIN_STRIP_HEIGHT = 120;
const MAX_STRIP_HEIGHT = 640;
const STRIP_HEIGHT_KEY = 'patch.managerStripHeight.v1';

/**
 * The strip's rows: every active chat on every host, needs-you first, then by
 * recency. The rule itself lives in `@patch/wire` (`threadRows`) so the
 * phone's Manager Chats tab orders exactly the same way.
 */
export function threadRows(chats: Record<string, ChatRow>, now: number): ChatRow[] {
  return sharedThreadRows(chats, now);
}

/** The pending `AskUserQuestion`, when the row is blocked on exactly one. */
function pendingQuestion(row: ChatRow): PendingPermission | undefined {
  return row.pendingPermissions.find((p) => p.tool === ASK_USER_QUESTION);
}

function readStoredHeight(): number {
  const raw = window.localStorage.getItem(STRIP_HEIGHT_KEY);
  if (raw === null) return DEFAULT_STRIP_HEIGHT;
  const parsed = Number(raw);
  // A corrupt persisted value resets to the default, a legitimate first-run
  // state — the same rule the batch settings follow.
  if (!Number.isFinite(parsed)) return DEFAULT_STRIP_HEIGHT;
  return Math.min(MAX_STRIP_HEIGHT, Math.max(MIN_STRIP_HEIGHT, parsed));
}

export function ThreadsStrip(): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  const resolvePermission = useChatStore((s) => s.resolvePermission);
  const hosts = usePresenceStore((s) => s.hosts);
  const pushError = useUiStore((s) => s.pushError);
  const navigate = useNavigate();
  const [height, setHeight] = useState(readStoredHeight);

  const rows = useMemo(() => threadRows(chats, Date.now()), [chats]);

  const answer = (chatId: string, requestId: string, answers?: Record<string, string>): void => {
    const ws = getActiveWs();
    if (!ws) {
      pushError('not connected');
      return;
    }
    permissionDeliveryTracker.send(
      answers
        ? {
            type: 'chat.permission_response',
            chatId,
            requestId,
            approve: true,
            decision: 'approve_with_edits',
            editedNewString: JSON.stringify(answers),
          }
        : { type: 'chat.permission_response', chatId, requestId, approve: true },
      (event) => ws.send(event),
    );
    resolvePermission(chatId, requestId, 'approve');
  };

  const deny = (chatId: string, requestId: string): void => {
    const ws = getActiveWs();
    if (!ws) {
      pushError('not connected');
      return;
    }
    permissionDeliveryTracker.send(
      { type: 'chat.permission_response', chatId, requestId, approve: false },
      (event) => ws.send(event),
    );
    resolvePermission(chatId, requestId, 'deny');
  };

  const stop = (chatId: string): void => {
    const ws = getActiveWs();
    if (!ws) {
      pushError('not connected');
      return;
    }
    ws.send({ type: 'chat.stop_request', chatId });
  };

  const carryOn = (chatId: string): void => {
    if (!nudgeContinue(chatId)) pushError('not connected');
  };

  const onDividerDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    let settled = startHeight;
    const onMove = (ev: MouseEvent): void => {
      settled = Math.min(
        MAX_STRIP_HEIGHT,
        Math.max(MIN_STRIP_HEIGHT, startHeight + (startY - ev.clientY)),
      );
      setHeight(settled);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.localStorage.setItem(STRIP_HEIGHT_KEY, String(settled));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <>
      <div
        className="threads-divider"
        data-testid="threads-divider"
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={onDividerDown}
      />
      <section
        className="threads-strip"
        data-testid="threads-strip"
        style={{ height: `${height}px` }}
        aria-label="Threads"
      >
        <div className="threads-head">
          <span className="threads-head-label">Threads</span>
          <ReachSwitch />
        </div>
        <SweepStatusLine />
        {rows.length === 0 ? (
          <div className="threads-empty empty-hint" data-testid="threads-empty">
            Nothing running.
          </div>
        ) : (
          rows.map((row) => {
            const state = rowState(row);
            const question = state === 'question' ? pendingQuestion(row) : undefined;
            const permission =
              state === 'permission'
                ? row.pendingPermissions.find((p) => p.tool !== ASK_USER_QUESTION)
                : undefined;
            const hostName = hosts[row.daemonId]?.host?.hostName ?? row.daemonId;
            return (
              <div className="thread-row" data-testid={`thread-row-${row.chatId}`} key={row.chatId}>
                <StatusBadge badge={deriveBadge(row)} pendingWake={row.pendingWake} />
                <div className="thread-body">
                  <div className="thread-title">
                    {deriveChatTitle(row.name)}
                    <span className="thread-where">
                      {hostName} · {row.folder}
                    </span>
                  </div>
                  {row.statusSummary ? (
                    <div className="thread-summary" data-testid={`thread-summary-${row.chatId}`}>
                      {row.statusSummary}
                    </div>
                  ) : null}
                  {question ? (
                    <QuestionOptions
                      permission={question}
                      onAnswer={(answers) => answer(row.chatId, question.requestId, answers)}
                      onOpen={() => navigate(`/chats/${row.chatId}`)}
                    />
                  ) : null}
                </div>
                <div className="thread-actions">
                  {permission ? (
                    <>
                      <button
                        type="button"
                        className="thread-btn primary"
                        data-testid={`thread-approve-${row.chatId}`}
                        onClick={() => answer(row.chatId, permission.requestId)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="thread-btn"
                        data-testid={`thread-deny-${row.chatId}`}
                        onClick={() => deny(row.chatId, permission.requestId)}
                      >
                        Deny
                      </button>
                    </>
                  ) : null}
                  {state === 'idle' ? (
                    <button
                      type="button"
                      className="thread-btn"
                      data-testid={`thread-carry-on-${row.chatId}`}
                      onClick={() => carryOn(row.chatId)}
                    >
                      <ArrowRight size={14} aria-hidden /> Carry on
                    </button>
                  ) : null}
                  {state === 'working' ? (
                    <button
                      type="button"
                      className="thread-btn"
                      data-testid={`thread-stop-${row.chatId}`}
                      onClick={() => stop(row.chatId)}
                    >
                      <Square size={12} aria-hidden /> Stop
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="thread-btn ghost"
                    data-testid={`thread-open-${row.chatId}`}
                    aria-label={`open ${deriveChatTitle(row.name)}`}
                    onClick={() => navigate(`/chats/${row.chatId}`)}
                  >
                    <ExternalLink size={14} aria-hidden />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>
    </>
  );
}

/**
 * The pending question's options, inline. A single-question ask is answerable
 * from here; anything more complex says so and sends the user into the chat,
 * rather than half-answering it — an unanswered question reaching the agent as
 * an answer is the exact failure the question card exists to prevent.
 */
function QuestionOptions({
  permission,
  onAnswer,
  onOpen,
}: {
  permission: PendingPermission;
  onAnswer(answers: Record<string, string>): void;
  onOpen(): void;
}): JSX.Element {
  const questions = useMemo(() => parseAskUserQuestion(permission.args), [permission.args]);
  const single = questions?.length === 1 ? questions[0] : undefined;
  if (!single || single.multiSelect) {
    return (
      <button
        type="button"
        className="thread-btn"
        data-testid="thread-question-open"
        onClick={onOpen}
      >
        Open to answer
      </button>
    );
  }
  return (
    <div className="thread-question" data-testid="thread-question">
      <span className="thread-question-text">{single.question}</span>
      <span className="thread-question-options">
        {single.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className="thread-btn"
            title={option.description}
            onClick={() => onAnswer({ [single.question]: option.label })}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}
