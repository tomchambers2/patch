// Host-side switch for Web Bot Auth (see @patch/wire/web-bot-auth). Per host,
// because whether a machine's browser should identify itself as Patch is a
// per-machine decision: PATCH_WEB_BOT_AUTH=on|off (default off).

import {
  DEFAULT_DIRECTORY_URL,
  parseWebBotAuthKey,
  type WebBotAuthKey,
} from '@patch/wire/web-bot-auth';

export interface WebBotAuthConfig {
  key: WebBotAuthKey;
  /** URL placed in `Signature-Agent`; where verifiers fetch the public key. */
  directoryUrl: string;
}

/**
 * undefined = signing off. Enabled with a missing/invalid key throws: a host
 * told to sign must not quietly browse unsigned.
 */
export function webBotAuthFromEnv(env: NodeJS.ProcessEnv): WebBotAuthConfig | undefined {
  const flag = env['PATCH_WEB_BOT_AUTH'];
  if (flag === undefined || flag === '' || flag === 'off') return undefined;
  if (flag !== 'on') {
    throw new Error(`PATCH_WEB_BOT_AUTH must be "on" or "off", got "${flag}"`);
  }
  const raw = env['PATCH_WEB_BOT_AUTH_KEY'];
  if (!raw) {
    throw new Error('PATCH_WEB_BOT_AUTH=on but PATCH_WEB_BOT_AUTH_KEY is not set');
  }
  return {
    key: parseWebBotAuthKey(raw),
    directoryUrl: env['PATCH_WEB_BOT_AUTH_DIRECTORY'] || DEFAULT_DIRECTORY_URL,
  };
}
