const _listeners = new Map<string, Set<(payload: never) => void>>();

const RNCallKeep = {
  async setup(): Promise<void> {},
  setAvailable(): void {},
  displayIncomingCall(): void {},
  endCall(): void {},
  endAllCalls(): void {},
  answerIncomingCall(): void {},
  rejectCall(): void {},
  addEventListener(event: string, cb: (payload: never) => void): void {
    let set = _listeners.get(event);
    if (!set) {
      set = new Set();
      _listeners.set(event, set);
    }
    set.add(cb);
  },
  removeEventListener(event: string, cb?: (payload: never) => void): void {
    if (cb) _listeners.get(event)?.delete(cb);
    else _listeners.delete(event);
  },
};
export default RNCallKeep;

/** Test helper: fire a fake CallKeep native event (e.g. 'answerCall'). */
export function __emitCallKeepEvent(event: string, payload: unknown): void {
  for (const cb of _listeners.get(event) ?? []) (cb as (p: unknown) => void)(payload);
}
export function __resetCallKeepListeners(): void {
  _listeners.clear();
}
