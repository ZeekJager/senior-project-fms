import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app';

/** A failed API call, with the contract's error envelope. */
export class SeedApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    request: string,
  ) {
    super(`${request} -> ${status}: ${JSON.stringify(body)}`);
  }
}

/**
 * The application's own HTTP API, served in this process on a loopback port.
 * The seed writes through it like any client, so validation, business rules,
 * audit and events all apply (FMS-113): nothing reaches the database the API
 * would refuse.
 */
export class SeedApi {
  private cookie = '';
  private credentials: { email: string; password: string } | null = null;

  private constructor(
    private readonly server: Server,
    private readonly base: string,
  ) {}

  static async start(): Promise<SeedApi> {
    const app = createApp();
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return new SeedApi(server, `http://127.0.0.1:${port}/api/v1`);
  }

  async signIn(email: string, password: string): Promise<void> {
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new SeedApiError(res.status, await res.json().catch(() => null), 'POST /auth/login');
    this.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    this.credentials = { email, password };
  }

  /** `data` and `meta` of a successful call. An expired access token (15 min) signs in again once. */
  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, retried = false): Promise<{ data: T; meta: Record<string, unknown> }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried && this.credentials) {
      await this.signIn(this.credentials.email, this.credentials.password);
      return this.call<T>(method, path, body, true);
    }
    const json = res.status === 204 ? null : ((await res.json().catch(() => null)) as { data: T; meta: Record<string, unknown> } | null);
    if (!res.ok) throw new SeedApiError(res.status, json, `${method} ${path}`);
    return { data: json?.data as T, meta: json?.meta ?? {} };
  }

  /** A multipart/form-data POST: `fields` as text parts plus the file in the "file" part (POST /documents). */
  async upload<T = Record<string, unknown>>(path: string, fields: Record<string, string>, file: { bytes: Buffer; filename: string }, retried = false): Promise<{ data: T; meta: Record<string, unknown> }> {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', new Blob([new Uint8Array(file.bytes)]), file.filename);
    const res = await fetch(this.base + path, { method: 'POST', headers: { cookie: this.cookie }, body: form });
    if (res.status === 401 && !retried && this.credentials) {
      await this.signIn(this.credentials.email, this.credentials.password);
      return this.upload<T>(path, fields, file, true);
    }
    const json = (await res.json().catch(() => null)) as { data: T; meta: Record<string, unknown> } | null;
    if (!res.ok) throw new SeedApiError(res.status, json, `POST ${path}`);
    return { data: json?.data as T, meta: json?.meta ?? {} };
  }

  post<T = Record<string, unknown>>(path: string, body: unknown) {
    return this.call<T>('POST', path, body);
  }

  patch<T = Record<string, unknown>>(path: string, body: unknown) {
    return this.call<T>('PATCH', path, body);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server.closeAllConnections();
    });
  }
}
