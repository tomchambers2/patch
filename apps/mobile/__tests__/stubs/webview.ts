// react-native-webview stand-in for unit tests. Renders a host 'WebView' node
// carrying every prop (so a test can read `source.html` and call `onMessage`
// as the page would), and records every `injectJavaScript` call made through
// its ref — the only way the app talks to the page.

import React from 'react';

export const __injected: string[] = [];

export function __resetWebView(): void {
  __injected.length = 0;
}

export interface WebViewMessageEvent {
  nativeEvent: { data: string };
}

export interface WebViewHandle {
  injectJavaScript(script: string): void;
}

export const WebView = React.forwardRef<WebViewHandle, Record<string, unknown>>((props, ref) => {
  React.useImperativeHandle(ref, () => ({
    injectJavaScript: (script: string) => {
      __injected.push(script);
    },
  }));
  return React.createElement('WebView', props);
});
WebView.displayName = 'WebView';

// The real module's WebView is a class, used as a ref type (`useRef<WebView>`).
export type WebView = WebViewHandle;

export default WebView;
