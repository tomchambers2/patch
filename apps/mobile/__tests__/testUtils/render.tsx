// Shared rendering harness for screen/component tests, built directly on
// react-test-renderer (no @testing-library/react-native — the react-native
// stub isn't a real host environment, so react-test-renderer's own
// tree-walking API, restricted to HOST (string-typed) instances, is enough).
//
// Restricting queries to host instances matters: several stub intrinsics
// (Pressable, TextInput) are themselves composite components wrapping a host
// node of the same name, and both receive the same passthrough props (e.g.
// accessibilityLabel) — searching over every instance would match both and
// make `findByProps`-style lookups ambiguous. Host-only search always finds
// exactly the one leaf node a real RN inspection tool would show.

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

export function renderRN(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/**
 * Like `renderRN`, but supplies a `createNodeMock` so a host component's ref
 * (e.g. `ScrollView`/`FlatList`/`TextInput`) resolves to a real object instead
 * of `null` — needed only when a test exercises code that calls a method off
 * that ref (react-test-renderer does not auto-populate host refs).
 */
export function renderRNWithNodeMock(
  element: React.ReactElement,
  createNodeMock: (element: React.ReactElement) => unknown,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element, { createNodeMock });
  });
  return renderer;
}

export function update(renderer: ReactTestRenderer, element: React.ReactElement): void {
  act(() => {
    renderer.update(element);
  });
}

export function actSync(fn: () => void): void {
  act(fn);
}

export async function actAsync(fn: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

/** Flush pending microtasks/timers inside `act`, without changing anything. */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

type Predicate = (i: ReactTestInstance) => boolean;

export function findHost(root: ReactTestInstance, predicate: Predicate): ReactTestInstance {
  const matches = root.findAll((i) => typeof i.type === 'string' && predicate(i));
  if (matches.length !== 1) {
    throw new Error(`findHost: expected exactly 1 match, found ${matches.length}`);
  }
  return matches[0]!;
}

export function queryHost(root: ReactTestInstance, predicate: Predicate): ReactTestInstance | null {
  const matches = root.findAll((i) => typeof i.type === 'string' && predicate(i));
  return matches[0] ?? null;
}

export function findAllHost(root: ReactTestInstance, predicate: Predicate): ReactTestInstance[] {
  return root.findAll((i) => typeof i.type === 'string' && predicate(i));
}

export const byLabel =
  (label: string): Predicate =>
  (i) =>
    i.props['accessibilityLabel'] === label;

export const byTestId =
  (id: string): Predicate =>
  (i) =>
    i.props['testID'] === id;

export const byType =
  (type: string): Predicate =>
  (i) =>
    i.type === type;

/** Flattened text content of a subtree — walks every 'Text'/'Markdown' host node. */
export function textOf(i: ReactTestInstance): string {
  let out = '';
  const visit = (node: ReactTestInstance): void => {
    if (typeof node.type === 'string' && (node.type === 'Text' || node.type === 'Markdown')) {
      for (const child of node.children) {
        if (typeof child === 'string') out += child;
      }
    }
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child);
    }
  };
  visit(i);
  return out;
}

/** True if any 'Text'/'Markdown' node in the subtree contains `needle`. */
export function hasText(root: ReactTestInstance, needle: string): boolean {
  return textOf(root).includes(needle);
}
