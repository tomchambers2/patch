// react-native-svg stub for unit tests. Each primitive is a thin host node.
import React from 'react';

export default function Svg(props: {
  children?: React.ReactNode;
  [k: string]: unknown;
}): React.ReactElement {
  return React.createElement('Svg', props, props.children);
}
export function Rect(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('Rect', props);
}
export function Circle(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('Circle', props);
}
export function Path(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('Path', props);
}
