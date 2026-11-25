import { act, cleanup, render, screen } from '@testing-library/react'
import { delay, http, HttpResponse } from 'msw'
import { afterAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { ErrorBoundary } from '@/components/shared'
import { ApiError } from '@/lib/api/errors'
import { permits } from '@/lib/permissions'
import { portals } from '@/router/routes'
import { currentUser, errorEnvelope, renderApp, signedInAs, testApi } from '@/test/auth'
import { server } from '@/test/msw/server'

// FMS-64 (SE-100, docs/screen-inventory.md#state-audit): every screen of the route table, rendered three ways, must never
// leave its page area blank: while its data is loading (nothing answered yet), when every list is empty, and when every
// request fails. "Not blank" means the page shows words, a loading skeleton or a status. The success state of each
// screen is its own test file's.

type Scenario = 'loading' | 'empty' | 'error'
const SCENARIOS: Scenario[] = ['loading', 'empty', 'error']
const ID = '00000000-0000-4000-8000-000000000001'

/** Every permission any route asks for: the audit opens each screen as someone allowed to. */
function permissionsOf(rule: unknown): string[] {
  if (typeof rule === 'string') return [rule]
  if (Array.isArray(rule)) return rule as string[]
  if (rule && typeof rule === 'object' && 'all' in rule) return [...(rule as { all: string[] }).all]
  return []
}
const routes = portals.flatMap((portal) => portal.routes.map((route) => ({ portal: portal.id, ...route })))
const staffPermissions = [...new Set(routes.filter((r) => r.portal !== 'driver').flatMap((r) => permissionsOf(r.permission)))]
const driverPermissions = [...new Set(routes.filter((r) => r.portal === 'driver').flatMap((r) => permissionsOf(r.permission)))]

/** The screens audited: every route that renders a page (not a redirect), with an id in place of each parameter. */
const screens = routes
  .filter((r) => typeof r.element.type !== 'function' || r.element.type.name !== 'Navigate')
  .map((r) => ({ path: r.path.replace(/:[A-Za-z]+/g, ID), route: r.path, driver: r.portal === 'driver', permission: r.permission }))

/** The API for a scenario. Sign-in and the session stay as they are; everything else answers per the scenario. */
function apiFor(scenario: Scenario) {
  server.use(
    http.all('/api/v1/*', async ({ request }) => {
      const path = new URL(request.url).pathname
      if (path.startsWith('/api/v1/auth/')) return undefined
      if (scenario === 'loading') {
        await delay('infinite')
        return undefined
      }
      if (scenario === 'error') return errorEnvelope(500, 'INTERNAL_ERROR', 'The audit failed this request.')
      // Empty: a list with nothing in it, or an empty object for a single record.
      return HttpResponse.json({ data: [], meta: { request_id: 'r-1', page: 1, page_size: 25, total: 0, total_pages: 0 } })
    }),
  )
}

/**
 * What the page area shows for a scenario: `pass`, or what is missing. `blank` is the failure the card forbids (a page
 * with nothing at all); the others are findings recorded in the checklist.
 *   loading  a skeleton, a spinner, a status or "Loading": else `no loading indicator`
 *   empty    anything: else `blank`
 *   error    an error with the request id support asks for: else `no request id`, or `error not shown`
 */
function judge(main: HTMLElement | null, scenario: Scenario): string {
  if (!main) return 'blank'
  const text = (main.textContent ?? '').replace(/\s+/g, ' ').trim()
  const has = (selector: string) => main.querySelector(selector) !== null
  const anything = text.length > 0 || has('.animate-shimmer, .animate-spin, [role="status"], [role="alert"], [role="progressbar"], [aria-busy="true"], canvas, img')
  if (!anything) return 'blank'
  if (scenario === 'loading') {
    return has('.animate-shimmer, .animate-spin, [role="status"], [role="progressbar"], [aria-busy="true"]') || /loading/i.test(text) ? 'pass' : 'no loading indicator'
  }
  if (scenario === 'error') {
    const alert = [...main.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').join(' ')
    const shown = alert.length > 0 || /went wrong|could not|couldn.t|failed|try again|error/i.test(text)
    if (!shown) return 'error not shown'
    return /r-1/.test(alert + text) ? 'pass' : 'no request id'
  }
  return 'pass'
}

const results = new Map<string, Record<Scenario, string>>()

describe('screen state audit (FMS-64)', () => {
  for (const s of screens) {
    for (const scenario of SCENARIOS) {
      it(`${s.route}: ${scenario} is not blank`, { timeout: 20_000 }, async () => {
        const perms = s.driver ? driverPermissions : staffPermissions
        signedInAs(currentUser(s.driver ? ['driver'] : ['admin'], perms))
        if (s.permission && !permits(perms, s.permission)) throw new Error(`the audit user cannot open ${s.route}`)
        apiFor(scenario)
        const { container } = renderApp(s.path, { api: testApi() })
        // Asked every 250 ms until the screen passes or its time is up: the session, the first render and the answers (or
        // none, while loading). A 5xx is retried twice, a second and two seconds apart (lib/query.ts), before it shows.
        const deadline = Date.now() + { loading: 1_500, empty: 3_000, error: 10_000 }[scenario]
        let verdict = 'blank'
        for (;;) {
          await act(() => new Promise((r) => setTimeout(r, 250)))
          verdict = judge(container.querySelector('main'), scenario)
          if (verdict === 'pass' || Date.now() > deadline) break
        }
        const row = results.get(s.route) ?? { loading: '', empty: '', error: '' }
        row[scenario] = verdict
        results.set(s.route, row)
        cleanup()
        // The card's bar: no screen is ever blank. What else is missing is a finding, in docs/screen-inventory.md.
        expect(verdict, `${s.route} under ${scenario}`).not.toBe('blank')
      })
    }
  }

  afterAll(() => {
    if (!process.env.SCREEN_AUDIT_OUT) return
    const lines = [...results.entries()].map(([route, r]) => `| \`${route}\` | ${r.loading} | ${r.empty} | ${r.error} |`)
    writeFileSync(process.env.SCREEN_AUDIT_OUT, lines.join('\n') + '\n')
  })

  it('opens every screen of the route table', () => {
    expect(screens.length).toBeGreaterThanOrEqual(39)
  })
})

describe('the error boundary shows the correlation id (FMS-64)', () => {
  function Throws({ error }: { error: unknown }): never {
    throw error
  }

  it('a screen that throws an API error shows its code and request id, which support can copy', () => {
    render(
      <ErrorBoundary resetKey="a">
        <Throws error={new ApiError(500, 'INTERNAL_ERROR', 'Something broke.', [], 'req-7f3a')} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('INTERNAL_ERROR')
    expect(screen.getByRole('alert')).toHaveTextContent('req-7f3a')
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  it('a screen that throws anything else still shows what failed instead of a blank page', () => {
    render(
      <ErrorBoundary resetKey="b">
        <Throws error={new TypeError('x is undefined')} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
