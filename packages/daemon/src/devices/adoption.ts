// The five-minute voice-device adoption window (spec/16 § F2, spec/02
// § Control IPC, spec/17 § Commands).
//
// A physical speaker belongs to ONE machine, and it carries no account
// credential — so nothing in this exchange reaches the server. The machine's
// own command line opens a window on its own host; the first device to
// announce itself inside that window is recorded, and its control link is
// accepted from then on.
//
// The rules that matter, and why:
//   - The window is time-boxed. An always-open adoption would let any device on
//     the network claim a machine.
//   - Exactly ONE device per window. Otherwise a burst of announcements could
//     enrol several unattended.
//   - An announcement OUTSIDE a window is refused. Being previously adopted is
//     not a reason to accept a re-announcement with a new key.
//   - Re-pairing MOVES a device to another machine rather than duplicating it:
//     the machine that adopts it last owns it.

export const ADOPTION_WINDOW_MS = 5 * 60 * 1000;

export interface AdoptionWindow {
  opensAt: number;
  expiresAt: number;
}

export type AdoptionOutcome =
  | { adopted: true; deviceId: string }
  | { adopted: false; reason: string };

/**
 * The adoption window for ONE machine. Deliberately in-memory: a window is a
 * live, attended act — a person ran the command and is holding the device — and
 * must not survive a host restart.
 */
export class DeviceAdoption {
  private window: AdoptionWindow | null = null;
  private consumedBy: string | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs: number = ADOPTION_WINDOW_MS,
  ) {}

  /** Open (or re-open) the window. Re-running the command restarts the clock. */
  open(): AdoptionWindow {
    const opensAt = this.now();
    this.window = { opensAt, expiresAt: opensAt + this.windowMs };
    this.consumedBy = null;
    return this.window;
  }

  /** The live window, or null when none is open or the last one has expired. */
  current(): AdoptionWindow | null {
    if (!this.window) return null;
    if (this.now() >= this.window.expiresAt) return null;
    return this.window;
  }

  isOpen(): boolean {
    return this.current() !== null && this.consumedBy === null;
  }

  /**
   * A device announcing itself. Accepted only inside an open, unconsumed
   * window; the refusal says which of those it failed, because "nothing
   * happened" is the least debuggable outcome for someone holding a device.
   */
  announce(deviceId: string): AdoptionOutcome {
    const live = this.current();
    if (!live) {
      return {
        adopted: false,
        reason:
          'no adoption window is open on this machine — run `patch hosts pair-device` there first',
      };
    }
    if (this.consumedBy !== null) {
      // One window adopts one device. A second announcement inside the same
      // window is refused rather than silently replacing the first.
      return {
        adopted: false,
        reason:
          this.consumedBy === deviceId
            ? `device ${deviceId} was already adopted in this window`
            : `this window already adopted ${this.consumedBy}`,
      };
    }
    this.consumedBy = deviceId;
    return { adopted: true, deviceId };
  }

  /** Close the window without adopting (the command was cancelled). */
  close(): void {
    this.window = null;
    this.consumedBy = null;
  }
}
