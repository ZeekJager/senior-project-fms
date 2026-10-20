// What the socket handshake checks before any session lookup (FMS-43). Pure.

/**
 * Whether a page at `origin` may open a socket. A browser always sends
 * Origin on a WebSocket and on a cross-origin request; it leaves it out only
 * for a same-origin polling request, which is the API's own page. So:
 *
 * - no Origin: allowed (same-origin, or a non-browser client, which has no
 *   victim's cookies to ride on); the session cookie is still required;
 * - Origin of the host the request was sent to: allowed;
 * - an origin on the allow-list (REALTIME_ALLOWED_ORIGINS): allowed;
 * - anything else: refused, so another site cannot open a socket with a
 *   signed-in user's cookies (cross-site WebSocket hijacking).
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowList: readonly string[]): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (host !== undefined && parsed.host === host) return true;
  return allowList.includes(parsed.origin);
}

/** The value of one cookie in a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * A token bucket per socket for client -> server events: `capacity` at once,
 * then `perSecond`. The only such event is the legacy location update, sent
 * every few seconds at most.
 */
export class RateLimit {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
