// Tiny helpers for computed UI bits — used by row & header components.

import type { ChatRow, DisplayBadge } from '../stores/types';
import type { ThemeColors } from './theme';

// Status-dot colour by badge state, drawn from the ACTIVE palette so the dot
// tracks light/dark: working/done use the leaf accent, permission the waiting
// amber, errored the danger red, background/monitoring/read the muted ink-3
// (same grey web draws all three in — see spec/14-design-web.md § Status
// badges — only the glyph tells them apart).
export function badgeColor(b: DisplayBadge, colors: ThemeColors): string {
  switch (b) {
    case 'working':
      return colors.leaf;
    case 'done':
      return colors.leaf;
    case 'permission':
      return colors.waiting;
    case 'errored':
      return colors.red;
    case 'background':
    case 'monitoring':
    case 'read':
      return colors.ink3;
  }
}

export function previewLine(row: ChatRow): string {
  if (row.preview) return row.preview;
  if (row.activity === 'awaiting-permission') return 'waiting on you';
  if (row.activity === 'running') return '…';
  return '';
}
