// `patch auth *` — QR pairing bootstrap and revoke.
//
// Flow per spec/10-auth.md and testing/qr-pairing.md:
//   1. Generate (or load) a fresh keypair.
//   2. POST /api/auth/pair/start { surfacePublicKey } → server returns
//      { type: 'pairing.nonce', nonce, surfacePublicKey, expiresAt }.
//   3. Encode { nonce, surfacePublicKey } as a QR + display ASCII to stdout.
//   4. Existing surface scans, signs, posts to /api/auth/pair/complete.
//   5. We poll /api/auth/me with a candidate JWT? Simpler: the existing
//      surface relays the credential back over /ws to the new surface.
//      For tests we accept --nonce <nonce> + --credential <jwt> to skip
//      the pairing dance entirely (per testing/qr-pairing.md).

import { Command } from 'commander';
import qrcode from 'qrcode-terminal';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';
import { credentialFilePath, identityFilePath, loadConfig } from '../config.js';
import {
  ensureConfigDir,
  loadOrCreateIdentity,
  readIdentity,
  writeCredential,
  writeIdentity,
} from '../auth.js';
import { RestClient } from '../transport/rest.js';
import { generateUserKeypair, verifySurfaceCredential } from '@patch/auth';

interface NonceResponse {
  type: 'pairing.nonce';
  nonce: string;
  surfacePublicKey: string;
  expiresAt: number;
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Identity / pairing ops');

  auth
    .command('login')
    .description('Pair a new surface via QR')
    .option('--nonce <nonce>', 'Skip QR display: a paired surface will sign with this nonce')
    .option('--credential <jwt>', 'Skip pairing dance: write this credential as the JWT')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { nonce?: string; credential?: string }) => {
      await run(opts, async () => {
        ensureConfigDir();

        // Test-friendly bypass: caller already has a credential.
        if (opts.credential) {
          const kp = loadOrCreateIdentity();
          writeIdentity(kp);
          // Verify the JWT signs against our local identity, and `sub` matches.
          let claims;
          try {
            claims = await verifySurfaceCredential(opts.credential, {
              userPublicKey: kp.publicKey,
            });
          } catch (e) {
            throw new Error(
              `--credential failed to verify against local identity (${identityFilePath()}): ${(e as Error).message}`,
            );
          }
          if (claims.sub !== kp.publicKey) {
            throw new Error(
              `--credential sub (${claims.sub}) does not match local accountId (${kp.publicKey})`,
            );
          }
          writeCredential(opts.credential);
          if (opts.json)
            emitJson({
              ok: true,
              identity: identityFilePath(),
              accountId: kp.publicKey,
              surfaceId: claims.surface_id,
              sub: claims.sub,
              expiresAt: claims.exp,
            });
          else
            emitText(
              `paired (test bypass) — accountId=${kp.publicKey} surfaceId=${claims.surface_id}`,
            );
          return;
        }

        const kp = loadOrCreateIdentity();
        writeIdentity(kp);
        const config = loadConfig();
        const rest = new RestClient({ serverUrl: config.serverUrl, bearer: null });
        const res = await rest.post<NonceResponse>('/api/auth/pair/start', {
          surfacePublicKey: kp.publicKey,
        });

        // Canonical pairing-QR payload — the SAME `patch-pair://<host>?nonce=`
        // URI every other generator emits (spec/05-surfaces.md § Canonical QR
        // payload). The QR carries only the nonce; the scanning surface binds
        // its own device key at /pair/complete, so no key travels in the QR.
        const host = config.serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const payload = `patch-pair://${host}?nonce=${encodeURIComponent(res.nonce)}`;
        if (opts.json) {
          emitJson({
            status: 'awaiting-pair',
            identity: identityFilePath(),
            accountId: kp.publicKey,
            nonce: res.nonce,
            expiresAt: res.expiresAt,
            payload,
          });
        } else {
          emitText('Scan with an already-linked surface to pair this terminal:');
          emitText('');
          await new Promise<void>((resolve) => {
            qrcode.generate(payload, { small: true }, (qr: string) => {
              process.stdout.write(qr + '\n');
              resolve();
            });
          });
          emitText(`nonce: ${res.nonce}`);
          emitText(`expires: ${new Date(res.expiresAt).toISOString()}`);
          emitText('');
          emitText(
            'Once approved, your credential is delivered over /ws — keep this terminal open.',
          );
        }
      });
    });

  auth
    .command('bootstrap')
    .description('First-run: create account from a fresh keypair, mint a CLI surface JWT')
    .option('--server <url>', 'Override server URL (else config / PATCH_SERVER_URL)')
    .option('--label <label>', 'Surface label', 'patch-cli')
    .option(
      '--surface-kind <kind>',
      'Surface kind to mint (terminal | web | desktop | mobile | voice-device | web-dev | desktop-dev | mobile-dev)',
      'terminal',
    )
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { server?: string; label: string; surfaceKind: string }) => {
      await run(opts, async () => {
        ensureConfigDir();
        // 1. Generate or reuse identity.
        let kp;
        try {
          kp = readIdentity();
        } catch {
          kp = generateUserKeypair();
          writeIdentity(kp);
        }

        // 2. Bootstrap the account on the server.
        //
        // The SERVER owns the account keypair (it calls generateUserKeypair()
        // itself) and mints the first surface credential. This used to send
        // `{userPublicKey}` from a locally-generated account key and then mint
        // its own JWT — an older contract the server no longer speaks, so
        // bootstrap failed outright with `{"error":"invalid body"}`. All this
        // command supplies now is THIS device's public key.
        const config = loadConfig();
        const serverUrl = opts.server ?? config.serverUrl;
        const rest = new RestClient({ serverUrl, bearer: null });
        const resp = await rest.post<{
          account: { accountId: string; userPublicKey: string; createdAt: number };
          credential: string;
          surfaceId: string;
        }>('/api/auth/account', {
          clientType: 'surface-cli',
          devicePublicKey: kp.publicKey,
          label: opts.label,
        });
        const jwt = resp.credential;

        // 3. Verify the credential the server gave us actually works, against
        // the account key the SERVER holds — not one we assumed.
        const claims = await verifySurfaceCredential(jwt, {
          userPublicKey: resp.account.userPublicKey,
        });
        const verifyClient = new RestClient({ serverUrl, bearer: jwt });
        try {
          await verifyClient.get<unknown>('/api/auth/me');
        } catch (e) {
          throw new Error(
            'bootstrap: the server rejected the credential it just issued. ' +
              'Aborting (NO FALLBACK). Underlying: ' +
              (e as Error).message,
          );
        }

        // 6. Persist.
        writeCredential(jwt);

        const out = {
          ok: true,
          // The SERVER's account id, not this device's public key — they are
          // different things, and reporting the device key here made bootstrap
          // print an "accountId" that matched nothing on the server.
          accountId: resp.account.accountId,
          surfaceId: claims.surface_id,
          expiresAt: claims.exp,
          identity: identityFilePath(),
          credential: credentialFilePath(),
          serverUrl,
          bootstrapped: true,
        };
        if (opts.json) emitJson(out);
        else
          emitText(
            `bootstrapped accountId=${out.accountId} surfaceId=${out.surfaceId} server=${serverUrl}`,
          );
      });
    });

  auth
    .command('revoke <id>')
    .description('Revoke a paired surface (alias of `surfaces revoke`)')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<{ ok: true }>('/api/auth/revoke', { id });
        if (opts.json) emitJson(res);
        else emitText('revoked');
      });
    });
}
