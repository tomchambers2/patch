// Does the published OTA carry the build it claims (scripts/verify-ota-bundle.mjs)?
//
// The failure this guards is not a crash — it is a green deploy. An update
// published on 1 Sep served JS stamped with a commit from 27 Aug, and every
// version panel repeated the stamp, so a broken app looked like a delivery
// problem. So the interesting cases are all the ways this must REFUSE, and in
// particular the CDN's unauthorized-asset page, which is a 200 with a body that
// contains neither stamp.
//
// Run: node scripts/verify-ota-bundle.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  manifestHeaders,
  parseManifestResponse,
  checkStamps,
  verifyOtaBundle,
} from './verify-ota-bundle.mjs';

const BOUNDARY = 'ExpoManifestBoundary-XYZ';
const ASSET_KEY = '12bc9e6ded3ab5d4381caf133f0ce7bf';
const ASSET_URL = 'https://assets.eascdn.net/launch-asset';

function multipart(parts) {
  return (
    parts
      .map(
        ([name, json]) =>
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n` +
          `Content-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n`,
      )
      .join('') + `--${BOUNDARY}--\r\n`
  );
}

const MANIFEST = {
  id: 'update-1',
  createdAt: '2026-09-01T16:29:08.105Z',
  runtimeVersion: '0.1.0',
  launchAsset: { key: ASSET_KEY, url: ASSET_URL },
};
const EXTENSIONS = {
  assetRequestHeaders: { [ASSET_KEY]: { authorization: 'EAS-HMAC-SHA256 sig' } },
};

/** A fetch double: manifest first, then the launch asset. */
function fakeFetch({ manifestBody, manifestStatus = 200, bundle = '', bundleStatus = 200 }) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });
    if (url.startsWith('https://u.expo.dev/')) {
      return {
        ok: manifestStatus === 200,
        status: manifestStatus,
        headers: { get: () => `multipart/mixed; boundary=${BOUNDARY}` },
        text: async () => manifestBody,
      };
    }
    return {
      ok: bundleStatus === 200,
      status: bundleStatus,
      headers: { get: () => 'application/javascript' },
      arrayBuffer: async () => new TextEncoder().encode(bundle).buffer,
    };
  };
  impl.seen = seen;
  return impl;
}

const args = {
  projectId: 'proj',
  runtime: '0.1.0',
  channel: 'preview',
  version: '0.1.753',
  gitSha: 'ce06cb4',
};

test('sends every header expo-updates sends — EAS refuses a request missing the channel', () => {
  assert.deepEqual(manifestHeaders('0.1.0', 'preview'), {
    'expo-platform': 'android',
    'expo-runtime-version': '0.1.0',
    'expo-channel-name': 'preview',
    'expo-protocol-version': '1',
    'expo-api-version': '1',
    accept: 'multipart/mixed',
  });
});

test('parses the manifest and extensions parts out of the multipart body', () => {
  const parsed = parseManifestResponse(
    multipart([
      ['manifest', MANIFEST],
      ['extensions', EXTENSIONS],
    ]),
    `multipart/mixed; boundary=${BOUNDARY}`,
  );
  assert.equal(parsed.manifest.id, 'update-1');
  assert.equal(
    parsed.extensions.assetRequestHeaders[ASSET_KEY].authorization,
    'EAS-HMAC-SHA256 sig',
  );
});

test('a body with no boundary is malformed, not empty', () => {
  const parsed = parseManifestResponse('anything', 'application/json');
  assert.match(parsed.why, /boundary/);
});

test('a response with no manifest part is malformed', () => {
  const parsed = parseManifestResponse(
    multipart([['extensions', EXTENSIONS]]),
    `multipart/mixed; boundary=${BOUNDARY}`,
  );
  assert.match(parsed.why, /no "manifest" part/);
});

test('accepts a bundle carrying both stamps', () => {
  assert.deepEqual(
    checkStamps('...0.1.753...ce06cb4...', { version: '0.1.753', gitSha: 'ce06cb4' }),
    {
      ok: true,
    },
  );
});

test('names BOTH stamps when a stale cached transform carried neither', () => {
  const res = checkStamps('...0.1.713...a307cac...', { version: '0.1.753', gitSha: 'ce06cb4' });
  assert.equal(res.ok, false);
  assert.match(res.why, /version 0\.1\.753/);
  assert.match(res.why, /gitSha ce06cb4/);
  // The remedy has to be in the message: this fires on a deploy box, not here.
  assert.match(res.why, /metro/i);
});

test('a bundle with the right version but the wrong sha is still refused', () => {
  const res = checkStamps('0.1.753 built from a307cac', { version: '0.1.753', gitSha: 'ce06cb4' });
  assert.equal(res.ok, false);
  assert.match(res.why, /gitSha ce06cb4/);
  assert.doesNotMatch(res.why, /version 0\.1\.753/);
});

test('passes end to end, and fetches the asset with the authorization the manifest gave', async () => {
  const f = fakeFetch({
    manifestBody: multipart([
      ['manifest', MANIFEST],
      ['extensions', EXTENSIONS],
    ]),
    bundle: 'stamped 0.1.753 / ce06cb4',
  });
  const res = await verifyOtaBundle(args, f);
  assert.deepEqual(res, { ok: true, createdAt: MANIFEST.createdAt, id: 'update-1' });
  assert.equal(f.seen[1].url, ASSET_URL);
  assert.equal(f.seen[1].headers.authorization, 'EAS-HMAC-SHA256 sig');
});

test('refuses the real failure: today’s update serving five-day-old JS', async () => {
  const res = await verifyOtaBundle(
    args,
    fakeFetch({
      manifestBody: multipart([
        ['manifest', MANIFEST],
        ['extensions', EXTENSIONS],
      ]),
      bundle: 'stamped 0.1.713 / a307cac',
    }),
  );
  assert.equal(res.ok, false);
  assert.match(res.why, /PUBLISHED OTA bundle does not contain/);
});

test('a manifest with no assetRequestHeaders fails for THAT reason, not a missing stamp', async () => {
  const res = await verifyOtaBundle(
    args,
    fakeFetch({
      manifestBody: multipart([
        ['manifest', MANIFEST],
        ['extensions', {}],
      ]),
      bundle: 'stamped 0.1.753 / ce06cb4',
    }),
  );
  assert.equal(res.ok, false);
  assert.match(res.why, /no assetRequestHeaders/);
});

test('an unmapped channel names the channel and the fix', async () => {
  const res = await verifyOtaBundle(args, fakeFetch({ manifestBody: '', manifestStatus: 404 }));
  assert.equal(res.ok, false);
  assert.match(res.why, /HTTP 404/);
  assert.match(res.why, /eas channel:create preview/);
});

test('an unreachable EAS is reported as unreachable, not as a stale bundle', async () => {
  const res = await verifyOtaBundle(args, async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  });
  assert.equal(res.ok, false);
  assert.match(res.why, /could not reach/);
});
