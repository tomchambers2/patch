// Calls GET <serverUrl>/api/healthz. NO FALLBACKS — non-2xx and network
// errors propagate.

import type { HealthzResponse } from '@patch/wire';

export async function healthz(serverUrl: string): Promise<HealthzResponse> {
  const url = new URL('/api/healthz', serverUrl).toString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`healthz: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as HealthzResponse;
}
