// spec/04 § Moving a chat to another host, spec/14 § Chat panel header — the
// Move dialog: pick the machine, get its folder with the same name offered,
// and a refusal keeps the dialog open with the server's own reason.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MoveChatModal } from '../components/MoveChatModal.js';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';
import { api, ApiError } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

vi.mock('../api/rest.js', async (orig) => {
  const real = await orig<typeof import('../api/rest.js')>();
  return { ...real, api: { moveChat: vi.fn() } };
});

function host(daemonId: string, hostName: string, online: boolean, recent: string[]): HostPresence {
  return {
    daemonId,
    online,
    lastSeenAt: null,
    host: { hostName } as HostPresence['host'],
    accounts: {},
    claudeSettings: null,
    folders: { roots: [], recent },
  };
}

const row = { chatId: 'c1', daemonId: 'mac', folder: '/Users/tom/wpp/Unite' } as ChatRow;

describe('MoveChatModal', () => {
  beforeEach(() => {
    usePresenceStore.setState({
      hosts: {
        mac: host('mac', 'Mac', true, ['/Users/tom/wpp/Unite']),
        box: host('box', 'Hetzner', true, ['/home/tom/projects', '/home/tom/Unite']),
        pi: host('pi', 'Pi', false, []),
      },
    });
    vi.mocked(api.moveChat).mockReset();
  });
  afterEach(() => cleanup());

  it('offers the other machines, the online one chosen, with its same-named folder filled in', () => {
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    expect(screen.getByTestId('move-chat-from').textContent).toBe('Mac · /Users/tom/wpp/Unite');
    expect(screen.queryByTestId('move-chat-host-mac')).toBeNull();
    expect(screen.getByTestId('move-chat-host-box').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('move-chat-host-pi') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
      '/home/tom/Unite',
    );
  });

  it('moves to the chosen machine and folder, then closes', async () => {
    vi.mocked(api.moveChat).mockResolvedValue({
      ok: true,
      chatId: 'c1',
      daemonId: 'box',
      folder: '/home/tom/Unite',
    });
    const onClose = vi.fn();
    render(<MoveChatModal row={row} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('move-chat-confirm'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.moveChat).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite');
  });

  it('a refusal stays open and says why', async () => {
    vi.mocked(api.moveChat).mockRejectedValue(
      new ApiError(409, 'busy', { error: 'busy', message: 'Mac: this chat is mid-turn' }),
    );
    const onClose = vi.fn();
    render(<MoveChatModal row={row} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('move-chat-confirm'));
    expect((await screen.findByTestId('move-chat-error')).textContent).toBe(
      'Mac: this chat is mid-turn',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with no folder of that name, the first folder the machine offers is selected', () => {
    usePresenceStore.setState({
      hosts: {
        mac: host('mac', 'Mac', true, []),
        box: host('box', 'Hetzner', true, ['/home/tom/projects', '/home/tom/other']),
      },
    });
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
      '/home/tom/projects',
    );
    expect((screen.getByTestId('move-chat-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('with no folders at all, Move waits for a typed one', () => {
    usePresenceStore.setState({
      hosts: { mac: host('mac', 'Mac', true, []), box: host('box', 'Hetzner', true, []) },
    });
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('move-chat-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('move-chat-folder'), { target: { value: '/srv/unite' } });
    expect((screen.getByTestId('move-chat-confirm') as HTMLButtonElement).disabled).toBe(false);
  });
});
