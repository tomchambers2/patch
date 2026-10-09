// useNavigationGuard — hold a navigation open until the user says it is fine to
// leave (spec/14 § Jobs view — Unsaved changes).
//
// react-router v7 ships `useBlocker`, but it works ONLY under a DATA router
// (`createBrowserRouter` + `RouterProvider`). This app mounts a declarative
// `<BrowserRouter>` (`main.tsx`) and the dev harness a `<MemoryRouter>`, so
// `useBlocker` throws "useBlocker must be used within a data router" in both.
//
// The interception point that DOES exist under a declarative router is the
// router's own `navigator` — the history object that `useNavigate()`, every
// `<Link>` and every `<Navigate>` push through. Wrapping its `push`/`replace`/
// `go` therefore catches every in-app route change at one point, including:
//   - the route's own `navigate('/jobs')` calls and any `<Link>` in the shell,
//   - the app's Back/Forward controls (`NavHistoryControls` calls `navigate()`),
//   - the desktop shell's `patch:navigate` IPC (`lib/desktopNavigation.ts`).
//
// NOT intercepted, deliberately: the real browser's own Back/Forward buttons.
// Under a non-data router those arrive as a `popstate` the History API has
// ALREADY applied, and the only way to hold one is to keep pushing sentinel
// entries — which silently corrupts the app's own history stack (and the
// separate stack `NavHistoryControls` keeps). The desktop shell, which is where
// this form is actually used, has no browser chrome: its back button IS
// `NavHistoryControls`, and that is covered.
//
// A window/tab close is covered by `beforeunload`. The dialog there is the
// browser's own generic one — a page is not allowed to draw its own at that
// point — so this is the one exit that does not use the app's modal.

import { useContext, useEffect, useRef, type Context } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';

/**
 * The part of the router's history object this guard wraps. Only forwarded,
 * never called with arguments of our own, so the parameters stay opaque.
 */
interface RouterNavigator {
  push: (...args: unknown[]) => void;
  replace: (...args: unknown[]) => void;
  go: (...args: unknown[]) => void;
}

/**
 * react-router-dom resolves its own `@types/react` (18) while this app is on
 * React 19, so its exported Context object is not assignable to this app's
 * Context type even though it IS the same runtime object. Restated here rather
 * than suppressed, so what we actually depend on is written down.
 */
const NavigationContext = UNSAFE_NavigationContext as unknown as Context<{
  navigator: RouterNavigator;
}>;

export interface NavigationGuard {
  /** Read at navigation time: does leaving right now need confirming? */
  shouldBlock: () => boolean;
  /** Ask the user. Resolving `true` lets the navigation through unchanged. */
  confirm: () => Promise<boolean>;
}

/** Every mounted guard, so a reload the app starts itself can ask the same question. */
const mountedGuards = new Set<{ current: NavigationGuard }>();
let unloadApproved = false;

/**
 * Ask whether leaving the document right now is fine, via the same app modal an
 * in-app navigation uses. Resolves `true` at once when nothing is blocking. On
 * `true` the `beforeunload` guard stands down for the unload that follows:
 * Electron draws no dialog for it, so a veto there is a reload that silently
 * does nothing — the Reload banner's button going dead.
 */
export async function confirmLeaveDocument(): Promise<boolean> {
  for (const g of mountedGuards) {
    if (g.current.shouldBlock() && !(await g.current.confirm())) return false;
  }
  unloadApproved = true;
  return true;
}

/** True when a guard is currently holding the document open. */
export function isDocumentLeaveBlocked(): boolean {
  for (const g of mountedGuards) if (g.current.shouldBlock()) return true;
  return false;
}

/** Test seam. */
export function __resetUnloadApprovalForTests(): void {
  unloadApproved = false;
}

export function useNavigationGuard(guard: NavigationGuard): void {
  const { navigator } = useContext(NavigationContext);
  // The guard closes over React state, so it is a new object every render while
  // the effect below must run once per navigator. A ref bridges the two.
  const guardRef = useRef(guard);
  guardRef.current = guard;

  useEffect(() => {
    mountedGuards.add(guardRef);
    return () => {
      mountedGuards.delete(guardRef);
    };
  }, []);

  useEffect(() => {
    const nav = navigator;
    const push = nav.push.bind(nav);
    const replace = nav.replace.bind(nav);
    const go = nav.go.bind(nav);

    // Each wrapper closes over the ORIGINAL bound method, so an approved
    // navigation calls straight through to history and never re-enters the
    // guard to ask a second time about the trip it has just allowed.
    function guarded<A extends unknown[]>(run: (...args: A) => void): (...args: A) => void {
      return (...args: A): void => {
        if (!guardRef.current.shouldBlock()) {
          run(...args);
          return;
        }
        void guardRef.current.confirm().then((ok) => {
          if (ok) run(...args);
        });
      };
    }

    nav.push = guarded(push);
    nav.replace = guarded(replace);
    nav.go = guarded(go);

    return () => {
      nav.push = push;
      nav.replace = replace;
      nav.go = go;
    };
  }, [navigator]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      if (unloadApproved || !guardRef.current.shouldBlock()) return;
      // Both are required: `preventDefault` is the modern signal, `returnValue`
      // the one older Chromium (which the Electron shell embeds) still reads.
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
