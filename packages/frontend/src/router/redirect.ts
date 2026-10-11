export { homePathFor } from './navigation'

/** `/login?redirect=<attempted url>`. Slashes stay readable (`/login?redirect=/dashboard`); `?`, `&` and `#` are escaped. */
export function loginPathFor(attempted: string): string {
  return `/login?redirect=${encodeURIComponent(attempted).replace(/%2F/gi, '/')}`
}

/**
 * Accepts only an in-app path. A redirect target comes from the URL, so an
 * absolute or protocol-relative value (`//evil.example`) would turn the login
 * page into an open redirect.
 */
export function safeRedirect(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return fallback
  return raw
}
