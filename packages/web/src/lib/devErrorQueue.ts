// devErrorQueue — dev-mode only error accumulator.
//
// Captures every unhandled error (window.onerror), unhandled promise
// rejection (window.onunhandledrejection) and console.error call into an
// in-memory queue so they can be inspected during dev testing without
// disappearing into the console scroll.
//
// Gated on import.meta.env.DEV — the module exports a no-op install() in
// production, and the overlay component never renders outside dev mode.
// Nothing here is imported in the production bundle path (main.tsx never
// imports this; it is pulled in only by dev-harness.tsx).

export interface DevError {
  at: number;
  type: 'onerror' | 'unhandledrejection' | 'console.error';
  message: string;
}

// The queue is a module-level array so any component can read it.
// Subscribers are notified via a custom event so React components can re-render.
const queue: DevError[] = [];

const NOTIFY_EVENT = 'patch:dev-error';

export function getDevErrors(): readonly DevError[] {
  return queue;
}

export function clearDevErrors(): void {
  queue.length = 0;
  window.dispatchEvent(new Event(NOTIFY_EVENT));
}

function push(entry: DevError): void {
  queue.push(entry);
  window.dispatchEvent(new Event(NOTIFY_EVENT));
}

/** Subscribe to queue changes. Returns an unsubscribe function. */
export function onDevErrors(cb: () => void): () => void {
  window.addEventListener(NOTIFY_EVENT, cb);
  return () => window.removeEventListener(NOTIFY_EVENT, cb);
}

let installed = false;

/**
 * Install the dev error collectors. Call once at harness boot (dev-harness.tsx).
 * No-op if import.meta.env.DEV is false — the production build tree-shakes this
 * out entirely because the condition is a compile-time constant.
 */
export function installDevErrorQueue(): void {
  if (!import.meta.env.DEV) return;
  if (installed) return;
  installed = true;

  // 1. Unhandled synchronous errors.
  const prevOnError = window.onerror;
  window.onerror = (message, _source, _lineno, _colno, error) => {
    push({
      at: Date.now(),
      type: 'onerror',
      message: error?.message ?? String(message),
    });
    if (typeof prevOnError === 'function') {
      return prevOnError.call(window, message, _source, _lineno, _colno, error);
    }
    return false;
  };

  // 2. Unhandled promise rejections.
  const prevOnUnhandledRejection = window.onunhandledrejection;
  window.onunhandledrejection = (event) => {
    const reason: unknown = event.reason;
    push({
      at: Date.now(),
      type: 'unhandledrejection',
      message: reason instanceof Error ? reason.message : String(reason),
    });
    if (typeof prevOnUnhandledRejection === 'function') {
      prevOnUnhandledRejection.call(window, event);
    }
  };

  // 3. console.error — wrap, not replace, so the real console still logs.
  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origConsoleError(...args);
    const message = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : String(a)))
      .join(' ');
    push({ at: Date.now(), type: 'console.error', message });
  };
}

/** Reset install state — for testing only. */
export function _resetInstallState(): void {
  installed = false;
}
