import { describe, it, expect, beforeEach } from 'vitest';
import {
  RELAY_ORIGIN,
  apiUrl,
  audioWsUrl,
  clearRoute,
  getRoute,
  getServerUrl,
  routeLabel,
  setRoute,
  wsUrl,
} from '../src/config';
import { TEST_SERVER_URL, __clearAllMmkv } from './stubs/mmkv';

beforeEach(() => {
  __clearAllMmkv();
});

describe('the route to the server (spec/05 § Canonical QR payload — the app has no server built in)', () => {
  it('is whatever pairing set, and asking before there is one throws instead of aiming somewhere', () => {
    clearRoute();
    expect(getRoute()).toBeNull();
    expect(() => getServerUrl()).toThrow(/not paired/);
    expect(() => apiUrl('/api/x')).toThrow(/not paired/);
    expect(routeLabel()).toBe('not paired');
  });

  it('keeps a direct server across restarts, trimmed of a trailing slash', () => {
    setRoute({ kind: 'direct', url: ' https://patch.example.com/ ' });
    expect(getRoute()).toEqual({ kind: 'direct', url: 'https://patch.example.com' });
    expect(getServerUrl()).toBe('https://patch.example.com');
    expect(routeLabel()).toBe('patch.example.com');
  });

  it('refuses an address that is not http(s) rather than producing dead URLs', () => {
    expect(() => setRoute({ kind: 'direct', url: 'ftp://nope.test' })).toThrow(/http/);
    expect(getServerUrl()).toBe(TEST_SERVER_URL);
  });

  it('addresses a relayed server to the placeholder the transport carries', () => {
    setRoute({
      kind: 'relay',
      relay: { url: 'wss://relay.example.com', channel: 'c', serverKey: 'k' },
    });
    expect(getServerUrl()).toBe(RELAY_ORIGIN);
    expect(apiUrl('/api/x')).toBe(`${RELAY_ORIGIN}/api/x`);
    expect(wsUrl()).toBe(`wss://relay.patch.invalid/ws`);
    expect(routeLabel()).toBe('through relay.example.com');
  });
});

describe('urls', () => {
  it('apiUrl prepends the server', () => {
    expect(apiUrl('/api/foo')).toBe(`${TEST_SERVER_URL}/api/foo`);
  });

  it('apiUrl rejects relative paths', () => {
    expect(() => apiUrl('api/foo')).toThrow();
  });

  it('wsUrl flips https→wss and http→ws', () => {
    expect(wsUrl()).toBe('wss://patch.test/ws');
    setRoute({ kind: 'direct', url: 'http://localhost:3000' });
    expect(wsUrl()).toBe('ws://localhost:3000/ws');
  });

  it('audioWsUrl resolves an /audio path against the server, same scheme rules', () => {
    expect(audioWsUrl('/audio/s1')).toBe('wss://patch.test/audio/s1');
    setRoute({ kind: 'direct', url: 'http://localhost:3000' });
    expect(audioWsUrl('/audio/s1')).toBe('ws://localhost:3000/audio/s1');
    expect(() => audioWsUrl('audio/s1')).toThrow(/must start with/);
  });

  it('audio can be aimed straight at a host in local dev', () => {
    process.env['EXPO_PUBLIC_PATCH_AUDIO_URL'] = 'http://localhost:3013';
    try {
      expect(audioWsUrl('/audio/s1')).toBe('ws://localhost:3013/audio/s1');
      process.env['EXPO_PUBLIC_PATCH_AUDIO_URL'] = 'ftp://bad.test';
      expect(() => audioWsUrl('/audio/s1')).toThrow(/unknown scheme/);
    } finally {
      delete process.env['EXPO_PUBLIC_PATCH_AUDIO_URL'];
    }
  });
});
