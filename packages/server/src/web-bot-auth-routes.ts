// Public identity of Patch's browsing agent (Web Bot Auth).
//
//   GET /.well-known/http-message-signatures-directory
//       The signed key directory a site fetches to verify the signatures on
//       Patch's requests (draft-meunier-http-message-signatures-directory).
//   GET /agent
//       The human-readable description of the agent, for site owners and for
//       Cloudflare/Akamai's verified-bot review.
//
// Both are unauthenticated by design — a third-party site has to reach them.
// NO FALLBACK: no key configured → 503 naming the missing variable, never an
// empty directory.

import type { FastifyInstance } from 'fastify';
import {
  DIRECTORY_PATH,
  DEFAULT_DIRECTORY_URL,
  directoryResponse,
  parseWebBotAuthKey,
  type WebBotAuthKey,
} from '@patch/wire/web-bot-auth';

export const AGENT_PAGE_PATH = '/agent';
export const AGENT_CONTACT_EMAIL = 'tom.chambers@gmail.com';

export function agentPageHtml(directoryUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Patch</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#111}h1{font-size:1.5rem}</style>
</head>
<body>
<h1>Patch</h1>
<p>Patch is a personal AI agent that acts on behalf of a single user. It browses the web only when that user asks it to, for tasks such as looking up a product, reading a page or filling in a form.</p>
<ul>
<li>It is not a crawler and does not index or collect content in bulk.</li>
<li>It obeys robots.txt.</li>
<li>It makes low request rates, in the manner of one person browsing.</li>
<li>Requests are signed with HTTP Message Signatures (Web Bot Auth, RFC 9421), tag <code>web-bot-auth</code>, and carry a <code>Signature-Agent</code> header pointing to <a href="${directoryUrl}">${directoryUrl}</a>.</li>
</ul>
<p>Operator: Tom Chambers. Contact: <a href="mailto:${AGENT_CONTACT_EMAIL}">${AGENT_CONTACT_EMAIL}</a></p>
</body>
</html>
`;
}

export function registerWebBotAuthRoutes(
  app: FastifyInstance,
  opts: { keyB64: string | undefined },
): void {
  let key: WebBotAuthKey | undefined;
  if (opts.keyB64) key = parseWebBotAuthKey(opts.keyB64);

  app.get(DIRECTORY_PATH, { logLevel: 'warn' }, async (req, reply) => {
    if (!key) {
      return reply.code(503).send({ error: 'PATCH_WEB_BOT_AUTH_KEY is not configured' });
    }
    const { headers, body } = directoryResponse(req.headers.host ?? '', key);
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    return reply.code(200).send(Buffer.from(body));
  });

  app.get(AGENT_PAGE_PATH, { logLevel: 'warn' }, async (_req, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(agentPageHtml(DEFAULT_DIRECTORY_URL));
  });
}
