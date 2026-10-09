import { describe, it, expect } from 'vitest';
import { usePresenceStore } from '../stores/presenceStore.js';

describe('presenceStore.hostsSeeded', () => {
  it('is false until setHosts seeds the roster, even an empty one', () => {
    usePresenceStore.setState({ hostsSeeded: false, hosts: {} });
    expect(usePresenceStore.getState().hostsSeeded).toBe(false);
    usePresenceStore.getState().setHosts([]);
    expect(usePresenceStore.getState().hostsSeeded).toBe(true);
  });
});
