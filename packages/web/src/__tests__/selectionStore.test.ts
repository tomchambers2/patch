// Sidebar range-selection maths — patch/todo.md "shift click should select
// multiple", spec/14 § Sidebar → Selecting multiple rows (shift-click).

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveRange, useSelectionStore } from '../stores/selectionStore.js';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

describe('resolveRange', () => {
  it('selects the inclusive run between anchor and target, downwards', () => {
    expect(resolveRange(ORDER, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  it('selects the same run upwards — order is drawn order, not click order', () => {
    expect(resolveRange(ORDER, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('an anchor shift-clicked onto itself is a one-row selection', () => {
    expect(resolveRange(ORDER, 'c', 'c')).toEqual(['c']);
  });

  it('with no anchor, selects just the clicked row', () => {
    expect(resolveRange(ORDER, null, 'c')).toEqual(['c']);
  });

  it('an anchor that has left the list falls back to the clicked row alone', () => {
    expect(resolveRange(ORDER, 'gone', 'c')).toEqual(['c']);
  });

  it('a target that is not selectable selects nothing', () => {
    expect(resolveRange(ORDER, 'a', 'manager')).toEqual([]);
  });
});

describe('selectionStore', () => {
  beforeEach(() => {
    useSelectionStore.setState({ order: ORDER, anchor: null, selected: [] });
  });

  it('a plain click sets the anchor and clears any selection', () => {
    useSelectionStore.getState().extendTo('b');
    useSelectionStore.getState().extendTo('d');
    expect(useSelectionStore.getState().selected).toEqual(['b', 'c', 'd']);
    useSelectionStore.getState().anchorAt('e');
    expect(useSelectionStore.getState().selected).toEqual([]);
    expect(useSelectionStore.getState().anchor).toBe('e');
  });

  it('re-shift-clicking re-resolves from the SAME anchor rather than accumulating', () => {
    useSelectionStore.getState().anchorAt('b');
    useSelectionStore.getState().extendTo('d');
    expect(useSelectionStore.getState().selected).toEqual(['b', 'c', 'd']);
    useSelectionStore.getState().extendTo('c');
    expect(useSelectionStore.getState().selected).toEqual(['b', 'c']);
    expect(useSelectionStore.getState().anchor).toBe('b');
  });

  it('a shift-click with no anchor selects that row and adopts it as the anchor', () => {
    useSelectionStore.getState().extendTo('c');
    expect(useSelectionStore.getState().selected).toEqual(['c']);
    expect(useSelectionStore.getState().anchor).toBe('c');
  });

  it('rows that leave the drawn order drop out of the selection and the anchor', () => {
    useSelectionStore.getState().anchorAt('b');
    useSelectionStore.getState().extendTo('d');
    useSelectionStore.getState().setOrder(['a', 'c', 'e']);
    expect(useSelectionStore.getState().selected).toEqual(['c']);
    expect(useSelectionStore.getState().anchor).toBeNull();
  });

  it('re-publishing the same order leaves the selection object identical (no re-render churn)', () => {
    useSelectionStore.getState().anchorAt('b');
    useSelectionStore.getState().extendTo('d');
    const before = useSelectionStore.getState().selected;
    useSelectionStore.getState().setOrder([...ORDER]);
    expect(useSelectionStore.getState().selected).toBe(before);
  });
});
