// Runs before every frontend test file.
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './msw/server'

// findBy*/waitFor wait up to 3s (default 1s): whole-screen tests that render a
// page, its queries and the shell can need more under a full parallel run.
configure({ asyncUtilTimeout: 3000 })

// Any request without a handler fails the test, so a test never reaches a
// real backend by accident.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => {
  server.resetHandlers()
  cleanup()
})
afterAll(() => server.close())
