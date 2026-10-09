// Test helper: let the fake host ANSWER the fires it was handed.
//
// spec/08-triggers-and-jobs.md ## Execution model step 6 — the server writes a
// run "filling the chatId and the outcome from the events that host emits back
// through it — `chat.spawned` for a fire that landed, the host's own error
// (`folder_not_found` and the like) for one that did not."
//
// So a dispatched fire has NO run entry until its host says what happened. A
// test that asserts an `ok` run has to make the host answer first — which is
// the point: an `ok` that needs no host is exactly the lie this helper's
// absence used to hide.

import type { InProcessDaemonLink } from '../src/daemon-link.js';

/**
 * Answer every fire on the link as a host that took it successfully:
 * `chat.spawned` for a spawn, `chat.input_ack` for an input. Idempotent —
 * already-settled fires are ignored, so it is safe to call after each step.
 */
export function hostConfirms(link: InProcessDaemonLink): void {
  for (const s of link.sent) {
    if (s.event.type === 'chat.spawn_request' && s.event.chatId) {
      link.emit({
        type: 'chat.spawned',
        chatId: s.event.chatId,
        daemonId: s.event.daemonId,
        folder: s.event.folder,
      });
    } else if (s.event.type === 'chat.input') {
      link.emit({
        type: 'chat.input_ack',
        chatId: s.event.chatId,
        localId: s.event.localId,
      });
    }
  }
}

/**
 * Answer the most recent spawn as a host that REFUSED it (the folder is not on
 * that machine), so the run lands as `dispatch-error` naming the host.
 */
export function hostRefusesLastSpawn(link: InProcessDaemonLink, message: string): void {
  for (let i = link.sent.length - 1; i >= 0; i--) {
    const e = link.sent[i]?.event;
    if (e && e.type === 'chat.spawn_request' && e.chatId) {
      link.emit({
        type: 'chat.error',
        chatId: e.chatId,
        error: { code: 'folder_not_found', message },
        seq: -1,
      });
      return;
    }
  }
}
