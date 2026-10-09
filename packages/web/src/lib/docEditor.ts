// Document editor — modes, suggestions, comments, history (spec/14 §
// Document editor, step 2 of 3). One query (the sidecar view) and one
// dispatcher (every mutation) for whichever `.md` file the file browser has
// open — `EditorRail.tsx`'s `BrowsePanel` is the sole caller.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocAction, DocView } from '@patch/wire';
import { api } from '../api/rest.js';

export function docViewQueryKey(chatId: string | null, path: string | null): unknown[] {
  return ['doc-view', chatId, path];
}

export function useDocView(
  chatId: string | null,
  path: string | null,
  enabled: boolean,
): {
  view: DocView | undefined;
  error: unknown;
  dispatch: (action: DocAction) => Promise<DocView>;
} {
  const queryClient = useQueryClient();
  const queryKey = docViewQueryKey(chatId, path);
  const { data, error } = useQuery({
    queryKey,
    queryFn: () => api.getDoc(chatId as string, path as string),
    enabled: chatId !== null && path !== null && enabled,
  });
  async function dispatch(action: DocAction): Promise<DocView> {
    const view = await api.docAction(chatId as string, path as string, action);
    queryClient.setQueryData(queryKey, view);
    return view;
  }
  return { view: data, error, dispatch };
}
