// ws.ts dispatch: a `notify` frame on the desktop channel becomes a native OS
// toast (spec/09 § Chat completion + § `### desktop`).
//
// This is the renderer half of the desktop channel. The server fans the frame
// out to every connected `desktop` surface, but only Electron's main process
// can raise a real Notification — so the SPA hands it to the preload bridge.
// Without this dispatch arm the whole desktop channel is dead on arrival, which
// is what these tests pin down.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs } from '../api/ws.js';
import type { PatchDesktopBridge } from '../lib/desktopBridge.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  url: string;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  addEventListener(name: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener(): void {}
  emit(name: string, data: unknown): void {
    for (const cb of this.listeners[name] ?? []) cb(data as MessageEvent);
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

function notifyFrame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'notify',
    chatId: 'c1',
    channel: 'desktop',
    message: 'bed planner finished: planted the beds',
    ...over,
  };
}

/** Open a socket and hand back the fake the SPA is listening on. */
async function connect(): Promise<{ fake: FakeWS; close: () => void }> {
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  return { fake: FakeWS.instances[0]!, close: () => ws.close() };
}

describe('ws desktop notify → native toast', () => {
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
    notify = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { patch?: PatchDesktopBridge }).patch;
    vi.unstubAllGlobals();
  });

  /** Install an Electron preload bridge on the window, as the shell does. */
  function installBridge(bridge: Partial<PatchDesktopBridge> = { notify }): void {
    (window as unknown as { patch?: PatchDesktopBridge }).patch = bridge as PatchDesktopBridge;
  }

  it('shows the toast with the message and chat it came from', async () => {
    installBridge();
    const { fake, close } = await connect();
    fake.receive(notifyFrame());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      title: 'Patch',
      body: 'bed planner finished: planted the beds',
      chatId: 'c1',
    });
    close();
  });

  // spec/09 § Reaching the user — the shell picks the toast's sound from it.
  it('hands the rung to the shell so an urgent toast can sound urgent', async () => {
    installBridge();
    const { fake, close } = await connect();
    fake.receive(notifyFrame({ priority: 'urgent' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ priority: 'urgent' }));
    close();
  });

  it('strips markdown before it reaches the native toast (the OS renders it verbatim)', async () => {
    installBridge();
    const { fake, close } = await connect();
    fake.receive(notifyFrame({ message: '**Build finished** — see `deploy/logs`' }));
    expect(notify).toHaveBeenCalledWith({
      title: 'Patch',
      body: 'Build finished — see deploy/logs',
      chatId: 'c1',
    });
    close();
  });

  // spec/09 § Notification actions.
  it('hands actions through to the shell so it can show Reply/Approve-Deny/options', async () => {
    installBridge();
    const { fake, close } = await connect();
    fake.receive(notifyFrame({ actions: { kind: 'permission', requestId: 'r1' } }));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ actions: { kind: 'permission', requestId: 'r1' } }),
    );
    close();
  });

  it('omits actions from the toast payload when the frame carries none', async () => {
    installBridge();
    const { fake, close } = await connect();
    fake.receive(notifyFrame());
    expect(notify).toHaveBeenCalledWith(
      expect.not.objectContaining({ actions: expect.anything() }),
    );
    close();
  });

  it('does nothing in a plain browser, where there is no bridge at all', async () => {
    const { fake, close } = await connect();
    expect(() => fake.receive(notifyFrame())).not.toThrow();
    expect(notify).not.toHaveBeenCalled();
    close();
  });

  it('does nothing on an older shell whose bridge predates notify', async () => {
    // The shell OTAs separately from the web bundle, so a build without the
    // handler will be running against a server that already sends the frame.
    installBridge({ openChat: vi.fn() });
    const { fake, close } = await connect();
    expect(() => fake.receive(notifyFrame())).not.toThrow();
    close();
  });

  it('leaves the other notify channels to their own transports', async () => {
    installBridge();
    const { fake, close } = await connect();
    for (const channel of ['push', 'speakers']) {
      fake.receive(notifyFrame({ channel }));
    }
    expect(notify).not.toHaveBeenCalled();
    close();
  });
});
