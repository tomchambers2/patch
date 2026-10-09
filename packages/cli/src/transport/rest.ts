// REST transport: talks to the patch server with the surface JWT bearer.
// NO FALLBACKS — non-2xx responses propagate as RestError.

export class RestError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** True iff the request carried an Authorization Bearer header. */
  readonly sentBearer: boolean;
  constructor(status: number, body: unknown, message: string, sentBearer: boolean) {
    super(message);
    this.name = 'RestError';
    this.status = status;
    this.body = body;
    this.sentBearer = sentBearer;
  }
}

export interface RestClientOptions {
  serverUrl: string;
  bearer: string | null;
  /** For tests — override fetch. */
  fetchFn?: typeof fetch;
}

export class RestClient {
  private readonly base: string;
  private readonly bearer: string | null;
  private readonly fetchFn: typeof fetch;

  constructor(opts: RestClientOptions) {
    this.base = opts.serverUrl.replace(/\/$/, '');
    this.bearer = opts.bearer;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.bearer) h['authorization'] = `Bearer ${this.bearer}`;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.base + path;
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchFn(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON — keep as text.
      }
    }
    if (!res.ok) {
      let msg = `${method} ${path} → ${res.status}`;
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error: unknown }).error === 'string'
      ) {
        msg = `${method} ${path} → ${res.status} ${(parsed as { error: string }).error}`;
      }
      throw new RestError(res.status, parsed, msg, this.bearer !== null);
    }
    return parsed as T;
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
