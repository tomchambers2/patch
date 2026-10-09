// Sending a change to one host, shared by every Settings page.
//
// A host-scoped edit goes over the live socket to the named machine and is
// never patched locally: the row settles when that machine answers with a fresh
// report, so what is shown is always what the machine holds. The server
// BUFFERS surface→host frames while a host is down and flushes them on its
// next connect, so an edit aimed at an offline machine is refused here, naming
// it, rather than appearing to do nothing and applying hours later (NO
// FALLBACK).

import { useEffect, useRef, useState } from 'react';
import type { HostSettingsEvent, WireEvent } from '@patch/wire';
import { getActiveWs } from '../../api/ws.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { hostLabel } from './hostScope.js';

/**
 * How long a confirmed connect/disconnect may wait for that host's
 * `daemon.account` report before it is declared failed (spec/10 § Surface in
 * Settings). The host's work is one local file write, so the real round trip
 * is milliseconds — this is a generous ceiling, not a budget.
 */
export const CLAUDE_ACK_TIMEOUT_MS = 5_000;

/** "4s ago" / "3m ago" for a host's last heartbeat; "never" when it has none. */
export function agoLabel(at: number | null): string {
  if (at === null) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}

/**
 * Send one frame to a host, or refuse with a message naming which link is down.
 * Returns whether it was sent.
 */
export function sendToHost(host: HostPresence, event: WireEvent): boolean {
  const pushError = useUiStore.getState().pushError;
  const ws = getActiveWs();
  const { connection } = usePresenceStore.getState();
  const name = hostLabel(host);
  if (!ws || connection !== 'connected') {
    pushError(
      `this surface has no link to the server (${connection}), so nothing was sent to ${name}`,
    );
    return false;
  }
  if (!host.online) {
    pushError(`${name} is offline. It cannot be changed until it reconnects.`);
    return false;
  }
  try {
    ws.send(event);
    return true;
  } catch (e) {
    pushError(`sending to ${name} failed: ${(e as Error).message}`);
    return false;
  }
}

/** `host.settings` with just the fields given. */
export function sendHostSettings(
  host: HostPresence,
  patch: Omit<HostSettingsEvent, 'type' | 'daemonId'>,
): boolean {
  return sendToHost(host, { type: 'host.settings', daemonId: host.daemonId, ...patch });
}

/**
 * What to say when a connect/disconnect gets no `daemon.account` report inside
 * the ack window.
 *
 * "did not respond" was the whole message, and it was wrong twice over. It
 * blamed the machine for a silence with three genuinely different causes, and
 * it reported FAILURE for something we cannot know failed: the frame is sent,
 * the host acts on it locally the moment it lands, and only the report back
 * is missing — so the credential may well be gone while the toast says it
 * isn't. That is exactly what happened in production on 2026-08-15: the host
 * emptied its store three times while the desktop app, unrouted by the server
 * (see WsHub's surface registry), never saw a single report.
 *
 * So: name which link went quiet, and say that the outcome is UNKNOWN rather
 * than failed. When both ends still look up the silence is a routing orphan —
 * our socket is open and pong'ing but the server has stopped addressing it —
 * which a reconnect repairs, so force one instead of leaving the surface
 * silently deaf for the rest of the session.
 */
export function unansweredMessage(
  action: 'connect' | 'disconnect' | 'add' | 'reorder',
  daemonId: string,
  label: string,
): string {
  const secs = Math.round(CLAUDE_ACK_TIMEOUT_MS / 1000);
  const unknown = `it may already have applied, and this row shows ${label}'s real state as soon as a report lands`;
  const { connection, hosts } = usePresenceStore.getState();
  if (connection !== 'connected') {
    return `${action} not confirmed: lost the link to the server before ${label} answered (${connection}); ${unknown}`;
  }
  const host = hosts[daemonId];
  if (!host?.online) {
    return `${action} not confirmed: ${label} went offline before it answered (last seen ${agoLabel(
      host?.lastSeenAt ?? null,
    )}); ${unknown}`;
  }
  // Both ends up, no report: the server is not addressing this socket. A
  // reconnect re-registers the surface and re-seeds every host's state.
  getActiveWs()?.forceReconnect(`no daemon.account from ${daemonId} within ${secs}s`);
  return `${action} not confirmed: ${label} is online but sent no report in ${secs}s, reconnecting to the server; ${unknown}`;
}

/** Shared preflight for credential actions: a live socket AND the named host up. */
export function readySocket(
  what: 'connect' | 'disconnect' | 'add' | 'refresh usage' | 'reorder',
  daemonId: string,
  label: string,
  pushError: (message: string) => void,
): ReturnType<typeof getActiveWs> {
  const ws = getActiveWs();
  const { connection, hosts } = usePresenceStore.getState();
  // Name WHICH link is down. "not connected to the server" read as a verdict
  // on the machine, which is the one thing it says nothing about.
  if (!ws || connection !== 'connected') {
    pushError(
      `${what} failed: this surface has no link to the server (${connection}), so nothing was sent to ${label}`,
    );
    return null;
  }
  // The server BUFFERS surface→host frames while a host is down and
  // flushes them on its next connect, so sending here would look like nothing
  // happened and then apply minutes later. Refuse instead — and say when the
  // machine was last heard from, since "offline" alone gives no idea whether
  // this is a blip or a box that has been down since yesterday.
  const hostPresence = hosts[daemonId];
  if (!hostPresence?.online) {
    pushError(
      `${what} failed: ${label} is offline (last seen ${agoLabel(
        hostPresence?.lastSeenAt ?? null,
      )}), so its Claude credential can only be changed on the machine itself`,
    );
    return null;
  }
  return ws;
}

/**
 * The Settings → Hosts / Updates "Update" button, shared so both pages give
 * the same feedback (there were two independent copies with none at all).
 *
 * Applying is a download, verify, install and restart — several seconds with
 * nothing to show for it, so a click that looked like it had done nothing was
 * followed by another (the host has its own guard against the resulting
 * double-run, but a click that visibly lands never needs it). `updating`
 * clears three ways, all real signals rather than a guessed duration: success
 * drops `updateAvailable` and the button unmounts with it; a refusal —
 * synchronous ("offline") or the host's async `chat.error` — names this
 * machine in a `pushError` toast; and a reconnect gives a machine whose
 * update never announced either outcome (no host left to send one) another
 * go once it is seen again.
 */
export function useHostUpdate(host: HostPresence): { updating: boolean; apply: () => void } {
  const pushError = useUiStore((s) => s.pushError);
  const errors = useUiStore((s) => s.errors);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    if (updating && errors.some((e) => e.message.includes(host.daemonId))) setUpdating(false);
  }, [errors, updating, host.daemonId]);
  const wasOffline = useRef(!host.online);
  useEffect(() => {
    if (host.online && wasOffline.current) setUpdating(false);
    wasOffline.current = !host.online;
  }, [host.online]);
  function apply(): void {
    if (!host.online) {
      pushError(`${hostLabel(host)} is offline. It cannot be updated until it reconnects.`);
      return;
    }
    setUpdating(true);
    const sent = sendToHost(host, { type: 'host.update', daemonId: host.daemonId });
    if (!sent) setUpdating(false);
  }
  return { updating, apply };
}
