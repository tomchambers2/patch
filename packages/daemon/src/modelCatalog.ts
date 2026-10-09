// spec/02 § Model catalogue — the models a new chat can spawn on, read from
// Anthropic rather than hard-coded in a surface. The host owns this because
// the host owns the Claude Code OAuth credential (spec/10); no surface holds
// a model API key (principles.md).
//
// Cached for MODELS_TTL_MS so the picker doesn't hit Anthropic on every open,
// and re-read after that so a model released since the last deploy shows up
// (todo: "should regularly update models, opus 5 is missing").
//
// NO FALLBACK: no baked-in list, no invented entries. A missing credential, a
// non-2xx, or an empty upstream list throws, and the caller turns that into an
// error on the wire. The only thing kept is a catalogue Anthropic actually
// returned — serving that past its TTL when a refresh fails is a cache, not a
// fallback, and it is flagged `stale` so the surface can say so.

import { ANTHROPIC_API_VERSION, ANTHROPIC_OAUTH_BETA } from '@patch/auth';
import type { RunOnAccountWithCredit } from './accountFailover.js';

/** How long a successfully read catalogue is served before re-reading. */
export const MODELS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
// Shared with the token-validation call in @patch/auth so there is exactly one
// definition of "how patch authenticates to Anthropic with an OAuth token".
const ANTHROPIC_VERSION = ANTHROPIC_API_VERSION;
// OAuth (not x-api-key) access to the Messages/Models API requires this beta.
const OAUTH_BETA = ANTHROPIC_OAUTH_BETA;

export interface ModelOption {
  /** SDK `options.model` value. */
  id: string;
  label: string;
}

export interface ModelCatalogSnapshot {
  models: ModelOption[];
  /** ISO 8601 — when this list was read from Anthropic. */
  fetchedAt: string;
  /** True when the TTL has passed but the refresh failed, so this is the last good read. */
  stale: boolean;
}

interface AnthropicModel {
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
}

export interface ModelCatalogOptions {
  /**
   * The host's AI-call gate (spec/10) — re-read per refresh, never cached.
   * Walks the stored accounts so a spent key does not empty the model picker.
   */
  runOnAccountWithCredit: RunOnAccountWithCredit;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Injected in tests; defaults to MODELS_TTL_MS. */
  ttlMs?: number;
}

export class ModelCatalog {
  private readonly runOnAccountWithCredit: RunOnAccountWithCredit;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;

  private cached: { models: ModelOption[]; fetchedAt: string; at: number } | null = null;
  private inFlight: Promise<ModelCatalogSnapshot> | null = null;

  constructor(opts: ModelCatalogOptions) {
    this.runOnAccountWithCredit = opts.runOnAccountWithCredit;
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? MODELS_TTL_MS;
  }

  /**
   * The current catalogue: the cached one while it is inside its TTL, otherwise
   * a fresh read. Concurrent callers share one upstream request. Throws when
   * there is nothing real to return.
   */
  async get(): Promise<ModelCatalogSnapshot> {
    const cached = this.cached;
    if (cached !== null && this.now() - cached.at < this.ttlMs) {
      return { models: cached.models, fetchedAt: cached.fetchedAt, stale: false };
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh()
      .catch((err: unknown) => {
        // A refresh failure does not throw away a catalogue Anthropic really
        // gave us — it is served, flagged stale, until the next attempt works.
        if (this.cached !== null) {
          return { models: this.cached.models, fetchedAt: this.cached.fetchedAt, stale: true };
        }
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async refresh(): Promise<ModelCatalogSnapshot> {
    const snapshot = await this.runOnAccountWithCredit('model catalogue', (accessToken) =>
      this.fetchCatalogue(accessToken),
    );
    if (snapshot === null) {
      throw new Error('Claude OAuth unavailable for the model catalogue: no account has credit');
    }
    return snapshot;
  }

  private async fetchCatalogue(accessToken: string): Promise<ModelCatalogSnapshot> {
    const res = await this.fetchImpl(MODELS_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': OAUTH_BETA,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic /v1/models failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: unknown };
    const raw = Array.isArray(body.data) ? (body.data as AnthropicModel[]) : [];
    const models = raw
      .filter((m): m is AnthropicModel & { id: string } => typeof m.id === 'string' && m.id !== '')
      .map((m) => ({
        model: {
          id: m.id,
          label:
            typeof m.display_name === 'string' && m.display_name !== '' ? m.display_name : m.id,
        },
        createdAt: typeof m.created_at === 'string' ? Date.parse(m.created_at) : Number.NaN,
      }))
      // Newest first — the model you most likely want is the one at the top.
      .sort(
        (a, b) =>
          (Number.isNaN(b.createdAt) ? 0 : b.createdAt) -
          (Number.isNaN(a.createdAt) ? 0 : a.createdAt),
      )
      .map((m) => m.model);
    if (models.length === 0) {
      throw new Error('Anthropic /v1/models returned no models');
    }
    const fetchedAt = new Date(this.now()).toISOString();
    this.cached = { models, fetchedAt, at: this.now() };
    return { models, fetchedAt, stale: false };
  }
}
