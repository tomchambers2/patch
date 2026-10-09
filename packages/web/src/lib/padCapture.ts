// padCapture — photograph a screen of the running app as one self-contained
// HTML file, so a Pad starts from what the app ACTUALLY looks like (spec/14 §
// Pads — Capturing a screen), never a from-scratch mockup.
//
// The snapshot is the live DOM with every stylesheet flattened into one <style>
// and every font / image inlined as a data URI: scripts are dropped (it is a
// picture to edit, not an app to run), links go nowhere. It runs in the page
// itself, so it sees the real data on screen right now — no dev harness, no
// fixtures.
//
// `captureRoute` loads a route of this same app in an off-screen frame
// (`?tabWindow=1&capture=1`: a throwaway layout that persists nothing and marks
// nothing read) and photographs that, for screens other than the one on show.
//
// NO FALLBACK: an asset that cannot be inlined, or a screen that never settles,
// fails the capture with what went wrong — a half-styled snapshot is worse than
// none.

const DROP =
  'script,style,link[rel=stylesheet],link[rel=modulepreload],link[rel=preload],base,noscript';

export class CaptureError extends Error {
  override readonly name = 'CaptureError';
}

async function toDataUri(url: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(url);
  if (hit) return hit;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new CaptureError(`could not inline ${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  const uri = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new CaptureError(`could not read ${url}`));
    r.readAsDataURL(blob);
  });
  cache.set(url, uri);
  return uri;
}

/** One sheet's rules as text, every url() inlined relative to the sheet itself. */
async function flatten(
  sheet: CSSStyleSheet,
  doc: Document,
  cache: Map<string, string>,
): Promise<string> {
  let text = '';
  for (const rule of Array.from(sheet.cssRules)) text += `${rule.cssText}\n`;
  const base = sheet.href ?? doc.baseURI;
  const urls = [
    ...new Set(
      [...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]
        .map((m) => m[1] as string)
        .filter((u) => !u.startsWith('data:') && !u.startsWith('#')),
    ),
  ];
  for (const u of urls) {
    const uri = await toDataUri(new URL(u, base).toString(), cache);
    text = text.split(u).join(uri);
  }
  return text;
}

export async function captureDocument(doc: Document = document): Promise<string> {
  const cache = new Map<string, string>();
  let css = '';
  for (const sheet of Array.from(doc.styleSheets)) css += await flatten(sheet, doc, cache);

  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(DROP).forEach((n) => n.remove());

  // The clone has no live state: carry over what the user is looking at.
  const live = doc.documentElement.querySelectorAll('input,textarea,select');
  const copy = clone.querySelectorAll('input,textarea,select');
  live.forEach((el, i) => {
    const c = copy[i];
    if (!c) return;
    if (el instanceof HTMLTextAreaElement) c.textContent = el.value;
    else if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) c.setAttribute('checked', '');
        else c.removeAttribute('checked');
      } else c.setAttribute('value', el.value);
    } else if (el instanceof HTMLSelectElement) {
      c.querySelectorAll('option').forEach((o, j) => {
        if (j === el.selectedIndex) o.setAttribute('selected', '');
        else o.removeAttribute('selected');
      });
    }
  });

  // Images load from the app's own origin (some behind the bearer): inline them.
  for (const img of Array.from(clone.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;
    img.setAttribute('src', await toDataUri(new URL(src, doc.baseURI).toString(), cache));
    img.removeAttribute('srcset');
  }
  // A picture's links lead nowhere: they must not navigate the Pad away.
  clone.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', '#'));
  clone.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));

  const style = doc.createElement('style');
  style.textContent = css;
  (clone.querySelector('head') ?? clone).appendChild(style);
  return `<!doctype html>\n${clone.outerHTML}`;
}

export interface CaptureSize {
  width: number;
  height: number;
}

export const DESKTOP_SIZE: CaptureSize = { width: 1400, height: 900 };
export const PHONE_SIZE: CaptureSize = { width: 390, height: 844 };

const SETTLE_MS = 1800;
const READY_TIMEOUT_MS = 20_000;

/**
 * Photograph `path` (an app route, e.g. `/jobs`) as it looks right now. The
 * route loads in an off-screen frame of this app; once its shell is on screen
 * and has had a moment to fill with data, that frame's DOM is captured.
 */
export async function captureRoute(
  path: string,
  size: CaptureSize = DESKTOP_SIZE,
): Promise<string> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${size.width}px;height:${size.height}px;border:0;visibility:hidden`;
  const sep = path.includes('?') ? '&' : '?';
  frame.src = `${window.location.origin}/app${path}${sep}tabWindow=1&capture=1`;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener('error', () => reject(new CaptureError(`could not load ${path}`)), {
        once: true,
      });
    });
    const started = Date.now();
    for (;;) {
      const d = frame.contentDocument;
      if (d?.querySelector('.three-col, [data-testid=chat-main], main')) break;
      if (Date.now() - started > READY_TIMEOUT_MS) {
        throw new CaptureError(`${path} never finished loading in ${READY_TIMEOUT_MS / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const d = frame.contentDocument;
    if (!d) throw new CaptureError(`${path} could not be read back`);
    return await captureDocument(d);
  } finally {
    frame.remove();
  }
}

/** The routes of Patch itself a Pad can start from, captured live on demand. */
export const PATCH_SCREENS: { id: string; name: string; path: string }[] = [
  { id: 'new-chat', name: 'New chat', path: '/chats/new' },
  { id: 'jobs', name: 'Jobs', path: '/jobs' },
  { id: 'settings', name: 'Settings', path: '/settings' },
  { id: 'pads', name: 'Pads', path: '/pads' },
];
