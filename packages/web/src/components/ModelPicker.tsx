// ModelPicker — the app's ONE model control (spec/14 § Model selector).
//
// It is used in two places: the new-chat setup row, where it picks the model a
// chat will START on, and the chat header's model crumb, where it changes the
// model a live chat runs on from its next turn (spec/04 § Model). Those are the
// same question asked twice, so they are the same control — a second pill built
// beside this one would drift in styling, in how it reports a catalogue error,
// and in which host's catalogue it reads.
//
// Deliberately NOT a native <select>: in the setup row it sits directly beside
// the custom folder pill, and native dropdown chrome next to a custom pill reads
// as two different apps.
//
// Open state is CONTROLLED by the caller. The new-chat row has three pop-ups
// that must be mutually exclusive, and only the caller knows about its
// siblings; owning `open` here would let two lists overlap.

import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useModelCatalog } from '../lib/models.js';
import { humaniseError } from '../lib/errorCopy.js';
import { ErrorDetail } from './ErrorDetail.js';

export interface ModelPickerProps {
  /**
   * The model in force, as an id. `null` when there is none to name — the pill
   * then reads `placeholder` rather than inventing an id.
   */
  selected: string | null;
  onSelect: (modelId: string) => void;
  open: boolean;
  onToggle: () => void;
  /**
   * The anchor element's ref. Supplied by the caller because click-off
   * dismissal is coordinated across every open pop-up on the screen, which only
   * the caller can see (see `useDismissOnClickOff`).
   */
  anchorRef: RefObject<HTMLDivElement | null>;
  /** Placement of the pop-up, measured by the caller's `usePopupPlacement`. */
  placement: { direction: 'up' | 'down'; maxHeight: number };
  /**
   * The pop-up element's ref. Only the `crumb` variant needs it: that pop-up is
   * PORTALLED to the body, so it is not inside `anchorRef` and the caller's
   * click-off dismissal would treat a press on the list as a press outside —
   * closing it on pointer-down, before the click could ever reach an option.
   * The caller must register this alongside `anchorRef`.
   */
  popupRef?: RefObject<HTMLDivElement | null>;
  /** `data-testid` for the pill; the pop-up's ids are shared between callers. */
  testId: string;
  /**
   * `crumb` renders the pill as a header breadcrumb segment — the readout and
   * the control are one thing there (spec/14 § Chat panel header).
   */
  variant?: 'pill' | 'crumb';
  disabled?: boolean;
  placeholder?: string;
  /**
   * A line printed above the list, e.g. which turn a change will affect. The
   * chat header uses it while a turn is running; presenting a switch as instant
   * would misdescribe the reply streaming underneath it.
   */
  note?: string | null;
  /**
   * True while a chosen model is awaiting the host's confirmation. The pill
   * already reads the chosen model (the caller passes it as `selected`); this
   * only marks it as not-yet-settled.
   */
  pending?: boolean;
}

export function ModelPicker({
  selected,
  onSelect,
  open,
  onToggle,
  anchorRef,
  placement,
  popupRef,
  testId,
  variant = 'pill',
  disabled = false,
  placeholder = 'Choose a model…',
  note = null,
  pending = false,
}: ModelPickerProps): JSX.Element {
  // The selectable models are LIVE: loaded from the host's catalogue, which
  // reads the backend's model list. NO baked-in array — that is what let the
  // picker go stale.
  const catalog = useModelCatalog();
  // A failed load carries the host's code (`oauth_unavailable`, `upstream`).
  // The pop-up reads the sentence; the code stays one click down.
  const problem = humaniseError({ code: catalog.error }, 'models');
  // An id with no matching option (a model retired since the chat started, or
  // the catalogue not loaded yet) shows the raw id — surfaced, never silently
  // blanked.
  const label =
    selected === null
      ? placeholder
      : (catalog.models.find((m) => m.id === selected)?.label ?? selected);

  // The crumb variant's pop-up is rendered into the document body, not next to
  // its anchor. The chat header's crumb zone is `overflow: hidden` (it
  // ellipsises a long folder path) and sits below the monitor bar in the
  // stacking order, so an in-flow absolutely-positioned pop-up there is both
  // clipped by its own container and painted over — the list opened and could
  // not be clicked. A portal escapes both, and the anchor's measured rect keeps
  // it pinned to the crumb.
  const portalled = variant === 'crumb';
  const [anchorRect, setAnchorRect] = useState<{
    left: number;
    top: number;
    bottom: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!portalled || !open) return;
    function measure(): void {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchorRect({ left: r.left, top: r.top, bottom: r.bottom });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [portalled, open, anchorRef]);

  const popup = !open ? null : (
    <div
      ref={popupRef}
      className={`model-popup place-${placement.direction} ${portalled ? 'is-portalled' : ''}`}
      style={
        portalled && anchorRect !== null
          ? placement.direction === 'down'
            ? {
                maxHeight: placement.maxHeight,
                position: 'fixed',
                left: anchorRect.left,
                top: anchorRect.bottom + 4,
              }
            : {
                // Anchored by `bottom`, not `top`: a list shorter than the
                // measured `maxHeight` would otherwise render full-height from
                // the top of that space down, leaving a gap between the popup
                // and its anchor (see UsagePopover). Bottom-anchoring lets the
                // box shrink-wrap its content and grow upward FROM the anchor;
                // `maxHeight` (never floored — see popupPlacement.ts) keeps its
                // top clear of the chat header.
                maxHeight: placement.maxHeight,
                position: 'fixed',
                left: anchorRect.left,
                bottom: window.innerHeight - anchorRect.top + 4,
              }
          : { maxHeight: placement.maxHeight }
      }
      data-testid="model-popup"
      role="listbox"
    >
      {note !== null ? (
        <div className="model-popup-note" data-testid="model-popup-note">
          {note}
        </div>
      ) : null}
      {catalog.status === 'error' ? (
        <div className="model-popup-status" data-testid="model-popup-error">
          <span>{problem.sentence}</span>
          <ErrorDetail detail={problem.detail} testId="model-popup-error-detail" />
        </div>
      ) : null}
      {catalog.status !== 'error' && catalog.models.length === 0 ? (
        <div className="model-popup-status" data-testid="model-popup-loading">
          Loading models…
        </div>
      ) : null}
      <ul className="model-popup-list">
        {catalog.models.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className={`model-option ${m.id === selected ? 'selected' : ''}`}
              data-testid={`model-option-${m.id}`}
              role="option"
              aria-selected={m.id === selected}
              onClick={() => onSelect(m.id)}
            >
              <span className="model-option-name">{m.label}</span>
              {m.id === selected ? (
                <span className="model-option-check" aria-hidden>
                  ✓
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  const trigger = (
    <div className={`model-picker ${variant === 'crumb' ? 'as-crumb' : ''}`} ref={anchorRef}>
      <button
        type="button"
        className={`model-pill ${variant === 'crumb' ? 'as-crumb' : ''} ${pending ? 'is-pending' : ''}`}
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="model"
        disabled={disabled}
        title={selected ?? undefined}
        onClick={onToggle}
      >
        <span className="model-pill-label mono">{label}</span>
        <span className="model-pill-caret" aria-hidden>
          ▾
        </span>
      </button>
      {portalled ? null : popup}
    </div>
  );

  return portalled ? (
    <>
      {trigger}
      {popup !== null ? createPortal(popup, document.body) : null}
    </>
  ) : (
    trigger
  );
}
