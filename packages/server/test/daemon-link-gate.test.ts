// The gate every frame from a host passes through before any handler sees it
// (the server queue uses it to keep a chat that still has messages waiting from
// looking finished), on the real inbound link and on the in-process stand-in.

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { encode, type WireEvent } from '@patch/wire';
import { InboundDaemonLink, InProcessDaemonLink } from '../src/daemon-link.js';

class FakeSocket extends EventEmitter {
  send(): void {}
  close(): void {
    this.emit('close');
  }
}

const say = (content: string): WireEvent =>
  ({ type: 'chat.message', chatId: 'c1', role: 'assistant', content, seq: 1 }) as WireEvent;

describe("the inbound link's event gate", () => {
  function setup() {
    const link = new InboundDaemonLink({ logger: pino({ level: 'silent' }) });
    const heard: string[] = [];
    link.onEvent((e) => {
      if (e.type === 'chat.message') heard.push(e.content);
    });
    const socket = new FakeSocket();
    link.attach(socket as never, 'd1');
    return { link, heard, socket };
  }
  const frame = (e: WireEvent): Buffer => Buffer.from(encode(e));

  it('passes every frame on while no gate is set', () => {
    const { heard, socket } = setup();
    socket.emit('message', frame(say('a')));
    expect(heard).toEqual(['a']);
  });

  it('passes on the frame the gate returns, which may be a changed copy', () => {
    const { link, heard, socket } = setup();
    link.setEventGate((e) => (e.type === 'chat.message' ? { ...e, content: 'changed' } : e));
    socket.emit('message', frame(say('a')));
    expect(heard).toEqual(['changed']);
  });

  it('drops a frame the gate returns null for, and tells the gate where it came from', () => {
    const { link, heard, socket } = setup();
    const from: Array<string | null> = [];
    link.setEventGate((e, f) => {
      from.push(f);
      return e.type === 'chat.message' && e.content === 'drop me' ? null : e;
    });
    socket.emit('message', frame(say('drop me')));
    socket.emit('message', frame(say('keep me')));
    expect(heard).toEqual(['keep me']);
    expect(from).toEqual(['d1', 'd1']);
  });

  it('does not gate a frame injected from inside the server', () => {
    const { link, heard } = setup();
    link.setEventGate(() => null);
    link.injectDaemonEvent(say('injected'));
    expect(heard).toEqual(['injected']);
  });
});

describe("the in-process link's event gate", () => {
  it('passes a frame on, changed, or drops it, and tells the gate the sender', () => {
    const link = new InProcessDaemonLink();
    const heard: string[] = [];
    link.onEvent((e) => {
      if (e.type === 'chat.message') heard.push(e.content);
    });
    link.emit(say('before any gate'));
    const from: Array<string | null> = [];
    link.setEventGate((e, f) => {
      from.push(f);
      if (e.type !== 'chat.message') return e;
      return e.content === 'drop me' ? null : { ...e, content: `${e.content}!` };
    });
    link.emit(say('drop me'));
    link.emit(say('hello'), 'd7');
    expect(heard).toEqual(['before any gate', 'hello!']);
    expect(from).toEqual(['d1', 'd7']);
  });

  it('injects past the gate', () => {
    const link = new InProcessDaemonLink();
    const heard: string[] = [];
    link.onEvent((e) => {
      if (e.type === 'chat.message') heard.push(e.content);
    });
    link.setEventGate(() => null);
    link.injectDaemonEvent(say('injected'));
    expect(heard).toEqual(['injected']);
  });

  it('dropOnlineHost takes an extra host offline, and ignores one it never had', () => {
    const link = new InProcessDaemonLink();
    const seen: string[] = [];
    link.onHostStatus((id, s) => seen.push(`${id}:${s}`));
    link.addOnlineHost('d2');
    link.dropOnlineHost('nobody');
    link.dropOnlineHost('d2');
    expect(seen).toEqual(['d2:online', 'd2:offline']);
    expect(link.isOnline('d2')).toBe(false);
  });
});
