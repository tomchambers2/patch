// Re-export shim — the canonical WireTestClient lives in `src/test-client.ts`
// so it's part of the published surface (`@patch/wire/test-client`). This
// path exists because the task brief refers to it; importing from here works
// in tests, importing from `@patch/wire/test-client` works in consumers.
export { WireTestClient, type WireTestClientOptions } from '../src/test-client.js';
