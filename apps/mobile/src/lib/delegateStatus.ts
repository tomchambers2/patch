// spec/15 § Chat detail — Delegate tool row: the status pill's label/colour,
// shared between the chat screen's tool row and the pushed transcript screen
// so the two never drift (same status, same word, same colour).

import type { DelegateUpdateInfo } from '../stores/chatStore';
import type { ThemeColors } from './theme';

export const DELEGATE_STATUS_LABEL: Record<DelegateUpdateInfo['status'], string> = {
  running: 'Running',
  'awaiting-permission': 'Awaiting permission',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

export function delegateStatusColor(
  status: DelegateUpdateInfo['status'],
  colors: ThemeColors,
): string {
  if (status === 'running' || status === 'awaiting-permission') return colors.waiting;
  if (status === 'failed') return colors.red;
  return colors.ink3;
}
