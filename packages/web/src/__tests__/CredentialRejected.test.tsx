// A credential the server REJECTS must not trap the app (spec/10 § Surface).
//
// The boot gate only asked whether a credential was PRESENT. After an account
// was re-created, every surface still held a token for the old account: the gate
// saw a string, rendered the whole shell, and every request 401'd — the error
// bar blinking forever with no route back to sign-in, because the sign-in screen
// only appears when NO credential is stored.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PairingScreen } from '../components/PairingScreen.js';

describe('a rejected credential', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('the API announces a 401 so the shell can drop the credential', async () => {
    const heard: string[] = [];
    window.addEventListener('patch:credential-rejected', (e) =>
      heard.push((e as CustomEvent<string>).detail),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
      ),
    );
    const { api } = await import('../api/rest.js');
    await expect(api.me()).rejects.toThrow();
    expect(heard).toEqual(['unauthenticated']);
  });

  it('does NOT announce for other failures — only auth invalidates a credential', async () => {
    const heard: string[] = [];
    window.addEventListener('patch:credential-rejected', () => heard.push('x'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })),
    );
    const { api } = await import('../api/rest.js');
    await expect(api.me()).rejects.toThrow();
    expect(heard).toEqual([]);
  });

  it('the sign-in screen says the surface was signed out, rather than appearing unexplained', () => {
    render(<PairingScreen onPaired={() => {}} rejectedReason="unauthenticated" />);
    expect(screen.getByTestId('pairing-signed-out')).toHaveTextContent('signed out');
  });

  it('a first-ever sign-in shows no signed-out notice', () => {
    render(<PairingScreen onPaired={() => {}} />);
    expect(screen.queryByTestId('pairing-signed-out')).toBeNull();
  });
});

// The socket half of the same seam. A REST 401 already drops the credential and
// sends the app to sign-in — but a credential can be refused on the WEBSOCKET
// (hub close 4401 / `auth.revoked`) with no REST call in flight to notice. The
// client saw a closed socket, said "reconnecting", and dialled for ever against
// a server that had already refused it. Retrying cannot fix a refusal.
describe('a credential the socket is refused with', () => {
  it('announces the rejection, so the shell drops it and shows sign-in', async () => {
    const heard: string[] = [];
    window.addEventListener('patch:credential-rejected', (e) =>
      heard.push((e as CustomEvent<string>).detail),
    );
    const { PatchWs } = await import('../api/ws.js');
    const sockets: Array<{
      close: () => void;
      listeners: Record<string, Array<(e: unknown) => void>>;
    }> = [];
    class FakeWS {
      static OPEN = 1;
      readyState = 1;
      listeners: Record<string, Array<(e: unknown) => void>> = {};
      constructor() {
        sockets.push(this as never);
      }
      send(): void {}
      close(): void {}
      addEventListener(n: string, cb: (e: unknown) => void): void {
        (this.listeners[n] ??= []).push(cb);
      }
      removeEventListener(): void {}
      emit(n: string, e: unknown): void {
        for (const cb of this.listeners[n] ?? []) cb(e);
      }
    }
    vi.stubGlobal('WebSocket', FakeWS);

    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    const sock = sockets[sockets.length - 1] as unknown as FakeWS;
    sock.emit('open', {});
    const before = sockets.length;
    sock.emit('close', { code: 4401, reason: 'invalid credential' });

    expect(heard).toEqual(['invalid credential']);
    // And it stops dialling: a refusal is terminal.
    await new Promise((r) => setTimeout(r, 1200));
    expect(sockets.length).toBe(before);
  });
});
