# Web Bot Auth — Cloudflare / Akamai verified-agent registration

Built, not submitted. Tom submits from his own dashboard.

- Key directory: https://patch.tomchambers.me/.well-known/http-message-signatures-directory
- Description page: https://patch.tomchambers.me/agent
- Key: Ed25519, 1Password Agents / `env-patch` / `PATCH_WEB_BOT_AUTH_KEY`
- keyid (JWK thumbprint): `zifIYXzA6uJp3Pxl4QMaKC29BkR3JXbwxICthLtabao`

## Turning it on (deploy step)

1. `env-render deploy/web-bot-auth.env.tpl`, load `deploy/web-bot-auth.env` into the
   server's environment (serves the directory) and each host's.
2. On each host that should sign: `PATCH_WEB_BOT_AUTH=on`. Default off.
3. Check: `curl -i https://patch.tomchambers.me/.well-known/http-message-signatures-directory`

## Verifying

`https://crawltest.com/cdn-cgi/web-bot-auth` returns 401 `unknown public key or
unknown verified bot ID for keyid` until registered — i.e. the signature is
parsed and only the registration is missing.

## Cloudflare submission values (Manage Account > Configurations > Bot Submission Form > Request Signature)

- Bot name: Patch
- Operator: Tom Chambers, tom.chambers@gmail.com
- Description / info URL: https://patch.tomchambers.me/agent
- Signature-Agent / key directory: https://patch.tomchambers.me/.well-known/http-message-signatures-directory
- keyid (JWK thumbprint): `zifIYXzA6uJp3Pxl4QMaKC29BkR3JXbwxICthLtabao`
- Public key (Ed25519, JWK x): `ukW1sKWt91vJL7mWhNxnEMaMxp8QYlcZYU27Xiv7GHo`
- Signed components: `@authority`, `signature-agent`; tag `web-bot-auth`

## Validation (8 Oct 2026)

Cloudflare's `http-signature-directory` v0.7.0 (cargo install; needs libssl headers
via `OPENSSL_*` env on this box) run against the real route with the real key:
key valid, `signature_verified: true`. Its only error was "URL must be an HTTPS
URL" because it was pointed at a local http port — the deployed URL is https.
The deployed server still returns 503 until the deploy step above is done.

Screwfix (www.screwfix.com, from this Hetzner IP): 403 "request could not be
satisfied" (CloudFront) both signed and unsigned — signing makes no difference
while unregistered, and this is an IP-level block rather than a Cloudflare challenge.
Re-test after registration and deploy.
