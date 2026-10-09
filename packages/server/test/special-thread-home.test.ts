// spec/06 § Where special threads run — the Manager and Speakers belong to the
// home machine. A copy another machine still carries is not the account's.

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { encode, type WireEvent } from '@patch/wire';
import { InboundDaemonLink } from '../src/daemon-link.js';

class FakeSocket extends EventEmitter {
  send(): void {}
  close(): void {
    this.emit('close');
  }
}

const frame = (chatId: string): Buffer =>
  Buffer.from(
    encode({
      type: 'chat.message',
      chatId,
      role: 'assistant',
      content: 'hi',
      seq: 1,
    } as WireEvent),
  );

describe('special threads come only from the home machine', () => {
  function setup(home: string | null) {
    const link = new InboundDaemonLink({
      logger: pino({ level: 'silent' }),
      homeDaemonId: () => home,
    });
    const heard: Array<[string, string | null]> = [];
    link.onEvent((e, from) => {
      if (e.type === 'chat.message') heard.push([e.chatId, from]);
    });
    const sockets = { home: new FakeSocket(), other: new FakeSocket() };
    link.attach(sockets.home as never, 'home');
    link.attach(sockets.other as never, 'other');
    return { heard, sockets };
  }

  it('passes on the Manager and Speakers from the home machine only', () => {
    const { heard, sockets } = setup('home');
    sockets.home.emit('message', frame('thread_manager'));
    sockets.other.emit('message', frame('thread_manager'));
    sockets.other.emit('message', frame('thread_speakers'));
    sockets.home.emit('message', frame('thread_speakers'));
    expect(heard).toEqual([
      ['thread_manager', 'home'],
      ['thread_speakers', 'home'],
    ]);
  });

  it('still passes on every ordinary chat from any machine', () => {
    const { heard, sockets } = setup('home');
    sockets.other.emit('message', frame('chat-1'));
    sockets.home.emit('message', frame('chat-2'));
    expect(heard).toEqual([
      ['chat-1', 'other'],
      ['chat-2', 'home'],
    ]);
  });

  it('drops nothing while no home machine is known', () => {
    const { heard, sockets } = setup(null);
    sockets.other.emit('message', frame('thread_manager'));
    expect(heard).toEqual([['thread_manager', 'other']]);
  });

  it('follows the host that stands in for the home machine, not the home machine', () => {
    const link = new InboundDaemonLink({
      logger: pino({ level: 'silent' }),
      homeDaemonId: () => 'home',
      specialThreadHost: () => 'other',
    });
    const heard: Array<[string, string | null]> = [];
    link.onEvent((e, from) => {
      if (e.type === 'chat.message') heard.push([e.chatId, from]);
    });
    const home = new FakeSocket();
    const other = new FakeSocket();
    link.attach(home as never, 'home');
    link.attach(other as never, 'other');
    home.emit('message', frame('thread_manager'));
    other.emit('message', frame('thread_manager'));
    expect(heard).toEqual([['thread_manager', 'other']]);
  });
});
