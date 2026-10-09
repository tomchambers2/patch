// Files the server serves, on a route through a relay (spec/10 § Relay): a phone
// that only reaches its server through the tunnel cannot hand an address to an
// Image, a WebView or the OS, so it fetches the file through the tunnel and shows
// the local copy. On a direct route nothing changes — the URL is the URL.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actAsync,
  byTestId,
  findHost,
  flush,
  queryHost,
  renderRN,
  textOf,
} from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import { __getLinkingOpenedUrls, __resetLinkingOpenedUrls } from './stubs/react-native';
import { readAsStringAsync } from './stubs/expo-file-system';
import { setRoute } from '../src/config';
import { __resetServedFiles, isRelayed, localUriFor, useLocalUri } from '../src/lib/servedFile';
import {
  ArtifactViewerHost,
  __resetArtifactViewer,
  openArtifactViewer,
  openServed,
} from '../src/components/ArtifactViewer';

const RELAY = {
  kind: 'relay' as const,
  relay: { url: 'wss://relay.example.com', channel: 'c', serverKey: 'k' },
};
const URL_ON_RELAY = 'https://relay.patch.invalid/api/chats/c1/artifact/a1';

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  __clearAllMmkv();
  __resetServedFiles();
  __resetArtifactViewer();
  __resetLinkingOpenedUrls();
  fetchMock = vi.fn(async () => new Response(new Uint8Array([104, 105, 33])));
  globalThis.fetch = fetchMock as never;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('localUriFor', () => {
  it('is the server URL itself on a direct route', async () => {
    expect(isRelayed()).toBe(false);
    expect(await localUriFor('https://patch.test/x.png')).toBe('https://patch.test/x.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches through the tunnel once and keeps a local copy on a relayed route', async () => {
    setRoute(RELAY);
    expect(isRelayed()).toBe(true);
    const path = await localUriFor(URL_ON_RELAY);
    expect(path).toMatch(/^file:\/\/\/cache\/served-[a-z0-9]+-a1$/);
    expect(await readAsStringAsync(path)).toBe('aGkh'); // "hi!" as base64
    expect(await localUriFor(URL_ON_RELAY)).toBe(path);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pads the base64 the file system needs', async () => {
    setRoute(RELAY);
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    expect(await readAsStringAsync(await localUriFor(`${URL_ON_RELAY}?v=1`))).toBe('AQI=');
  });

  it('says what the server said when it refuses, and tries again next time', async () => {
    setRoute(RELAY);
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 404 }));
    await expect(localUriFor(URL_ON_RELAY)).rejects.toThrow(/HTTP 404/);
    expect(await localUriFor(URL_ON_RELAY)).toMatch(/^file:/);
  });
});

function Probe({ url }: { url: string | null }): React.ReactElement {
  const { uri, error } = useLocalUri(url);
  return React.createElement('Text', { testID: 'probe' }, `${uri ?? '-'}|${error ?? '-'}`);
}

describe('useLocalUri', () => {
  it('is the URL straight away on a direct route', () => {
    const r = renderRN(<Probe url="https://patch.test/a" />);
    expect(textOf(findHost(r.root, byTestId('probe')))).toBe('https://patch.test/a|-');
  });

  it('is nothing for no url', () => {
    setRoute(RELAY);
    const r = renderRN(<Probe url={null} />);
    expect(textOf(findHost(r.root, byTestId('probe')))).toBe('-|-');
  });

  it('is empty until the copy arrives on a relayed route, then the local file', async () => {
    setRoute(RELAY);
    const r = renderRN(<Probe url={URL_ON_RELAY} />);
    expect(textOf(findHost(r.root, byTestId('probe')))).toBe('-|-');
    await actAsync(flush);
    expect(textOf(findHost(r.root, byTestId('probe')))).toMatch(/^file:\/\/\/cache\/served-.*\|-$/);
  });

  it('carries the failure when the file cannot be fetched', async () => {
    setRoute(RELAY);
    fetchMock.mockResolvedValue(new Response('no', { status: 500 }));
    const r = renderRN(<Probe url={URL_ON_RELAY} />);
    await actAsync(flush);
    expect(textOf(findHost(r.root, byTestId('probe')))).toMatch(/-\|.*HTTP 500/);
  });
});

describe('the artifact viewer', () => {
  it('opens the server URL in the WebView and offers the browser, on a direct route', () => {
    const r = renderRN(<ArtifactViewerHost />);
    return actAsync(async () => openArtifactViewer('https://patch.test/a', 'A')).then(() => {
      expect(findHost(r.root, byTestId('artifact-viewer-webview')).props.source.uri).toBe(
        'https://patch.test/a',
      );
      expect(findHost(r.root, byTestId('artifact-viewer-open-browser'))).toBeTruthy();
    });
  });

  it('shows the local copy and offers no browser on a relayed route', async () => {
    setRoute(RELAY);
    const r = renderRN(<ArtifactViewerHost />);
    await actAsync(async () => openArtifactViewer(URL_ON_RELAY, 'Bus times'));
    await actAsync(flush);
    expect(findHost(r.root, byTestId('artifact-viewer-webview')).props.source.uri).toMatch(
      /^file:\/\/\/cache\/served-/,
    );
    expect(queryHost(r.root, byTestId('artifact-viewer-open-browser'))).toBeNull();
  });

  it('says so when the file cannot be fetched', async () => {
    setRoute(RELAY);
    fetchMock.mockResolvedValue(new Response('gone', { status: 410 }));
    const r = renderRN(<ArtifactViewerHost />);
    await actAsync(async () => openArtifactViewer(URL_ON_RELAY, 'Bus times'));
    await actAsync(flush);
    expect(textOf(findHost(r.root, byTestId('artifact-viewer-error')))).toMatch(/HTTP 410/);
  });
});

describe('openServed', () => {
  it('hands a direct URL to the OS', () => {
    openServed('https://patch.test/f.pdf', 'f');
    expect(__getLinkingOpenedUrls()).toEqual(['https://patch.test/f.pdf']);
  });

  it('opens the in-app viewer instead on a relayed route', async () => {
    setRoute(RELAY);
    const r = renderRN(<ArtifactViewerHost />);
    await actAsync(async () => openServed(URL_ON_RELAY, 'f.pdf'));
    expect(findHost(r.root, byTestId('artifact-viewer-title'))).toBeTruthy();
    expect(__getLinkingOpenedUrls()).toEqual([]);
  });
});
