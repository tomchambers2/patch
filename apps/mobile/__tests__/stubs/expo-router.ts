// expo-router stub for unit tests. Provides a shared, inspectable router
// mock (vi.fn() methods) plus the navigation primitives (Stack/Tabs/Link/
// Redirect) as thin host-node components so screens can render under
// react-test-renderer without a real navigator.

import React from 'react';
import { vi } from 'vitest';

// Whether the root navigator has mounted. Real expo-router keeps this on its
// store and THROWS from every navigating method (`assertIsReady`) until the
// root layout has rendered a navigator — a detail that matters, because the
// root layout renders `null` behind its font gate on a cold start, so any
// navigation attempted in that window blows up instead of being deferred.
// Defaults to ready so ordinary screen tests are unaffected; the cold-start
// tests drive it explicitly.
let _rootNavReady = true;

/** Test helper: mount/unmount the root navigator. */
export function __setRootNavigationReady(ready: boolean): void {
  _rootNavReady = ready;
}

function assertIsReady(method: string): void {
  if (!_rootNavReady) {
    throw new Error(
      `Attempted to navigate before mounting the Root Layout component (router.${method}). ` +
        'Ensure the Root Layout component is rendering a Slot, or other navigator on the first render.',
    );
  }
}

export const routerMock = {
  push: vi.fn((_href: string) => assertIsReady('push')),
  navigate: vi.fn((_href: string) => assertIsReady('navigate')),
  replace: vi.fn((_href: string) => assertIsReady('replace')),
  back: vi.fn(),
  canGoBack: vi.fn((): boolean => true),
  setParams: vi.fn(),
};

/** Test helper: reset call history + canGoBack/readiness defaults between tests. */
export function __resetRouterMock(): void {
  routerMock.push.mockClear();
  routerMock.navigate.mockClear();
  routerMock.replace.mockClear();
  routerMock.back.mockClear();
  routerMock.setParams.mockClear();
  routerMock.canGoBack.mockClear();
  routerMock.canGoBack.mockReturnValue(true);
  _rootNavReady = true;
}

/**
 * Real `useRootNavigationState()` returns undefined until the root navigator
 * mounts, then a state object with a `key`. That transition is the only signal
 * a root layout has that it is safe to navigate.
 */
export function useRootNavigationState(): { key: string } | undefined {
  return _rootNavReady ? { key: 'stack-root' } : undefined;
}

export function useRouter(): typeof routerMock {
  return routerMock;
}

let _params: Record<string, string | undefined> = {};
/** Test helper: set what useLocalSearchParams() returns. */
export function __setLocalSearchParams(p: Record<string, string | undefined>): void {
  _params = p;
}
export function useLocalSearchParams<T = Record<string, string>>(): T {
  return _params as unknown as T;
}

export function useSegments(): string[] {
  return [];
}

// useFocusEffect: real expo-router/react-navigation re-runs the effect each
// time the screen regains focus; under test there is no navigator driving
// focus, so it runs once on mount (a test can call the returned cleanup by
// unmounting) — sufficient to exercise the effect body + its cleanup.
export function useFocusEffect(effect: () => void | (() => void)): void {
  React.useEffect(effect, [effect]);
}

export function Redirect({ href }: { href: string }): React.ReactElement {
  React.useEffect(() => {
    routerMock.push(href);
  }, [href]);
  return React.createElement('Redirect', { href });
}

export function Link(props: {
  href: string;
  children?: React.ReactNode;
  [k: string]: unknown;
}): React.ReactElement {
  return React.createElement('Link', props, props.children);
}

interface ScreenProps {
  name?: string;
  options?: unknown;
  children?: React.ReactNode;
}
function ScreenComponent(props: ScreenProps): React.ReactElement {
  return React.createElement('Stack.Screen', props, props.children ?? null);
}
function StackComponent(props: {
  children?: React.ReactNode;
  screenOptions?: unknown;
}): React.ReactElement {
  return React.createElement('Stack', props, props.children);
}
(StackComponent as typeof StackComponent & { Screen: typeof ScreenComponent }).Screen =
  ScreenComponent;
export const Stack = StackComponent as typeof StackComponent & { Screen: typeof ScreenComponent };

function TabsScreenComponent(props: ScreenProps): React.ReactElement {
  return React.createElement('Tabs.Screen', props, props.children ?? null);
}
function TabsComponent(props: {
  children?: React.ReactNode;
  screenOptions?: unknown;
}): React.ReactElement {
  return React.createElement('Tabs', props, props.children);
}
(TabsComponent as typeof TabsComponent & { Screen: typeof TabsScreenComponent }).Screen =
  TabsScreenComponent;
export const Tabs = TabsComponent as typeof TabsComponent & { Screen: typeof TabsScreenComponent };
