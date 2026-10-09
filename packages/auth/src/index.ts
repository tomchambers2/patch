// @patch/auth — auth primitives consumed by the server, host, and surfaces.
//
// See packages/auth/README.md for the trust model.

export {
  generateUserKeypair,
  loadUserIdentity,
  getAccountId,
  type UserKeypair,
  type RandomBytesFn,
} from './identity.js';

export {
  mintSurfaceCredential,
  verifySurfaceCredential,
  SURFACE_KINDS,
  SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS,
  type SurfaceKind,
  type SurfaceCredentialClaims,
  type MintSurfaceCredentialOptions,
  type VerifySurfaceCredentialOptions,
} from './jwt.js';

export {
  mintDaemonKey,
  verifyDaemonKey,
  type DaemonKeyClaims,
  type MintDaemonKeyOptions,
} from './daemon-key.js';

export {
  createPairingNonce,
  completePairing,
  InMemoryPairingNonceStore,
  PAIRING_NONCE_TTL_MS,
  PAIRING_NONCE_BYTES,
  type CreatedPairingNonce,
  type CreatePairingNonceOptions,
  type CompletePairingOptions,
  type PairingNonceRecord,
  type PairingNonceStore,
} from './pairing.js';

export {
  loadClaudeOAuth,
  // Patch's own credential store — the only source consulted once it exists.
  loadLegacyClaudeOAuth,
  resolvePatchStorePath,
  readPatchStore,
  writePatchStore,
  seedPatchStore,
  disconnectPatchStore,
  connectPatchStore,
  addPatchStoreAccount,
  listPatchStoreAccounts,
  findAccountByOrganization,
  setAccountOrganization,
  DEFAULT_ACCOUNT_ID,
  type PatchStoredCredential,
  type PatchStoreContents,
  type ClaudeStoredAccount,
  clearClaudeOAuth,
  getClaudeOAuthToken,
  resolveClaudeConfigPath,
  refreshClaudeOAuth,
  validateClaudeOAuthToken,
  persistClaudeOAuth,
  isClaudeOAuthStale,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REFRESH_SKEW_MS,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_VALIDATE_URL,
  type ClaudeTokenValidation,
  type ValidateClaudeOAuthOptions,
  type ClaudeOAuthCredentials,
  type ClaudeOAuthSourceKind,
  type LoadClaudeOAuthOptions,
  type ClearClaudeOAuthOptions,
  type ClearClaudeOAuthResult,
  type RefreshClaudeOAuthOptions,
  type PersistClaudeOAuthOptions,
} from './claude-oauth.js';

export {
  fetchClaudeUsage,
  fetchClaudeOrganizationId,
  readUsageHeaders,
  ORGANIZATION_HEADER,
  ANTHROPIC_IDENTITY_URL,
  type ClaudeUsageScope,
  type ClaudeUsageWindow,
  type ClaudeUsageReading,
  type ClaudeUsageResult,
  type ClaudeUsageOptions,
} from './claude-usage.js';

export { RevocationStore, type RevocationStoreInterface } from './revocation.js';

export {
  AuthError,
  ClaudeOAuthMissingError,
  ClaudeOAuthMalformedError,
  PairingNonceExpiredError,
  PairingNonceUnknownError,
  CredentialVerificationError,
  CredentialExpiredError,
  CredentialBindingError,
  CredentialMissingExpError,
  CredentialFutureIatError,
} from './errors.js';
