// useGoBack — what a page's own Back control does (spec/14 § Layout —
// desktop): step back to the page the user was actually on, wherever that
// was, and only go to the page's parent when this window's history has
// nothing earlier to return to (a deep link, a reload into a fresh window).
//
// A hardcoded parent is wrong the moment a page has a second way in: the job
// editor opened from a chat, a settings page opened from a chat's banner. Router
// state naming the origin is wrong too, because every caller has to remember
// to set it and a history replay drops it.
//
// react-router marks the first entry a router was created with by the key
// 'default' — in the BrowserRouter as much as the dev harness's MemoryRouter —
// so any other key means there is an in-app entry behind this one.

import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export function useGoBack(parent: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (key === 'default') navigate(parent);
    else navigate(-1);
  }, [key, navigate, parent]);
}
