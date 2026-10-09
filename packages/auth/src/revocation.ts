// Revocation registry primitive.
//
// Per spec/10-auth.md "Revocation": any linked surface can be revoked, and
// the server invalidates the JWT + terminates the WebSocket. The persistent
// registry lives in /data/registry.json (group 5 owns it). Here we provide:
//
//   - the type-safe `RevocationStoreInterface` the server implements
//   - an in-memory `RevocationStore` for tests and the host's local cache

export interface RevocationStoreInterface {
  revoke(surfaceId: string): void | Promise<void>;
  isRevoked(surfaceId: string): boolean | Promise<boolean>;
}

export class RevocationStore implements RevocationStoreInterface {
  private revoked = new Set<string>();

  revoke(surfaceId: string): void {
    if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
      throw new Error('RevocationStore.revoke: surfaceId must be a non-empty string');
    }
    this.revoked.add(surfaceId);
  }

  isRevoked(surfaceId: string): boolean {
    return this.revoked.has(surfaceId);
  }

  /** Test helper. */
  size(): number {
    return this.revoked.size;
  }

  /** Test helper — wipe state. */
  clear(): void {
    this.revoked.clear();
  }
}
