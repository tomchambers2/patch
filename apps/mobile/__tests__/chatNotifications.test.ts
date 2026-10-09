import { beforeEach, describe, expect, it } from 'vitest';
import * as Notifications from 'expo-notifications';
import { dismissChatNotifications } from '../src/lib/chatNotifications';

const stub = Notifications as unknown as {
  __setPresented(l: unknown[]): void;
  __getDismissed(): string[];
  __clearDismissed(): void;
};
const n = (identifier: string, chatId: unknown) => ({
  request: { identifier, content: { data: { chatId } } },
});

describe('dismissChatNotifications', () => {
  beforeEach(() => {
    stub.__clearDismissed();
    stub.__setPresented([]);
  });

  it('dismisses only the notifications for that chat', async () => {
    stub.__setPresented([n('a', 'c1'), n('b', 'c2'), n('c', 'c1'), n('d', undefined)]);
    expect(await dismissChatNotifications('c1')).toBe(2);
    expect(stub.__getDismissed().sort()).toEqual(['a', 'c']);
  });

  it('does nothing when the shade has none for the chat', async () => {
    stub.__setPresented([n('b', 'c2')]);
    expect(await dismissChatNotifications('c1')).toBe(0);
    expect(stub.__getDismissed()).toEqual([]);
  });
});
