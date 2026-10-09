// Reading a chat clears its notifications (spec/09 § Notification actions
// sits alongside): every notification still in the shade whose push `data`
// names this chat is dismissed, so the shade never holds a stale alert for
// something already seen.

import * as Notifications from 'expo-notifications';

export async function dismissChatNotifications(chatId: string): Promise<number> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  const mine = presented.filter((n) => n.request.content.data?.['chatId'] === chatId);
  await Promise.all(mine.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)));
  return mine.length;
}
