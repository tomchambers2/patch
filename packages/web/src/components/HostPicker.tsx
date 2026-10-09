// The host (machine) control: the same pill-and-pop-up as ModelPicker, so the
// app's pickers read as one family. The chosen host is the pill's label;
// opening it lists every host, an offline one visible but not selectable.

import type { RefObject } from 'react';
import type { PopupPlacement } from '../lib/popupPlacement.js';

export interface HostPickerOption {
  daemonId: string;
  label: string;
  online: boolean;
}

interface HostPickerProps {
  hosts: HostPickerOption[];
  selected: string | null;
  onSelect: (daemonId: string) => void;
  open: boolean;
  onToggle: () => void;
  anchorRef: RefObject<HTMLDivElement | null>;
  placement: PopupPlacement;
  testId: string;
}

export function HostPicker({
  hosts,
  selected,
  onSelect,
  open,
  onToggle,
  anchorRef,
  placement,
  testId,
}: HostPickerProps): JSX.Element {
  const current = hosts.find((h) => h.daemonId === selected);
  const label = current?.label ?? selected ?? 'Choose a host…';
  return (
    <div className="model-picker" ref={anchorRef}>
      <button
        type="button"
        className="model-pill"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="host"
        title={selected ?? undefined}
        onClick={onToggle}
      >
        <span className="model-pill-label mono">{label}</span>
        <span className="model-pill-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div
          className={`model-popup place-${placement.direction}`}
          style={{ maxHeight: placement.maxHeight }}
          data-testid="host-popup"
          role="listbox"
        >
          <ul className="model-popup-list">
            {hosts.map((h) => (
              <li key={h.daemonId}>
                <button
                  type="button"
                  className={`model-option ${h.daemonId === selected ? 'selected' : ''}`}
                  data-testid={`host-option-${h.daemonId}`}
                  role="option"
                  aria-selected={h.daemonId === selected}
                  disabled={!h.online}
                  title={h.online ? undefined : 'Offline'}
                  onClick={() => onSelect(h.daemonId)}
                >
                  <span className="model-option-name">
                    {h.label}
                    {h.online ? null : ' · offline'}
                  </span>
                  {h.daemonId === selected ? (
                    <span className="model-option-check" aria-hidden>
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
