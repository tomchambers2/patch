import { refreshClaudeOAuth } from '@patch/auth';
import type { SharedSecrets } from '@patch/wire';

export function tokenExpiry(token: string): number | undefined {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Only the server keeps rotating credentials. Hosts get access tokens. */
export function hostSecrets(secrets: SharedSecrets): SharedSecrets {
  const copy = structuredClone(secrets);
  for (const a of copy.claude) if (a.credential) delete a.credential.refreshToken;
  for (const a of copy.codex) {
    if (a.kind !== 'chatgpt' || !a.authJson) continue;
    const auth = JSON.parse(a.authJson);
    if (auth.tokens) delete auth.tokens.refresh_token;
    auth.auth_mode = 'chatgptAuthTokens';
    a.authJson = JSON.stringify(auth);
  }
  return copy;
}

export async function refreshOpenAI(authJson: string): Promise<string> {
  const auth = JSON.parse(authJson);
  if (!auth.tokens?.refresh_token) throw new Error('ChatGPT needs a new sign-in');
  // OpenAI Codex rust-v0.154.0 login/src/auth/manager.rs.
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      refresh_token: auth.tokens.refresh_token,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `ChatGPT sign-in could not be renewed (HTTP ${response.status}). Sign in again in Settings.`,
    );
  const next = (await response.json()) as Record<string, unknown>;
  if (typeof next.access_token !== 'string')
    throw new Error('OpenAI refresh response has no access token');
  for (const key of ['access_token', 'refresh_token', 'id_token']) {
    if (typeof next[key] === 'string') auth.tokens[key] = next[key];
  }
  auth.last_refresh = new Date().toISOString();
  return JSON.stringify(auth);
}

export const refreshClaude = (token: string) =>
  refreshClaudeOAuth(token, {
    fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
  });
