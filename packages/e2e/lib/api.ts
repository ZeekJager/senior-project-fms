import { request, type APIRequestContext, type APIResponse } from '@playwright/test'

// One person at the API (FMS-63): signed in with their own cookies, sending the CSRF token on writes, as the web app
// does. Every call names the step it is part of; an answer other than the one expected fails with the step, the
// request, the status, the error code and the request id (X-Request-Id), so a red run says where to look in the logs.

export interface Envelope<T> {
  data: T
  meta: Record<string, unknown>
}

let currentStep = 'setup'

/** The step under way, for failure messages (set by `step()` in the spec). */
export function setStep(name: string): void {
  currentStep = name
}

export function stepName(): string {
  return currentStep
}

export class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly requestId: string | null,
    message: string,
  ) {
    super(`Step "${step}" failed: ${message}${requestId ? ` (request id ${requestId})` : ''}`)
  }
}

export class Actor {
  private csrf = ''

  private constructor(
    readonly who: string,
    private readonly ctx: APIRequestContext,
  ) {}

  /** A new session at `baseURL` (the web app's origin, whose /api the dev server proxies). */
  static async signIn(who: string, baseURL: string, email: string, password: string): Promise<Actor> {
    const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { accept: 'application/json' } })
    const actor = new Actor(who, ctx)
    await actor.call('POST', '/auth/login', { email, password }, 200)
    const state = await ctx.storageState()
    actor.csrf = decodeURIComponent(state.cookies.find((c) => c.name === 'fms_csrf')?.value ?? '')
    return actor
  }

  /** The session's cookies, to sign a browser page in as this person. */
  cookies() {
    return this.ctx.storageState().then((s) => s.cookies)
  }

  async call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, expect: number | number[]): Promise<Envelope<T> & { status: number; requestId: string | null; error?: { code: string; message: string; details?: unknown[] } }> {
    const url = `/api/v1${path}`
    let res: APIResponse
    try {
      res = await this.ctx.fetch(url, {
        method,
        headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': this.csrf },
        ...(method === 'GET' || body === undefined ? {} : { data: body }),
      })
    } catch (err) {
      throw new StepFailure(currentStep, null, `${this.who}: ${method} ${path} did not answer (${(err as Error).message})`)
    }
    const requestId = res.headers()['x-request-id'] ?? null
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      /* a file or an empty body */
    }
    const wanted = Array.isArray(expect) ? expect : [expect]
    if (!wanted.includes(res.status())) {
      const error = json.error as { code?: string; message?: string; details?: unknown } | undefined
      const why = error ? `${error.code}: ${error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ''}` : text.slice(0, 300)
      throw new StepFailure(currentStep, requestId, `${this.who}: ${method} ${path} answered ${res.status()}, expected ${wanted.join(' or ')}. ${why}`)
    }
    return { ...(json as unknown as Envelope<T>), status: res.status(), requestId, error: json.error as never }
  }

  get<T = unknown>(path: string, expect: number | number[] = 200) {
    return this.call<T>('GET', path, undefined, expect)
  }

  post<T = unknown>(path: string, body: unknown = {}, expect: number | number[] = [200, 201]) {
    return this.call<T>('POST', path, body, expect)
  }

  put<T = unknown>(path: string, body: unknown, expect: number | number[] = 200) {
    return this.call<T>('PUT', path, body, expect)
  }

  dispose(): Promise<void> {
    return this.ctx.dispose()
  }
}

/** Waits until `check` returns a value (not undefined), asking every `everyMs`; fails the step after `timeoutMs`. */
export async function eventually<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 30_000, everyMs = 1_000): Promise<T> {
  const until = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await check()
      if (value !== undefined) return value
    } catch (err) {
      last = err
      if (err instanceof StepFailure) throw err
    }
    if (Date.now() > until) throw new StepFailure(currentStep, null, `${what} did not happen within ${timeoutMs / 1000} s${last ? ` (${(last as Error).message})` : ''}`)
    await new Promise((r) => setTimeout(r, everyMs))
  }
}
