// UDS transport: HTTP over a Unix-domain socket. Used when running on the
// same host as the host (Hetzner box). Gated by PATCH_DAEMON_LOCAL_KEY
// per spec/02-daemon.md. NO FALLBACKS — non-2xx responses propagate.

import { request as httpRequest } from 'node:http';

export class UdsError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'UdsError';
    this.status = status;
    this.body = body;
  }
}

export interface UdsClientOptions {
  socketPath: string;
  localKey: string | null;
}

export class UdsClient {
  private readonly socketPath: string;
  private readonly localKey: string | null;

  constructor(opts: UdsClientOptions) {
    this.socketPath = opts.socketPath;
    this.localKey = opts.localKey;
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string> = {
        host: 'patch-daemon',
      };
      if (this.localKey) headers['authorization'] = `Bearer ${this.localKey}`;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      // Only advertise a JSON content-type when we actually send a body.
      // Fastify rejects an empty body with content-type:application/json
      // (FST_ERR_CTP_EMPTY_JSON_BODY → 400), which broke every no-body POST
      // (jobs enable/disable, chats stop). No-body POSTs send no body and no
      // content-type at all.
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            if (text.length > 0) {
              try {
                parsed = JSON.parse(text);
              } catch {
                // keep as text
              }
            }
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              let msg = `${method} ${path} → ${status}`;
              if (
                parsed &&
                typeof parsed === 'object' &&
                parsed !== null &&
                'error' in parsed &&
                typeof (parsed as { error: unknown }).error === 'string'
              ) {
                msg = `${method} ${path} → ${status} ${(parsed as { error: string }).error}`;
              }
              reject(new UdsError(status, parsed, msg));
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
