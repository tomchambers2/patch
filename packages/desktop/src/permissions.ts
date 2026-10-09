// Browser-permission gate for the desktop shell (spec/14-design-web.md
// § Browser permissions (desktop shell)).
//
// Electron applies its own defaults only while NO permission handler is
// registered, and those defaults deny `media` — so the renderer's
// getUserMedia({ audio: true }) rejected with NotAllowedError, the mic never
// opened, and voice did nothing on the desktop app. Registering a handler to
// fix that replaces the defaults WHOLESALE: from then on a permission is
// granted only if this module says so. So the allowlist has to enumerate
// EVERYTHING the shell needs, not just the one thing it was written for.
// Anything left off it fails in the packaged app alone — a browser grants these
// itself for a user gesture in a secure context, which is why the renderer's
// own tests cannot see the difference.
//
// What the app's OWN origin (the deployed SPA, or the dev vite server) is
// allowed to do:
//   - `media` / `audioCapture` — the microphone, for voice notes
//     (lib/voiceRecorder) and voice calls (lib/audioSession).
//   - `clipboard-sanitized-write` — navigator.clipboard.writeText(), behind the
//     copy control on a fenced code block in the transcript and Copy report on
//     the connection-diagnostics screen. Denied, the write promise rejects and
//     both buttons land on "Copy failed". This is the ONLY name Electron 33
//     surfaces for a clipboard write, on either handler; the web Permissions
//     API's `clipboard-write` never reaches this code, so listing it would be
//     decoration.
//
// Reading the clipboard is a different privilege — it hands a page whatever the
// user last copied — and nothing in Patch needs it, so `clipboard-read` and
// `deprecated-sync-clipboard-read` stay denied. Only the write side is allowed.
//
// NO FALLBACK / privacy: a permission not on the list is denied, and so is
// every permission from a foreign origin. Nothing is ever blanket-approved.
// Deliberately electron-runtime-free so it unit-tests without booting Electron;
// main.ts wires it onto session.defaultSession.

/** The shell's whole allowlist. getUserMedia({audio}) surfaces as `media`; some
 *  Electron/Chromium paths use the finer-grained `audioCapture`. A clipboard
 *  WRITE surfaces as `clipboard-sanitized-write` (the write is sanitised by
 *  Chromium before it lands); the read permissions are deliberately absent. */
export const ALLOWED_PERMISSIONS: readonly string[] = [
  'media',
  'audioCapture',
  'clipboard-sanitized-write',
];

/**
 * Pure decision: should `permission`, requested by `requestingOrigin`, be
 * granted for an app served from `allowedOrigin`? True only for an allowlisted
 * permission asked for by the app's own origin.
 */
export function decidePermission(
  permission: string,
  requestingOrigin: string,
  allowedOrigin: string,
): boolean {
  if (!ALLOWED_PERMISSIONS.includes(permission)) return false;
  return sameOrigin(requestingOrigin, allowedOrigin);
}

/** True when `url` (a full URL or a bare origin) shares an origin with `allowedOrigin`. */
function sameOrigin(url: string, allowedOrigin: string): boolean {
  const want = originOf(allowedOrigin);
  const got = originOf(url);
  // NO FALLBACK: an unparseable/empty origin never matches, so it's denied.
  return want.length > 0 && got.length > 0 && got === want;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** The bits of a permission REQUEST we read (Electron's PermissionRequest and
 *  its subtypes all carry `requestingUrl`). Widened to optional so both the real
 *  Electron detail union and a plain test fake satisfy it. */
export interface PermissionRequestDetails {
  requestingUrl?: string;
}

/** The subset of Electron's Session surface this module drives (kept minimal +
 *  structurally compatible with the real Session so a plain fake satisfies it in
 *  tests AND `session.defaultSession` can be passed at the call site). */
export interface PermissionSession {
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (granted: boolean) => void,
          details: PermissionRequestDetails,
        ) => void)
      | null,
  ): void;
  setPermissionCheckHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          requestingOrigin: string,
          details: unknown,
        ) => boolean)
      | null,
  ): void;
}

/**
 * Register the permission handlers on `sess`, granting the allowlist to
 * `allowedOrigin` only. Both handlers are needed: the REQUEST handler answers a
 * prompt-driven ask (getUserMedia), and the CHECK handler answers Chromium's
 * synchronous permission checks — a clipboard write is decided entirely there,
 * and without it a granted mic can still read as "denied" on a later query and
 * the stream is dropped.
 */
export function configurePermissions(sess: PermissionSession, allowedOrigin: string): void {
  sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = details?.requestingUrl ?? '';
    callback(decidePermission(permission, origin, allowedOrigin));
  });
  sess.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return decidePermission(permission, requestingOrigin, allowedOrigin);
  });
}
