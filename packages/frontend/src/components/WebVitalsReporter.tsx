import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { pageTemplate, startWebVitals, type StartOptions } from '@/lib/webVitals'
import { portals } from '@/router/routes'

/** Every screen's route template, from the route table: the only pages a report may name. */
const PATTERNS = ['/', ...portals.flatMap((portal) => portal.routes.map((route) => route.path))]

/**
 * Reports how fast pages were for this session (FMS-75, docs/metrics.md) while someone is signed in: the API takes the reports
 * from any signed-in user only. Renders nothing. Production builds only (`enabled`), so development and tests do not report
 * their own timings.
 */
export function WebVitalsReporter({ enabled = import.meta.env.PROD, ...overrides }: { enabled?: boolean } & Partial<Pick<StartOptions, 'send' | 'observers' | 'target' | 'win'>>) {
  const { session } = useAuth()
  const { pathname } = useLocation()
  const page = useRef<string | undefined>(undefined)
  page.current = pageTemplate(pathname, PATTERNS)
  const signedIn = session !== null

  useEffect(() => {
    if (!enabled || !signedIn) return undefined
    return startWebVitals({ page: () => page.current, ...overrides })
    // The overrides are for tests and do not change while mounted.
  }, [enabled, signedIn])

  return null
}
