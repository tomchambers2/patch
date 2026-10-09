// The models a new chat can spawn on (spec/14 § Model selector, spec/02 §
// Model catalogue). The choice is forwarded as the SDK `--model` override on
// spawn (POST /api/chats { model }), so it's a per-chat, spawn-time setting.
//
// The list is LIVE, never a constant in this file: `GET /api/models` →
// server → host → Anthropic's model list, cached host-side on a TTL. A
// hand-maintained array is exactly what went stale (todo: "should regularly
// update models, opus 5 is missing"), so there is none here.
//
// NO FALLBACK: until the catalogue loads it is empty and `status` says why; a
// failed load carries the error. The picker renders that state rather than a
// plausible-looking list that may be wrong.
//
// The model is OPTIONAL on a spawn. Omitted, the chat takes the ACCOUNT's
// default model (spec/04 § Spawn), so this module holds no default id and no
// surface-local last-used — see the note at the foot of the file.

import { useSyncExternalStore } from 'react';
import { api } from '../api/rest.js';

export interface ModelOption {
  /** SDK `options.model` value. */
  id: string;
  label: string;
}

export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ModelCatalog {
  models: readonly ModelOption[];
  status: ModelCatalogStatus;
  /**
   * Set when `status === 'error'` — the machine-readable code, which the
   * picker turns into a sentence and keeps as its Details (`lib/errorCopy.ts`).
   */
  error?: string;
  /** When the host last read the list from Anthropic (ISO 8601). */
  fetchedAt?: string;
}

const EMPTY: ModelCatalog = { models: [], status: 'idle' };

let catalog: ModelCatalog = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getModelCatalog(): ModelCatalog {
  return catalog;
}

/** Replace the catalogue (used by `loadModels`, and by tests to seed a state). */
export function setModelCatalog(next: {
  models?: readonly ModelOption[];
  status: ModelCatalogStatus;
  error?: string;
  fetchedAt?: string;
}): void {
  catalog = {
    models: next.models ?? [],
    status: next.status,
    ...(next.error !== undefined ? { error: next.error } : {}),
    ...(next.fetchedAt !== undefined ? { fetchedAt: next.fetchedAt } : {}),
  };
  emit();
}

/** Back to first-load state — tests only. */
export function resetModelCatalog(): void {
  catalog = EMPTY;
  inFlight = null;
  emit();
}

export function subscribeModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React view of the catalogue — re-renders the picker as it loads / fails. */
export function useModelCatalog(): ModelCatalog {
  return useSyncExternalStore(subscribeModelCatalog, getModelCatalog, getModelCatalog);
}

let inFlight: Promise<void> | null = null;
/** Which machine the cached catalogue belongs to — null before any load. */
let loadedFor: string | null = null;

/**
 * Load (or reload) the catalogue from the host. Concurrent callers share one
 * request. Never throws — the failure lands in the catalogue's `error` so the
 * picker can show it.
 */
export function loadModels(daemonId: string | null, force = false): Promise<void> {
  // The catalogue is PER MACHINE (spec/02 § Model catalogue) — `/api/models`
  // requires the machine whose catalogue is being read, and rejects a call that
  // names none. Asking without one produced `invalid query` and an empty picker.
  if (!daemonId) {
    setModelCatalog({
      models: [],
      status: 'error',
      // A code, like every other value that lands here — the picker is what
      // turns it into a sentence (`lib/errorCopy.ts`).
      error: 'no_machine_chosen',
    });
    return Promise.resolve();
  }
  if (inFlight && loadedFor === daemonId) return inFlight;
  // A different machine means a different catalogue; a cached one must not be
  // shown for it.
  if (!force && catalog.status === 'ready' && loadedFor === daemonId) return Promise.resolve();
  loadedFor = daemonId;
  setModelCatalog({ models: catalog.models, status: 'loading' });
  inFlight = api
    .models(daemonId)
    .then((res) => {
      setModelCatalog({
        models: res.models,
        status: 'ready',
        ...(res.fetchedAt !== undefined ? { fetchedAt: res.fetchedAt } : {}),
      });
    })
    .catch((err: unknown) => {
      setModelCatalog({
        models: [],
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// There is deliberately NO surface-local "last used model" here, and no default
// model id. Last-used follows the MACHINE, not the surface that asked
// (spec/04-chats-and-folders.md § Spawn: "a host records the model of each chat
// spawned on it, so the last-used value follows the machine rather than the
// surface that asked"). The host reports it as `daemon.host.defaultModel`, and
// a spawn that names no model resolves against it on the host.
//
// A browser-local copy plus a hard-coded starting id is what made the surface's
// default win: a first-run browser sent `claude-opus-5` on every spawn and
// overwrote whatever the machine was actually last used on.

/** A provider's connected accounts changed; refresh only the visible host. */
export async function refreshModelsForHost(daemonId: string): Promise<void> {
  if (loadedFor !== daemonId) return;
  if (inFlight) await inFlight;
  if (loadedFor === daemonId) await loadModels(daemonId, true);
}
