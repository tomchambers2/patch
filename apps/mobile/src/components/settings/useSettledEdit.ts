// Waiting for a host to answer a Claude Code settings edit (settings.json, a
// memory's text, a memory's deletion). The host answers a good edit with a
// fresh `claude_settings.updated` snapshot and refuses a bad one with an
// out-of-band error (hostRefusalStore); neither is addressed to the frame, so
// the edit is settled by whichever lands first after it was sent. No answer
// inside the window is said as unknown — the frame went out and may still
// apply — never as a failure.

import React from 'react';
import { useHostRefusalStore } from '../../stores/hostRefusalStore';
import { CLAUDE_ACK_TIMEOUT_MS } from './accountRows';

export function useSettledEdit<A extends string>(
  /** The host's current snapshot; a new object means the host has answered. */
  current: unknown,
  /** The host's name, for the no-answer line. */
  label: string,
  onSettled: (action: A) => void,
): {
  waiting: A | null;
  problem: string | null;
  start: (action: A) => void;
  clearProblem: () => void;
} {
  const [waiting, setWaiting] = React.useState<{ action: A; at: number; snapshot: unknown } | null>(
    null,
  );
  const [problem, setProblem] = React.useState<string | null>(null);
  const refusal = useHostRefusalStore((s) => s.last);
  const labelRef = React.useRef(label);
  labelRef.current = label;
  const settledRef = React.useRef(onSettled);
  settledRef.current = onSettled;

  React.useEffect(() => {
    if (!waiting) return;
    if (refusal && refusal.at >= waiting.at && refusal.code === 'claude_settings_invalid') {
      setWaiting(null);
      setProblem(refusal.message);
      return;
    }
    if (current !== waiting.snapshot) {
      setWaiting(null);
      settledRef.current(waiting.action);
    }
  }, [waiting, refusal, current]);

  // Its own effect, keyed on the wait alone, so heartbeats and unrelated
  // refusals never restart the window.
  React.useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setWaiting(null);
      setProblem(
        `${labelRef.current} sent no answer in ${CLAUDE_ACK_TIMEOUT_MS / 1000}s. It may still apply.`,
      );
    }, CLAUDE_ACK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  return {
    waiting: waiting?.action ?? null,
    problem,
    start: (action) => {
      setProblem(null);
      setWaiting({ action, at: Date.now(), snapshot: current });
    },
    clearProblem: () => setProblem(null),
  };
}
