// The notifications bell (spec/09 § bell): what agents sent, newest first,
// unread ones distinct, click to read and open the source chat.

import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useNotificationsStore } from '../stores/notificationsStore.js';
import { relativeTime } from '../lib/relativeTime.js';

export function NotificationBell(): JSX.Element {
  const { items, unread, error, load, markRead } = useNotificationsStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const navigate = useNavigate();

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <span className="notif-bell" ref={ref}>
      <button
        type="button"
        className="sidebar-collapse-btn notif-bell-btn"
        data-testid="notif-bell"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        title="Notifications"
        aria-expanded={open}
        onClick={() => {
          const r = ref.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 4, left: Math.max(8, r.left - 8) });
          setOpen((v) => !v);
          void load();
        }}
      >
        <Bell size={16} aria-hidden />
        {unread > 0 ? (
          <span className="notif-badge" data-testid="notif-badge">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open
        ? createPortal(
            <div
              className="notif-panel"
              ref={panelRef}
              style={{ top: pos.top, left: pos.left }}
              data-testid="notif-panel"
              role="dialog"
              aria-label="Notifications"
            >
              <div className="notif-panel-head">
                <span>Notifications</span>
                <button
                  type="button"
                  className="notif-markall"
                  data-testid="notif-mark-all"
                  disabled={unread === 0}
                  onClick={() => void markRead({ all: true })}
                >
                  Mark all read
                </button>
              </div>
              {error ? (
                <div className="notif-empty" data-testid="notif-error">
                  {error}
                </div>
              ) : items.length === 0 ? (
                <div className="notif-empty" data-testid="notif-empty">
                  Nothing yet.
                </div>
              ) : (
                <ul className="notif-list">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className={`notif-item ${n.readAt === null ? 'unread' : 'read'}`}
                        data-testid={`notif-item-${n.id}`}
                        data-read={n.readAt !== null}
                        onClick={() => {
                          void markRead({ ids: [n.id] });
                          setOpen(false);
                          navigate(`/chats/${n.chatId}`);
                        }}
                      >
                        <span className="notif-dot" aria-hidden />
                        <span className="notif-msg">{n.message}</span>
                        <span className="notif-time">{relativeTime(n.sentAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
