import { ProviderCallError, type HttpMethod, type ProviderClient, type ProviderRequest, type ProviderResponse } from '../domain/adapter';
import type { ProviderBreaker } from './circuit-breaker';

export interface ClientSettings {
  /** Each attempt is cancelled after this. */
  timeoutMs: number;
  /** Extra attempts for an idempotent call that failed in a way worth retrying. */
  maxRetries: number;
  /** Backoff before retry n is a random time up to min(cap, base * 2^n) ("full jitter"). */
  retryBaseMs: number;
  retryCapMs: number;
}

export const DEFAULT_CLIENT: ClientSettings = { timeoutMs: 5_000, maxRetries: 2, retryBaseMs: 200, retryCapMs: 2_000 };

const IDEMPOTENT_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'PUT', 'DELETE'];

/**
 * Full jitter (api-contract §20: exponential backoff and jitter): spread over [0, min(cap, base * 2^attempt)),
 * so clients that failed together do not retry together.
 */
export function backoffMs(attempt: number, settings: Pick<ClientSettings, 'retryBaseMs' | 'retryCapMs'>, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(settings.retryCapMs, settings.retryBaseMs * 2 ** attempt));
}

export interface HttpClientOptions {
  code: string;
  baseUrl: string | null;
  settings: ClientSettings;
  breaker: ProviderBreaker;
  /** Sent as X-Request-Id, so the provider's logs can be matched to ours (api-contract §2). */
  correlationId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The gateway's HTTP client (FMS-85). Every attempt goes through the provider's breaker and has its
 * own timeout. Retries only for idempotent calls and only for failures the provider may recover
 * from (timeouts, network errors, 408, 429, 5xx); never while the breaker is open.
 */
export class HttpProviderClient implements ProviderClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? wait;
    this.random = opts.random ?? Math.random;
  }

  async call<T = unknown>(request: ProviderRequest): Promise<ProviderResponse<T>> {
    const url = this.urlFor(request);
    const idempotent = request.idempotent ?? IDEMPOTENT_METHODS.includes(request.method);
    const { maxRetries } = this.opts.settings;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.opts.breaker.fire(() => this.once<T>(url, request));
      } catch (err) {
        const again = err instanceof ProviderCallError && err.retryable && idempotent && attempt < maxRetries;
        if (!again) throw err;
        await this.sleep(backoffMs(attempt, this.opts.settings, this.random));
      }
    }
  }

  /**
   * The provider's base URL joined with the path. A path is always under the base URL: an absolute URL
   * or a `..` could send the API key to another host.
   */
  private urlFor(request: ProviderRequest): URL {
    const { baseUrl, code } = this.opts;
    if (!baseUrl) throw new ProviderCallError('network', `${code} has no base URL.`);
    if (!request.path.startsWith('/') || request.path.includes('://') || request.path.split('/').includes('..')) {
      throw new Error(`Provider paths are relative to the base URL ('/vehicles'), not '${request.path}'.`);
    }
    const url = new URL(baseUrl.replace(/\/+$/, '') + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value));
    return url;
  }

  private async once<T>(url: URL, request: ProviderRequest): Promise<ProviderResponse<T>> {
    const { method, path } = request;
    const { timeoutMs } = this.opts.settings;
    const headers: Record<string, string> = { accept: 'application/json', 'x-request-id': this.opts.correlationId, ...request.headers };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    try {
      // The signal covers reading the body too: a provider that sends headers and then stalls still times out.
      const res = await this.fetch(url, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderCallError('http', `${method} ${path} answered ${res.status}.`, res.status);
      const json = (res.headers.get('content-type') ?? '').includes('json') && text !== '';
      return { status: res.status, headers: res.headers, body: (json ? JSON.parse(text) : text) as T };
    } catch (err) {
      if (err instanceof ProviderCallError) throw err;
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderCallError('timeout', `${method} ${path} timed out after ${timeoutMs} ms.`);
      if (err instanceof SyntaxError) throw new ProviderCallError('http', `${method} ${path} answered with JSON that could not be read.`, 502);
      throw new ProviderCallError('network', `${method} ${path} could not reach the provider.`);
    }
  }
}
