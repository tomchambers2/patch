// Outgoing turns, from Send to delivery (spec/15 § Composer → Attachments).
//
// Sending reacts at once whatever the message carries: the turn is echoed into
// the stream the moment Send is pressed, and a turn with attachments shows its
// LOCAL files there, marked `Uploading done/total`, while they upload. Only once
// every upload has landed is the turn handed to `deliveryTracker.submit` (same
// localId as the bubble) — from there it is an ordinary send (spec/12 §
// Guaranteed input delivery). The agent never gets a turn missing some of its
// attachments.
//
// This lives here, not in the Composer, so an upload survives the composer
// unmounting — the user leaving the chat, or the new-chat screen replacing
// itself with the chat it just created — and so Retry / × work from the
// transcript.
//
// ORDER: turns reach delivery in the order they were sent, per chat. A turn
// sent behind one still uploading (text or attachments) is echoed at once but
// waits in that chat's chain. A FAILED upload leaves the chain — it must not
// hold up the turns behind it — and stays in the stream as `Not uploaded` with
// Retry (upload the same files again, then send; it rejoins the chain at the
// back) and × (discard). NO FALLBACK: nothing is dropped without the user
// discarding it, and every failure is toasted.

import type { AttachmentRef } from '@patch/wire';
import { api } from '../api/rest';
import { getWs } from '../api/ws';
import { useChatStore } from '../stores/chatStore';
import { useToolsStore } from '../stores/toolsStore';
import { useUiStore } from '../stores/uiStore';
import type { PendingAttachment } from '../stores/composerAttachmentStore';
import { deliveryTracker } from './deliveryTracker';
import { downscaleImage } from './imageResize';

interface Outgoing {
  chatId: string;
  localId: string;
  text: string;
  files: PendingAttachment[];
  /** The Tools panel's OFF set captured at SEND time (see deliveryTracker). */
  disabledTools: string[];
  /** The uploaded refs; `null` while the files are still uploading. */
  refs: AttachmentRef[] | null;
}

/** Per chat, the turns not yet handed to delivery, in send order. */
const chains = new Map<string, Outgoing[]>();
/** Turns whose upload failed, awaiting Retry or ×. */
const failed = new Map<string, Outgoing>();

let counter = 0;
const key = (chatId: string, localId: string): string => `${chatId} ${localId}`;

/**
 * Send a turn into `chatId`: echo it now, upload `files` (if any), deliver it
 * once everything ahead of it in the chat has. Returns the turn's localId.
 */
export function sendMessage(chatId: string, text: string, files: PendingAttachment[]): string {
  counter += 1;
  const localId = `m-${Date.now()}-${counter}`;
  const item: Outgoing = {
    chatId,
    localId,
    text,
    files,
    disabledTools: useToolsStore.getState().disabledFor(chatId),
    refs: files.length === 0 ? [] : null,
  };
  useChatStore.getState().appendLocalUserMessage(chatId, text, localId, undefined, {
    localAttachments: files.map((f) => ({
      uri: f.uri,
      name: f.name,
      mimeType: f.mimeType,
      kind: f.kind,
    })),
  });
  enqueue(item);
  return localId;
}

/** Retry: upload the same files again, then send (spec/15). */
export function retryUpload(chatId: string, localId: string): void {
  const item = failed.get(key(chatId, localId));
  if (!item) {
    // The files went with the process that picked them (the app restarted).
    // Say so rather than leave a Retry that does nothing.
    useUiStore
      .getState()
      .pushError(
        'attachment upload failed: the files are no longer available — discard and resend',
      );
    return;
  }
  failed.delete(key(chatId, localId));
  useChatStore.getState().patchLocalMessage(chatId, localId, {
    upload: { done: 0, total: item.files.length, failed: false },
  });
  enqueue(item);
}

/** ×: discard a turn whose upload failed. */
export function discardUpload(chatId: string, localId: string): void {
  failed.delete(key(chatId, localId));
  useChatStore.getState().removeLocalMessage(chatId, localId);
}

function enqueue(item: Outgoing): void {
  const chain = chains.get(item.chatId) ?? [];
  chain.push(item);
  chains.set(item.chatId, chain);
  if (item.refs === null) void upload(item);
  drain(item.chatId);
}

/** Hand every turn at the head of the chain that is ready to delivery. */
function drain(chatId: string): void {
  // Only ever called for a chat with a chain: a turn stays in it until drained.
  const chain = chains.get(chatId)!;
  while (chain.length > 0 && chain[0]!.refs !== null) {
    const item = chain.shift()!;
    deliveryTracker.submit(
      item.chatId,
      item.text,
      item.localId,
      item.refs!.length > 0 ? item.refs! : undefined,
      (e) => getWs().send(e),
      item.disabledTools,
    );
  }
  if (chain.length === 0) chains.delete(chatId);
}

async function upload(item: Outgoing): Promise<void> {
  const { chatId, localId, files } = item;
  const total = files.length;
  try {
    const refs: AttachmentRef[] = [];
    // One at a time, so the count ticks visibly through a batch.
    for (const a of files) {
      // spec/15 § Composer — downscale/compress images so they're within the
      // backend's vision limits. Non-images upload as-is.
      const up =
        a.kind === 'image'
          ? await downscaleImage({
              uri: a.uri,
              name: a.name,
              mimeType: a.mimeType,
              width: a.width,
              height: a.height,
            })
          : { uri: a.uri, name: a.name, mimeType: a.mimeType };
      const { ref } = await api.uploadAttachment(chatId, up);
      refs.push({ id: ref.id, name: ref.name, mimeType: ref.mimeType, kind: ref.kind });
      useChatStore.getState().patchLocalMessage(chatId, localId, {
        upload: { done: refs.length, total, failed: false },
      });
    }
    item.refs = refs;
    // Every file is up: from here it is an ordinary send.
    useChatStore.getState().patchLocalMessage(chatId, localId, {
      upload: undefined,
      attachments: refs,
      deliveryPending: true,
    });
  } catch (e) {
    const chain = chains.get(chatId)!;
    chain.splice(chain.indexOf(item), 1);
    failed.set(key(chatId, localId), item);
    useChatStore.getState().patchLocalMessage(chatId, localId, {
      upload: { done: 0, total, failed: true },
    });
    useUiStore.getState().pushError(`attachment upload failed: ${(e as Error).message}`);
  }
  drain(chatId);
}

/** Test seam: forget every in-flight and failed turn. */
export function _resetSendQueue(): void {
  chains.clear();
  failed.clear();
}
