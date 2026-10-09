// Render coverage for the anchored kebab dropdown (spec/15 § Chat detail).
// Deliberately NOT a centre-screen Alert — pins: (1) the Modal only mounts
// content when visible, (2) it positions off the safe-area top inset,
// (3) tap-outside-to-dismiss, (4) selecting an item dismisses THEN selects,
// (5) destructive items render red, non-destructive render ink, and (6) the
// per-item pressed-style branch (accentTint while pressed, transparent
// otherwise) is exercised via onPressIn/onPressOut.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byLabel,
  hasText,
  actSync,
  update,
} from './testUtils/render';
import { AnchoredMenu, type AnchoredMenuItem } from '../src/components/AnchoredMenu';
import { lightColors as colors } from '../src/lib/theme';
import { __setSafeAreaInsets } from './stubs/safe-area-context';
import { __pressBack, __backListenerCount } from './stubs/react-native';

const items: AnchoredMenuItem[] = [
  { id: 'archive', label: 'Archive chat' },
  { id: 'delete', label: 'Delete chat', destructive: true },
];

afterEach(() => {
  __setSafeAreaInsets({ top: 20 });
});

describe('AnchoredMenu — visibility', () => {
  it('mounts no content while invisible (real RN Modal semantics)', () => {
    const r = renderRN(
      <AnchoredMenu visible={false} items={items} onSelect={() => {}} onDismiss={() => {}} />,
    );
    expect(r.toJSON()).toBeNull();
    expect(queryHost(r.root, byLabel('Dismiss menu'))).toBeNull();
  });

  it('mounts the backdrop + card once visible', () => {
    const r = renderRN(
      <AnchoredMenu visible items={items} onSelect={() => {}} onDismiss={() => {}} />,
    );
    expect(findHost(r.root, byLabel('Dismiss menu'))).toBeDefined();
    expect(hasText(r.root, 'Archive chat')).toBe(true);
    expect(hasText(r.root, 'Delete chat')).toBe(true);
  });
});

describe('AnchoredMenu — positioning', () => {
  it('anchors the card top = safe-area inset top + 52', () => {
    __setSafeAreaInsets({ top: 44 });
    const r = renderRN(
      <AnchoredMenu visible items={items} onSelect={() => {}} onDismiss={() => {}} />,
    );
    const card = findHost(
      r.root,
      (i) => i.type === 'View' && i.props.style.position === 'absolute',
    );
    expect(card.props.style.top).toBe(44 + 52);
  });
});

describe('AnchoredMenu — dismiss / select', () => {
  it('tapping the backdrop dismisses without selecting', () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    const r = renderRN(
      <AnchoredMenu visible items={items} onSelect={onSelect} onDismiss={onDismiss} />,
    );
    findHost(r.root, byLabel('Dismiss menu')).props.onPress();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('tapping an item dismisses THEN selects that item id, in that order', () => {
    const calls: string[] = [];
    const onSelect = vi.fn((id: string) => calls.push(`select:${id}`));
    const onDismiss = vi.fn(() => calls.push('dismiss'));
    const r = renderRN(
      <AnchoredMenu visible items={items} onSelect={onSelect} onDismiss={onDismiss} />,
    );
    const [archiveItem] = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem');
    archiveItem!.props.onPress();
    expect(calls).toEqual(['dismiss', 'select:archive']);
  });
});

describe('AnchoredMenu — item styling', () => {
  it('renders a destructive item in red and a normal item in ink', () => {
    const r = renderRN(
      <AnchoredMenu visible items={items} onSelect={() => {}} onDismiss={() => {}} />,
    );
    const menuItems = findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem');
    expect(menuItems.length).toBe(2);
    const archiveText = menuItems[0]!.findByType('Text' as unknown as string);
    const deleteText = menuItems[1]!.findByType('Text' as unknown as string);
    expect(archiveText.props.style.color).toBe(colors.ink);
    expect(deleteText.props.style.color).toBe(colors.red);
  });

  it('resolves the pressed-style branch: accentTint while pressed, transparent otherwise', () => {
    const onSelect = vi.fn();
    const r = renderRN(
      <AnchoredMenu visible items={items} onSelect={onSelect} onDismiss={() => {}} />,
    );
    const menuItem = (): ReturnType<typeof findAllHost>[number] =>
      findAllHost(r.root, (i) => i.props.accessibilityRole === 'menuitem')[0]!;
    expect(menuItem().props.style.backgroundColor).toBe('transparent');
    actSync(() => menuItem().props.onPressIn());
    expect(menuItem().props.style.backgroundColor).toBe(colors.accentTint);
    actSync(() => menuItem().props.onPressOut());
    expect(menuItem().props.style.backgroundColor).toBe('transparent');
    // Pressing (onPress) fires the item's own handler: dismiss then select.
    menuItem().props.onPress();
    expect(onSelect).toHaveBeenCalledWith('archive');
  });
});

// Composer's permission padlock (placement="bottom") skips <Modal>: on
// Android it unconditionally steals window focus right after showing, which
// drops whatever keyboard was open underneath (Todoist 6hfvvHWp6QqVjjQ6).
describe('AnchoredMenu — nonModal (composer padlock)', () => {
  // The back-press listener lives for as long as the component is mounted
  // (__backListenerCount reads a module-level list the stub never resets) —
  // unmount after each case so the next one starts from zero.
  const mounted: Array<ReturnType<typeof renderRN>> = [];
  afterEach(() => {
    for (const r of mounted.splice(0)) actSync(() => r.unmount());
  });

  it('renders nothing while invisible, with no back-press listener registered', () => {
    const r = renderRN(
      <AnchoredMenu
        visible={false}
        items={items}
        onSelect={() => {}}
        onDismiss={() => {}}
        placement="bottom"
        nonModal
      />,
    );
    expect(r.toJSON()).toBeNull();
    expect(__backListenerCount()).toBe(0);
  });

  it('mounts the backdrop + card once visible, without a Modal host node', () => {
    const r = renderRN(
      <AnchoredMenu
        visible
        items={items}
        onSelect={() => {}}
        onDismiss={() => {}}
        placement="bottom"
        nonModal
      />,
    );
    mounted.push(r);
    expect(queryHost(r.root, (i) => i.type === 'Modal')).toBeNull();
    expect(findHost(r.root, byLabel('Dismiss menu'))).toBeDefined();
    expect(hasText(r.root, 'Archive chat')).toBe(true);
  });

  it('the Android hardware back button dismisses it, consuming the press', () => {
    const onDismiss = vi.fn();
    const r = renderRN(
      <AnchoredMenu
        visible
        items={items}
        onSelect={() => {}}
        onDismiss={onDismiss}
        placement="bottom"
        nonModal
      />,
    );
    mounted.push(r);
    expect(__backListenerCount()).toBe(1);
    const consumed = __pressBack();
    expect(consumed).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('unregisters the back-press listener once dismissed', () => {
    const r = renderRN(
      <AnchoredMenu
        visible
        items={items}
        onSelect={() => {}}
        onDismiss={() => {}}
        placement="bottom"
        nonModal
      />,
    );
    mounted.push(r);
    expect(__backListenerCount()).toBe(1);
    update(
      r,
      <AnchoredMenu
        visible={false}
        items={items}
        onSelect={() => {}}
        onDismiss={() => {}}
        placement="bottom"
        nonModal
      />,
    );
    expect(__backListenerCount()).toBe(0);
  });
});
