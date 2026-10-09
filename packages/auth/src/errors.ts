// Typed errors. Per portfolio rules: NO FALLBACKS — every failure is a
// distinct, named error so callers can surface a precise message.

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ClaudeOAuthMissingError extends AuthError {
  constructor(public readonly path: string) {
    super(`Claude OAuth credentials not found at ${path}. Run \`claude login\` on the host.`);
    this.name = 'ClaudeOAuthMissingError';
  }
}

export class ClaudeOAuthMalformedError extends AuthError {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Claude OAuth file at ${path} is malformed: ${reason}`);
    this.name = 'ClaudeOAuthMalformedError';
  }
}

export class PairingNonceExpiredError extends AuthError {
  constructor() {
    super('Pairing nonce expired');
    this.name = 'PairingNonceExpiredError';
  }
}

export class PairingNonceUnknownError extends AuthError {
  constructor() {
    super('Pairing nonce unknown or already consumed');
    this.name = 'PairingNonceUnknownError';
  }
}

export class CredentialVerificationError extends AuthError {
  constructor(reason: string) {
    super(`Credential verification failed: ${reason}`);
    this.name = 'CredentialVerificationError';
  }
}

export class CredentialBindingError extends AuthError {
  constructor(reason: string) {
    super(`Pairing credential binding failed: ${reason}`);
    this.name = 'CredentialBindingError';
  }
}

/**
 * The credential is structurally valid and signed by the master key, but its
 * `exp` is in the past. This is a TRANSIENT condition (the surface can refresh
 * or re-mint) and is deliberately distinct from a genuine revocation — callers
 * must NOT treat an expired token as a destructive "wipe credential + re-pair"
 * signal.
 */
export class CredentialExpiredError extends AuthError {
  constructor(public readonly exp: number | undefined) {
    super(
      exp !== undefined ? `Surface credential expired (exp=${exp})` : 'Surface credential expired',
    );
    this.name = 'CredentialExpiredError';
  }
}

export class CredentialMissingExpError extends AuthError {
  constructor() {
    super('Surface credential is missing required `exp` claim');
    this.name = 'CredentialMissingExpError';
  }
}

export class CredentialFutureIatError extends AuthError {
  constructor(iat: number, now: number) {
    super(`Surface credential iat=${iat} is in the future (now=${now}, tolerance=60s)`);
    this.name = 'CredentialFutureIatError';
  }
}
