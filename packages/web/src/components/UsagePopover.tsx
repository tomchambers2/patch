// UsagePopover — every usage figure in one place (spec/14 § Usage popover):
// the open chat's context window, then each connected account's limit windows
// on every host, drawn with the same bars the Usage settings page uses.
//
// Opened from two triggers — the context ring beside Send and the usage crumb
// in the chat header — so it is portalled to the body and positioned from the
// trigger's measured rect: the header's crumb zone is `overflow: hidden`, and
// an in-flow pop-up there is clipped (see ModelPicker for the same fix).

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { CLAUDE_BACKEND_ID, type ChatContextUsage } from '@patch/wire';
import { usePresenceStore, type HostAccount } from '../stores/presenceStore.js';
import { UsageBars } from '../routes/settings/accountList.js';
import { formatReadAt, summariseContext } from '../lib/usage.js';

const BACKEND_LABEL: Record<string, string> = { [CLAUDE_BACKEND_ID]: 'Claude', codex: 'OpenAI' };

interface Row {
  key: string;
  title: string;
  usage: HostAccount['usage'];
}

/** Every connected subscription account on every host — API keys have no limits to draw. */
function accountRows(hosts: ReturnType<typeof usePresenceStore.getState>['hosts']): Row[] {
  const list = Object.values(hosts).filter((h) => Object.keys(h.accounts).length > 0);
  const many = list.length > 1;
  const rows: Row[] = [];
  for (const h of list) {
    const hostName = h.host?.hostName ?? h.daemonId;
    for (const acct of Object.values(h.accounts)) {
      const backend = BACKEND_LABEL[acct.backendId] ?? acct.backendId;
      const entries =
        acct.accounts ??
        (acct.connected
          ? [{ id: acct.backendId, label: backend, connected: true, usage: acct.usage }]
          : []);
      for (const a of entries) {
        if (!a.connected || ('kind' in a && a.kind === 'apiKey')) continue;
        const name = acct.accounts ? `${backend} · ${a.label}` : backend;
        rows.push({
          key: `${h.daemonId}:${acct.backendId}:${a.id}`,
          title: many ? `${hostName} · ${name}` : name,
          usage: a.usage,
        });
      }
    }
  }
  return rows;
}

export function UsagePopover({
  anchorRef,
  direction,
  align,
  context,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  direction: 'up' | 'down';
  align: 'start' | 'end';
  /** The open chat's reading; omitted where there is no chat. */
  context?: ChatContextUsage | null;
  onClose: () => void;
}): JSX.Element | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const rows = accountRows(hosts);
  const ctx = summariseContext(context);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    function measure(): void {
      const el = anchorRef.current;
      if (el) setRect(el.getBoundingClientRect());
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    function onDown(e: PointerEvent): void {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  if (rect === null) return null;
  const margin = 8;
  const style: CSSProperties = {
    position: 'fixed',
    ...(direction === 'down'
      ? { top: rect.bottom + 6, maxHeight: window.innerHeight - rect.bottom - 6 - margin }
      : { bottom: window.innerHeight - rect.top + 6, maxHeight: rect.top - 6 - margin }),
    ...(align === 'start'
      ? { left: Math.max(margin, rect.left) }
      : { right: Math.max(margin, window.innerWidth - rect.right) }),
  };

  return createPortal(
    <div
      ref={popRef}
      className="usage-pop"
      role="dialog"
      aria-label="Usage"
      data-testid="usage-popover"
      style={style}
    >
      {ctx ? (
        <section className="usage-pop-section" data-testid="usage-pop-context">
          <h4>Context</h4>
          <div className="set-bars">
            <div
              className={`set-bar-row${ctx.level === 'ok' || ctx.level === 'unknown' ? '' : ` ${ctx.level === 'blocked' ? 'blocked' : 'warn'}`}`}
            >
              <span className="set-bar-label">Window</span>
              <span className="set-bar" aria-hidden="true">
                <i style={{ width: `${Math.round(ctx.fraction * 100)}%` }} />
              </span>
              <span className="set-bar-value">{ctx.percent}</span>
              <span className="set-bar-reset">{ctx.tokens}</span>
            </div>
          </div>
        </section>
      ) : null}
      {rows.map((r) => {
        const readAt = formatReadAt(r.usage?.at);
        return (
          <section className="usage-pop-section" key={r.key} data-testid="usage-pop-account">
            <h4>{r.title}</h4>
            {readAt ? <span className="set-sub usage-pop-read-at">{readAt}</span> : null}
            <UsageBars
              usage={r.usage}
              testId={`usage-pop-bars-${r.key}`}
              testIdFor={(scope) => `usage-pop-${scope}-${r.key}`}
            />
          </section>
        );
      })}
      <Link className="usage-pop-link" to="/settings/usage" onClick={onClose}>
        Settings
      </Link>
    </div>,
    document.body,
  );
}
