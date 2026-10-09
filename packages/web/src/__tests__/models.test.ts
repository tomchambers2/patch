// Model catalogue.
//
// The list of selectable models is LIVE (spec/14 § Model selector): the surface
// loads it from `GET /api/models`, which the host answers from Anthropic's
// model list. It is never a hand-maintained constant — that is what let the
// picker go stale (todo: "should regularly update models, opus 5 is missing").
// NO FALLBACK: before it loads the catalogue is empty and its status says so.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as models from '../lib/models.js';
import {
  getModelCatalog,
  setModelCatalog,
  subscribeModelCatalog,
  loadModels,
  resetModelCatalog,
} from '../lib/models.js';

const LAST_USED_KEY = 'patch.model.lastUsed';

describe('model catalogue', () => {
  beforeEach(() => {
    localStorage.removeItem(LAST_USED_KEY);
    resetModelCatalog();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts empty — there is no baked-in model list to go stale', () => {
    const cat = getModelCatalog();
    expect(cat.models).toEqual([]);
    expect(cat.status).toBe('idle');
  });

  it('loads the live catalogue from /api/models and notifies subscribers', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              { id: 'claude-opus-5', label: 'Claude Opus 5' },
              { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
            ],
            fetchedAt: '2026-08-03T09:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const seen: number[] = [];
    const unsub = subscribeModelCatalog(() => seen.push(getModelCatalog().models.length));

    await loadModels('host-a');

    const firstCall = fetchMock.mock.calls[0] as unknown as unknown[];
    expect(String(firstCall[0])).toBe('/api/models?daemonId=host-a');
    const cat = getModelCatalog();
    expect(cat.status).toBe('ready');
    expect(cat.models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(seen.length).toBeGreaterThan(0);
    unsub();
  });

  it('surfaces a load failure instead of falling back to a stale list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'daemon_timeout' }), { status: 504 })),
    );

    await loadModels('host-a');

    const cat = getModelCatalog();
    expect(cat.status).toBe('error');
    expect(cat.models).toEqual([]);
    expect(cat.error).toBeTruthy();
  });

  it('offers no synthetic "Default model" row — every option is a real model', () => {
    setModelCatalog({
      status: 'ready',
      models: [{ id: 'claude-opus-5', label: 'Claude Opus 5' }],
    });
    for (const m of getModelCatalog().models) {
      expect(m.id).not.toBe('');
      expect(m.label).not.toBe('Default model');
    }
  });
});

// Last-used follows the MACHINE, not this browser (spec/04 § Spawn: "the
// last-used value follows the machine rather than the surface that asked"). A
// browser-local copy plus a hard-coded starting id is what made a fresh SPA send
// `claude-opus-5` on every spawn and overwrite the host's real last-used model.
describe('no surface-local model default', () => {
  it('exports no default model id and no surface-local last-used accessors', () => {
    expect(Object.keys(models).sort()).toEqual([
      'getModelCatalog',
      'loadModels',
      'refreshModelsForHost',
      'resetModelCatalog',
      'setModelCatalog',
      'subscribeModelCatalog',
      'useModelCatalog',
    ]);
  });

  it('writes no last-used key to localStorage when the catalogue loads', async () => {
    resetModelCatalog();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ id: 'm1', label: 'M1' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await loadModels('host-a', true);
    expect(localStorage.getItem(LAST_USED_KEY)).toBeNull();
  });
});

// The catalogue is per MACHINE. The web asked `/api/models` with no daemonId,
// which the server rejects (`ModelsQuery` is strict), so the picker showed
// "Couldn't load models — invalid query" and offered nothing.
describe('the catalogue is per machine', () => {
  it('names the machine in the request', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(JSON.stringify({ models: [{ id: 'm', label: 'M' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await loadModels('host-b', true);
    expect(String(fetchMock.mock.lastCall?.[0])).toContain('daemonId=host-b');
  });

  it('refuses to ask without a machine, and says why', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await loadModels(null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getModelCatalog().status).toBe('error');
    expect(getModelCatalog().error).toContain('machine');
  });

  it('re-fetches when the machine changes — a cached list must not be shown for another', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(JSON.stringify({ models: [{ id: 'm', label: 'M' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await loadModels('host-a', true);
    await loadModels('host-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.lastCall?.[0])).toContain('daemonId=host-b');
  });
});

it('refreshes the active host after a provider connects without switching hosts or reloading', async () => {
  resetModelCatalog();
  let list = [{ id: 'claude-test', label: 'Claude' }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ models: list }), { status: 200 })),
  );
  try {
    await loadModels('host-a');
    list = [...list, { id: 'openai/test', label: 'ChatGPT' }];
    await models.refreshModelsForHost('host-b');
    expect(getModelCatalog().models).toHaveLength(1);
    await models.refreshModelsForHost('host-a');
    expect(getModelCatalog().models).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
