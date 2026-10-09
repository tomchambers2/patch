// Stub of react-native for unit tests. Extended (2026) beyond the original
// pure-logic surface to support RENDERING screens/components with
// react-test-renderer — every intrinsic is a thin function component that
// produces a host node of the same name, so a test can walk the tree with
// react-test-renderer's own `root.find*` API. No real native code runs; this
// is a plain-JS behavioural stand-in, not a faithful re-implementation of
// RN's layout/animation engine (there is no layout, no real timers-driven
// animation — see Animated below for the simplification).
//
// Design note on interactive intrinsics (Pressable, TextInput, Switch): each
// resolves function-style `style` props (`style={({pressed}) => ({...})}`)
// itself, using its OWN pressed/focus state, so tests get real coverage of
// both branches of those inline style callbacks by driving onPressIn/
// onPressOut/onFocus/onBlur — not just by reading the prop back unevaluated.

import React from 'react';

export const AppState = {
  currentState: 'active' as AppStateStatus,
  _listeners: new Map<string, Set<(s: AppStateStatus) => void>>(),
  addEventListener(event: string, cb: (s: AppStateStatus) => void): { remove(): void } {
    let set = AppState._listeners.get(event);
    if (!set) {
      set = new Set();
      AppState._listeners.set(event, set);
    }
    set.add(cb);
    return {
      remove(): void {
        set!.delete(cb);
      },
    };
  },
};
/** Test helper: simulate the OS flipping foreground/background state. */
export function __emitAppStateChange(state: AppStateStatus): void {
  AppState.currentState = state;
  for (const cb of AppState._listeners.get('change') ?? []) cb(state);
}
/** Test helper: fire a non-state AppState event (Android window 'focus'/'blur'). */
export function __emitAppStateEvent(event: 'focus' | 'blur'): void {
  for (const cb of AppState._listeners.get(event) ?? []) cb(AppState.currentState);
}
export type AppStateStatus = 'active' | 'background' | 'inactive';
export interface NativeEventSubscription {
  remove(): void;
}

const keyboardListeners = new Map<string, Set<(e: unknown) => void>>();
export const Keyboard = {
  dismiss(): void {},
  addListener(event: string, cb: (e: unknown) => void): { remove(): void } {
    let set = keyboardListeners.get(event);
    if (!set) {
      set = new Set();
      keyboardListeners.set(event, set);
    }
    set.add(cb);
    return {
      remove(): void {
        set!.delete(cb);
      },
    };
  },
  removeAllListeners(event: string): void {
    keyboardListeners.delete(event);
  },
};
// Android's hardware/gesture back. Listeners run newest-first and the first to
// return true consumes the press, as on a device.
const backListeners: Array<() => boolean> = [];
export const BackHandler = {
  addEventListener(_event: 'hardwareBackPress', cb: () => boolean): { remove(): void } {
    backListeners.push(cb);
    return {
      remove(): void {
        const i = backListeners.indexOf(cb);
        if (i !== -1) backListeners.splice(i, 1);
      },
    };
  },
};
/** Test helper: press back. Returns whether a listener consumed it. */
export function __pressBack(): boolean {
  for (let i = backListeners.length - 1; i >= 0; i--) {
    if (backListeners[i]!()) return true;
  }
  return false;
}
/** Test helper: how many back listeners are registered. */
export function __backListenerCount(): number {
  return backListeners.length;
}

/** Test helper: fire a keyboard lifecycle event (e.g. 'keyboardDidShow'). */
export function __emitKeyboardEvent(event: string, payload: unknown = {}): void {
  for (const cb of keyboardListeners.get(event) ?? []) cb(payload);
}

export const Platform = {
  // Unit tests run off-device; native-only branches (mic capture, foreground
  // service) key off this. Mutable so a test can flip it to 'android' to
  // exercise those branches against a faked NativeModules entry.
  OS: 'test' as 'test' | 'android' | 'ios',
  select<T>(spec: Record<string, T>): T | undefined {
    return spec[Platform.OS] ?? spec['default'];
  },
};

export type ColorSchemeName = 'light' | 'dark' | null | undefined;
let _colorScheme: ColorSchemeName = 'light';
export function __setColorScheme(scheme: ColorSchemeName): void {
  _colorScheme = scheme;
}
export function useColorScheme(): ColorSchemeName {
  return _colorScheme;
}

export const NativeModules: Record<string, unknown> = {};

// findNodeHandle: a stable fake React tag per ref'd instance (there are no
// native views off-device). null in, null out — as on device.
const nodeTags = new WeakMap<object, number>();
let nextNodeTag = 1;
export function findNodeHandle(node: unknown): number | null {
  if (node == null || typeof node !== 'object') return null;
  let tag = nodeTags.get(node);
  if (tag === undefined) {
    tag = nextNodeTag++;
    nodeTags.set(node, tag);
  }
  return tag;
}

export class NativeEventEmitter {
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  addListener(event: string, cb: (ev: unknown) => void): { remove(): void } {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return {
      remove: (): void => {
        set!.delete(cb);
      },
    };
  }
  /** Test helper (not part of the real RN API): fire a fake native event. */
  __emit(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }
}

// ── Alert ────────────────────────────────────────────────────────────────
export interface AlertButton {
  text?: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}
interface LastAlert {
  title?: string;
  message?: string;
  buttons?: AlertButton[];
}
let _lastAlert: LastAlert | null = null;
export const Alert = {
  alert(title?: string, message?: string, buttons?: AlertButton[]): void {
    _lastAlert = { title, message, buttons };
  },
};
/** Test helper: the most recent Alert.alert(...) call, or null. */
export function __getLastAlert(): LastAlert | null {
  return _lastAlert;
}
export function __clearLastAlert(): void {
  _lastAlert = null;
}

// ── Linking (react-native's own, distinct from the expo-linking stub) ────
const linkingListeners = new Set<(e: { url: string }) => void>();
const _openedUrls: string[] = [];
export const Linking = {
  async openURL(url: string): Promise<void> {
    _openedUrls.push(url);
  },
  async canOpenURL(_url: string): Promise<boolean> {
    return true;
  },
  async getInitialURL(): Promise<string | null> {
    return null;
  },
  addEventListener(_event: 'url', cb: (e: { url: string }) => void): { remove(): void } {
    linkingListeners.add(cb);
    return {
      remove(): void {
        linkingListeners.delete(cb);
      },
    };
  },
};
export function __emitLinkingUrl(url: string): void {
  for (const cb of linkingListeners) cb({ url });
}
/** Test helper: URLs passed to Linking.openURL(), in call order. */
export function __getLinkingOpenedUrls(): string[] {
  return _openedUrls;
}
/** Test helper: reset the Linking.openURL() call log between tests. */
export function __resetLinkingOpenedUrls(): void {
  _openedUrls.length = 0;
}

// ── Dimensions ────────────────────────────────────────────────────────────
let _window = { width: 400, height: 800, scale: 2, fontScale: 1 };
export const Dimensions = {
  get(_which: 'window' | 'screen'): {
    width: number;
    height: number;
    scale: number;
    fontScale: number;
  } {
    return _window;
  },
  addEventListener(): { remove(): void } {
    return { remove(): void {} };
  },
};
export function __setWindowDimensions(dims: Partial<typeof _window>): void {
  _window = { ..._window, ...dims };
}
export function useWindowDimensions(): typeof _window {
  return _window;
}

// ── StyleSheet ────────────────────────────────────────────────────────────
export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T): T {
    return styles;
  },
  flatten<T>(style: T): T {
    return style;
  },
  absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  hairlineWidth: 1,
};

// ── Generic host-intrinsic factory ─────────────────────────────────────────
// A plain passthrough that renders a host node named `name`, resolving a
// function-style `style` prop against `state` (used by Pressable below).
function passthrough(
  name: string,
): React.ForwardRefExoticComponent<
  React.PropsWithoutRef<Record<string, unknown>> & React.RefAttributes<unknown>
> {
  const C = React.forwardRef<unknown, Record<string, unknown>>((props, ref) =>
    React.createElement(
      name,
      { ...props, ref },
      (props as { children?: React.ReactNode }).children,
    ),
  );
  C.displayName = name;
  return C;
}

export const View = passthrough('View');
export const Text = passthrough('Text');
export const Image = passthrough('Image');
export const ScrollView = passthrough('ScrollView');
export const ActivityIndicator = passthrough('ActivityIndicator');
export const KeyboardAvoidingView = passthrough('KeyboardAvoidingView');

// ── Pressable ───────────────────────────────────────────────────────────
// Resolves function-style `style`/`children` against its own pressed state,
// and gates the press handlers on `disabled` (mirrors real Pressable: a
// disabled Pressable never fires onPress/onLongPress).
interface PressableState {
  pressed: boolean;
}
interface PressableProps {
  style?: React.CSSProperties | ((s: PressableState) => unknown);
  children?: React.ReactNode | ((s: PressableState) => React.ReactNode);
  onPress?: (e?: unknown) => void;
  onLongPress?: (e?: unknown) => void;
  onPressIn?: (e?: unknown) => void;
  onPressOut?: (e?: unknown) => void;
  disabled?: boolean;
  [key: string]: unknown;
}
export const Pressable = React.forwardRef<unknown, PressableProps>((props, ref) => {
  const { style, children, onPress, onLongPress, onPressIn, onPressOut, disabled, ...rest } = props;
  const [pressed, setPressed] = React.useState(false);
  const resolvedStyle = typeof style === 'function' ? style({ pressed }) : style;
  const resolvedChildren = typeof children === 'function' ? children({ pressed }) : children;
  return React.createElement(
    'Pressable',
    {
      ...rest,
      ref,
      style: resolvedStyle,
      disabled,
      onPress: disabled ? undefined : onPress,
      onLongPress: disabled ? undefined : onLongPress,
      onPressIn: (e?: unknown) => {
        if (disabled) return;
        setPressed(true);
        onPressIn?.(e);
      },
      onPressOut: (e?: unknown) => {
        if (disabled) return;
        setPressed(false);
        onPressOut?.(e);
      },
    },
    resolvedChildren,
  );
});
(Pressable as React.ForwardRefExoticComponent<unknown>).displayName = 'Pressable';

// ── Switch ──────────────────────────────────────────────────────────────
export const Switch = React.forwardRef<
  unknown,
  {
    value?: boolean;
    onValueChange?: (v: boolean) => void;
    disabled?: boolean;
    [k: string]: unknown;
  }
>((props, ref) => React.createElement('Switch', { ...props, ref }));

// ── TextInput ───────────────────────────────────────────────────────────
export interface TextInputHandle {
  focus(): void;
  blur(): void;
  clear(): void;
  isFocused(): boolean;
}
export const TextInput = React.forwardRef<TextInputHandle, Record<string, unknown>>(
  (props, ref) => {
    const [focused, setFocused] = React.useState(false);
    React.useImperativeHandle(ref, () => ({
      focus: () => setFocused(true),
      blur: () => setFocused(false),
      clear: () => (props as { onChangeText?: (t: string) => void }).onChangeText?.(''),
      isFocused: () => focused,
    }));
    const { onFocus, onBlur, ...rest } = props as {
      onFocus?: () => void;
      onBlur?: () => void;
      [k: string]: unknown;
    };
    return React.createElement('TextInput', {
      ...rest,
      onFocus: (): void => {
        setFocused(true);
        onFocus?.();
      },
      onBlur: (): void => {
        setFocused(false);
        onBlur?.();
      },
    });
  },
);

// ── Modal ───────────────────────────────────────────────────────────────
// Real RN Modal only mounts its children while visible; mirrored here so
// tests can assert content is absent when closed.
export function Modal(props: {
  visible?: boolean;
  children?: React.ReactNode;
  onRequestClose?: () => void;
  [k: string]: unknown;
}): React.ReactElement | null {
  const { visible, children, ...rest } = props;
  if (!visible) return null;
  return React.createElement('Modal', rest, children);
}

// ── FlatList ────────────────────────────────────────────────────────────
export interface FlatListHandle {
  scrollToEnd(opts?: { animated?: boolean }): void;
  scrollToOffset(opts: { offset: number; animated?: boolean }): void;
  scrollToIndex(opts: { index: number; animated?: boolean }): void;
}
interface FlatListProps<T> {
  data?: T[] | null;
  renderItem: (info: { item: T; index: number }) => React.ReactElement | null;
  keyExtractor?: (item: T, index: number) => string;
  ListEmptyComponent?: React.ReactElement | React.ComponentType | null;
  ListHeaderComponent?: React.ReactElement | React.ComponentType | null;
  ListFooterComponent?: React.ReactElement | React.ComponentType | null;
  onContentSizeChange?: (w: number, h: number) => void;
  onScroll?: (e: unknown) => void;
  // Real RN's `inverted` flips render direction AND swaps which end
  // `ListHeaderComponent`/`ListFooterComponent` land on (a "footer" always
  // renders after the last DATA item, which visually is the TOP once
  // inverted). The stub mirrors both so a test tree always reads in normal
  // chronological/visual order — a caller passing already-reversed `data` +
  // `inverted` gets the SAME rendered order as the un-inverted equivalent,
  // which is what a person looking at the real screen would see.
  inverted?: boolean;
  [k: string]: unknown;
}
// Test helper: every scrollToEnd/scrollToOffset/scrollToIndex call across
// every FlatList instance, in order — a component's `listRef.current` is
// private, so this is how a test observes "did the screen scroll the list,
// and with what args" (e.g. chat-detail's scroll-restore-on-open logic).
export const __flatListCalls: Array<{ method: keyof FlatListHandle; args: unknown[] }> = [];
export function __resetFlatListCalls(): void {
  __flatListCalls.length = 0;
}
function FlatListInner<T>(
  props: FlatListProps<T>,
  ref: React.Ref<FlatListHandle>,
): React.ReactElement {
  const {
    data,
    renderItem,
    keyExtractor,
    ListEmptyComponent,
    ListHeaderComponent,
    ListFooterComponent,
    onContentSizeChange,
    onScroll,
    inverted,
    ...rest
  } = props;
  React.useImperativeHandle(ref, () => ({
    scrollToEnd: (...args) => __flatListCalls.push({ method: 'scrollToEnd', args }),
    scrollToOffset: (...args) => __flatListCalls.push({ method: 'scrollToOffset', args }),
    scrollToIndex: (...args) => __flatListCalls.push({ method: 'scrollToIndex', args }),
  }));
  const items = data ?? [];
  const displayItems = inverted ? [...items].slice().reverse() : items;
  const displayIndexFor = (i: number): number => (inverted ? items.length - 1 - i : i);
  // Simulate content-size measurement: real RN FlatList reports its content
  // height after every layout pass, both on mount AND whenever the content
  // grows (a new item streams in) — this is what lets "restore scroll
  // position on open" AND "keep pinned to the end as new messages arrive"
  // both be exercised under test. Keyed on item count (not a full deep-equal
  // of `data`) — enough for every current caller, and avoids re-firing on an
  // unrelated re-render.
  //
  // Fired via a MICROTASK, not synchronously inside the effect: on a real
  // device this callback comes from native layout, always at least one tick
  // after the current commit's synchronous effects (a screen's own
  // mount-time effects — e.g. "seed this ref from saved state" — have
  // already run by the time it arrives). Firing synchronously here made a
  // parent's same-commit effect that resets a ref on mount run AFTER this
  // one and silently clobber it — a stub-timing artifact, not a real
  // ordering a device ever produces. Tests that depend on this must
  // `await flush()` (see testUtils/render.tsx) after the render/interaction
  // that changes `data`.
  React.useEffect(() => {
    void Promise.resolve().then(() => onContentSizeChange?.(0, 0));
  }, [items.length]);
  const renderNode = (
    n: React.ReactElement | React.ComponentType | null | undefined,
    key: string,
  ): React.ReactNode => {
    if (!n) return null;
    if (React.isValidElement(n)) return React.cloneElement(n, { key });
    const Comp = n as React.ComponentType;
    return React.createElement(Comp, { key });
  };
  // A real footer sits after the last DATA item; inverted flips which visual
  // end that is, so the stub renders Footer first / Header last when inverted
  // to keep the tree in the same top-to-bottom order a person would see.
  const leadingNode = inverted ? ListFooterComponent : ListHeaderComponent;
  const trailingNode = inverted ? ListHeaderComponent : ListFooterComponent;
  return React.createElement(
    'FlatList',
    { ...rest, onScroll },
    items.length === 0
      ? renderNode(ListEmptyComponent, '__empty')
      : [
          renderNode(leadingNode, '__leading'),
          ...displayItems.map((item, displayIndex) => {
            const index = displayIndexFor(displayIndex);
            return React.cloneElement(renderItem({ item, index })!, {
              key: keyExtractor ? keyExtractor(item, index) : index,
            });
          }),
          renderNode(trailingNode, '__trailing'),
        ],
  );
}
export const FlatList = React.forwardRef(FlatListInner) as <T>(
  props: FlatListProps<T> & { ref?: React.Ref<FlatListHandle> },
) => React.ReactElement;

// ── PanResponder ────────────────────────────────────────────────────────
// Real PanResponder maps onPanResponderGrant/Move/Release/... config keys to
// low-level onStartShouldSetResponder/onResponderMove/... panHandlers. We
// don't need the negotiation dance under test — panHandlers is just the
// config object itself, so a test can invoke e.g.
// `instance.props.onPanResponderMove(fakeEvent, fakeGesture)` directly.
export const PanResponder = {
  create(config: Record<string, unknown>): { panHandlers: Record<string, unknown> } {
    return { panHandlers: config };
  },
};

// ── Animated ────────────────────────────────────────────────────────────
// A deliberately simplified stand-in: no real timer-driven interpolation (we
// have no renderer for pixels to verify), but every method used by this app
// (Value/interpolate/timing/spring/sequence/parallel/loop/delay + Animated.
// View/Image) is present with the right *shape*, and `.start()` resolves
// synchronously so effect bodies that chain animations run to completion
// under test without needing fake timers. `loop()` runs its child ONCE
// (rather than recursing forever) — enough to exercise the component code
// that sets a loop up and tears it down, without hanging the test process.
type AnimatedListener = (v: { value: number }) => void;
export class AnimatedValueImpl {
  private value: number;
  private listeners = new Map<string, AnimatedListener>();
  private nextId = 0;
  constructor(value: number) {
    this.value = value;
  }
  setValue(v: number): void {
    this.value = v;
    for (const l of this.listeners.values()) l({ value: v });
  }
  getValue(): number {
    return this.value;
  }
  addListener(l: AnimatedListener): string {
    const id = String(this.nextId++);
    this.listeners.set(id, l);
    return id;
  }
  removeListener(id: string): void {
    this.listeners.delete(id);
  }
  removeAllListeners(): void {
    this.listeners.clear();
  }
  stopAnimation(cb?: (v: number) => void): void {
    cb?.(this.value);
  }
  interpolate(_config: { inputRange: number[]; outputRange: number[] }): {
    __kind: 'interpolation';
    interpolate: AnimatedValueImpl['interpolate'];
  } {
    return {
      __kind: 'interpolation',
      interpolate: this.interpolate.bind(this),
    };
  }
}
interface CompositeAnimation {
  start(cb?: (r: { finished: boolean }) => void): void;
  stop(): void;
}
function animationOf(target?: AnimatedValueImpl, toValue?: number): CompositeAnimation {
  return {
    start(cb): void {
      if (target && typeof toValue === 'number') target.setValue(toValue);
      cb?.({ finished: true });
    },
    stop(): void {},
  };
}
export const Animated = {
  Value: AnimatedValueImpl,
  View: passthrough('Animated.View'),
  Text: passthrough('Animated.Text'),
  Image: passthrough('Animated.Image'),
  ScrollView: passthrough('Animated.ScrollView'),
  timing(target: AnimatedValueImpl, config: { toValue: number }): CompositeAnimation {
    return animationOf(target, config.toValue);
  },
  spring(target: AnimatedValueImpl, config: { toValue: number }): CompositeAnimation {
    return animationOf(target, config.toValue);
  },
  decay(target: AnimatedValueImpl, config: { toValue?: number }): CompositeAnimation {
    return animationOf(target, config.toValue);
  },
  delay(_ms: number): CompositeAnimation {
    return { start: (cb): void => cb?.({ finished: true }), stop: (): void => {} };
  },
  sequence(anims: CompositeAnimation[]): CompositeAnimation {
    return {
      start(cb): void {
        for (const a of anims) a.start();
        cb?.({ finished: true });
      },
      stop(): void {
        for (const a of anims) a.stop();
      },
    };
  },
  parallel(anims: CompositeAnimation[]): CompositeAnimation {
    return {
      start(cb): void {
        for (const a of anims) a.start();
        cb?.({ finished: true });
      },
      stop(): void {
        for (const a of anims) a.stop();
      },
    };
  },
  loop(anim: CompositeAnimation): CompositeAnimation {
    // Simplified: run the child ONCE rather than forever (see class doc).
    return {
      start(cb): void {
        anim.start();
        cb?.({ finished: true });
      },
      stop(): void {
        anim.stop();
      },
    };
  },
};

// ── Easing ──────────────────────────────────────────────────────────────
const identityEasing = (t: number): number => t;
export const Easing = {
  linear: identityEasing,
  ease: identityEasing,
  quad: identityEasing,
  cubic: identityEasing,
  sin: identityEasing,
  circle: identityEasing,
  exp: identityEasing,
  bounce: identityEasing,
  elastic: () => identityEasing,
  back: () => identityEasing,
  bezier: () => identityEasing,
  poly: () => identityEasing,
  step0: identityEasing,
  step1: identityEasing,
  in: (fn: (t: number) => number) => fn,
  out: (fn: (t: number) => number) => fn,
  inOut: (fn: (t: number) => number) => fn,
};

// Type-only re-exports used across the app (erased at runtime).
export type NativeSyntheticEvent<T> = { nativeEvent: T };
export interface NativeScrollEvent {
  contentOffset: { x: number; y: number };
  contentSize: { width: number; height: number };
  layoutMeasurement: { width: number; height: number };
}
