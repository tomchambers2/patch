// Settings building blocks (design/settings-redesign): every page is a title,
// then groups — an uppercase label over a rounded card of rows. A row is a
// title with an optional small subtitle on the left and its control on the
// right. Pages compose these and nothing else, so the eleven pages read as one
// thing.

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import { useGoBack } from '../../lib/useGoBack.js';
import type { HostPresence } from '../../stores/presenceStore.js';
import { hostLabel, useSettingsHost } from './hostScope.js';

/**
 * spec/14 § Panes and tabs: Settings is one pane tab now, with its own
 * sub-pages as internal state (`SettingsRoute`) rather than real
 * `/settings/<page>` routes — so a phone-width page's back arrow can no
 * longer rely on router history (nothing pushed a new entry) the way
 * `useGoBack` does everywhere else. `SettingsRoute` provides this; a page
 * rendered without it (only the settings test harnesses, if ever) falls back
 * to the old router-history behaviour so it still does *something* sane.
 */
export const SettingsBackContext = createContext<(() => void) | null>(null);

function useSettingsBack(): () => void {
  const fromContext = useContext(SettingsBackContext);
  const fallback = useGoBack('/settings');
  return fromContext ?? fallback;
}

/** A page: back arrow (phone only), title, optional host switcher and actions. */
export function SettingsPage({
  title,
  testid,
  hostSwitch = false,
  actions,
  fill = false,
  children,
}: {
  title: string;
  testid: string;
  /** Show the host switcher when more than one host has reported. */
  hostSwitch?: boolean;
  actions?: ReactNode;
  /** Take the whole panel — width and height — instead of a 720px column. */
  fill?: boolean;
  children: ReactNode;
}): JSX.Element {
  const goBack = useSettingsBack();
  return (
    <div className={fill ? 'set-page fill' : 'set-page'} data-testid={testid}>
      <div className="set-head">
        {/* Back to wherever the page was opened from — the settings list, or
            a chat whose banner linked here — and the list only when there is
            nothing earlier (spec/14 § Layout — desktop). */}
        <button
          type="button"
          className="set-back"
          aria-label="Back"
          data-testid="settings-back"
          onClick={goBack}
        >
          ←
        </button>
        <h1 className="display">{title}</h1>
        {hostSwitch ? <HostSwitch /> : null}
        {actions}
      </div>
      {children}
    </div>
  );
}

/** Uppercase label over a card; `after` sits below the card (e.g. "Add account"). */
export function Group({
  label,
  children,
  after,
  testid,
}: {
  label?: string;
  children: ReactNode;
  after?: ReactNode;
  testid?: string;
}): JSX.Element {
  return (
    <section className="set-group" data-testid={testid}>
      {label ? <h2 className="set-label">{label}</h2> : null}
      <div className="set-card">{children}</div>
      {after}
    </section>
  );
}

export function Row({
  title,
  sub,
  children,
  testid,
  className,
  onClick,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  testid?: string;
  className?: string;
  /** A row that opens something: the text half becomes the button. */
  onClick?: () => void;
}): JSX.Element {
  const text = (
    <>
      <span className="set-row-title">{title}</span>
      {sub !== undefined && sub !== null && sub !== '' ? (
        <span className="set-sub">{sub}</span>
      ) : null}
    </>
  );
  return (
    <div className={`set-row${className ? ` ${className}` : ''}`} data-testid={testid}>
      {onClick ? (
        <button type="button" className="set-row-text set-row-open" onClick={onClick}>
          {text}
        </button>
      ) : (
        <div className="set-row-text">{text}</div>
      )}
      {children !== undefined ? <div className="set-row-ctrl">{children}</div> : null}
    </div>
  );
}

/** A one-line statement inside a card: "Mac hasn't reported yet". */
export function Note({ children, testid }: { children: ReactNode; testid?: string }): JSX.Element {
  return (
    <p className="set-note" data-testid={testid}>
      {children}
    </p>
  );
}

export function Pills<T extends string>({
  options,
  value,
  onChange,
  disabled,
  testid,
  label,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  testid?: string;
  label: string;
  /** What each option reads as, where that is not the option itself. */
  labels?: Partial<Record<T, string>>;
}): JSX.Element {
  return (
    <div className="set-pills" role="group" aria-label={label} data-testid={testid}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={o === value ? 'on' : undefined}
          aria-pressed={o === value}
          disabled={disabled}
          data-testid={testid ? `${testid}-${o}` : undefined}
          onClick={() => {
            if (o !== value) onChange(o);
          }}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

/**
 * The per-host switcher in a page header. Drawn only when more than one host
 * has reported: with one, there is nothing to choose and the page is simply
 * about that host.
 */
export function HostSwitch(): JSX.Element | null {
  const { options, daemonId, select } = useSettingsHost();
  if (options.length < 2) return null;
  return (
    <div className="set-seg" role="tablist" aria-label="Host" data-testid="settings-host-switch">
      {options.map((h) => (
        <button
          key={h.daemonId}
          type="button"
          role="tab"
          aria-selected={h.daemonId === daemonId}
          className={h.daemonId === daemonId ? 'on' : undefined}
          data-testid={`settings-host-${h.daemonId}`}
          onClick={() => select(h.daemonId)}
        >
          <OnlineDot online={h.online} />
          {hostLabel(h)}
        </button>
      ))}
    </div>
  );
}

export function OnlineDot({ online }: { online: boolean }): JSX.Element {
  return (
    <span className={`set-dot${online ? '' : ' off'}`} aria-label={online ? 'online' : 'offline'} />
  );
}

/**
 * What a per-host page says instead of controls when it has nothing honest to
 * show: no host at all, or the chosen one has never reported.
 */
export function useHostGate(): { host: HostPresence | null; gate: JSX.Element | null } {
  const { host } = useSettingsHost();
  if (!host) {
    return {
      host: null,
      gate: (
        <Group>
          <Note testid="settings-no-hosts">No hosts yet</Note>
        </Group>
      ),
    };
  }
  if (!host.host) {
    return {
      host,
      gate: (
        <Group>
          <Note testid="settings-host-unreported">{hostLabel(host)} hasn’t reported yet</Note>
        </Group>
      ),
    };
  }
  return { host, gate: null };
}
