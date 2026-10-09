// Web Bot Auth (RFC 9421 HTTP Message Signatures, profile
// draft-meunier-web-bot-auth-architecture) for Patch's own browsers, plus the
// signed key directory (draft-meunier-http-message-signatures-directory) that
// lets a site verify them. Node-only (node:crypto), so it is a subpath export
// (`@patch/wire/web-bot-auth`), never part of the browser-safe index.
//
// One Ed25519 key. Its private half is a base64 PKCS#8 DER string held in the
// 1Password Agents vault (env-patch / PATCH_WEB_BOT_AUTH_KEY); nothing here
// reads or writes disk.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as edSign,
  type KeyObject,
} from 'node:crypto';

export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const DIRECTORY_CONTENT_TYPE = 'application/http-message-signatures-directory+json';
export const DEFAULT_DIRECTORY_URL = `https://patch.tomchambers.me${DIRECTORY_PATH}`;
export const SIGNATURE_LABEL = 'sig1';
/** How long a request signature stays valid. Short: it is minted per request. */
export const REQUEST_SIGNATURE_TTL_S = 60;
/** How long a signed directory response stays valid. */
export const DIRECTORY_SIGNATURE_TTL_S = 300;

export interface WebBotAuthKey {
  privateKey: KeyObject;
  /** Public JWK (kty/crv/x). */
  jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  /** RFC 7638 JWK thumbprint, base64url — the `keyid` on every signature. */
  keyId: string;
}

/** Parse the vault value (base64 PKCS#8 DER). Throws on anything else. */
export function parseWebBotAuthKey(b64: string): WebBotAuthKey {
  const trimmed = b64.trim();
  if (!trimmed) throw new Error('web-bot-auth: private key is empty');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(trimmed, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (err) {
    throw new Error(`web-bot-auth: private key is not base64 PKCS#8: ${(err as Error).message}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`web-bot-auth: key is ${privateKey.asymmetricKeyType}, must be ed25519`);
  }
  const exported = createPublicKey(privateKey).export({ format: 'jwk' });
  const jwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: String(exported.x) };
  // RFC 7638: required members, lexicographic order, no whitespace.
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
  const keyId = createHash('sha256').update(canonical).digest('base64url');
  return { privateKey, jwk, keyId };
}

export interface SignOptions {
  now?: () => number;
  nonce?: () => string;
}

function params(
  components: string[],
  key: WebBotAuthKey,
  created: number,
  expires: number,
  tag: string,
  nonce?: string,
): string {
  const list = components.join(' ');
  return (
    `(${list});created=${created};expires=${expires};keyid="${key.keyId}";alg="ed25519"` +
    `${nonce ? `;nonce="${nonce}"` : ''};tag="${tag}"`
  );
}

function sign(key: WebBotAuthKey, base: string): string {
  return edSign(null, Buffer.from(base), key.privateKey).toString('base64');
}

/**
 * The `@authority` of a URL as RFC 9421 §2.2.3 defines it: lowercase host, port
 * only when it is not the scheme's default. `URL.host` already does exactly that.
 */
export function authorityOf(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`web-bot-auth: cannot sign a ${u.protocol} request`);
  }
  return u.host;
}

/**
 * Headers to add to an outgoing request. Per request, because `@authority`
 * changes with the target and the signature carries its own created/expires/nonce.
 */
export function signRequestHeaders(
  url: string,
  key: WebBotAuthKey,
  directoryUrl: string,
  opts: SignOptions = {},
): Record<string, string> {
  const created = Math.floor((opts.now ?? Date.now)() / 1000);
  const nonce = (opts.nonce ?? (() => randomBytes(32).toString('base64')))();
  const signatureAgent = `"${directoryUrl}"`;
  const sigParams = params(
    ['"@authority"', '"signature-agent"'],
    key,
    created,
    created + REQUEST_SIGNATURE_TTL_S,
    'web-bot-auth',
    nonce,
  );
  const base =
    `"@authority": ${authorityOf(url)}\n` +
    `"signature-agent": ${signatureAgent}\n` +
    `"@signature-params": ${sigParams}`;
  return {
    'Signature-Agent': signatureAgent,
    'Signature-Input': `${SIGNATURE_LABEL}=${sigParams}`,
    Signature: `${SIGNATURE_LABEL}=:${sign(key, base)}:`,
  };
}

/**
 * The key directory body and its response headers. The response is itself
 * signed with the key (tag `http-message-signatures-directory`, covering the
 * request's `@authority`), which is how a verifier knows the directory is the
 * agent's own.
 */
export function directoryResponse(
  authority: string,
  key: WebBotAuthKey,
  opts: SignOptions = {},
): { headers: Record<string, string>; body: string } {
  const created = Math.floor((opts.now ?? Date.now)() / 1000);
  const sigParams = params(
    ['"@authority";req'],
    key,
    created,
    created + DIRECTORY_SIGNATURE_TTL_S,
    'http-message-signatures-directory',
  );
  const base = `"@authority";req: ${authority}\n"@signature-params": ${sigParams}`;
  return {
    headers: {
      'Content-Type': DIRECTORY_CONTENT_TYPE,
      'Cache-Control': 'max-age=300',
      'Signature-Input': `${SIGNATURE_LABEL}=${sigParams}`,
      Signature: `${SIGNATURE_LABEL}=:${sign(key, base)}:`,
    },
    body: JSON.stringify({ keys: [key.jwk] }),
  };
}
