// The models a chat can be spawned on, read live from a host's catalogue
// (spec/02 § Model catalogue, spec/15 § New chat flow → Model picker).
//
// The catalogue is PER MACHINE — `/api/models` is addressed to the host whose
// backends are being read — so this hook takes the daemonId and re-reads when
// it changes. Showing one machine's models for a spawn pinned to another is how
// an unrunnable model id gets sent.
//
// NO FALLBACK: a failed read leaves the list empty and carries the reason, for
// the picker to print. There is deliberately no baked-in array of model names
// here — a hand-maintained list is exactly what goes stale, and a plausible
// wrong list is worse than a stated error.
//
// There is likewise no default model id here. A spawn that names no model is
// resolved by the HOST (spec/04 § Spawn), so a surface-local default would
// silently overwrite the machine's own answer.

import React from 'react';
import { api } from '../api/rest';
import { usePresenceStore } from '../stores/presenceStore';

export interface ModelOption {
  /** The backend's model id — what a spawn sends as `model`. */
  id: string;
  label: string;
}

export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ModelCatalog {
  models: ModelOption[];
  status: ModelCatalogStatus;
  /** The failure, verbatim, when `status === 'error'`. Null otherwise. */
  error: string | null;
}

/**
 * Read `daemonId`'s catalogue. `idle` while no host has been resolved — there
 * is nothing to ask, and asking without one is an error the server raises.
 */
export function useModelCatalog(daemonId: string | null): ModelCatalog {
  const accountState = usePresenceStore((s) =>
    JSON.stringify(
      Object.values(daemonId ? (s.hosts[daemonId]?.accounts ?? {}) : {}).map((a) => [
        a.backendId,
        a.connected,
        a.accounts?.map((x) => [x.id, x.kind, x.connected]),
      ]),
    ),
  );
  const [catalog, setCatalog] = React.useState<ModelCatalog>({
    models: [],
    status: 'idle',
    error: null,
  });

  React.useEffect(() => {
    if (daemonId === null || daemonId === '') {
      setCatalog({ models: [], status: 'idle', error: null });
      return;
    }
    let live = true;
    setCatalog({ models: [], status: 'loading', error: null });
    void api
      .models(daemonId)
      .then((r) => {
        if (live) setCatalog({ models: r.models ?? [], status: 'ready', error: null });
      })
      .catch((e: unknown) => {
        if (live) {
          setCatalog({ models: [], status: 'error', error: (e as Error).message });
        }
      });
    return () => {
      live = false;
    };
  }, [daemonId, accountState]);

  return catalog;
}
