// What a screen's own back control does (spec/15 § Navigation shell): return
// to the screen the user was on before, wherever that was, and go to the
// screen's parent only when there is nothing beneath it in the stack.
//
// "Nothing beneath" is real: a launcher shortcut or a patch:// link opened on a
// cold start mounts its screen as the only one in the stack, and a bare
// `router.back()` there does nothing — a back arrow that is dead to the tap.

import { useCallback } from 'react';
import { useRouter, type Href } from 'expo-router';

/** The router surface `goBack` needs — satisfied by expo-router's `useRouter()`. */
export interface BackRouter {
  canGoBack(): boolean;
  back(): void;
  replace(href: Href): void;
}

export function goBack(router: BackRouter, parent: Href): void {
  if (router.canGoBack()) router.back();
  else router.replace(parent);
}

/** A stable handler for a back control whose parent screen is `parent`. */
export function useGoBack(parent: Href): () => void {
  const router = useRouter();
  return useCallback(() => goBack(router, parent), [router, parent]);
}
