// Expo push backend (group 11) — posts to Expo's push API. No server
// credential: the FCM V1 service-account key that actually reaches Android
// devices is uploaded once to the EAS project by the app publisher (Expo
// holds it, not this server), so a self-hosted server needs nothing in its
// own env to wake the phone.

import type { PushBackend, PushPayload } from './router.js';

/**
 * The Android channel and bundled sound an urgent push plays (spec/09 §
 * Reaching the user). Both are created by the app
 * (`apps/mobile/src/lib/push.ts`, `app.config.ts` `sounds`); a phone on an
 * APK that predates them shows the push on its default channel with the
 * ordinary sound.
 */
export const URGENT_CHANNEL_ID = 'patch_urgent_alert';
export const URGENT_SOUND = 'patch_urgent';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo's documented cap on messages per request — chunk anything larger. */
const MAX_MESSAGES_PER_REQUEST = 100;

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  priority?: 'default' | 'high';
  channelId?: string;
  sound?: 'default' | null;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Expo-push-API-backed PushBackend. One HTTP call per chunk of up to 100
 * tokens — no SDK, no client to construct, no credential.
 */
export class ExpoPushBackend implements PushBackend {
  async send(
    tokens: string[],
    payload: PushPayload,
  ): Promise<{ delivered: number; failed: string[]; permanentlyRejected: string[] }> {
    if (tokens.length === 0) return { delivered: 0, failed: [], permanentlyRejected: [] };

    // The channel is what actually decides whether an Android notification
    // makes a noise, so a silent push cannot buzz whatever its priority.
    // `priority` decides whether the phone is woken at all: a 'default' FCM
    // message is held for the next Doze maintenance window, which is exactly
    // when the user is away from the computer and the phone is idle in a
    // pocket. Every rung therefore goes at 'high'.
    const channelFields: Pick<ExpoPushMessage, 'channelId' | 'sound'> = payload.silent
      ? { channelId: 'patch_quiet', sound: null }
      : payload.urgentSound
        ? { channelId: URGENT_CHANNEL_ID, sound: 'default' }
        : {};

    let delivered = 0;
    const failed: string[] = [];
    const permanentlyRejected: string[] = [];

    for (let i = 0; i < tokens.length; i += MAX_MESSAGES_PER_REQUEST) {
      const chunk = tokens.slice(i, i + MAX_MESSAGES_PER_REQUEST);
      const messages: ExpoPushMessage[] = chunk.map((to) => ({
        to,
        title: payload.title,
        body: payload.body,
        ...(payload.data ? { data: payload.data } : {}),
        priority: 'high',
        ...channelFields,
      }));
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        throw new Error(`Expo push API returned ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as { data?: ExpoPushTicket[] };
      const tickets = body.data ?? [];
      tickets.forEach((ticket, idx) => {
        const token = chunk[idx];
        if (!token) return;
        if (ticket.status === 'ok') {
          delivered += 1;
          return;
        }
        failed.push(token);
        // A permanently-dead token must be pruned from the registry so it is
        // never re-attempted (spec/09: no retry queue). Expo's stable
        // permanent-rejection code for a token whose app was uninstalled /
        // has expired is `DeviceNotRegistered`. Every other error
        // (`MessageTooBig`, `MessageRateExceeded`, `InvalidCredentials`, or
        // none at all) is transient/operator-fixable and NOT pruned.
        if (ticket.details?.error === 'DeviceNotRegistered') {
          permanentlyRejected.push(token);
        }
      });
    }
    return { delivered, failed, permanentlyRejected };
  }
}
