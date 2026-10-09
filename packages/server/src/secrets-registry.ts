// Server-side mirror of the host-owned secret store (spec/15 § Secrets).
//
// The host owns the secret store and publishes it over the host link:
// `secrets.list` (snapshot on connect) and `secrets.updated` (push on change,
// after a set/delete lands). The ws-hub fans those account-scoped events
// straight out to every live surface; this mirror caches the latest set so the
// cold-start REST endpoint (`GET /api/secrets`) can serve a surface that
// connected AFTER the host's snapshot — exactly how `FolderRegistry` backs
// `GET /api/folders`.
//
// Purely in-memory: on server restart the mirror is empty until the host
// reconnects and re-publishes its `secrets.list`. NO FALLBACK — an empty list
// means the host has not published yet, never a fabricated set.

import type { SecretEntry, WireEvent } from '@patch/wire';

export class SecretsRegistry {
  private secrets: SecretEntry[] = [];

  /** Update the mirror from a host secrets event. Ignores everything else. */
  observe(event: WireEvent): void {
    if (event.type === 'secrets.list' || event.type === 'secrets.updated') {
      this.secrets = event.secrets.map((s) => ({ key: s.key, value: s.value }));
    }
  }

  /** The most-recent secret set the host published (ordered as published). */
  list(): SecretEntry[] {
    return this.secrets.map((s) => ({ key: s.key, value: s.value }));
  }
}
