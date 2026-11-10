/**
 * A signed-in user as the web app is one (FMS-61): the session cookies from POST /auth/login, sent back on every request,
 * and the CSRF token (the `fms_csrf` cookie) echoed in `X-CSRF-Token` on every write (docs/security.md). Times each
 * request from sending it to reading the whole answer.
 */
import { randomUUID } from 'node:crypto';

export interface Timed {
  status: number;
  ms: number;
  ok: boolean;
  /** The HTTP status as a string, or `network` when no answer came. */
  outcome: string;
  body: unknown;
}

/** The cookies a response set, by name (the value up to the first `;`). */
export function setCookies(headers: Headers): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return jar;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class Session {
  private readonly cookies = new Map<string, string>();

  private constructor(private readonly api: string) {}

  /** Signs in; throws with the answer's status when refused. */
  static async signIn(api: string, email: string, password: string): Promise<Session> {
    const session = new Session(api);
    const res = await session.request('POST', '/auth/login', { email, password });
    if (!res.ok) throw new Error(`Sign-in as ${email} answered ${res.outcome}: ${JSON.stringify(res.body)}`);
    return session;
  }

  /** The Cookie header, for a Socket.IO handshake. */
  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Timed> {
    const sent: Record<string, string> = { accept: 'application/json', ...headers };
    if (this.cookies.size > 0) sent.cookie = this.cookieHeader();
    if (body !== undefined) sent['content-type'] = 'application/json';
    if (WRITES.has(method) && this.cookies.has('fms_csrf')) sent['x-csrf-token'] = this.cookies.get('fms_csrf')!;
    if (method === 'POST' && path !== '/auth/login' && !sent['idempotency-key']) sent['idempotency-key'] = randomUUID();
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.api}${path}`, { method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      const ms = performance.now() - t0;
      for (const [k, v] of setCookies(res.headers)) this.cookies.set(k, v);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, ms, ok: res.status >= 200 && res.status < 300, outcome: String(res.status), body: parsed };
    } catch {
      return { status: 0, ms: performance.now() - t0, ok: false, outcome: 'network', body: null };
    }
  }
}

/** Waits a random time in [min, max] milliseconds, as a user between actions. */
export const think = ([min, max]: readonly [number, number]) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
