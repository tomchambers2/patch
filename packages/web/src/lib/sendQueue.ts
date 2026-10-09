// Outgoing turns, from Send to delivery (spec/15 § Composer → Attachments, the
// cross-surface contract; spec/14 § Composer → Attachments).
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
// unmounting — leaving the chat, or the new-chat route handing over to the
// chat it just created — and so Retry / × work from the transcript.
//
// ORDER: turns reach delivery in the order they were sent, per chat. A turn
// sent behind one still uploading (text or attachments) is echoed at once but
// waits in that chat's chain. A FAILED upload leaves the chain — it must not
// hold up the turns behind it — and stays in the stream as `Not uploaded` with
// Retry (upload the same files again, then send; it rejoins the chain at the
// back) and × (discard). NO FALLBACK: nothing is dropped without the user
// discarding it, and every failure is toasted.

import type { AttachmentRef, WireEvent } from '@patch/wire';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useToolsStore } from '../stores/toolsStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { deliveryTracker } from './deliveryTracker.js';
import { downscaleImageFile } from './imageResize.js';
import { failed as failedSentence } from './errorCopy.js';

/** A file a turn is sent with, as the local copy the user picked. */
export interface OutgoingFile {
  file: File;
  name: string;
  kind: 'image' | 'file';
  /** Object URL of the local copy (images) — drawn in the stream while it uploads. */
  previewUrl?: string;
}

export interface SendMessageOptions {
  /** The chat's folder — seeds the row of a chat the surface has not seen yet. */
  folder?: string;
  /** The socket to deliver on (the route's `ws`); retries use the live one. */
  send?: (event: WireEvent) => void;
}

interface Outgoing {
  chatId: string;
  localId: string;
  text: string;
  files: OutgoingFile[];
  /** The Tools panel's OFF set captured at SEND time (see deliveryTracker). */
  disabledTools: string[];
  opts: SendMessageOptions;
  /** The uploaded refs; `null` while the files are still uploading. */
  refs: AttachmentRef[] | null;
}

/** Per chat, the turns not yet handed to delivery, in send order. */
const chains = new Map<string, Outgoing[]>();
/** Turns whose upload failed, awaiting Retry or ×. */
const failed = new Map<string, Outgoing>();

const key = (chatId: string, localId: string): string => `${chatId} ${localId}`;

/**
 * Send a turn into `chatId`: echo it now, upload `files` (if any), deliver it
 * once everything ahead of it in the chat has. Returns the turn's localId.
 */
export function sendMessage(
  chatId: string,
  text: string,
  files: OutgoingFile[],
  opts: SendMessageOptions = {},
): string {
  const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item: Outgoing = {
    chatId,
    localId,
    text,
    files,
    disabledTools: useToolsStore.getState().disabledFor(chatId),
    opts,
    refs: files.length === 0 ? [] : null,
  };
  useChatStore.getState().addLocalMessage(chatId, text, localId, opts.folder, undefined, {
    localAttachments: files.map((f) => ({
      name: f.name,
      kind: f.kind,
      ...(f.previewUrl !== undefined ? { url: f.previewUrl } : {}),
    })),
  });
  enqueue(item);
  return localId;
}

/** Retry: upload the same files again, then send. */
export function retryUpload(chatId: string, localId: string): void {
  const item = failed.get(key(chatId, localId));
  if (!item) {
    // The files went with the page that picked them (it reloaded). Say so
    // rather than leave a Retry that does nothing.
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
  const item = failed.get(key(chatId, localId));
  failed.delete(key(chatId, localId));
  if (item) for (const f of item.files) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
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
      item.opts.send,
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
      // spec/15 § Composer — the ORIGINAL is uploaded (it is what gets stored,
      // served and rendered) alongside a downscaled copy for the agent, which
      // has to stay within Claude's vision limits. `downscaleImageFile` hands
      // back the very same File when no resize was needed, so an identity
      // result means there is no second copy to send — as with any non-image.
      const downscaled = a.kind === 'image' ? await downscaleImageFile(a.file) : a.file;
      const model = downscaled === a.file ? undefined : downscaled;
      const { ref } = await api.uploadAttachment(chatId, a.file, model);
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
    useUiStore
      .getState()
      .pushError(failedSentence('attachment upload'), undefined, (e as Error).message);
  }
  drain(chatId);
}

/** Test seam: forget every in-flight and failed turn. */
export function _resetSendQueue(): void {
  chains.clear();
  failed.clear();
}
