// The Manager view's "carry on" action (spec/14 § Manager view).
//
// Delivers a `continue` user turn to a stopped chat over the live socket, so a
// thread can be pushed onward from the Threads strip without opening it. Per
// the portfolio "no fallbacks" rule it returns `false` — never a silent
// success — when there is no socket to send on.

import { getActiveWs } from '../api/ws.js';

export function nudgeContinue(chatId: string): boolean {
  const ws = getActiveWs();
  if (!ws) return false;
  const localId = `mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ws.send({ type: 'chat.input', chatId, message: 'continue', localId });
  return true;
}
