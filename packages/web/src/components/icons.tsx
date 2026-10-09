import { X } from 'lucide-react';
import type { JSX } from 'react';

/**
 * Shared delete / close glyphs — the single source of truth for the app's
 * destructive-action and dismiss icons (spec/14-design-web.md § Icons).
 *
 * These controls used to render at a jumble of sizes (12, 13, 14, 16, 18, 20
 * and even a bare "×" text node), so a bin here and an × there never read the
 * same. They now share ONE generous size and come from this module, so every
 * delete/close control is consistent, comfortably large, and easy to hit.
 */
export const CLOSE_ICON_SIZE = 18;
export const DELETE_ICON_SIZE = 18;

/**
 * Dismiss / close glyph — banners, dialogs, chips, the file-editor toolbar.
 * A consistent, slightly heavier lucide × so it reads clearly at any size.
 * Decorative: the accessible name lives on the wrapping button.
 */
export function CloseIcon({
  size = CLOSE_ICON_SIZE,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return <X size={size} strokeWidth={2.5} aria-hidden className={className} />;
}

/**
 * Destructive-delete glyph — a friendlier "bin" than the flat lucide Trash2:
 * a lidded can with a jaunty raised lid, a little handle, and two ribs. A more
 * fun, more legible mark for a delete action. Bespoke SVG on purpose (not
 * lucide) — the `data-icon` marker makes that explicit.
 */
export function DeleteIcon({
  size = DELETE_ICON_SIZE,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-icon="delete-bin"
      className={className}
    >
      {/* Lid — a full-width bar across the top */}
      <line x1="4" y1="6.5" x2="20" y2="6.5" />
      {/* Lid handle — a friendly rounded tab */}
      <path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5 -1.5h2A1.5 1.5 0 0 1 14.5 5v1.5" />
      {/* Can body — gently tapering with a rounded base */}
      <path d="M6 6.5l1.2 12a2 2 0 0 0 2 1.8h5.6a2 2 0 0 0 2 -1.8l1.2 -12" />
      {/* Ribs */}
      <line x1="10" y1="10.5" x2="10.3" y2="16.5" />
      <line x1="14" y1="10.5" x2="13.7" y2="16.5" />
    </svg>
  );
}
